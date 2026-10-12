/**
 * Is the Counterparty node new enough for the reveals it composes to count?
 *
 * Since Core v11.5.0 (`require_reveal_source_signature`, mainnet block
 * 969,320) a taproot reveal is attributed to its source only when the
 * envelope leaf is closed by a key of the source address. Older nodes compose
 * reveals closed by a throwaway key, parse them as valid themselves, and the
 * network ignores them: no asset, no ledger rows, fees gone. Fifteen counters
 * were lost that way in the first ten days, ten of them from one wallet.
 *
 * Core only checks its own version when its process starts, so a node left
 * running across a release never notices. The proxy checks on every compose
 * instead (`/api/cp`), and the mint checks the compose result once more: a
 * `signed_reveal_rawtransaction` without a `reveal_rawtransaction` can only
 * come from a node that predates the rule.
 */

/** The oldest Core whose compose output this app knows how to sign. */
export const MIN_CORE_VERSION: readonly [number, number, number] = [11, 5, 0];

export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function lessThan(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/** Why the node must not compose, or null when it may. */
export function nodeVersionProblem(version: string | null | undefined): string | null {
  const parsed = parseVersion(version);
  const floor = MIN_CORE_VERSION.join(".");
  if (!parsed) return `the Counterparty node did not report a readable version (${String(version)}); refusing to compose blind`;
  if (lessThan(parsed, MIN_CORE_VERSION)) {
    return (
      `the Counterparty node runs Core v${parsed.join(".")}, older than v${floor}. ` +
      `Since block 969,320 the network ignores reveals composed by such a node ` +
      `(require_reveal_source_signature), so nothing was composed. The node must be upgraded.`
    );
  }
  return null;
}

export class OutdatedNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutdatedNodeError";
  }
}
