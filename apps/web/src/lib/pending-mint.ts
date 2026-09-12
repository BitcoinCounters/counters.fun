/**
 * A mint whose commit is on chain and whose reveal is not, kept across
 * reloads.
 *
 * The reveal PSBT used to live only in React state, so closing the tab after
 * the commit broadcast stranded the commit's coins with nothing to rebuild
 * from. Everything needed to finish is small and safe to store, and there is
 * one pending mint per address at a time.
 *
 * `revealKey` is the exception to "safe to store", and it is deliberate. When
 * the leaf names a key of the mint's own rather than the wallet's, that key is
 * the only thing that can open the commit — dropping it would strand the coins
 * exactly as Core's discarded key does. It is a fresh key that has never held
 * anything else, it guards one output worth the reveal's fee, and it is
 * cleared the moment the reveal is broadcast. It is never sent anywhere.
 */

import type { MintPlan } from "@/lib/inscribe/mint";

const KEY = "counters.fun:pending-mint";

export interface PendingMint {
  source: string;
  asset: string;
  commitTxid: string;
  revealPsbt: string;
  /** Hex, when the reveal is signed by this page rather than by the wallet. */
  revealKey?: string;
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
