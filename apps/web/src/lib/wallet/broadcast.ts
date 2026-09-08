/**
 * Relaying a signed transaction when the wallet will not.
 *
 * Horizon Wallet has no broadcast method — it signs and hands the bytes back.
 * They go to this site's own node: Counterparty Core proxies bitcoind's
 * `sendrawtransaction` at `POST /v2/bitcoin/transactions` (not to be confused
 * with `compose/broadcast`, which composes Counterparty's *broadcast message*
 * type), reached through the same-origin proxy. There is no second, public
 * relay: the operator's node is the only one this site speaks to, and a
 * signed transaction is never sent anywhere else.
 */

import { Transaction } from "@scure/btc-signer";

const TXID = /^[0-9a-f]{64}$/i;

/**
 * Rejections that mean the transaction is already relayed.
 *
 * This is success, not failure, and it is a case that genuinely happens: a
 * retry after a timeout. Bitcoin Core words it several ways and **none of
 * them include the txid** — an already-confirmed transaction comes back as
 * `-27: Transaction outputs already in utxo set`, with nothing to parse —
 * which is why the id is computed from the bytes instead of scraped.
 */
const ALREADY_RELAYED =
  /already[- ](in|known|have)|txn-already|duplicate|outputs already|transaction already/i;

/** The txid of a finalized raw transaction, computed rather than trusted. */
export function txidOf(rawHex: string): string | null {
  try {
    return Transaction.fromRaw(hexToBytes(rawHex), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    }).id;
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Relay through the node. `base` is the same-origin proxy in the browser;
 * tests pass the node's own `/v2` root. Returns the txid, or throws with the
 * node's reason — including the fee-floor ones, which are final here since
 * there is nowhere else to try.
 */
export async function broadcastViaNode(rawHex: string, base = "/api/cp"): Promise<string> {
  const res = await fetch(`${base}/bitcoin/transactions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ signedhex: rawHex }).toString(),
  });
  const body = (await res.text()).trim();
  let parsed: { result?: unknown; error?: unknown } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON — fall through to the generic error below.
  }
  if (res.ok && typeof parsed.result === "string" && TXID.test(parsed.result)) return parsed.result;
  const reason = typeof parsed.error === "string" ? parsed.error : body.slice(0, 200);
  if (ALREADY_RELAYED.test(reason)) {
    const txid = reason.match(/[0-9a-f]{64}/i)?.[0] ?? txidOf(rawHex);
    if (txid) return txid;
  }
  const expected = txidOf(rawHex);
  throw new Error(
    `Could not relay the transaction${expected ? ` (${expected})` : ""}. It is signed, so it can be ` +
      `submitted again.\nnode: ${reason}`,
  );
}

/** The one relay path. Kept as a separate name so callers read as intent, not mechanism. */
export function broadcastTransaction(rawHex: string): Promise<string> {
  return broadcastViaNode(rawHex);
}
