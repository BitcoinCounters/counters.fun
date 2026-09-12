/**
 * The browser's view of Counterparty Core, through the same-origin proxy.
 *
 * One rule runs through every helper: a 404 is an answer ("no such pool",
 * "no such asset") and anything else is not. The old helpers folded both
 * into `null`/`0`, so a proxy outage read as "no pool exists — this deposit
 * sets the price" — a claim about someone's money made because a request
 * failed. Here a failure throws, and the forms say "could not check".
 */

import { parseJsonLossless, type Raw, big } from "@counters/core/numeric";
import type { ComposeResult } from "@/lib/inscribe/psbt";

export class CpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CpError";
  }
}

/** The node answered, and the answer is "no such thing". */
export class CpNotFound extends CpError {
  constructor(path: string) {
    super(`not found: ${path}`, 404);
    this.name = "CpNotFound";
  }
}

async function parse<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  let body: { result?: T; error?: string } = {};
  try {
    body = parseJsonLossless(text);
  } catch {
    // Not JSON — the proxy or the node fell over mid-reply.
  }
  if (res.status === 404) throw new CpNotFound(path);
  if (!res.ok) throw new CpError(body.error ?? `Counterparty said ${res.status}`, res.status);
  return body.result as T;
}

export async function cpGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/cp/${path}`, { cache: "no-store" });
  return parse<T>(res, path);
}

/** A compose. Parameters go as a form body so a file-sized description fits. */
export async function cpCompose(
  address: string,
  type: string,
  params: Record<string, string> | URLSearchParams,
): Promise<ComposeResult> {
  const body = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const path = `addresses/${encodeURIComponent(address)}/compose/${type}`;
  const res = await fetch(`/api/cp/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return parse<ComposeResult>(res, path);
}

/* -------------------------------------------------------------------- */
/* Reads the forms pre-flight with                                      */
/* -------------------------------------------------------------------- */

export interface AssetInfo {
  asset: string;
  asset_longname: string | null;
  owner: string;
  issuer: string;
  divisible: boolean;
  locked: boolean;
  description_locked?: boolean;
  supply: Raw;
  mime_type?: string | null;
  first_issuance_block_index?: number;
}

/** The asset, or null when nobody has issued it. Throws on anything else. */
export async function fetchAsset(asset: string): Promise<AssetInfo | null> {
  try {
    return await cpGet<AssetInfo>(`assets/${encodeURIComponent(asset)}`);
  } catch (cause) {
    if (cause instanceof CpNotFound) return null;
    throw cause;
  }
}

/** One address's balance of one asset, raw. Zero rows is zero; a failure throws. */
export async function fetchBalance(address: string, asset: string): Promise<bigint> {
  const rows = await cpGet<{ quantity: Raw }[]>(
    `addresses/${encodeURIComponent(address)}/balances/${encodeURIComponent(asset)}?type=address`,
  );
  return rows.reduce((sum, r) => sum + big(r.quantity), 0n);
}

/**
 * One asset an address owns, as the reinscribe picker needs it: everything but
 * the file. `/api/owned` pages Counterparty and strips the descriptions, which
 * for inscribed assets are megabytes of image.
 */
export interface OwnedAsset {
  asset: string;
  asset_longname: string | null;
  divisible: boolean;
  locked: boolean;
  supply: string;
  description_locked: boolean;
  mime_type: string | null;
  /** Size of the description on chain, in bytes. 0 means it has none. */
  description_bytes: number;
  last_issuance_block_index: number | null;
}

/** Everything the address owns, newest issuance first. Throws on a failure. */
export async function fetchOwnedAssets(address: string): Promise<OwnedAsset[]> {
  const path = `owned?address=${encodeURIComponent(address)}`;
  const res = await fetch(`/api/${path}`, { cache: "no-store" });
  return parse<OwnedAsset[]>(res, path);
}

export interface BtcFunds {
  confirmed: bigint;
  unconfirmed: bigint;
  utxos: number;
}

/** Spendable satoshis at an address, from the node's own bitcoind. */
export async function fetchBtcFunds(address: string): Promise<BtcFunds> {
  const rows = await cpGet<{ value: number; status?: { confirmed?: boolean } }[]>(
    `bitcoin/addresses/${encodeURIComponent(address)}/utxos?unconfirmed=true`,
  );
  let confirmed = 0n;
  let unconfirmed = 0n;
  for (const u of rows) {
    if (u.status?.confirmed === false) unconfirmed += BigInt(u.value);
    else confirmed += BigInt(u.value);
  }
  return { confirmed, unconfirmed, utxos: rows.length };
}

/**
 * Does this node know the transaction?
 *
 * Asked after a broadcast, because "the relay returned a txid" and "the
 * transaction exists" are not the same claim — a wallet's own backend answered
 * one with a txid for a reveal that never reached any mempool, and the app
 * reported a finished mint over a commit that sat mined and unspent. A 404
 * here is a real answer: this node has never seen it.
 */
export async function nodeKnowsTransaction(txid: string): Promise<boolean> {
  try {
    await cpGet<string>(`bitcoin/transactions/${encodeURIComponent(txid)}?result_format=hex`);
    return true;
  } catch (cause) {
    if (cause instanceof CpNotFound) return false;
    // Anything else is the node failing to answer, which is not an answer.
    throw cause;
  }
}

/** The chain tip Counterparty has parsed to. */
export async function fetchTip(): Promise<number> {
  const block = await cpGet<{ block_index: number }>("blocks/last");
  return block.block_index;
}

/** The fairminters that deployed an asset, newest first. Empty when none. */
export async function fetchAssetFairminters<T = Record<string, unknown>>(asset: string): Promise<T[]> {
  try {
    return await cpGet<T[]>(`assets/${encodeURIComponent(asset)}/fairminters?verbose=true`);
  } catch (cause) {
    if (cause instanceof CpNotFound) return [];
    throw cause;
  }
}
