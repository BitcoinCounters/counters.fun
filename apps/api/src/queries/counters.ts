/**
 * Every read of the counters table goes through here, and every statement in
 * here carries `is_pointer_like = 0`.
 *
 * That is deliberate structure rather than convention. A pointer-like counter
 * is one whose description is a URL: rendering it means fetching bytes from
 * whatever server that URL names, which is exactly the thing counters.fun
 * exists not to do. There is no route parameter that relaxes this and no
 * query builder that can forget it — the predicate is baked into the SQL, and
 * `tests/on-chain-rule.test.ts` asserts it holds across the whole live index.
 */

import { q, one } from "#api/db";
const query = q;

/** The predicate, named once so a new query cannot spell it differently. */
const ON_CHAIN = `c.is_pointer_like = 0 AND c.size > 0`;

/**
 * LP tokens are not counters worth listing, even when they are counters.
 *
 * Nothing stops the owner of a pool's LP asset from inscribing a file on it —
 * someone already has: counter #163 is `A18189972090142917414`, MEMENOME's own
 * LP token carrying 30 bytes of text. It is a perfectly valid counter and it
 * has no business in a listing of tokens, because it *is* the accounting unit
 * for another token's pool. Left in, it appears in "unpooled" as something to
 * create liquidity for, which is nonsense.
 */
const NOT_AN_LP_TOKEN = `NOT EXISTS (SELECT 1 FROM pools lp WHERE lp.lp_asset = c.asset)`;

/** One row per asset: a reinscribed asset has several counters, and the
 *  original (lowest number) is the one that represents it. */
const ORIGINAL_ONLY = `c.number = (SELECT MIN(c2.number) FROM counters c2
                                    WHERE c2.asset = c.asset AND c2.is_pointer_like = 0)`;

export interface CounterRow {
  number: number;
  asset: string;
  asset_longname: string | null;
  kind: string;
  content_type: string;
  size: number;
  is_pointer_like: number;
  owner: string | null;
  txid: string;
  block: number;
  tx_index: number;
  sha256: string | null;
  rolling_hash: string | null;
  supply: string | null;
  divisible: number | null;
  locked: number | null;
  burned: string | null;
  fee: number | null;
  tx_size: number | null;
  body: string | null;
  block_time: number | null;
  /** 'xcp.fun' when the deploy came through that launchpad; see @counters/core/launchpad. */
  launchpad: string | null;
}

export interface PooledCounterRow extends CounterRow {
  asset_a: string;
  asset_b: string;
  lp_asset: string;
  reserve_a: string;
  reserve_b: string;
  price: number | null;
  price_24h_ago: number | null;
  volume_24h: string | null;
  pool_block_index: number;
}

export interface MintingCounterRow extends CounterRow {
  fm_tx_hash: string;
  status: string;
  start_block: number | null;
  soft_cap_deadline_block: number | null;
  soft_cap: string | null;
  hard_cap: string | null;
  pool_quantity: string | null;
  lp_asset: string | null;
  price_per_lot: string | null;
  quantity_by_price: string | null;
  earned_quantity: string | null;
}

const COUNTER_COLUMNS = `
  c.number, c.asset, c.asset_longname, c.kind, c.content_type, c.size,
  c.is_pointer_like, c.owner, c.txid, c.block, c.tx_index, c.sha256,
  c.rolling_hash, c.supply, c.divisible, c.locked, c.burned, c.fee,
  c.tx_size, c.body, c.block_time, c.launchpad`;

export type PooledSort = "depth" | "volume" | "change" | "number" | "newest";

