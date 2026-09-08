/**
 * Slipstream from the browser, through this site's own server route.
 *
 * Nothing here talks to slipstream.mara.com directly — it sends no CORS headers
 * and a key must never reach a page. `/api/slipstream` is the only door, and it
 * reports verdicts rather than throwing, because "rejected" and "probably
 * accepted" are both real outcomes that need different handling.
 */

import type { SlipstreamRates, Verdict } from "@counters/core/slipstream";

export type { SlipstreamRates, Verdict };

export interface RatesResult extends SlipstreamRates {
  /** Whether the server holds a discount code. Never the code itself. */
  haveKey: boolean;
}

export interface SubmitResult {
  verdict: Verdict;
  status: number | null;
  seconds: number;
  message: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error || `Slipstream request failed (${res.status})`);
  }
  return body as T;
}

/**
 * The two live rates.
 *
 * Read these BEFORE composing: the commit output is sized for the reveal's fee
 * at compose time, and once the commit is on chain it cannot be resized. A rate
 * below `submitFloor` is refused outright; one between the floor and `mineable`
 * is accepted and then waits for the market to come down.
 */
export function slipstreamRates(): Promise<RatesResult> {
  return json<RatesResult>("/api/slipstream?action=rates");
}

/** Whether MARA's origin is answering right now. */
export function slipstreamProbe(): Promise<{
  alive: boolean;
  status: number | null;
  seconds: number;
}> {
  return json("/api/slipstream?action=probe");
}

/** Submit a signed transaction. Read `verdict`, not the HTTP status. */
export function slipstreamSubmit(hex: string): Promise<SubmitResult> {
  return json<SubmitResult>("/api/slipstream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hex }),
  });
}

/**
 * MARA's own view of a submission — for display only, never for decisions.
 *
 * It has reported "not found" for transactions that later mined. The chain is
 * the only authority on whether a submission worked.
 */
export function slipstreamStatus(txid: string): Promise<Record<string, unknown>> {
  return json(`/api/slipstream?action=status&txid=${encodeURIComponent(txid)}`);
}
