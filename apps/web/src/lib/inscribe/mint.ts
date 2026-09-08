/**
 * Mint a counter: put a file in Bitcoin's witness data and issue the
 * Counterparty asset that owns it, in one commit/reveal pair.
 *
 * This is the whole protocol, and it is short because Counterparty does the
 * work. A counter is an asset whose *description is the file*, carried in a
 * v11 taproot envelope. Compose an issuance with `inscription=true`, a
 * `mime_type` and the bytes as `description`, and the reveal that lands is a
 * counter — the indexer numbers it, gap-free, in the order it reached the
 * chain. No new opcodes, no side registry.
 *
 * ORDER MATTERS, and not the way it first appears. The commit is broadcast
 * BEFORE the reveal is signed. Signing both first is safer in principle, but
 * XCP Wallet cannot complete a signature for an input whose parent it cannot
 * find: it blocks on a lookup for a commit that is not broadcast, reports
 * "could not independently verify previous transaction", and by the time the
 * prompt is usable Chrome has idled out the extension's MV3 service worker and
 * dropped the request.
 *
 * The cost of that ordering is that an unsigned reveal parks the commit's
 * coins. It is recoverable, because the re-keyed leaf names the *user's* key
 * rather than Core's discarded one: the reveal can be rebuilt and re-signed as
 * many times as it takes. {@link RevealPendingError} carries everything needed
 * to try again, and the PSBT is handed to the caller before the commit goes
 * out so it can be stashed somewhere durable first.
 */

import { RawTx } from "@scure/btc-signer";
import { commitEnvelope, bytesToHex, hexToBytes, reKeyEnvelope } from "./envelope";
import { encodeContent } from "./content";
import {
  type ComposeResult,
  buildCommitPsbt,
  buildRevealPsbt,
  detectOrdEnvelope,
  commitTopUp,
  finalize,
  unsignedRevealTxid,
} from "./psbt";
import { STANDARD_WITNESS_LIMIT_WU } from "@/lib/constants";

/**
 * The wallet this needs, as the adapter defines it — see lib/wallet/adapter.ts.
 * Both XCP Wallet and Horizon Wallet satisfy it, and the differences that
 * matter (XCP requires the inscription context to approve a commit; Horizon
 * cannot broadcast) are handled inside their adapters rather than here.
 */
import type { WalletAdapter } from "@/lib/wallet/adapter";
export type SigningWallet = WalletAdapter;

/**
 * Which envelope carries the message.
 *
 * `counterparty` is Core's native envelope; `counterparty/ord` additionally
 * wraps it in an ordinals-compatible one, so the same reveal is numbered by
 * ord indexers too. Both produce a valid counter — the counters protocol reads
 * the `CNTRPRTY` marker in the reveal's OP_RETURN and does not care which
 * envelope style carries the description. Roughly 39% of the existing index is
 * ord-style.
 *
 * The ordinals-*native* metadata map is deliberately absent: Counterparty's
 * parser does not read it on mainnet (it activates at a 999,999,999
 * placeholder), so a mint in that style is numbered as an ordinal and creates
 * no asset at all.
 */
export type EnvelopeStyle = "counterparty" | "counterparty/ord";

export interface MintRequest {
  /** The address issuing the asset. Must be taproot to hold the commit. */
  source: string;
  /** The signer's x-only taproot output key — what the leaf gets re-keyed to. */
  sourceXOnly: Uint8Array;
  /** A named asset (0.5 XCP burn), a subasset, or "" for a free numeric one. */
  asset: string;
  /** The file's bytes. These become the asset's description, verbatim. */
  body: Uint8Array;
  /** MIME committed to by the envelope — it cannot be corrected later. */
  mimeType: string;
  /** Raw units. 0 issues the asset with no supply, which is still a counter. */
  quantity: bigint;
  divisible: boolean;
  lockQuantity: boolean;
  satPerVbyte: number;
  envelope: EnvelopeStyle;
}

export type MintStage =
  | "composing"
  | "signing-commit"
  | "broadcasting-commit"
  | "signing-reveal"
  | "broadcasting-reveal"
  | "done";

export interface MintPlan {
  commitAddress: string;
  commitValue: number;
  commitFee: number;
  revealFee: number;
  totalFee: number;
  commitTxid: string;
  revealTxid: string;
  commitHex: string;
  revealHex: string;
  leafBytes: number;
  revealWeight: number;
}

