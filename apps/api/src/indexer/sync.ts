/**
 * The sync tick. Pulls both upstreams, writes the join, recomputes rollups.
 *
 * Costs are asymmetric and the code reflects it. The counters index is small
 * and grows by a handful a day, so it is walked fully on the first run and
 * only from the tip afterwards. Pool history is per-pair and only fetched for
 * pairs whose token is a counter — which is 1 of the chain's 30 pools today,
 * and will stay a small fraction of them.
 */

import type { Counter } from "@counters/core/counter";
import type { Pool } from "@counters/core/pool";
import type { Fairminter } from "@counters/core/fairminter";
import { seedsPool } from "@counters/core/fairminter";
import { launchpadOfFairminter } from "@counters/core/launchpad";
import { listingFromDispenser, listingFromOrder, type Listing } from "@counters/core/listing";
import { ledgerAssetName } from "@counters/core/counter";
import { isXcpPool, poolPrice, priceFromReserves, tokenSide } from "@counters/core/pool";
import { big } from "@counters/core/numeric";
import type { Env } from "#api/env";
import { one, q } from "#api/db";
import { Counterparty } from "#api/upstream/counterparty";
import { CountersServer } from "#api/upstream/counters-server";

/** Raw u64s are stored as decimal TEXT — see migrations/0001_init.sql. */
const raw = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const bool = (value: unknown): number | null =>
  value === null || value === undefined ? null : value ? 1 : 0;

export interface SyncReport {
  counters: number;
  pools: number;
  fairminters: number;
  snapshots: number;
  matches: number;
  listings: number;
  /** Counter assets asked about this tick — see `syncListings`. */
  swept: number;
  tip: number;
}

export async function sync(env: Env): Promise<SyncReport> {
  const counters = new CountersServer(env.COUNTERS_API_BASE);
  const cp = new Counterparty(env.COUNTERPARTY_API_BASE);

  const [status, tip] = await Promise.all([counters.status(), cp.tip()]);

  const written = {
    counters: await syncCounters(env.DB, counters, status.count),
    pools: 0,
    fairminters: 0,
    snapshots: 0,
    matches: 0,
    listings: 0,
    swept: 0,
    tip: tip.counterparty_height,
  };

  const { pools, snapshots, matches } = await syncPools(env.DB, cp);
  written.pools = pools;
  written.snapshots = snapshots;
  written.matches = matches;
  written.fairminters = await syncFairminters(env.DB, cp);

  // Its own failure, not the tick's: the tip and the timestamps below are
  // what the site reports as "synced", and they describe the stages above.
  try {
    const listings = await syncListings(env.DB, cp, tip.counterparty_height);
    written.listings = listings.listings;
    written.swept = listings.swept;
  } catch (cause) {
    console.error("[sync] listings not refreshed:", (cause as Error).message);
  }

  await setState(env.DB, "tip", String(tip.counterparty_height));
  await setState(env.DB, "counters_indexed", String(status.indexed));
  await setState(env.DB, "synced_at", String(Math.floor(Date.now() / 1000)));

  return written;
}

/* -------------------------------------------------------------------- */
/* Counters                                                             */
/* -------------------------------------------------------------------- */

/**
 * Upsert counters. On a cold table the whole index is walked; afterwards only
 * pages newer than the highest known number, which is normally one short page.
 *
 * Counters are append-only and immutable once numbered, so an existing row is
 * left alone except for `body` — the indexer withholds inline bodies for large
 * counters, and a later fetch may fill one in.
 */