const POOLED_ORDER: Record<PooledSort, string> = {
  // Depth is the XCP side: reserve_b when XCP is asset_b, reserve_a when it
  // leads. CAST is safe here — pool reserves are well inside 2^63.
  depth: `CASE WHEN p.asset_b = 'XCP' THEN CAST(p.reserve_b AS INTEGER)
               ELSE CAST(p.reserve_a AS INTEGER) END DESC`,
  volume: `CAST(COALESCE(p.volume_24h, '0') AS INTEGER) DESC`,
  change: `CASE WHEN p.price_24h_ago IS NULL OR p.price_24h_ago = 0 THEN -1e18
                ELSE (p.price - p.price_24h_ago) / p.price_24h_ago END DESC`,
  number: `c.number ASC`,
  newest: `p.block_index DESC`,
};

/** Counters with a live XCP pool — the headline listing. */
export function pooledCounters(
  db: D1Database,
  sort: PooledSort = "depth",
  limit = 100,
): Promise<PooledCounterRow[]> {
  return q<PooledCounterRow>(
    db,
    `SELECT ${COUNTER_COLUMNS},
            p.asset_a, p.asset_b, p.lp_asset, p.reserve_a, p.reserve_b,
            p.price, p.price_24h_ago, p.volume_24h, p.block_index AS pool_block_index
       FROM counters c
       JOIN pools p ON p.token_asset = c.asset
      WHERE ${ON_CHAIN}
        AND ${ORIGINAL_ONLY}
      ORDER BY ${POOLED_ORDER[sort]}
      LIMIT ?1`,
    limit,
  );
}

/**
 * On-chain counters with no pool yet. With one pooled counter against
 * seventy on-chain ones, this is the section that carries the site today —
 * each row is a Create LP away from the listing above.
 */
export function unpooledCounters(db: D1Database, limit = 100, before?: number): Promise<CounterRow[]> {
  const cursor = before ?? Number.MAX_SAFE_INTEGER;
  return q<CounterRow>(
    db,
    `SELECT ${COUNTER_COLUMNS}
       FROM counters c
      WHERE ${ON_CHAIN}
        AND ${NOT_AN_LP_TOKEN}
        AND ${ORIGINAL_ONLY}
        AND c.number < ?1
        AND NOT EXISTS (SELECT 1 FROM pools p WHERE p.token_asset = c.asset)
      ORDER BY c.number DESC
      LIMIT ?2`,
    cursor,
    limit,
  );
}

/** In-flight launches whose deploy is itself a counter and which seed a pool. */
export function mintingCounters(db: D1Database, limit = 50): Promise<MintingCounterRow[]> {
  return q<MintingCounterRow>(
    db,
    `SELECT ${COUNTER_COLUMNS},
            f.tx_hash AS fm_tx_hash, f.status, f.start_block, f.soft_cap_deadline_block,
            f.soft_cap, f.hard_cap, f.pool_quantity, f.lp_asset,
            f.price AS price_per_lot, f.quantity_by_price, f.earned_quantity
       FROM fairminters f
       JOIN counters c ON c.number = f.counter_number
      WHERE ${ON_CHAIN}
        AND f.status IN ('open', 'pending')
      ORDER BY CASE f.status WHEN 'open' THEN 0 ELSE 1 END,
               f.start_block ASC
      LIMIT ?1`,
    limit,
  );
}

/** One counter by number. Null for unknown *and* for pointer-like. */
export function counterByNumber(db: D1Database, number: number): Promise<CounterRow | null> {
  return one<CounterRow>(
    db,
    `SELECT ${COUNTER_COLUMNS} FROM counters c WHERE c.number = ?1 AND ${ON_CHAIN}`,
    number,
  );
}

/** One counter by asset — the original (lowest-numbered) inscription on it. */
export function counterByAsset(db: D1Database, asset: string): Promise<CounterRow | null> {
  return one<CounterRow>(
    db,
    `SELECT ${COUNTER_COLUMNS} FROM counters c
      WHERE c.asset = ?1 AND ${ON_CHAIN}
      ORDER BY c.number ASC LIMIT 1`,
    asset,
  );
}

/**
 * Whether a number exists at all, and why it is not displayable. Lets a deep
 * link render an honest refusal — "off-chain pointer, nothing to display" —
 * instead of a 404 that implies the counter is not real.
 */
