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
  /** Non-null when the description is a `STAMP:<base64>` payload the indexer
   *  decoded to an image — see the `stamp` mode in @counters/core/counter. */
  stamp_mime: string | null;
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
  /**
   * Set when this counter renders another counter's file instead of its own
   * body — RARE.PEPE.5 is 1 KB of JSON naming #219's SVG and `edition-5`.
   * The fields are the *target's*; `fragment` goes on the URL of its file.
   * Absent on payloads from before the API carried it.
   */
  delegate?: Delegate | null;
}

export interface Delegate {
  number: number;
  content_type: string;
  size: number;
  fragment: string | null;
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

/**
 * One open offer — a DEX order or a dispenser — with the counter it is on.
 * `offer_asset` is the unit the price is in: XCP for most orders, BTC for
 * every dispenser, and whatever a maker chose otherwise. Nothing converts
 * between them.
 */
export interface Offer extends CounterRow {
  /** The order's or dispenser's own tx hash. */
  offer_id: string;
  offer_kind: "order" | "dispenser";
  /** `ask` when the counter is being sold, `bid` when it is wanted. */
  offer_side: "ask" | "bid";
  offer_price: number;
  offer_asset: string;
  offer_remaining: string | null;
  offer_source: string | null;
  offer_block: number;
  /** 1 when the counter also has a pool — it appears under both venues. */
  has_pool: number;
}

/** One open offer on a counter, as the detail route returns it. */
export interface Listing {
  id: string;
  kind: "order" | "dispenser";
  token_asset: string;
  side: "ask" | "bid";
  price: number;
  price_asset: string;
  remaining: string | null;
  source: string | null;
  block_index: number;
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
  /** Open orders and dispensers on this counter, asks first. */
  listings: Listing[];
  siblings: CounterRow[];
}

export interface Stats {
  counters_total: number;
  counters_on_chain: number;
  pooled: number;
  listed: number;
  minting: number;
  bytes_on_chain: number;
  tip: number;
  counters_indexed: number;
  synced_at: number;
}

export interface HomeData {
  pooled: PooledCounter[];
  /** One page of open DEX orders, newest first. */
  dex: Offer[];
  /** One page of open dispensers, newest first. */
  dispensers: Offer[];
  minting: MintingCounter[];
  /** How much is on each venue in all — the lists above are pages of it. */
  counts: { pool: number; dex: number; dispenser: number };
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

const NO_COUNTERS: HomeData = {
  pooled: [],
  dex: [],
  dispensers: [],
  minting: [],
  counts: { pool: 0, dex: 0, dispenser: 0 },
};

const NO_STATS: Stats = {
  counters_total: 0,
  counters_on_chain: 0,
  pooled: 0,
  listed: 0,
  minting: 0,
  bytes_on_chain: 0,
  tip: 0,
  counters_indexed: 0,
  synced_at: 0,
};

/** Offers per page on the DEX and dispenser venues. */
export const OFFERS_PAGE = 50;

/**
 * Spread over the empty shape, so a list the payload does not have reads as
 * empty rather than undefined. The API and this app deploy separately and the
 * fetch cache outlives a deploy: for thirty seconds after `dex` and
 * `dispensers` were added, the page was handed a payload from before they
 * existed and threw on `.length`.
 */
export const getHome = async (sort = "liquidity", offersOffset = 0): Promise<HomeData> => ({
  ...NO_COUNTERS,
  ...(await readOr<Partial<HomeData>>(
    `/counters?sort=${encodeURIComponent(sort)}&offers_limit=${OFFERS_PAGE}&offers_offset=${offersOffset}`,
    NO_COUNTERS,
  )),
});

export const getStats = () => readOr<Stats>("/stats", NO_STATS);

/** `listings` defaults for the same reason `getHome` spreads: a detail
 *  payload cached from before the field existed does not carry it. */
export const getCounter = async (id: string): Promise<CounterDetail | UndisplayableCounter> => {
  const counter = await read<CounterDetail | UndisplayableCounter>(
    `/counters/${encodeURIComponent(id)}`,
  );
  return counter.displayable ? { ...counter, listings: counter.listings ?? [] } : counter;
};

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