async function syncCounters(
  db: D1Database,
  server: CountersServer,
  upstreamCount: number,
): Promise<number> {
  const highest = await one<{ n: number | null }>(db, `SELECT MAX(number) AS n FROM counters`);
  const known = highest?.n ?? -1;
  const cold = known < 0;

  const WARM_PAGES = 5;
  const fetched: Counter[] = [];
  let unseen = 0;
  let hitPageCap = false;

  for await (const batch of server.walk(100, cold ? 200 : WARM_PAGES)) {
    const novel = cold ? batch.length : batch.filter((c) => c.number > known).length;
    unseen += novel;

    // Every counter on a page is upserted, not only the ones we have never
    // seen. A counter's *file* is immutable once numbered, but its supply is
    // not: a fairminter deploy is inscribed with a supply of 0 and grows with
    // every mint against it, so the row written the tick it appeared is wrong
    // by the next one. #188 LORDFUN sat at supply 0 against a real 37M-token
    // pool, which ranked it last by market cap instead of first.
    //
    // This costs nothing to fetch — the page is downloaded either way and the
    // known half of it used to be discarded — and the upsert already updates
    // exactly the fields that can still change.
    fetched.push(...batch);

    // Warm path: the first page that reaches numbers we already hold means
    // everything below it is already stored.
    if (!cold && novel < batch.length) {
      hitPageCap = false;
      break;
    }
    hitPageCap = !cold && unseen >= WARM_PAGES * 100;
  }

  // Reaching the page cap without meeting a known number means the walk
  // stopped mid-way. Storing what it did fetch pushes MAX(number) to the tip,
  // so the next tick starts *above* the counters it skipped and they are never
  // requested again — a permanent hole rather than a delay. Numbering is
  // gap-free by protocol, so the hole is detectable, and gaps are filled below
  // whether they came from this or from an upstream hiccup.
  if (hitPageCap) {
    await setState(db, "counters_walk_truncated", String(Date.now()));
  }

  // A number names one reveal forever, so a server that puts a different
  // reveal at a number this table already holds is not the index the table
  // was built from — and everything above the first disagreement is numbered
  // by the same different rule. Nothing from such a walk is stored.
  const disputed = await renumbered(db, fetched);
  await setState(db, "counters_renumbered", disputed === null ? "" : String(disputed));
  if (disputed !== null) {
    console.error(
      `[sync] counters server disagrees with the stored numbering at #${disputed}; ` +
        `no counters written. Numbers are immutable — check COUNTERS_API_BASE.`,
    );
    return 0;
  }

  if (fetched.length > 0) await upsertCounters(db, fetched);

  const filled = await backfillGaps(db, server);

  // Its own failure, like the listings: the table arrives by migration, and a
  // sync that runs before it does should still index counters.
  try {
    await syncDelegates(db, server, fetched, cold);
  } catch (cause) {
    console.error("[sync] delegates not recorded:", (cause as Error).message);
  }

  // A count mismatch means the index is still short. Recorded rather than
  // thrown: a partial index is serviceable, and the next tick continues.
  const stored = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM counters`);
  await setState(
    db,
    "counters_incomplete",
    String(Math.max(0, upstreamCount - (stored?.n ?? 0))),
  );

  // Counted as new counters, not as rows touched: a refresh of something
  // already stored is not an addition, and the report is read as "how much
  // did the index grow".
  return unseen + filled;
}

/**
 * Record which counters render another counter's file.
 *
 * The walk above only reaches the newest page once the table is warm, and
 * the 300 RARE.PEPE editions were all indexed before this table existed — so
 * the first run after the migration walks the whole index once for its
 * `delegate` fields, and every run after that keeps up from the page it
 * already fetched. Only a *resolved* delegate is stored: one whose target is
 * not an indexed counter has nothing to render, and shows as the reference
 * it literally is.
 */
async function syncDelegates(
  db: D1Database,
  server: CountersServer,
  fetched: Counter[],
  walkedEverything: boolean,
): Promise<void> {
  let counters = fetched;
  const seeded = await one<{ value: string }>(
    db,
    `SELECT value FROM chain_state WHERE key = 'delegates_seeded'`,
  );
  if (!seeded && !walkedEverything) {
    counters = [];
    for await (const batch of server.walk(100, 200)) counters.push(...batch);
  }

  const writes: D1PreparedStatement[] = [];
  for (const c of counters) {
    const d = c.delegate;
    if (d && d.number != null && d.content_type && d.size != null) {
      writes.push(
        db
          .prepare(
            `INSERT INTO delegates (number, target_number, target_type, target_size, fragment)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(number) DO UPDATE SET
               target_number = excluded.target_number,
               target_type = excluded.target_type,
               target_size = excluded.target_size,
               fragment = excluded.fragment`,
          )
          .bind(c.number, d.number, d.content_type, d.size, d.fragment ?? null),
      );
    }
  }
  for (let i = 0; i < writes.length; i += 50) await db.batch(writes.slice(i, i + 50));
  if (!seeded) await setState(db, "delegates_seeded", String(Date.now()));
}

/**
 * The lowest number at which the server and this table name different
 * reveals, or null when they agree on every number both hold.
 *
 * The upsert below is keyed by number and refreshes only the fields that can
 * change, which is right exactly as long as the number means the same reveal
 * on both sides. When it does not, the result is not an error but a chimera:
 * the row keeps its asset and takes the other counter's supply, owner and
 * body. A local counters server that had fairminter deploys in a different
 * block order numbered MEMENOME #162 instead of #160 and shifted everything
 * after it; one sync against it left #215 FAKEBANG with DEGENT.1's supply of
 * one unit — a market cap of zero — and #160 MEMENOME rendering GREENER's
 * file. The walk is newest-first and a shift moves every later number, so the
 * newest rows already held are always among the ones that show it.
 */
async function renumbered(db: D1Database, fresh: Counter[]): Promise<number | null> {
  if (fresh.length === 0) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const c of fresh) {
    if (c.number < low) low = c.number;
    if (c.number > high) high = c.number;
  }
  const stored = new Map(
    (
      await q<{ number: number; txid: string; msg_index: number }>(
        db,
        `SELECT number, txid, msg_index FROM counters WHERE number BETWEEN ?1 AND ?2`,
        low,
        high,
      )
    ).map((row) => [row.number, row]),
  );

  let first: number | null = null;
  for (const c of fresh) {
    const row = stored.get(c.number);
    if (!row) continue;
    if (row.txid !== c.txid || row.msg_index !== c.msg_index) {
      if (first === null || c.number < first) first = c.number;
    }
  }
  return first;
}

/**
 * Fetch counters the walk missed.
 *
 * Counters are numbered gap-free from zero, so "missing" is exactly the
 * numbers below the highest one we hold that are absent — no heuristic needed.
 * The whole set of stored numbers is read to compute it, which is cheap at this
 * scale (a few hundred rows, and it grows by a handful a day); if the index
 * ever reaches a size where that is not true, this becomes a range query.
 *
 * Bounded per tick so one bad day cannot turn a sync into a thousand
 * subrequests.
 */
const MAX_BACKFILL_PER_TICK = 50;

async function backfillGaps(db: D1Database, server: CountersServer): Promise<number> {
  const rows = await q<{ number: number }>(db, `SELECT number FROM counters ORDER BY number`);
  if (rows.length === 0) return 0;

  const highest = rows[rows.length - 1]!.number;
  if (rows.length === highest + 1) return 0; // contiguous 0..highest

  const have = new Set(rows.map((r) => r.number));
  const missing: number[] = [];
  for (let n = 0; n <= highest && missing.length < MAX_BACKFILL_PER_TICK; n += 1) {
    if (!have.has(n)) missing.push(n);
  }
  if (missing.length === 0) return 0;

  const fetched = (await Promise.all(missing.map((n) => server.counter(n)))).filter(
    (c): c is Counter => c !== null,
  );
  if (fetched.length > 0) await upsertCounters(db, fetched);
  return fetched.length;
}

/** Upsert counters. They are append-only and immutable once numbered, so an
 *  existing row is left alone except for the fields that can still change. */
async function upsertCounters(db: D1Database, fresh: Counter[]): Promise<void> {

  const now = Math.floor(Date.now() / 1000);
  const statements = fresh.map((c) =>
    db
      .prepare(
        `INSERT INTO counters (
           number, asset, asset_id, asset_longname, kind, content_type, content_type_raw,
           size, is_pointer_like, stamp_mime, envelope, owner, source, txid, msg_index,
           block, tx_index, sha256, rolling_hash, supply, divisible, locked, burned,
           fee, tx_size, xcp_burned, body, block_time, seen_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
                   ?21,?22,?23,?24,?25,?26,?27,?28,?29)
         ON CONFLICT(number) DO UPDATE SET
           body = COALESCE(excluded.body, counters.body),
           owner = excluded.owner,
           supply = excluded.supply,
           burned = excluded.burned,
           locked = excluded.locked`,
      )
      .bind(
        c.number,
        c.asset,
        c.asset_id ?? null,
        c.asset_longname ?? null,
        c.kind,
        c.content_type,
        c.content_type_raw ?? null,
        c.size,
        c.is_pointer_like ? 1 : 0,
        c.stamp_mime ?? null,
        c.envelope ?? null,
        c.owner ?? null,
        c.source ?? null,
        c.txid,
        c.msg_index,
        c.block,
        c.tx_index,
        c.sha256 ?? null,
        c.rolling_hash ?? null,
        raw(c.supply),
        bool(c.divisible),
        bool(c.locked),
        raw(c.burned),
        c.fee ?? null,
        c.tx_size ?? null,
        raw(c.xcp_burned),
        c.body ?? null,
        c.block_time ?? null,
        now,
      ),
  );

  await db.batch(statements);
}

/* -------------------------------------------------------------------- */
/* Pools                                                                */
/* -------------------------------------------------------------------- */

async function syncPools(
  db: D1Database,
  cp: Counterparty,
): Promise<{ pools: number; snapshots: number; matches: number }> {
  const all = await cp.pools();
  const xcpPools = all.filter(isXcpPool);

  // A token's divisibility decides what its raw reserve means. The counters
  // table already knows it for every counter; the verbose pool record says
  // it for everything else.
  const divisibility = new Map(
    (await q<{ asset: string; divisible: number | null }>(db, `SELECT asset, divisible FROM counters`)).map((r) => [
      r.asset,
      r.divisible === null ? true : r.divisible === 1,
    ]),
  );
  const tokenDivisible = (p: Pool): boolean => {
    const token = tokenSide(p);
    if (token && divisibility.has(token)) return divisibility.get(token)!;
    const info = p.asset_a === token ? p.asset_a_info : p.asset_b_info;
    return info?.divisible ?? true;
  };

  const now = Math.floor(Date.now() / 1000);
  const writes = xcpPools.map((p) => {
    const token = tokenSide(p);
    return db
      .prepare(
        `INSERT INTO pools (
           asset_a, asset_b, lp_asset, reserve_a, reserve_b, token_asset,
           source, tx_hash, tx_index, block_index, block_time, price, updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(asset_a, asset_b) DO UPDATE SET
           reserve_a = excluded.reserve_a,
           reserve_b = excluded.reserve_b,
           lp_asset = excluded.lp_asset,
           price = excluded.price,
           updated_at = excluded.updated_at`,
      )
      .bind(
        p.asset_a,
        p.asset_b,
        p.lp_asset,
        raw(p.reserve_a),
        raw(p.reserve_b),
        token,
        p.source ?? null,
        p.tx_hash,
        p.tx_index ?? null,
        p.block_index,
        p.block_time ?? null,
        poolPrice(p, tokenDivisible(p)),
        now,
      );
  });
  if (writes.length > 0) await db.batch(writes);

  // Only counters get history pulled. Every other pool on the chain is an
  // off-chain-description launch this site does not list, and paying a
  // subrequest per tick for each of them would make the job's cost scale with
  // somebody else's activity.
  const counterAssets = new Set(
    (
      await q<{ asset: string }>(
        db,
        `SELECT DISTINCT asset FROM counters WHERE is_pointer_like = 0`,
      )
    ).map((r) => r.asset),
  );

  let snapshots = 0;
  let matches = 0;
  for (const pool of xcpPools) {
    const token = tokenSide(pool);
    if (!token || !counterAssets.has(token)) continue;
    snapshots += await syncPriceHistory(db, cp, token, tokenDivisible(pool));
    matches += await syncMatches(db, cp, pool.asset_a, pool.asset_b, token);
  }

  await rollupPools(db);
  return { pools: xcpPools.length, snapshots, matches };
}

async function syncPriceHistory(db: D1Database, cp: Counterparty, token: string, divisible: boolean): Promise<number> {
  const latest = await one<{ b: number | null }>(
    db,
    `SELECT MAX(block_index) AS b FROM price_snapshots WHERE token_asset = ?1`,
    token,
  );
  const since = latest?.b ?? -1;

  const entries = (await cp.priceHistory(token)).filter((e) => e.block_index > since);
  if (entries.length === 0) return 0;

  await db.batch(
    entries.map((e) => {
      // History rows come in the pair's sorted order too; read the sides by name.
      const tokenIsA = tokenSideIsA(token);
      const tokenReserve = big(tokenIsA ? e.reserve_a : e.reserve_b);
      const xcpReserve = big(tokenIsA ? e.reserve_b : e.reserve_a);
      const price = priceFromReserves(tokenReserve, xcpReserve, divisible);
      return db
        .prepare(
          `INSERT INTO price_snapshots (token_asset, block_index, reserve_a, reserve_b, price, block_time)
           VALUES (?1,?2,?3,?4,?5,?6)
           ON CONFLICT(token_asset, block_index) DO NOTHING`,
        )
        .bind(token, e.block_index, raw(e.reserve_a), raw(e.reserve_b), price, e.block_time ?? null);
    }),
  );
  return entries.length;
}

async function syncMatches(
  db: D1Database,
  cp: Counterparty,
  assetA: string,
  assetB: string,
  token: string,
): Promise<number> {
  const rows = await cp.poolMatches(token);
  if (rows.length === 0) return 0;

  await db.batch(
    rows.map((m, i) => {
      // The API's match rows carry either a single tx_hash or the tx0/tx1
      // pair; either way the hash plus its position is stable and unique.
      const id = `${m.id ?? m.tx_hash ?? `${m.tx0_hash}_${m.tx1_hash}`}:${i}`;
      return db
        .prepare(
          `INSERT INTO pool_matches (
             id, asset_a, asset_b, token_asset, block_index, block_time,
             tx_hash, source, give_asset, give_qty, get_asset, get_qty
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          id,
          assetA,
          assetB,
          token,
          m.block_index,
          m.block_time ?? null,
          m.tx_hash ?? m.tx1_hash ?? null,
          m.source ?? null,
          m.give_asset ?? null,
          raw(m.give_quantity),
          m.get_asset ?? null,
          raw(m.get_quantity),
        );
    }),
  );
  return rows.length;
}

