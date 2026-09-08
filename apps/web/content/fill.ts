/**
 * `{{TOKEN}}` substitution, shared by `copy.ts` and `docs.md`.
 *
 * Deliberately free of Node imports. Client components use this, and a module
 * that reaches `node:fs` — even transitively, even only for a function they do
 * not call — fails the browser bundle with
 * "the chunking context does not support external modules (request:
 * node:fs/promises)". The docs reader lives in `content/docs.ts` for that
 * reason alone.
 */

import {
  AMM_POOLS_ACTIVATION_BLOCK,
  COUNTERS_GENESIS_BLOCK,
  FAIRMINT_POOL_ACTIVATION_BLOCK,
  NAMED_ASSET_XCP_BURN,
  STANDARD_WITNESS_LIMIT_WU,
  XCP_POOL_FEE_BPS,
} from "@/lib/constants";

/**
 * What `{{TOKEN}}` can name.
 *
 * These are protocol facts, not prose — activation heights, consensus fees,
 * relay limits. Keeping them out of the text means an editor cannot leave a
 * stale number behind, and the day one of them changes it changes everywhere at
 * once.
 */
const TOKENS: Record<string, string> = {
  XCP_POOL_FEE_BPS: String(XCP_POOL_FEE_BPS),
  AMM_POOLS_ACTIVATION_BLOCK: AMM_POOLS_ACTIVATION_BLOCK.toLocaleString("en-US"),
  FAIRMINT_POOL_ACTIVATION_BLOCK: FAIRMINT_POOL_ACTIVATION_BLOCK.toLocaleString("en-US"),
  COUNTERS_GENESIS_BLOCK: COUNTERS_GENESIS_BLOCK.toLocaleString("en-US"),
  STANDARD_WITNESS_LIMIT_WU: STANDARD_WITNESS_LIMIT_WU.toLocaleString("en-US"),
  NAMED_ASSET_XCP_BURN: String(NAMED_ASSET_XCP_BURN),
};

/**
 * Substitute `{{TOKEN}}` in a string.
 *
 * An unknown token is left exactly as written rather than replaced with an
 * empty string. A typo should be visible in the page — silently deleting a
 * number from a sentence about consensus rules is the worse failure.
 */
export function fill(text: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => TOKENS[name] ?? whole);
}
