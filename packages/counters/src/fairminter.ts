/**
 * Fairminters, as they matter to counters.fun.
 *
 * A fairminter with `pool_quantity > 0` is a *pool fairminter* (Core v11.2.0,
 * `fairmint_pool` gate, mainnet block 961,100): at soft cap, consensus pairs
 * `pool_quantity` of the minted asset with every satoshi of raised XCP,
 * opens the TOKEN/XCP pool, and mints the LP tokens to the unspendable
 * address. Nobody, creator included, can withdraw that liquidity.
 *
 * When such a deploy also carries its file in a taproot envelope, the one
 * transaction is both a launch and a numbered Counter. That is the object
 * this site is built around.
 */

import { big, type Raw } from "./numeric";
import { randomNumericAsset } from "./assetnames";

export const FAIRMINT_POOL_ACTIVATION_BLOCK = 961_100;

/** Core rewrites `soft_cap_deadline_block` on a sell-out — see {@link mintWindow}. */
export type FairminterStatus = "pending" | "open" | "closed" | "cancelled";

export interface Fairminter {
  tx_hash: string;
  tx_index: number;
  block_index: number;
  source: string;
  asset: string;
  asset_longname: string | null;
  description: string;
  /** "text/plain" for a hosted-URL description; the real type when inscribed. */
  mime_type?: string;
  price: Raw;
  quantity_by_price: Raw;
  hard_cap: Raw;
  soft_cap: Raw;
  soft_cap_deadline_block: number;
  start_block: number;
  end_block: number;
  burn_payment: boolean;
  max_mint_per_tx: Raw;
  max_mint_per_address: Raw | null;
  premint_quantity: Raw;
  minted_asset_commission_int: Raw | null;
  lock_description: boolean;
  lock_quantity: boolean;
  divisible: boolean;
  /** Tokens reserved for the AMM pool. Null or 0 means no pool will open. */
  pool_quantity: Raw | null;
  lp_asset: string | null;
  status: FairminterStatus;
  earned_quantity: Raw | null;
  paid_quantity: Raw | null;
}

/** A launch that will open a pool by consensus if it reaches soft cap. */
export function seedsPool(fm: Pick<Fairminter, "pool_quantity">): boolean {
  return big(fm.pool_quantity ?? 0) > 0n;
}

/**
 * Fraction of the soft cap sold, 0–1. `earned_quantity` is the minted asset
 * total; the sale succeeds the moment it reaches `soft_cap`.
 */
export function mintProgress(fm: Pick<Fairminter, "earned_quantity" | "soft_cap">): number {
  const cap = big(fm.soft_cap);
  if (cap <= 0n) return 0;
  const earned = big(fm.earned_quantity ?? 0);
  if (earned >= cap) return 1;
  const SCALE = 1_000_000n;
  return Number((earned * SCALE) / cap) / 1e6;
}

/**
 * Blocks left in the mint window, or null once the field stops meaning
 * "deadline".
 *
 * The caveat that bites integrators: when a launch sells out early, Core
 * *rewrites* `soft_cap_deadline_block` to the fill block and settles the pool
 * in that block's end-of-block phase. On a `closed` record the field is the
 * settlement block, not the composed deadline — so a countdown may only trust
 * it while the status is `open`.
 */
export function blocksRemaining(
  fm: Pick<Fairminter, "status" | "soft_cap_deadline_block">,
  tip: number,
): number | null {
  if (fm.status !== "open") return null;
  return Math.max(0, fm.soft_cap_deadline_block - tip);
}

/** Blocks until an announced launch becomes mintable. */
export function blocksUntilStart(
  fm: Pick<Fairminter, "status" | "start_block">,
  tip: number,
): number | null {
  if (fm.status !== "pending") return null;
  return Math.max(0, fm.start_block - tip);
}

/**
 * The composed mint window. Exact for `pending`/`open`; for `closed` records
 * the deadline field has been rewritten, so the original binding must come
 * from the append-only `NEW_FAIRMINTER` event
 * (`GET /v2/transactions/{tx_hash}/events/NEW_FAIRMINTER`) instead.
 */
export function mintWindow(fm: Fairminter): number | null {
  if (fm.status === "closed") return null;
  return fm.soft_cap_deadline_block - fm.start_block;
}

/**
 * The price the pool will open at, in XCP per whole token: all raised XCP
 * over the reserved tokens. Every minter is above water at open whenever the
 * public sale is larger than the pool reserve.
 */
export function openingPrice(fm: Fairminter): number | null {
  const pool = big(fm.pool_quantity ?? 0);
  if (pool <= 0n) return null;

  const softCap = big(fm.soft_cap);
  const lot = big(fm.quantity_by_price);
  const lotPrice = big(fm.price);
  if (lot <= 0n) return null;

  const raised = (softCap / lot) * lotPrice;
  if (raised <= 0n) return null;

  const SCALE = 1_000_000_000_000n;
  return Number((raised * SCALE) / pool) / 1e12;
}

