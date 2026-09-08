/**
 * Client for this site's own API worker — the counters × pools join.
 *
 * Everything transactional — balances, quotes, composes — goes to Counterparty
 * through the same-origin proxy at `app/api/cp`. This file only reads the
 * index.
 */

import { COUNTERS_API_BASE } from "@/lib/constants";

export interface CounterRow {
  number: number;
  asset: string;
  asset_longname: string | null;
  kind: "issuance" | "fairminter";
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
  /** "xcp.fun" when the deploy came through that launchpad. */
  launchpad: string | null;
}

export interface PooledCounter extends CounterRow {
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

export interface MintingCounter extends CounterRow {
  fm_tx_hash: string;
  status: "open" | "pending";
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

export interface PoolDetail {
  asset_a: string;
  asset_b: string;
  lp_asset: string;
  reserve_a: string;
  reserve_b: string;
  price: number | null;
  price_24h_ago: number | null;
  volume_24h: string | null;
  block_index: number;
  lp_supply: string;
  lp_locked: string;
  /** True when every LP token sits at the unspendable address. */
  fully_locked: boolean;
}

/**
 * A counter the site will not render. Not an error — the counter is real and
 * numbered; its bytes just are not on Bitcoin. `description` is the raw text
 * of the pointer, shown as text and never followed.
 */
export interface UndisplayableCounter {
  number: number;
  asset: string;
  displayable: false;
  reason: "pointer" | "empty";
  description: string | null;
}

export interface CounterDetail extends CounterRow {
  displayable: true;
  pool: Omit<PoolDetail, "lp_supply" | "lp_locked" | "fully_locked"> | null;
  siblings: CounterRow[];
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

export interface HomeData {
  pooled: PooledCounter[];
  minting: MintingCounter[];
  unpooled: CounterRow[];
}

async function read<T>(path: string, revalidate = 30): Promise<T> {
  const res = await fetch(`${COUNTERS_API_BASE}${path}`, { next: { revalidate } });
  if (!res.ok) throw new Error(`counters api ${path} → ${res.status}`);
  const body = (await res.json()) as { result: T };
  return body.result;
}

/**
 * Read, or fall back.
 *
 * The home page prerenders, so a build that runs while the API is momentarily
 * unreachable would otherwise fail outright — and a deploy blocked by a
 * transient upstream blip is a worse failure than a page that renders empty
 * and fills in on the next revalidation, thirty seconds later. Routes that
 * genuinely have nothing to show without their data (a counter's detail page)
 * still throw, because an empty one would be a lie.
 */
async function readOr<T>(path: string, fallback: T, revalidate = 30): Promise<T> {
  try {
    return await read<T>(path, revalidate);
  } catch (cause) {
    console.warn(`[counters] ${path} unavailable, rendering empty:`, (cause as Error).message);
    return fallback;
  }
}

const NO_COUNTERS: HomeData = { pooled: [], minting: [], unpooled: [] };

const NO_STATS: Stats = {
  counters_total: 0,
  counters_on_chain: 0,
  pooled: 0,
  minting: 0,
  bytes_on_chain: 0,
  tip: 0,
  counters_indexed: 0,
  synced_at: 0,
};

export const getHome = (sort = "depth") =>
  readOr<HomeData>(`/counters?sort=${encodeURIComponent(sort)}`, NO_COUNTERS);

export const getStats = () => readOr<Stats>("/stats", NO_STATS);

export const getCounter = (id: string) =>
  read<CounterDetail | UndisplayableCounter>(`/counters/${encodeURIComponent(id)}`);

export const getPool = (id: string) =>
  read<PoolDetail | null>(`/counters/${encodeURIComponent(id)}/pool`);

export const getHistory = (id: string) =>
  read<{ block_index: number; block_time: number | null; reserve_a: string; reserve_b: string; price: number | null }[]>(
    `/counters/${encodeURIComponent(id)}/history`,
    60,
  );

export const getActivity = (limit = 50) =>
  readOr<
    {
      id: string;
      token_asset: string;
      counter_number: number;
      content_type: string;
      block_index: number;
      block_time: number | null;
      tx_hash: string | null;
      give_asset: string | null;
      give_qty: string | null;
      get_asset: string | null;
      get_qty: string | null;
    }[]
  >(`/activity?limit=${limit}`, []);

export const isDisplayable = (
  c: CounterDetail | UndisplayableCounter,
): c is CounterDetail => c.displayable === true;
