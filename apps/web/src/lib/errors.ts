/**
 * What to tell a person when something the node or a wallet said goes wrong.
 *
 * Core's messages are for developers — `['insufficient funds']` is a Python
 * list, and `No UTXOs found for bc1p…, provide UTXOs with the inputs_set
 * parameter` names an API parameter the person has never heard of. Each
 * known message is mapped to a sentence that says what to do about it; an
 * unknown one is shown as is, because a guess dressed as an explanation is
 * worse than the raw text.
 */

import { UserRejectedError, NotConnectedError } from "@/lib/wallet/adapter";
import { CpNotFound } from "@/lib/cp";
import { copy } from "@content/copy";

const KNOWN: [RegExp, keyof typeof copy.errors][] = [
  [/user (rejected|denied|cancel)/i, "cancelled"],
  [/insufficient funds/i, "insufficientBtc"],
  [/No UTXOs found/i, "noUtxos"],
  [/insufficient balance of ([A-Z0-9.]+)/i, "insufficientAsset"],
  [/slippage protection/i, "slippage"],
  [/Invalid mime type|not a valid mime/i, "badMime"],
  [/numeric asset name not in range/i, "numericRange"],
  [/too short|too long|invalid asset name|non-alphabetic|starts with|must not/i, "badAssetName"],
  [/parent asset owned by another address/i, "notParentOwner"],
  [/issued by another address/i, "notOwner"],
  [/Cannot update a locked description|description.*locked/i, "descriptionLocked"],
  [/locked asset|quantity.*locked|Cannot issue more/i, "supplyLocked"],
  [/already in use|earmarked by an active fairminter/i, "lpAssetTaken"],
  [/Odd-length string|converting description to bytes/i, "badHex"],
  [/Counterparty is unreachable|failed to fetch|NetworkError|ECONNREFUSED/i, "unreachable"],
  [/not proxied/i, "notProxied"],
  [/start_block.*(past|must)|start block/i, "startBlock"],
  [/RPC error|min relay fee|mempool|bad-txns|non-mandatory/i, "relayRejected"],
];

/** A sentence for the form, plus the raw text for the person who wants it. */
export function describeError(cause: unknown): { message: string; detail: string | null } {
  if (cause instanceof UserRejectedError) return { message: copy.errors.cancelled(), detail: null };
  if (cause instanceof NotConnectedError) return { message: copy.errors.notConnected(), detail: null };
  if (cause instanceof CpNotFound) return { message: copy.errors.notFound(), detail: cause.message };

  const raw = cause instanceof Error ? cause.message : String(cause);
  for (const [pattern, key] of KNOWN) {
    const match = raw.match(pattern);
    if (match) {
      const render = copy.errors[key] as (arg?: string) => string;
      return { message: render(match[1]), detail: raw };
    }
  }
  return { message: raw, detail: null };
}

/** True when the failure was the person changing their mind, not a fault. */
export function isCancellation(cause: unknown): boolean {
  if (cause instanceof UserRejectedError) return true;
  const raw = cause instanceof Error ? cause.message : String(cause);
  return /user (rejected|denied|cancel)/i.test(raw);
}

/**
 * Tell the local error log about a failure the UI is handling.
 *
 * The window listeners in `DevErrorReporter` see only what nothing caught,
 * and a mint that fails is caught by definition: the form shows the sentence
 * and carries on. So the log — and anyone tailing it — saw a working page
 * while the person in front of it was reading "Request failed". Every form
 * that puts an error on screen reports it here first.
 *
 * Development only; the route it posts to does not exist in a production
 * build. Never throws and never awaits anything the caller depends on.
 */
export function reportHandled(kind: string, cause: unknown, detail?: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return;
  const raw = cause instanceof Error ? cause.message : String(cause);
  try {
    void fetch("/api/dev-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: `handled ${kind}`,
        message: detail ? `${raw} · ${JSON.stringify(detail)}` : raw,
        url: window.location.pathname,
        stack: cause instanceof Error ? cause.stack : undefined,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // The log is a convenience; it never gets in the way of the failure it
    // is describing.
  }
}