/**
 * 24h volume in XCP and the price 24 hours back, from the snapshot series.
 * Blocks stand in for time at 144 a day — near enough for a change badge,
 * and it costs no extra upstream calls.
 */
const BLOCKS_PER_DAY = 144;

async function rollupPools(db: D1Database): Promise<void> {
  const tipRow = await one<{ v: string }>(db, `SELECT value AS v FROM chain_state WHERE key = 'tip'`);
  const tip = Number(tipRow?.v ?? 0);
  if (!tip) return;
  const since = tip - BLOCKS_PER_DAY;

  await db
    .prepare(
      `UPDATE pools SET
         volume_24h = (
           SELECT CAST(COALESCE(SUM(
             CASE WHEN m.give_asset = 'XCP' THEN CAST(m.give_qty AS INTEGER)
                  WHEN m.get_asset  = 'XCP' THEN CAST(m.get_qty  AS INTEGER)
                  ELSE 0 END), 0) AS TEXT)
           FROM pool_matches m
           WHERE m.token_asset = pools.token_asset AND m.block_index >= ?1
         ),
         price_24h_ago = (
           SELECT s.price FROM price_snapshots s
           WHERE s.token_asset = pools.token_asset AND s.block_index <= ?1
           ORDER BY s.block_index DESC LIMIT 1
         )
       WHERE token_asset IS NOT NULL`,
    )
    .bind(since)
    .run();
}