export function counterVisibility(
  db: D1Database,
  number: number,
): Promise<{ number: number; asset: string; is_pointer_like: number; size: number; body: string | null } | null> {
  return one(
    db,
    `SELECT number, asset, is_pointer_like, size, body FROM counters WHERE number = ?1`,
    number,
  );
}

/** Every inscription on one asset — the reinscription chain. */
export function counterSiblings(db: D1Database, asset: string): Promise<CounterRow[]> {
  return q<CounterRow>(
    db,
    `SELECT ${COUNTER_COLUMNS} FROM counters c
      WHERE c.asset = ?1 AND ${ON_CHAIN}
      ORDER BY c.number ASC`,
    asset,
  );
}

/** Leaderboard by inscription weight — bytes committed to Bitcoin. */
export function heaviestCounters(db: D1Database, limit = 50): Promise<CounterRow[]> {
  return q<CounterRow>(
    db,
    `SELECT ${COUNTER_COLUMNS} FROM counters c
      WHERE ${ON_CHAIN} AND ${NOT_AN_LP_TOKEN} AND ${ORIGINAL_ONLY}
      ORDER BY c.size DESC
      LIMIT ?1`,
    limit,
  );
}

export interface Stats {
  counters_total: number;
  counters_on_chain: number;
  pooled: number;
  minting: number;
  bytes_on_chain: number;
  tip: number;
  counters_indexed: number;
  synced_at: number;
}

export async function stats(db: D1Database): Promise<Stats> {
  const [totals, pooled, minting, state] = await Promise.all([
    one<{ total: number; on_chain: number; bytes: number }>(
      db,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN is_pointer_like = 0 AND size > 0 THEN 1 ELSE 0 END) AS on_chain,
              SUM(CASE WHEN is_pointer_like = 0 THEN size ELSE 0 END) AS bytes
         FROM counters`,
    ),
    one<{ n: number }>(
      db,
      `SELECT COUNT(DISTINCT c.asset) AS n FROM counters c
        JOIN pools p ON p.token_asset = c.asset
       WHERE ${ON_CHAIN}`,
    ),
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM fairminters WHERE status IN ('open','pending') AND counter_number IS NOT NULL`,
    ),
    q<{ key: string; value: string }>(db, `SELECT key, value FROM chain_state`),
  ]);

  const kv = new Map(state.map((r) => [r.key, r.value]));
  return {
    counters_total: totals?.total ?? 0,
    counters_on_chain: totals?.on_chain ?? 0,
    pooled: pooled?.n ?? 0,
    minting: minting?.n ?? 0,
    bytes_on_chain: totals?.bytes ?? 0,
    tip: Number(kv.get("tip") ?? 0),
    counters_indexed: Number(kv.get("counters_indexed") ?? 0),
    synced_at: Number(kv.get("synced_at") ?? 0),
  };
}

/**
 * Counters whose asset name contains `q`, or the counter with that number.
 * On-chain only, originals only, LP tokens excluded — the same rules as the
 * listings, because a search result is a listing of one.
 */
export function searchCounters(db: D1Database, q: string, limit = 8): Promise<CounterRow[]> {
  const needle = `%${q.replace(/[%_]/g, "")}%`;
  const asNumber = /^\d+$/.test(q) ? Number(q) : -1;
  return query<CounterRow>(
    db,
    `SELECT ${COUNTER_COLUMNS} FROM counters c
      WHERE ${ON_CHAIN}
        AND ${NOT_AN_LP_TOKEN}
        AND ${ORIGINAL_ONLY}
        AND (c.asset LIKE ?1 OR c.asset_longname LIKE ?1 OR c.number = ?2)
      ORDER BY CASE WHEN c.number = ?2 THEN 0 WHEN c.asset LIKE ?3 THEN 1 ELSE 2 END, c.number DESC
      LIMIT ?4`,
    needle,
    asNumber,
    `${q.replace(/[%_]/g, "")}%`,
    limit,
  );
}
