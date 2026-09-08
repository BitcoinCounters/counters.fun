/**
 * XCP-69: xcp.fun's fixed launch shape, as their docs specify it.
 *
 * One template, exact to the unit: 0.01 XCP buys a lot of 1,000; 100M hard
 * cap; 69M soft cap, all or nothing; 31M held back and paired with every
 * raised XCP at soft cap to open the TOKEN/XCP pool, whose LP tokens go to
 * the unspendable address; 1M per address; a 1,000-block window; supply and
 * description locked; no premint, no commission, payment not burned. And a
 * timing rule — the deploy must confirm in a block *before* its start block,
 * so nobody announces a 1,000-block window that opened the moment they
 * broadcast.
 *
 * Any on-chain fairminter matching this is indexed by xcp.fun whether or not
 * it was created there. On mainnet today every pool fairminter matches it.
 */

import { big, type Raw } from "./numeric";
import { fairminterComposeParams, type FairminterParams } from "./fairminter";

export const XCP69 = {
  /** Raw units: 0.01 XCP. */
  lot_price: 1_000_000n,
  /** Raw units: 1,000 tokens. */
  lot_size: 100_000_000_000n,
  hard_cap: 10_000_000_000_000_000n,
  soft_cap: 6_900_000_000_000_000n,
  pool_quantity: 3_100_000_000_000_000n,
  max_mint_per_tx: 100_000_000_000_000n,
  max_mint_per_address: 100_000_000_000_000n,
  premint_quantity: 0n,
  minted_asset_commission: 0,
  burn_payment: false,
  lock_quantity: true,
  lock_description: true,
  divisible: true,
  /** soft_cap_deadline_block − start_block. */
  window_blocks: 1000,
} as const;

/** Blocks between the compose-time tip and the start block. */
export const XCP69_MIN_START_LEAD = 1;
export const XCP69_DEFAULT_START_LEAD = 3;

/** The two blocks a launch is scheduled by, from the current tip and a lead. */
export function xcp69Schedule(tip: number, lead: number): { startBlock: number; deadlineBlock: number } {
  const startBlock = tip + Math.max(XCP69_MIN_START_LEAD, Math.floor(lead));
  return { startBlock, deadlineBlock: startBlock + XCP69.window_blocks };
}

export interface Xcp69Launch {
  asset: string;
  startBlock: number;
  /** Numeric asset for the LP token. Drawn client-side so the compose is deterministic. */
  lpAsset: string;
}

/** The template as a full parameter set, scheduled from `startBlock`. */
export function xcp69Params(startBlock: number, lpAsset?: string): FairminterParams {
  return {
    lotPrice: XCP69.lot_price,
    lotSize: XCP69.lot_size,
    hardCap: XCP69.hard_cap,
    softCap: XCP69.soft_cap,
    poolQuantity: XCP69.pool_quantity,
    maxMintPerTx: XCP69.max_mint_per_tx,
    maxMintPerAddress: XCP69.max_mint_per_address,
    premintQuantity: XCP69.premint_quantity,
    mintedAssetCommission: XCP69.minted_asset_commission,
    burnPayment: XCP69.burn_payment,
    lockQuantity: XCP69.lock_quantity,
    lockDescription: XCP69.lock_description,
    divisible: XCP69.divisible,
    startBlock,
    endBlock: 0,
    softCapDeadlineBlock: startBlock + XCP69.window_blocks,
    lpAsset,
  };
}

/**
 * The `compose/fairminter` parameters for a conforming launch, by the node's
 * current names (`lot_price`/`lot_size`; the old `price`/`quantity_by_price`
 * are still accepted as aliases). Everything but the name, the schedule and
 * the LP asset is the template.
 */
export function xcp69ComposeParams(launch: Xcp69Launch): Record<string, string> {
  return fairminterComposeParams(xcp69Params(launch.startBlock, launch.lpAsset), launch.asset);
}

/** The fields the conformance check reads, as the node reports a fairminter. */
export interface Xcp69Shape {
  price: Raw;
  quantity_by_price: Raw;
  hard_cap: Raw;
  soft_cap: Raw;
  pool_quantity: Raw | null;
  premint_quantity: Raw;
  max_mint_per_address: Raw | null;
  max_mint_per_tx?: Raw | null;
  minted_asset_commission_int?: Raw | null;
  divisible: boolean;
  lock_quantity?: boolean;
  lock_description?: boolean;
  burn_payment?: boolean;
  start_block?: number;
  soft_cap_deadline_block?: number;
  block_index?: number;
}

/**
 * The numeric template, to the unit. This is the part that identifies a
 * launch as XCP-69 for tagging: the flags below are also required by xcp.fun
 * but are not what distinguishes the shape.
 */
export function matchesXcp69Template(fm: Xcp69Shape): boolean {
  return (
    big(fm.price) === XCP69.lot_price &&
    big(fm.quantity_by_price) === XCP69.lot_size &&
    big(fm.hard_cap) === XCP69.hard_cap &&
    big(fm.soft_cap) === XCP69.soft_cap &&
    big(fm.pool_quantity ?? 0) === XCP69.pool_quantity &&
    big(fm.premint_quantity) === XCP69.premint_quantity &&
    big(fm.max_mint_per_address ?? 0) === XCP69.max_mint_per_address &&
    Boolean(fm.divisible) === XCP69.divisible
  );
}

/**
 * Full conformance as xcp.fun's docs state it: the template, the flags, and
 * the deploy confirmed before the start block. `block_index` on an open
 * fairminter is its confirmation block.
 */
export function isXcp69Conformant(fm: Xcp69Shape): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!matchesXcp69Template(fm)) problems.push("template");
  if (fm.max_mint_per_tx !== undefined && big(fm.max_mint_per_tx ?? 0) !== XCP69.max_mint_per_tx) problems.push("max_mint_per_tx");
  if (fm.lock_quantity === false) problems.push("lock_quantity");
  if (fm.lock_description === false) problems.push("lock_description");
  if (fm.burn_payment === true) problems.push("burn_payment");
  if (fm.minted_asset_commission_int !== undefined && big(fm.minted_asset_commission_int ?? 0) !== 0n) problems.push("commission");
  if (fm.start_block !== undefined && fm.soft_cap_deadline_block !== undefined && fm.soft_cap_deadline_block - fm.start_block !== XCP69.window_blocks) problems.push("window");
  if (fm.start_block !== undefined && fm.block_index !== undefined && !(fm.start_block > fm.block_index)) problems.push("start_block");
  return { ok: problems.length === 0, problems };
}