/* -------------------------------------------------------------------- */
/* Listings                                                             */
/* -------------------------------------------------------------------- */

/**
 * How many counter assets one tick asks Counterparty about when nothing is
 * known to have changed — the background pass.
 *
 * The cost is two subrequests per asset. Forty a tick is 80, and the 417
 * on-chain counter assets come round in eleven ticks, a little under an hour.
 * That is acceptable only because it is not what keeps the venues current:
 * `followListingEvents` does that, block by block, and this pass exists to
 * correct whatever that missed.
 */
const LISTING_SWEEP_BATCH = 40;

/**
 * The ceiling when more than a batch is known to be stale — assets a block
 * just touched, or counters never asked about. One block opened orders on
 * 268 RARE.PEPE.N at once; at forty a tick the last of them would surface
 * half an hour after it was on chain.
 */
const LISTING_SWEEP_MAX = 150;

/** How many assets are asked about at once. Ordinary politeness to the node. */
const LISTING_CONCURRENCY = 6;

/**
 * How far back the event follower will read. A sync that has been down for
 * longer than this does not replay the gap — the background pass re-reads
 * every asset within the hour anyway, and a day of blocks is a day of
 * subrequests.
 */
const LISTING_EVENT_BLOCKS = 12;

/**
 * Mark the assets whose offers changed since the last tick, so the sweep
 * reads them first.
 *
 * Nothing on Counterparty changes between blocks, so a block is the unit:
 * each one since the last tick is asked for its order and dispenser events,
 * and any counter one of them names is due again. "Names" is deliberately
 * loose. An OPEN_ORDER carries `give_asset` and `get_asset`, a
 * DISPENSER_UPDATE carries `asset`, and a CANCEL_ORDER or ORDER_EXPIRATION
 * carries only the hash of the order it ends — so every string in an event's
 * params is checked against the counters' ledger names and against the
 * hashes of the listings already stored, rather than each event type being
 * taken apart by field.
 *
 * Marking is deleting the asset's `listing_sweeps` row: the sweep orders by
 * that timestamp with a missing one first, so there is one queue and no
 * second notion of priority to keep in step with it.
 */