export interface MintResult extends MintPlan {
  commitBroadcast: string;
  revealBroadcast: string;
}

/* -------------------------------------------------------------------- */
/* Compose                                                              */
/* -------------------------------------------------------------------- */

/**
 * Compose the inscribed issuance.
 *
 * `encoding=taproot` is what makes the description land in witness data, and
 * it is the only encoding that can produce a counter: classic OP_RETURN
 * Counterparty data is ARC4-encrypted with the first input's prevout txid, so
 * it can never show the literal `CNTRPRTY` marker the counters protocol
 * requires.
 */
async function composeInscribedIssuance(req: MintRequest): Promise<ComposeResult> {
  const { description } = encodeContent(req.body, req.mimeType);

  const params = new URLSearchParams({
    asset: req.asset,
    quantity: req.quantity.toString(),
    divisible: String(req.divisible),
    lock: String(req.lockQuantity),
    description,
    mime_type: req.mimeType,
    encoding: "taproot",
    inscription: String(req.envelope === "counterparty/ord"),
    sat_per_vbyte: String(req.satPerVbyte),
    verbose: "true",
    // A UTXO carrying an asset balance is not a coin to spend on fees; moving
    // it would move the balance with it.
    exclude_utxos_with_balances: "true",
  });

  // POST, not GET: the description *is* the file, and a 200 KB PNG does not fit
  // in a query string.
  const res = await fetch(
    `/api/cp/addresses/${encodeURIComponent(req.source)}/compose/issuance`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
  );

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `Counterparty refused the compose (${res.status})`);
  }
  return body.result as ComposeResult;
}

/* -------------------------------------------------------------------- */
/* Mint                                                                 */
/* -------------------------------------------------------------------- */

export async function mintCounter(
  wallet: SigningWallet,
  req: MintRequest,
  onStage?: (stage: MintStage) => void,
  onRevealPsbt?: (psbt: string, plan: MintPlan) => void | Promise<void>,
): Promise<MintResult> {
  onStage?.("composing");
  const compose = await composeInscribedIssuance(req);

  if (!compose.envelope_script || !compose.signed_reveal_rawtransaction) {
    throw new Error(
      "Core returned no commit/reveal pair. The node must be v11+ with taproot envelopes enabled.",
    );
  }

  // Core applies `inscription` only to content-carrying issuances and otherwise
  // falls back to its own envelope WITHOUT saying so. The style is committed to
  // by the commit address, so it cannot be corrected later — check now, while
  // nothing has been signed.
  const wantOrd = req.envelope === "counterparty/ord";
  const isOrd = detectOrdEnvelope(hexToBytes(compose.envelope_script));
  if (isOrd !== wantOrd) {
    throw new Error(
      `Core built a ${isOrd ? "counterparty + ord" : "counterparty native"} envelope, not the ` +
        `${wantOrd ? "counterparty + ord" : "counterparty native"} one requested. Nothing was signed.`,
    );
  }

  const leaf = reKeyEnvelope(hexToBytes(compose.envelope_script), req.sourceXOnly);
  const commit = commitEnvelope(leaf);
  const valueDelta = commitTopUp(compose, req.satPerVbyte);

  const {
    psbt: commitPsbt,
    commitValue,
    commitIndex,
  } = buildCommitPsbt(compose, commit.script, valueDelta);

  onStage?.("signing-commit");
  // The inscription context is what gets XCP Wallet past its own gate on BTC
  // moving for reasons the bytes cannot prove: it verifies that the internal
  // key is NUMS and that the leaf's key is this signer's. Horizon Wallet needs
  // no such context and its adapter drops it, so it is always passed.
  const signedCommit = await wallet.signPsbt(
    commitPsbt,
    { [req.source]: compose.inputs_values.map((_, i) => i) },
    {
      revealScript: bytesToHex(commit.leaf),
      tapInternalKey: bytesToHex(commit.internalKey),
    },
  );
  const commitFinal = finalize(signedCommit);

  const revealPsbt = buildRevealPsbt(compose, commitFinal.txid, commitIndex, commitValue, commit);

  // Core's reveal outputs are reproduced verbatim, so its values give the
  // reveal's fee before we hold a signed reveal of our own.
  const revealOut = revealOutputTotal(compose);

  const plan: MintPlan = {
    commitAddress: commit.address,
    commitValue,
    commitFee: compose.btc_fee,
    revealFee: commitValue - revealOut,
    totalFee: compose.btc_fee + (commitValue - revealOut),
    commitTxid: commitFinal.txid,
    revealTxid: unsignedRevealTxid(revealPsbt),
    commitHex: commitFinal.hex,
    revealHex: "",
    leafBytes: leaf.length,
    revealWeight: 0,
  };

  // Hand the reveal PSBT out before any money moves. If the caller writes it
  // somewhere durable, a mint is never unrecoverable — the leaf names the
  // user's key, so this PSBT can be re-signed at any point in the future.
  await onRevealPsbt?.(revealPsbt, plan);

  onStage?.("broadcasting-commit");
  const commitTxid = await wallet.broadcast(commitFinal.hex);

  onStage?.("signing-reveal");
  try {
    const reveal = await finishReveal(wallet, req.source, revealPsbt, onStage);
    onStage?.("done");
    return {
      ...plan,
      revealTxid: reveal.txid,
      revealHex: reveal.hex,
      revealWeight: reveal.weight,
      commitBroadcast: commitTxid || plan.commitTxid,
      revealBroadcast: reveal.txid,
    };
  } catch (cause) {
    throw new RevealPendingError(
      { ...plan, commitBroadcast: commitTxid || plan.commitTxid, revealBroadcast: "" },
      revealPsbt,
      cause,
    );
  }
}

