/**
 * A mint whose commit is on chain and whose reveal is not, kept across
 * reloads.
 *
 * The reveal PSBT used to live only in React state, so closing the tab after
 * the commit broadcast stranded the commit's coins with nothing to rebuild
 * from. Everything needed to finish is small and safe to store: the PSBT
 * names the person's own key, so it is worthless to anyone else, and there
 * is one pending mint per address at a time.
 */

import type { MintPlan } from "@/lib/inscribe/mint";

const KEY = "counters.fun:pending-mint";

export interface PendingMint {
  source: string;
  asset: string;
  commitTxid: string;
  revealPsbt: string;
  plan: MintPlan;
  savedAt: number;
}

export function loadPendingMint(): PendingMint | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PendingMint) : null;
  } catch {
    return null;
  }
}

export function savePendingMint(mint: PendingMint): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(mint));
  } catch {
    // Private mode or storage full: the in-memory copy still exists.
  }
}

export function clearPendingMint(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do.
  }
}