async function followListingEvents(db: D1Database, cp: Counterparty, tip: number): Promise<void> {
  const last = await one<{ value: string }>(
    db,
    `SELECT value FROM chain_state WHERE key = 'listings_block'`,
  );
  if (!last) {
    // First run: there is no "since". Every asset is unswept and the sweep
    // will reach all of them; following starts from here.
    await setState(db, "listings_block", String(tip));
    return;
  }

  const from = Math.max(Number(last.value) + 1, tip - LISTING_EVENT_BLOCKS + 1);
  if (from > tip) return;

  const [assets, stored] = await Promise.all([
    q<{ asset: string; asset_id: string }>(
      db,
      `SELECT asset, MAX(asset_id) AS asset_id FROM counters
        WHERE is_pointer_like = 0 AND size > 0 GROUP BY asset`,
    ),
    q<{ id: string; token_asset: string }>(db, `SELECT id, token_asset FROM listings`),
  ]);
  // Ledger name or offer hash → the counters it concerns. An order between
  // two counters is two listings under one hash, hence the list.
  const concerns = new Map<string, string[]>();
  const note = (key: string, asset: string) => {
    const list = concerns.get(key);
    if (list) list.push(asset);
    else concerns.set(key, [asset]);
  };
  for (const row of assets) note(ledgerAssetName(row), row.asset);
  for (const row of stored) note(row.id, row.token_asset);

  const touched = new Set<string>();
  let reached = from - 1;
  for (let block = from; block <= tip; block += 1) {
    let events;
    try {
      events = await cp.blockMarketEvents(block);
    } catch {
      // Stop rather than skip: the next tick resumes at this block, and a
      // block passed over is an offer that stays wrong until the background
      // pass comes round.
      break;
    }
    for (const event of events) {
      for (const value of Object.values(event.params ?? {})) {
        if (typeof value !== "string") continue;
        for (const asset of concerns.get(value) ?? []) touched.add(asset);
      }
    }
    reached = block;
  }

  const due = [...touched];
  const writes: D1PreparedStatement[] = [];
  // Fifty names a statement: D1 allows a hundred bound parameters.
  for (let i = 0; i < due.length; i += 50) {
    const slice = due.slice(i, i + 50);
    writes.push(
      db
        .prepare(
          `DELETE FROM listing_sweeps WHERE asset IN (${slice.map((_, n) => `?${n + 1}`).join(",")})`,
        )
        .bind(...slice),
    );
  }
  if (writes.length > 0) await db.batch(writes);
  if (reached >= from) await setState(db, "listings_block", String(reached));
}

