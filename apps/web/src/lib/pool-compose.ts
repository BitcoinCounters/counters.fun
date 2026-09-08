/**
 * Composing pool deposits, withdrawals and the LP lock.
 *
 * The math for what a deposit *will* do lives in `@counters/core/pool`; this
 * is the part that talks to the node. Every compose carries a `min_*` bound
 * taken from the slippage setting, so a stale local estimate can only cost a
 * revert, never a bad fill.
 *
 * Two rules the old version got wrong. Core sorts every pair, so nothing
 * here assumes the token is `asset_a` — quotes and records are oriented by
 * name (`orientPool`, `orientDepositQuote`). And a lookup that fails is not
 * a lookup that found nothing: only a 404 means "no pool".
 */

import { type Raw } from "@counters/core/numeric";
import type { Pool } from "@counters/core/pool";
import { sortedPair, type DepositQuoteLike, type WithdrawQuoteLike } from "@counters/core/pool";
import { BURN_ADDRESS } from "@/lib/constants";
import { HARD_MIN_RATE } from "@counters/core/fees";
import { CpNotFound, cpCompose, cpGet, fetchBalance } from "@/lib/cp";
import type { ComposeResult } from "@/lib/inscribe/psbt";

export { fetchBalance };

/** The pool for a counter, null when nobody has opened one. Throws on any other failure. */
export async function fetchPool(asset: string): Promise<Pool | null> {
  try {
    return await cpGet<Pool>(`pools/${encodeURIComponent(asset)}/XCP?verbose=true`);
  } catch (cause) {
    if (cause instanceof CpNotFound) return null;
    throw cause;
  }
}

/** Exactly what `/quote/deposit` returns, names included. */
export type DepositQuote = DepositQuoteLike & { asset_a: string; asset_b: string };

/**
 * What a proportional deposit requires, from the node.
 *
 * The node is the authority: the local formula needs the pool's LP supply,
 * and `sqrt(reserve_a * reserve_b)` is only right in the instant after a
 * first deposit. `side` says which amount the person typed — the node quotes
 * from whichever asset the URL names first — so either field can lead.
 */
export function fetchDepositQuote(asset: string, side: "token" | "xcp", quantity: bigint): Promise<DepositQuote> {
  const [first, second] = side === "token" ? [asset, "XCP"] : ["XCP", asset];
  return cpGet<DepositQuote>(
    `pools/${encodeURIComponent(first)}/${encodeURIComponent(second)}/quote/deposit?quantity=${quantity}`,
  );
}

export type WithdrawQuote = WithdrawQuoteLike & { asset_a: string; asset_b: string; pool_exists: boolean };

export function fetchWithdrawQuote(asset: string, lpQuantity: bigint): Promise<WithdrawQuote> {
  return cpGet<WithdrawQuote>(`pools/${encodeURIComponent(asset)}/XCP/quote/withdraw?quantity=${lpQuantity}`);
}

/**
 * The XCP gas fee consensus charges for a pool message. Shown before signing —
 * it is paid in XCP, not satoshis, and a wallet that is short of it fails at
 * validation rather than at compose.
 */
export function estimateDepositXcpFee(address: string): Promise<number> {
  return cpGet<number>(`addresses/${encodeURIComponent(address)}/compose/pooldeposit/estimatexcpfees`);
}

export function estimateWithdrawXcpFee(address: string): Promise<number> {
  return cpGet<number>(`addresses/${encodeURIComponent(address)}/compose/poolwithdraw/estimatexcpfees`);
}

export type ComposedTx = ComposeResult;

const COMMON = {
  exclude_utxos_with_balances: "true",
  verbose: "true",
};

export interface DepositRequest {
  address: string;
  asset: string;
  /** Raw units of the counter. */
  quantityToken: bigint;
  /** Raw XCP. */
  quantityXcp: bigint;
  /** Floor on LP tokens minted. 0 disables the check. */
  minLpQuantity: bigint;
  /** Only for a first deposit; the node draws one when omitted. */
  lpAsset?: string;
  satPerVbyte: number;
}

/**
 * The pair goes to the node in Core's own order with the quantities kept
 * beside their assets, so a name that sorts after "XCP" is handled the same
 * as one that sorts before it.
 */
function rate(satPerVbyte: number): string {
  if (!(satPerVbyte >= HARD_MIN_RATE)) throw new Error("The fee rate must be above zero.");
  return String(satPerVbyte);
}

export function composeDeposit(req: DepositRequest): Promise<ComposedTx> {
  const [a, b] = sortedPair(req.asset, "XCP");
  const qa = a === req.asset ? req.quantityToken : req.quantityXcp;
  const qb = b === req.asset ? req.quantityToken : req.quantityXcp;
  const params: Record<string, string> = {
    asset_a: a,
    asset_b: b,
    quantity_a: qa.toString(),
    quantity_b: qb.toString(),
    min_lp_quantity: req.minLpQuantity.toString(),
    sat_per_vbyte: rate(req.satPerVbyte),
    ...COMMON,
  };
  if (req.lpAsset) params.lp_asset = req.lpAsset;
  return cpCompose(req.address, "pooldeposit", params);
}

export interface WithdrawRequest {
  address: string;
  asset: string;
  /** LP tokens to destroy. */
  quantity: bigint;
  minQuantityToken: bigint;
  minQuantityXcp: bigint;
  satPerVbyte: number;
}

export function composeWithdraw(req: WithdrawRequest): Promise<ComposedTx> {
  const [a, b] = sortedPair(req.asset, "XCP");
  const minA = a === req.asset ? req.minQuantityToken : req.minQuantityXcp;
  const minB = b === req.asset ? req.minQuantityToken : req.minQuantityXcp;
  return cpCompose(req.address, "poolwithdraw", {
    asset_a: a,
    asset_b: b,
    quantity: req.quantity.toString(),
    min_quantity_a: minA.toString(),
    min_quantity_b: minB.toString(),
    sat_per_vbyte: rate(req.satPerVbyte),
    ...COMMON,
  });
}

/**
 * Lock liquidity: send LP tokens to the unspendable address. What a pool
 * fairminter does by consensus at soft cap, done by hand for a pool opened
 * here. Irreversible, which is the point.
 */
export function composeLpLock(address: string, lpAsset: string, quantity: bigint, satPerVbyte: number): Promise<ComposedTx> {
  return cpCompose(address, "send", {
    destination: BURN_ADDRESS,
    asset: lpAsset,
    quantity: quantity.toString(),
    sat_per_vbyte: rate(satPerVbyte),
    ...COMMON,
  });
}

/** Reduce a quantity by a slippage percentage, for a `min_*` bound. */
export function withSlippage(quantity: bigint, percent: number): bigint {
  const bps = BigInt(Math.round(percent * 100));
  return (quantity * (10_000n - bps)) / 10_000n;
}

/** Raw quantities in the pool's own decimals, for pre-filling a field. */
export function rawToUnits(raw: Raw | bigint, decimals: number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(String(raw));
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
