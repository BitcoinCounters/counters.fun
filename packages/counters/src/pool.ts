/**
 * Counterparty AMM pools (Core v11.1.0, `amm_pools` gate — message types
 * `pooldeposit` 120 / `poolwithdraw` 121).
 *
 * The math here mirrors consensus so the UI can show a number before
 * composing. It is for display and slippage bounds only: the node's
 * `/v2/pools/{a}/{b}/quote*` endpoints are the authority, and every compose
 * carries a `min_*` bound so a stale local estimate can only cost a revert,
 * never a bad fill.
 */

import { big, type Raw, type RawLike } from "./numeric";

export interface Pool {
  tx_index: number;
  tx_hash: string;
  block_index: number;
  /** Address that opened the pool. */
  source: string;
  asset_a: string;
  asset_b: string;
  reserve_a: Raw;
  reserve_b: Raw;
  /** Numeric asset minted as the LP token. */
  lp_asset: string;
  block_time: number;
  reserve_a_normalized?: string;
  reserve_b_normalized?: string;
}

/**
 * Swap fee in basis points. Consensus charges 50 bps on XCP pairs and 100
 * elsewhere (`XCP_POOL_FEE_BPS`); counters.fun only ever surfaces XCP pairs,
 * but the branch stays honest.
 */
export function feeBps(assetA: string, assetB: string): number {
  return assetA === "XCP" || assetB === "XCP" ? 50 : 100;
}

const BPS = 10_000n;

/**
 * Constant-product output for selling `amountIn` of the reserve-in side,
 * fee-adjusted and floored — consensus computes in integers, so a fill that
 * looks profitable in continuous math can floor to zero. Returns 0n when the
 * pool is empty or the input rounds away.
 */
export function poolOutput(
  amountIn: RawLike,
  reserveIn: RawLike,
  reserveOut: RawLike,
  bps: number,
): bigint {
  const dx = big(amountIn);
  const x = big(reserveIn);
  const y = big(reserveOut);
  if (dx <= 0n || x <= 0n || y <= 0n) return 0n;

  const dxAfterFee = (dx * (BPS - BigInt(bps))) / BPS;
  if (dxAfterFee <= 0n) return 0n;

  return (dxAfterFee * y) / (x + dxAfterFee);
}

/** Integer square root, for the first deposit's LP mint. */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("isqrt of a negative");
  if (value < 2n) return value;

  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * LP tokens a deposit mints. The first deposit gets `floor(sqrt(qa * qb))`
 * and sets the price; later deposits get the proportional share of the
 * smaller side, which is why the composed quantities are maximums rather
 * than exact amounts.
 */
export function lpMinted(
  quantityA: RawLike,
  quantityB: RawLike,
  reserveA: RawLike,
  reserveB: RawLike,
  lpSupply: RawLike,
): bigint {
  const qa = big(quantityA);
  const qb = big(quantityB);
  const ra = big(reserveA);
  const rb = big(reserveB);
  const supply = big(lpSupply);

  if (supply <= 0n || ra <= 0n || rb <= 0n) return isqrt(qa * qb);

  const fromA = (qa * supply) / ra;
  const fromB = (qb * supply) / rb;
  return fromA < fromB ? fromA : fromB;
}

/**
 * The counterpart quantity a proportional deposit requires. Undefined for an
 * empty pool — there is no ratio yet, which is exactly what makes the first
 * deposit a price-setting act.
 */
export function proportionalCounterpart(
  quantityA: RawLike,
  reserveA: RawLike,
  reserveB: RawLike,
): bigint | null {
  const ra = big(reserveA);
  const rb = big(reserveB);
  if (ra <= 0n || rb <= 0n) return null;
  // Round up: consensus debits at most the composed maximum, and rounding
  // down here would compose a quantity that cannot satisfy the ratio.
  const qa = big(quantityA);
  return (qa * rb + ra - 1n) / ra;
}

/** Reserves a withdrawal of `lpQuantity` returns, floored as consensus does. */
export function withdrawalShares(
  lpQuantity: RawLike,
  reserveA: RawLike,
  reserveB: RawLike,
  lpSupply: RawLike,
): { quantityA: bigint; quantityB: bigint } {
  const supply = big(lpSupply);
  if (supply <= 0n) return { quantityA: 0n, quantityB: 0n };
  const lp = big(lpQuantity);
  return {
    quantityA: (lp * big(reserveA)) / supply,
    quantityB: (lp * big(reserveB)) / supply,
  };
}

/**
 * Price of one whole unit of `asset_a` denominated in `asset_b`, as a double.
 * Display only — never round-trip a composed quantity through this.
 */
export function poolPrice(pool: Pick<Pool, "reserve_a" | "reserve_b">): number | null {
  const a = big(pool.reserve_a);
  const b = big(pool.reserve_b);
  if (a <= 0n || b <= 0n) return null;
  // Scale before dividing so small pools keep significant figures.
  const SCALE = 1_000_000_000_000n;
  return Number((b * SCALE) / a) / 1e12;
}

/** Order a pair the way the API addresses it, with XCP as the quote side. */
export function pairFor(asset: string): { asset1: string; asset2: string } {
  return { asset1: asset, asset2: "XCP" };
}

/** True when this pool is a counter/XCP pool — the only kind this site lists. */
export function isXcpPool(pool: Pick<Pool, "asset_a" | "asset_b">): boolean {
  return pool.asset_a === "XCP" || pool.asset_b === "XCP";
}

/** The non-XCP side of an XCP pool. */
export function tokenSide(pool: Pick<Pool, "asset_a" | "asset_b">): string | null {
  if (pool.asset_b === "XCP") return pool.asset_a;
  if (pool.asset_a === "XCP") return pool.asset_b;
  return null;
}