/**
 * Refresh open orders and dispensers for the counter assets that are due:
 * the ones a block just touched, then the stalest.
 *
 * The whole open set for an asset is re-read and replaces what was stored,
 * rather than the events being applied one by one: rows that vanished
 * upstream vanish here, which is the only way a filled order stops being
 * displayed as an offer, and it means an event this job misread costs a
 * late refresh instead of a wrong row that never heals.
 *
 * LP tokens are swept too rather than excluded. One of them is a counter
 * (#163 is MEMENOME's own LP token) and an open offer on it is a real offer;
 * the listing query is what decides they do not belong in a tokens listing.
 */
async function syncListings(
  db: D1Database,
  cp: Counterparty,
  tip: number,
): Promise<{ listings: number; swept: number }> {
  await followListingEvents(db, cp, tip);

  // Everything with no sweep on record is known to be stale — touched by a
  // block, or a counter that arrived this tick — and is read now, up to the
  // ceiling. Past that the batch is the background pass.
  const unswept = await one<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT c.asset) AS n
       FROM counters c
       LEFT JOIN listing_sweeps s ON s.asset = c.asset
      WHERE c.is_pointer_like = 0 AND c.size > 0 AND s.asset IS NULL`,
  );
  const batch = Math.min(LISTING_SWEEP_MAX, Math.max(LISTING_SWEEP_BATCH, unswept?.n ?? 0));

  // NULLs first: an asset with no sweep on record is asked about before one
  // that was current a few minutes ago.
  const due = await q<{ asset: string; asset_id: string; divisible: number | null }>(
    db,
    `SELECT c.asset, MAX(c.asset_id) AS asset_id, MAX(c.divisible) AS divisible
       FROM counters c
       LEFT JOIN listing_sweeps s ON s.asset = c.asset
      WHERE c.is_pointer_like = 0 AND c.size > 0
      GROUP BY c.asset
      ORDER BY COALESCE(s.checked_at, 0) ASC, c.asset ASC
      LIMIT ?1`,
    batch,
  );
  if (due.length === 0) return { listings: 0, swept: 0 };

  const now = Math.floor(Date.now() / 1000);
  const writes: D1PreparedStatement[] = [];
  let count = 0;

  for (let i = 0; i < due.length; i += LISTING_CONCURRENCY) {
    const slice = due.slice(i, i + LISTING_CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (row) => {
        const divisible = row.divisible === null ? true : row.divisible === 1;
        // Core is asked by the ledger's name and answers in it; the rows are
        // stored under the counter's own, which is what every join against
        // `counters` uses. For anything but a subasset the two are the same.
        const ledgerName = ledgerAssetName(row);
        // A node that answers one route and not the other must not wipe the
        // half it did answer, so a failure on either side skips the asset
        // entirely and leaves its timestamp alone for the next tick.
        try {
          const [orders, dispensers] = await Promise.all([
            cp.assetOrders(ledgerName),
            cp.assetDispensers(ledgerName),
          ]);
          const listings = [
            ...orders.map((o) => listingFromOrder(o, ledgerName, divisible)),
            ...dispensers.map((d) => listingFromDispenser(d, divisible)),
          ]
            .filter((l): l is Listing => l !== null)
            .map((l) => ({ ...l, token_asset: row.asset }));
          return { asset: row.asset, listings };
        } catch {
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      // Replace rather than merge: what upstream no longer reports as open is
      // no longer an offer, and a stale ask is worse than none.
      writes.push(
        db.prepare(`DELETE FROM listings WHERE token_asset = ?1`).bind(result.asset),
      );
      for (const listing of result.listings) {
        count += 1;
        writes.push(
          db
            .prepare(
              `INSERT INTO listings (
                 id, kind, token_asset, side, price, price_asset,
                 remaining, source, block_index, updated_at
               ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
               ON CONFLICT(id, token_asset) DO UPDATE SET
                 price = excluded.price,
                 price_asset = excluded.price_asset,
                 remaining = excluded.remaining,
                 side = excluded.side,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              listing.id,
              listing.kind,
              listing.token_asset,
              listing.side,
              listing.price,
              listing.price_asset,
              raw(listing.remaining),
              listing.source,
              listing.block_index,
              now,
            ),
        );
      }
      writes.push(
        db
          .prepare(
            `INSERT INTO listing_sweeps (asset, checked_at) VALUES (?1, ?2)
             ON CONFLICT(asset) DO UPDATE SET checked_at = excluded.checked_at`,
          )
          .bind(result.asset, now),
      );
    }
  }

  if (writes.length > 0) await db.batch(writes);
  return { listings: count, swept: due.length };
}