/**
 * Sign the reveal and broadcast it. Separate so it can be retried on its own.
 *
 * The failure this exists for is usually not a bad transaction — it is Chrome
 * dropping the extension's pending signing request when its MV3 service worker
 * idles out ("Signing request not found or no longer pending"). Nothing about
 * the PSBT changes between attempts, so pressing the button again is the
 * entire remedy.
 */
export async function finishReveal(
  wallet: SigningWallet,
  source: string,
  revealPsbt: string,
  onStage?: (stage: MintStage) => void,
): Promise<{ txid: string; hex: string; weight: number }> {
  // The reveal is a taproot script-path spend: the wallet signs input 0 against
  // the tapleaf that names its own key. Both wallets handle `tapLeafScript` —
  // it is the reason the envelope was re-keyed in the first place.
  const signed = await wallet.signPsbt(revealPsbt, { [source]: [0] });
  const final = finalize(signed);

  // A reveal past the standard relay cap will not propagate no matter how it is
  // fee-rated — the limit is policy on witness weight, not price. Saying so
  // beats a broadcast that silently goes nowhere.
  if (final.weight > STANDARD_WITNESS_LIMIT_WU) {
    throw new NonStandardRevealError(final.weight, final.hex);
  }

  onStage?.("broadcasting-reveal");
  const txid = await wallet.broadcast(final.hex);
  return { txid: txid || final.txid, hex: final.hex, weight: final.weight };
}

/** What Core's reveal pays out — everything above it in the commit is fee. */
function revealOutputTotal(compose: ComposeResult): number {
  return RawTx.decode(hexToBytes(compose.signed_reveal_rawtransaction!)).outputs.reduce(
    (sum, o) => sum + Number(o.amount),
    0,
  );
}

/**
 * The commit is on chain and the reveal is not. Recoverable, and the fields
 * here are what recovery needs: re-sign `revealPsbt` and broadcast.
 */
export class RevealPendingError extends Error {
  constructor(
    readonly result: MintResult,
    readonly revealPsbt: string,
    readonly cause: unknown,
  ) {
    super(
      "The commit is confirmed but the reveal was not broadcast. Nothing is lost — the reveal " +
        "can be signed again.",
    );
    this.name = "RevealPendingError";
  }
}

/**
 * A reveal over 400,000 weight units. Standard relay will not carry it at any
 * fee rate; it needs a direct-to-miner route (MARA Slipstream), which is how
 * the multi-megabyte counters in the index were mined.
 */
export class NonStandardRevealError extends Error {
  constructor(
    readonly weight: number,
    readonly hex: string,
  ) {
    super(
      `This reveal is ${weight.toLocaleString("en-US")} weight units, past the ` +
        `${STANDARD_WITNESS_LIMIT_WU.toLocaleString("en-US")} standard relay cap. It needs a ` +
        "direct-to-miner route, not a higher fee.",
    );
    this.name = "NonStandardRevealError";
  }
}
