/**
 * Relaying a signed transaction when the wallet will not.
 *
 * Horizon Wallet has no broadcast method — it signs and hands the bytes back.
 * First hop is our own node: Counterparty Core proxies `sendrawtransaction`
 * at `POST /v2/bitcoin/transactions` (not to be confused with `compose/
 * broadcast`, which composes Counterparty's *broadcast message* type), reached
 * through the same-origin proxy. If that fails for any reason other than a
 * verdict on the transaction itself, the bytes go to an Esplora server, a
 * plain `POST /api/tx` returning the txid as text — two hosts, in order,
 * because a single relay is a single point of failure at the exact moment it
 * matters: after the user has signed.
 */

import { Transaction } from "@scure/btc-signer";

const HOSTS = ["https://mempool.space/api", "https://blockstream.info/api"] as const;

const TXID = /^[0-9a-f]{64}$/i;

/**
 * Rejections that mean the transaction is already relayed.
 *
 * This is success, not failure, and it is a case that genuinely happens: a
 * retry after a timeout, or a second host that already saw it. Bitcoin Core
 * words it several ways and **none of them include the txid** — an
 * already-confirmed transaction comes back as
 * `-27: Transaction outputs already in utxo set`, with nothing to parse — which
 * is why the id is computed from the bytes instead of scraped from the reply.
 */
const ALREADY_RELAYED =
  /already[- ](in|known|have)|txn-already|duplicate|outputs already|transaction already/i;

/** The txid of a finalized raw transaction, computed rather than trusted. */
function txidOf(rawHex: string): string | null {
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

/** Our own node, through the proxy. Returns the txid, or throws with the node's reason. */
export async function broadcastViaNode(rawHex: string): Promise<string> {
  const res = await fetch("/api/cp/bitcoin/transactions", {
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
  throw new Error(`node: ${reason}`);
}

/**
 * Node first, Esplora after. A rejection that names the transaction as the
 * problem (Bitcoin Core policy — a `RPC error`, a mempool rule) is final and
 * is not retried elsewhere; an unreachable or misconfigured node is.
 */
export async function broadcastTransaction(rawHex: string): Promise<string> {
  try {
    return await broadcastViaNode(rawHex);
  } catch (cause) {
    const message = (cause as Error).message;
    if (/RPC error|min relay fee|mempool|non-mandatory|bad-txns|dust/i.test(message)) throw cause;
    try {
      return await broadcastViaEsplora(rawHex);
    } catch (fallback) {
      throw new Error(`${message}\n${(fallback as Error).message}`);
    }
  }
}

export async function broadcastViaEsplora(rawHex: string): Promise<string> {
  const expected = txidOf(rawHex);
  const failures: string[] = [];

  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/tx`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: rawHex,
      });
      const body = (await res.text()).trim();

      if (res.ok && TXID.test(body)) return body;

      if (ALREADY_RELAYED.test(body)) {
        const named = body.match(/[0-9a-f]{64}/i)?.[0];
        const txid = named ?? expected;
        // Only claim success if we can actually name the transaction. Without
        // an id there is nothing to hand the caller to follow.
        if (txid) return txid;
      }

      failures.push(`${host}: ${body.slice(0, 200)}`);

      // A rejection from Bitcoin Core itself is a verdict on the transaction,
      // not on the host. The second relay runs the same policy and will say the
      // same thing, so there is nothing to gain by asking it.
      if (/RPC error/i.test(body)) break;
    } catch (cause) {
      // A network failure IS worth trying the other host for.
      failures.push(`${host}: ${(cause as Error).message}`);
    }
  }

  throw new Error(
    `Could not relay the transaction${expected ? ` (${expected})` : ""}. It is signed, so it can be ` +
      `submitted again.\n${failures.join("\n")}`,
  );
}