/* -------------------------------------------------------------------- */
/* Fairminters                                                          */
/* -------------------------------------------------------------------- */

/**
 * Pool fairminters only — a launch with no `pool_quantity` never opens a pool
 * and has no place on this site. `counter_number` is resolved by asset, and
 * stays NULL until the counters server numbers the deploy (up to one tick
 * behind, or forever if the description was a pointer).
 */
async function syncFairminters(db: D1Database, cp: Counterparty): Promise<number> {
  const [open, pending, closed] = await Promise.all([
    cp.fairminters("open"),
    cp.fairminters("pending"),
    cp.fairminters("closed"),
  ]);
  const live = [...open, ...pending].filter(seedsPool);

  // Launchpad tagging covers closed launches too: a pooled counter's
  // fairminter resolved long ago, and the tag is about where it came from,
  // not whether it is still minting.
  await tagLaunchpads(db, [...live, ...closed.filter(seedsPool)]);

  const now = Math.floor(Date.now() / 1000);
  if (live.length > 0) {
    await db.batch(live.map((fm) => upsertFairminter(db, fm, now)));
  }

  // Anything we tracked that is no longer open or pending has resolved. Its
  // pool (or its refund) is now the truth, so drop the in-flight row rather
  // than leaving a stale countdown on the home page.
  const liveHashes = live.map((fm) => fm.tx_hash);
  if (liveHashes.length > 0) {
    const placeholders = liveHashes.map((_, i) => `?${i + 1}`).join(",");
    await db
      .prepare(`DELETE FROM fairminters WHERE tx_hash NOT IN (${placeholders})`)
      .bind(...liveHashes)
      .run();
  } else {
    await db.prepare(`DELETE FROM fairminters`).run();
  }

  await db
    .prepare(
      `UPDATE fairminters SET counter_number = (
         SELECT MIN(c.number) FROM counters c
         WHERE c.asset = fairminters.asset AND c.is_pointer_like = 0
       )`,
    )
    .run();

  return live.length;
}

