/**
 * MARA Slipstream — the route for reveals the public relay network refuses.
 *
 * An oversized taproot reveal is a perfectly VALID transaction that merely
 * exceeds the 400,000 WU standard-relay cap, so no ordinary node will carry it
 * and no fee rate changes that: the limit is policy on witness weight, not
 * price. Slipstream takes such transactions directly into MARA's own mempool.
 *
 * Four facts shape everything here, each learned the hard way:
 *
 *   - **No API key is required.** `/api/rates`, `/api/transactions` and
 *     `/api/transactions/status` all answer unauthenticated. A key, where one
 *     exists, travels as `client_code` and buys only whatever fee discount MARA
 *     has assigned it — it is never required to mint.
 *
 *   - **Two rates, and they are not interchangeable.** `submit_fee_rate` is the
 *     floor a submission must meet to be ACCEPTED; `effective_rate` is what MARA
 *     is mining at now. They diverge whenever the market moves, and a submission
 *     between them is accepted and then simply waits. Gate on the floor; treat
 *     the mineable rate as the confirm-soon advice it is.
 *
 *   - **No package submission.** One transaction at a time, and a reveal is
 *     priced from the chain and from MARA's own submissions — NEVER from the
 *     public mempool. A reveal whose commit is only in the public mempool prices
 *     as fee 0 and is refused ("Fee rate of 0 is below the threshold"), so the
 *     commit must be MINED before the reveal can go up.
 *
 *   - **A submission is invisible until it is mined.** Not relayed to the public
 *     network before it has a confirmation, so bitcoind and every explorer are
 *     blind to it. Only the chain can confirm it worked.
 */

/** Slipstream's published policy cap — ~99.8% of a block. Past this, refused. */
export const MAX_WEIGHT = 3_991_000;

/** At or below this the public network relays free; Slipstream is for beyond. */
export const STANDARD_MAX_WEIGHT = 400_000;

/**
 * Cloudflare gives up at roughly 100 seconds. A 524 later than this means the
 * origin was still working on a body it had already received in full.
 */
export const FULL_UPLOAD_SECONDS = 90;

export interface SlipstreamRates {
  /** The minimum sat/vB a submission must pay to be accepted. A hard gate. */
  submitFloor: number;
  /** The rate actually being mined now. Paying between the two is legitimate. */
  mineable: number;
  marketRate: number | null;
  multiplier: number | null;
}

/**
 * What a submission response actually means.
 *
 * - `accepted` — MARA has it.
 * - `rejected` — it never will; stop.
 * - `probably-accepted` — the ambiguous 524; watch the chain, re-upload slowly.
 * - `ambiguous` — the body never landed; try again.
 */
export type Verdict = "accepted" | "rejected" | "probably-accepted" | "ambiguous";

/**
 * Classify a submission response.
 *
 * The hard case is 524. Cloudflare abandons the connection at ~100 s while the
 * origin is still validating a multi-megabyte transaction it HAS received — so
 * a 524 after a full upload is what every accepted large submission looks like,
 * and re-uploading on it wastes megabytes to no purpose. A FAST 524 is the
 * opposite: the body never arrived.
 *
 * "not found" is Slipstream answering about a transaction it cannot see yet,
 * which says nothing either way, so it stays ambiguous rather than fatal.
 *
 * @param status HTTP status, or null when no answer arrived at all.
 * @param body   Response body, used only for the 400 sub-cases.
 * @param seconds How long the request took — decisive for 524.
 */
export function classify(status: number | null, body: string, seconds: number): Verdict {
  const low = (body || "").toLowerCase();
  if (status === 200 || status === 201) return "accepted";
  // It already has the transaction; submitting again would be the error.
  if (status === 400 && (low.includes("already") || low.includes("known"))) return "accepted";
  if (status === 400 && !low.includes("not found")) return "rejected";
  if (status === 524 && seconds > FULL_UPLOAD_SECONDS) return "probably-accepted";
  return "ambiguous";
}

/** Read the two rates out of `/api/rates`, tolerating older deployments. */
export function parseRates(body: unknown): SlipstreamRates {
  const r = (body ?? {}) as Record<string, unknown>;
  const mineable = Number(r.effective_rate);
  if (!Number.isFinite(mineable)) {
    throw new Error("Slipstream returned no effective_rate");
  }
  // Older deployments published only effective_rate; falling back errs toward
  // overpaying rather than toward rejection.
  const floor = r.submit_fee_rate == null ? mineable : Number(r.submit_fee_rate);
  return {
    submitFloor: floor,
    mineable,
    marketRate: r.market_rate == null ? null : Number(r.market_rate),
    multiplier: r.multiplier == null ? null : Number(r.multiplier),
  };
}

/** Whether a reveal of this weight can use each route. */
export type RouteFit = "public" | "slipstream-only" | "too-large";

/**
 * Which routes a reveal of this weight can take.
 *
 * Above `MAX_WEIGHT` nothing can carry it and the mint must be refused before
 * any money moves; between the two caps only Slipstream can; at or below the
 * standard cap the public network takes it for free and Slipstream is a choice,
 * not a requirement.
 */
export function routeFor(weight: number): RouteFit {
  if (weight > MAX_WEIGHT) return "too-large";
  if (weight > STANDARD_MAX_WEIGHT) return "slipstream-only";
  return "public";
}

/**
 * Whether a fee rate clears Slipstream's acceptance floor.
 *
 * Separate from `judgeRate` in `fees.ts`, which answers the different question
 * of whether the public network would relay it. A rate can pass one and fail
 * the other in both directions: this node relays down to 0.001 sat/vB, while
 * Slipstream's floor has been 1.0.
 */
export function meetsFloor(rate: number, rates: Pick<SlipstreamRates, "submitFloor">): boolean {
  return rate >= rates.submitFloor;
}
