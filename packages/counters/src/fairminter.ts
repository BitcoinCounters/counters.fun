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

/**
 * A numeric asset name for the LP token, drawn with real randomness.
 * Front-running protection: a predictable name can be issued out from under
 * the launch. Valid numeric assets are `A` + an integer in
 * (26^12, 2^64), and consensus rejects anything outside that.
 */
export function randomLpAsset(): string {
  const MIN = 26n ** 12n + 1n;
  const MAX = 2n ** 64n - 1n;
  const span = MAX - MIN;

  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  return `A${MIN + (value % span)}`;
}