/**
 * Stamp `counters.launchpad` from the fairminter that deployed each asset.
 * Runs every tick and matches by asset, so a counter that is numbered after
 * its fairminter was first seen is tagged on the next pass. Only positive
 * results are written; a NULL is never overwritten with a NULL.
 */
async function tagLaunchpads(db: D1Database, fairminters: Fairminter[]): Promise<void> {
  const tagged = new Map<string, string>();
  for (const fm of fairminters) {
    const launchpad = launchpadOfFairminter(fm);
    if (launchpad) tagged.set(fm.asset, launchpad);
  }
  if (tagged.size === 0) return;
  await db.batch(
    [...tagged].map(([asset, launchpad]) =>
      db
        .prepare(`UPDATE counters SET launchpad = ?2 WHERE asset = ?1 AND launchpad IS NOT ?2`)
        .bind(asset, launchpad),
    ),
  );
}

function upsertFairminter(db: D1Database, fm: Fairminter, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO fairminters (
         tx_hash, asset, asset_longname, source, status, description, mime_type,
         block_index, start_block, soft_cap_deadline_block, hard_cap, soft_cap,
         pool_quantity, lp_asset, price, quantity_by_price, max_mint_per_address,
         premint_quantity, earned_quantity, paid_quantity, divisible, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
       ON CONFLICT(tx_hash) DO UPDATE SET
         status = excluded.status,
         earned_quantity = excluded.earned_quantity,
         paid_quantity = excluded.paid_quantity,
         soft_cap_deadline_block = excluded.soft_cap_deadline_block,
         updated_at = excluded.updated_at`,
    )
    .bind(
      fm.tx_hash,
      fm.asset,
      fm.asset_longname ?? null,
      fm.source ?? null,
      fm.status,
      fm.description ?? null,
      fm.mime_type ?? null,
      fm.block_index ?? null,
      fm.start_block ?? null,
      fm.soft_cap_deadline_block ?? null,
      raw(fm.hard_cap),
      raw(fm.soft_cap),
      raw(fm.pool_quantity),
      fm.lp_asset ?? null,
      raw(fm.price),
      raw(fm.quantity_by_price),
      raw(fm.max_mint_per_address),
      raw(fm.premint_quantity),
      raw(fm.earned_quantity),
      raw(fm.paid_quantity),
      bool(fm.divisible),
      now,
    );
}

/** Core sorts the pair; the token is `asset_a` only when it sorts before "XCP". */
function tokenSideIsA(token: string): boolean {
  return token < "XCP";
}

/* -------------------------------------------------------------------- */

async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chain_state (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}