/**
 * Consensus requires all mintable supply to be spoken for:
 * `hard_cap = existing_supply + premint + pool_quantity + soft_cap`.
 * Checked client-side before composing so the error lands in the form rather
 * than coming back from the node.
 */
export function poolCapsBalance(input: {
  hard_cap: Raw;
  existing_supply: Raw;
  premint_quantity: Raw;
  pool_quantity: Raw;
  soft_cap: Raw;
}): boolean {
  return (
    big(input.hard_cap) ===
    big(input.existing_supply) +
      big(input.premint_quantity) +
      big(input.pool_quantity) +
      big(input.soft_cap)
  );
}

/** A numeric asset name for the LP token — see {@link randomNumericAsset}. */
export function randomLpAsset(): string {
  return randomNumericAsset();
}

/* -------------------------------------------------------------------- */
/* Composing a deploy                                                   */
/* -------------------------------------------------------------------- */

/**
 * Everything `compose/fairminter` takes that shapes the sale, in raw units.
 * XCP-69 is one fixed instance of this (see ./xcp69); a custom deploy is any
 * other. Zero means "none" wherever Core reads it that way: no soft cap, no
 * pool, no per-address cap, no end block.
 */
export interface FairminterParams {
  /** Raw XCP per lot. 0 makes the mint free, and `maxMintPerTx` the amount per mint. */
  lotPrice: bigint;
  /** Raw tokens per lot. */
  lotSize: bigint;
  hardCap: bigint;
  softCap: bigint;
  /** Raw tokens reserved for the AMM pool, paired with all raised XCP at soft cap. */
  poolQuantity: bigint;
  maxMintPerTx: bigint;
  maxMintPerAddress: bigint;
  premintQuantity: bigint;
  /** Fraction of each mint paid to the issuer, 0–1. */
  mintedAssetCommission: number;
  burnPayment: boolean;
  lockQuantity: boolean;
  lockDescription: boolean;
  divisible: boolean;
  /** 0 opens the sale in the deploy's own block. */
  startBlock: number;
  /** 0 for no end. */
  endBlock: number;
  /** Required when `softCap` > 0. */
  softCapDeadlineBlock: number;
  /** Numeric asset for the LP token; drawn when empty. Only meaningful with a pool. */
  lpAsset?: string;
}

/** Why a set of parameters cannot be composed, in the order Core would find them. */
export function fairminterProblems(p: FairminterParams): string[] {
  const problems: string[] = [];
  if (p.lotSize <= 0n) problems.push("lot size must be positive");
  if (p.hardCap < 0n || p.softCap < 0n || p.poolQuantity < 0n || p.premintQuantity < 0n) problems.push("quantities cannot be negative");
  if (p.softCap > 0n && p.hardCap > 0n && p.softCap > p.hardCap) problems.push("soft cap cannot exceed hard cap");
  if (p.softCap > 0n && p.softCapDeadlineBlock <= 0) problems.push("a soft cap needs a deadline block");
  if (p.softCap > 0n && p.startBlock > 0 && p.softCapDeadlineBlock <= p.startBlock) problems.push("the soft cap deadline must be after the start block");
  if (p.poolQuantity > 0n && p.softCap <= 0n) problems.push("a pool needs a soft cap to open at");
  if (p.poolQuantity > 0n && p.hardCap > 0n && p.poolQuantity + p.softCap > p.hardCap) problems.push("pool reserve plus soft cap cannot exceed the hard cap");
  if (p.poolQuantity > 0n && p.burnPayment) problems.push("a pool launch cannot burn the payment — the XCP seeds the pool");
  if (p.mintedAssetCommission < 0 || p.mintedAssetCommission >= 1) problems.push("commission is a fraction below 1");
  if (p.endBlock > 0 && p.startBlock > 0 && p.endBlock <= p.startBlock) problems.push("the end block must be after the start block");
  return problems;
}

/** The compose parameters, by the node's current names. */
export function fairminterComposeParams(p: FairminterParams, asset: string): Record<string, string> {
  const out: Record<string, string> = {
    asset,
    lot_price: p.lotPrice.toString(),
    lot_size: p.lotSize.toString(),
    hard_cap: p.hardCap.toString(),
    soft_cap: p.softCap.toString(),
    pool_quantity: p.poolQuantity.toString(),
    max_mint_per_tx: p.maxMintPerTx.toString(),
    max_mint_per_address: p.maxMintPerAddress.toString(),
    premint_quantity: p.premintQuantity.toString(),
    minted_asset_commission: String(p.mintedAssetCommission),
    burn_payment: String(p.burnPayment),
    lock_quantity: String(p.lockQuantity),
    lock_description: String(p.lockDescription),
    divisible: String(p.divisible),
    start_block: String(p.startBlock),
    end_block: String(p.endBlock),
    soft_cap_deadline_block: String(p.softCapDeadlineBlock),
  };
  if (p.lpAsset) out.lp_asset = p.lpAsset;
  return out;
}
