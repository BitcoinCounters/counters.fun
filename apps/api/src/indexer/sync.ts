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
import type { Fairminter } from "@counters/core/fairminter";
import { seedsPool } from "@counters/core/fairminter";
import { isXcpPool, poolPrice, tokenSide } from "@counters/core/pool";
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
    tip: tip.counterparty_height,
  };

  const { pools, snapshots, matches } = await syncPools(env.DB, cp);
  written.pools = pools;
  written.snapshots = snapshots;
  written.matches = matches;
  written.fairminters = await syncFairminters(env.DB, cp);

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
  const fresh: Counter[] = [];
  let hitPageCap = false;

  for await (const batch of server.walk(100, cold ? 200 : WARM_PAGES)) {
    const wanted = cold ? batch : batch.filter((c) => c.number > known);
    fresh.push(...wanted);
    // Warm path: the first page that reaches numbers we already hold means
    // everything below it is already stored.
    if (!cold && wanted.length < batch.length) {
      hitPageCap = false;
      break;
    }
    hitPageCap = !cold && fresh.length >= WARM_PAGES * 100;
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

  if (fresh.length > 0) await upsertCounters(db, fresh);

  const filled = await backfillGaps(db, server);

  // A count mismatch means the index is still short. Recorded rather than
  // thrown: a partial index is serviceable, and the next tick continues.
  const stored = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM counters`);
  await setState(
    db,
    "counters_incomplete",
    String(Math.max(0, upstreamCount - (stored?.n ?? 0))),
  );

  return fresh.length + filled;
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
        poolPrice(p),
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
    snapshots += await syncPriceHistory(db, cp, token);
    matches += await syncMatches(db, cp, pool.asset_a, pool.asset_b, token);
  }

  await rollupPools(db);
  return { pools: xcpPools.length, snapshots, matches };
}

async function syncPriceHistory(db: D1Database, cp: Counterparty, token: string): Promise<number> {
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
      const a = big(e.reserve_a);
      const b = big(e.reserve_b);
      const price = a > 0n ? Number((b * 1_000_000_000_000n) / a) / 1e12 : null;
      return db
        .prepare(
          `INSERT INTO price_snapshots (token_asset, block_index, reserve_a, reserve_b, price, block_time)
           VALUES (?1,?2,?3,?4,?5,?6)
           ON CONFLICT(token_asset, block_index) DO NOTHING`,
        )
        .bind(token, e.block_index, raw(e.reserve_a), raw(e.reserve_b), e.price ?? price, e.block_time ?? null);
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
/* Fairminters                                                          */
/* -------------------------------------------------------------------- */

/**
 * Pool fairminters only — a launch with no `pool_quantity` never opens a pool
 * and has no place on this site. `counter_number` is resolved by asset, and
 * stays NULL until the counters server numbers the deploy (up to one tick
 * behind, or forever if the description was a pointer).
 */
async function syncFairminters(db: D1Database, cp: Counterparty): Promise<number> {
  const [open, pending] = await Promise.all([cp.fairminters("open"), cp.fairminters("pending")]);
  const live = [...open, ...pending].filter(seedsPool);

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
