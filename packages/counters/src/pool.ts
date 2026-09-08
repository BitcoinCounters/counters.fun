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
  /** Present on verbose records; the token side's `divisible` is what prices need. */
  asset_a_info?: { divisible?: boolean } | null;
  asset_b_info?: { divisible?: boolean } | null;
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
 * Price of one whole token in XCP, as a double. Display only — never
 * round-trip a composed quantity through this.
 *
 * Reserves are raw units. XCP is always divisible (10^8 raw per XCP); the
 * token may not be, and an indivisible token's raw unit *is* its whole
 * unit. Dividing raw by raw is only right when both scale the same way —
 * BONPARTY, 500 raw against 100 XCP, is 0.2 XCP a piece, not 20 million.
 */
export function poolPrice(
  pool: Pick<Pool, "asset_a" | "asset_b" | "reserve_a" | "reserve_b">,
  tokenDivisible = true,
): number | null {
  const token = tokenSide(pool);
  if (!token) return null;
  const tokenReserve = big(pool.asset_a === token ? pool.reserve_a : pool.reserve_b);
  const xcpReserve = big(pool.asset_a === token ? pool.reserve_b : pool.reserve_a);
  return priceFromReserves(tokenReserve, xcpReserve, tokenDivisible);
}

/** XCP per whole token from raw reserves. Scaled before dividing so small pools keep significant figures. */
export function priceFromReserves(tokenReserve: bigint, xcpReserve: bigint, tokenDivisible: boolean): number | null {
  if (tokenReserve <= 0n || xcpReserve <= 0n) return null;
  const SCALE = 1_000_000_000_000n;
  const tokenUnit = tokenDivisible ? 100_000_000n : 1n;
  // (xcp / 1e8) / (token / tokenUnit) = xcp * tokenUnit / (token * 1e8)
  return Number((xcpReserve * tokenUnit * SCALE) / (tokenReserve * 100_000_000n)) / 1e12;
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

/* -------------------------------------------------------------------- */
/* Orientation                                                          */
/* -------------------------------------------------------------------- */

/**
 * Core sorts every pair (`ledger/markets.py`), and every pool record and
 * quote comes back in *sorted* order no matter which order the URL named
 * them in. For a counter whose name sorts after "XCP" — XDUALS, ZELD,
 * XCPBULL — the token is `asset_b`, not `asset_a`. Nothing here may assume
 * a side by position; it reads the names.
 */
export function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** True when `token` is the `asset_a` side of its XCP pair. */
export function tokenIsA(token: string): boolean {
  return sortedPair(token, "XCP")[0] === token;
}

export interface OrientedPool {
  token: string;
  tokenReserve: bigint;
  xcpReserve: bigint;
  /** XCP per raw unit of the token; use the divisibility to scale for display. */
  lpAsset: string | null;
}

/** A pool record read as token/XCP regardless of Core's ordering. Null when the pair is not token/XCP. */
export function orientPool(
  pool: Pick<Pool, "asset_a" | "asset_b" | "reserve_a" | "reserve_b"> & { lp_asset?: string },
  token: string,
): OrientedPool | null {
  if (pool.asset_a === token && pool.asset_b === "XCP") {
    return { token, tokenReserve: big(pool.reserve_a), xcpReserve: big(pool.reserve_b), lpAsset: pool.lp_asset ?? null };
  }
  if (pool.asset_b === token && pool.asset_a === "XCP") {
    return { token, tokenReserve: big(pool.reserve_b), xcpReserve: big(pool.reserve_a), lpAsset: pool.lp_asset ?? null };
  }
  return null;
}

export interface DepositQuoteLike {
  asset_a?: string;
  asset_b?: string;
  first_deposit: boolean;
  quantity_a_required: Raw;
  quantity_b_required: Raw;
  quantity_minted_estimate: Raw;
}

export interface OrientedDepositQuote {
  firstDeposit: boolean;
  tokenRequired: bigint;
  xcpRequired: bigint;
  minted: bigint;
}

/** A deposit quote read as token/XCP. Falls back to the sort rule when the quote omits names. */
export function orientDepositQuote(quote: DepositQuoteLike, token: string): OrientedDepositQuote {
  const aIsToken = quote.asset_a !== undefined ? quote.asset_a === token : tokenIsA(token);
  return {
    firstDeposit: quote.first_deposit,
    tokenRequired: big(aIsToken ? quote.quantity_a_required : quote.quantity_b_required),
    xcpRequired: big(aIsToken ? quote.quantity_b_required : quote.quantity_a_required),
    minted: big(quote.quantity_minted_estimate),
  };
}

export interface WithdrawQuoteLike {
  asset_a?: string;
  asset_b?: string;
  supply: Raw;
  quantity_a_estimate: Raw;
  quantity_b_estimate: Raw;
}

export function orientWithdrawQuote(
  quote: WithdrawQuoteLike,
  token: string,
): { tokenOut: bigint; xcpOut: bigint; supply: bigint } {
  const aIsToken = quote.asset_a !== undefined ? quote.asset_a === token : tokenIsA(token);
  return {
    tokenOut: big(aIsToken ? quote.quantity_a_estimate : quote.quantity_b_estimate),
    xcpOut: big(aIsToken ? quote.quantity_b_estimate : quote.quantity_a_estimate),
    supply: big(quote.supply),
  };
}

/**
 * Input needed to take `out` from a constant-product pool that charges
 * `bps` on the input, as consensus does. Ceiling, so the forward formula
 * reaches the target. Null when the pool cannot supply that much.
 */
export function inputForOutput(out: bigint, reserveIn: bigint, reserveOut: bigint, bps: number): bigint | null {
  if (out <= 0n || out >= reserveOut) return null;
  const effective = (out * reserveIn) / (reserveOut - out) + 1n;
  const keep = BigInt(10_000 - bps);
  return (effective * 10_000n + keep - 1n) / keep;
}
