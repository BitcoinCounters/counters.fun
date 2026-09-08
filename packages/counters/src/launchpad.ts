/**
 * Which launchpad, if any, a counter was deployed through.
 *
 * xcp.fun deploys a fairminter whose description is an asset manifest: JSON
 * with `website` and `image` fields on xcp.fun. Most of its launches carry
 * that manifest as a URL (`https://xcp.fun/NAME.json`) and are pointer
 * counters this site never renders. Some inscribe the manifest itself, and
 * those are real on-chain counters — the bytes in the block are the manifest,
 * not the art. They are listed like any other counter, and tagged so a reader
 * can tell that the picture lives on the launchpad rather than in the block.
 *
 * Two signals, neither a source-address list nor an upstream flag:
 *
 * 1. **The fairminter's shape.** xcp.fun composes every launch from one
 *    template — 0.01 XCP per lot of 1,000 tokens, 100M hard cap, 69M soft
 *    cap, 31M reserved for the pool, 1M per address, a 1,000-block window.
 *    On mainnet today all 204 pool fairminters, open and closed, match it
 *    exactly; nobody has hand-composed one. This is what tags a launch whose
 *    inscribed file is the art itself (a PNG) rather than a manifest.
 * 2. **The description.** A manifest (JSON whose `website`/`image` are on
 *    xcp.fun) or a pointer to one (`https://xcp.fun/NAME.json`). This is
 *    what the web app can check on its own from the on-chain body.
 *
 * A body that merely mentions xcp.fun in prose is neither.
 */

import { type Raw } from "./numeric";
import { XCP69, matchesXcp69Template } from "./xcp69";

export type Launchpad = "xcp.fun";

/** The numeric template, kept in one place — see ./xcp69. */
export const XCP_FUN_TEMPLATE = {
  price: XCP69.lot_price,
  quantity_by_price: XCP69.lot_size,
  hard_cap: XCP69.hard_cap,
  soft_cap: XCP69.soft_cap,
  pool_quantity: XCP69.pool_quantity,
  premint_quantity: XCP69.premint_quantity,
  max_mint_per_address: XCP69.max_mint_per_address,
  divisible: XCP69.divisible,
} as const;

export interface FairminterShape {
  price: Raw;
  quantity_by_price: Raw;
  hard_cap: Raw;
  soft_cap: Raw;
  pool_quantity: Raw | null;
  premint_quantity: Raw;
  max_mint_per_address: Raw | null;
  divisible: boolean;
  description?: string | null;
}

/** True when a fairminter's parameters are xcp.fun's template, to the unit. */
export function matchesXcpFunTemplate(fm: Omit<FairminterShape, "description">): boolean {
  return matchesXcp69Template(fm);
}

/** The launchpad behind a fairminter: by description first, then by shape. */
export function launchpadOfFairminter(fm: FairminterShape): Launchpad | null {
  return launchpadOf({ body: fm.description }) ?? (matchesXcpFunTemplate(fm) ? "xcp.fun" : null);
}

const XCP_FUN_HOSTS = new Set(["xcp.fun", "www.xcp.fun"]);

function hostOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Inspect a manifest-shaped object for xcp.fun links. */
function manifestLaunchpad(manifest: unknown): Launchpad | null {
  if (!manifest || typeof manifest !== "object") return null;
  const m = manifest as Record<string, unknown>;
  const candidates: unknown[] = [m.website, m.image];
  if (Array.isArray(m.images)) {
    for (const entry of m.images) {
      if (entry && typeof entry === "object") candidates.push((entry as Record<string, unknown>).data);
    }
  }
  return candidates.some((c) => {
    const host = hostOf(c);
    return host !== null && XCP_FUN_HOSTS.has(host);
  })
    ? "xcp.fun"
    : null;
}

/**
 * The launchpad behind a counter, or null. Works for both kinds of xcp.fun
 * launch: an inscribed manifest (a JSON body) and a pointer to one (a body
 * that is an `https://xcp.fun/…` URL). `body` may be withheld upstream for
 * large counters; a manifest is a few hundred bytes, so it never is.
 */
export function launchpadOf(counter: { body: string | null | undefined }): Launchpad | null {
  const body = counter.body?.trim();
  if (!body) return null;

  if (body.startsWith("{")) {
    try {
      return manifestLaunchpad(JSON.parse(body));
    } catch {
      return null;
    }
  }

  const host = hostOf(body);
  return host !== null && XCP_FUN_HOSTS.has(host) ? "xcp.fun" : null;
}
