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

import { RawTx, Transaction } from "@scure/btc-signer";
import { commitEnvelope, bytesToHex, hexToBytes, reKeyEnvelope } from "./envelope";
import { encodeContent } from "./content";
import {
  type ComposeResult,
  buildCommitPsbt,
  buildPlainPsbt,
  buildRevealPsbt,
  detectOrdEnvelope,
  commitTopUp,
  finalize,
  unsignedRevealTxid,
} from "./psbt";
import { STANDARD_WITNESS_LIMIT_WU } from "@/lib/constants";
import { cpCompose, fetchAsset, type AssetInfo } from "@/lib/cp";
import { randomNumericAsset } from "@counters/core/assetnames";
import { HARD_MIN_RATE } from "@counters/core/fees";
import { MAX_WEIGHT, meetsFloor, routeFor } from "@counters/core/slipstream";
import { handOffReveal, slipstreamRates } from "@/lib/slipstream";
import { fairminterComposeParams, fairminterProblems, type FairminterParams } from "@counters/core/fairminter";

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

/**
 * Three things a mint can be. They share the whole commit/reveal path and
 * differ only in what is composed:
 *
 * - `counter`: a new asset whose description is the file (compose/issuance).
 * - `reinscribe`: an existing asset of yours gets a new file; quantity 0, so
 *   supply is untouched (compose/issuance again — Core treats an issuance of
 *   an existing asset as a reissuance).
 * - `fairminter`: a fairminter deploy whose description is the file
 *   (compose/fairminter). The deploy is itself the counter. XCP-69 is this
 *   with every parameter fixed to xcp.fun's template; `custom` is the same
 *   transaction with the parameters the person chose.
 */
export type MintMode = "counter" | "reinscribe" | "fairminter";

/** Where a signed reveal is sent. See `MintRequest.route`. */
export type RevealRoute = "public" | "slipstream";
export type FairminterPreset = "xcp69" | "custom";

export interface MintRequest {
  mode: MintMode;
  /** The address issuing the asset. Must be taproot to hold the commit. */
  source: string;
  /** The signer's x-only taproot output key — what the leaf gets re-keyed to. */
  sourceXOnly: Uint8Array;
  /**
   * A named asset (0.5 XCP burn), a subasset, a numeric name, or "" to have
   * a free numeric one drawn here. Core never picks a name itself — an empty
   * name is refused as "too short" — so the draw has to happen client-side.
   */
  asset: string;
  /** The file's bytes. These become the asset's description, verbatim. */
  body: Uint8Array;
  /** MIME committed to by the envelope — it cannot be corrected later. */
  mimeType: string;
  /**
   * `counter` only. Raw units; 0 issues the asset with no supply, which is
   * still a counter. A fairminter takes its supply from `fairminter`, and a
   * reinscription takes it from the asset — see {@link supplyParams}.
   */
  quantity: bigint;
  /** `counter` only. A reinscription copies the asset's own divisibility. */
  divisible: boolean;
  /** `counter` only. A reinscription never touches the supply lock. */
  lockQuantity: boolean;
  satPerVbyte: number;
  envelope: EnvelopeStyle;
  /**
   * Where the reveal goes. `public` is this node's own relay; `slipstream`
   * hands it to MARA, which is the ONLY route for a reveal past the standard
   * relay cap and an option for any other. Defaults to `public`.
   *
   * A Slipstream reveal cannot be sent when it is signed: MARA prices a reveal
   * from the chain and from its own submissions, never from the public mempool,
   * so the commit must be MINED first. Choosing this route for a mint that did
   * not need it therefore buys a confirmation wait the public path does not
   * have.
   */
  route?: RevealRoute;
  /** fairminter only: which shape, for the receipt and the xcp.fun link. */
  preset?: FairminterPreset;
  /** fairminter only: the sale, in raw units. Built by the form from the preset or its fields. */
  fairminter?: FairminterParams;
}

export type MintStage =
  | "checking"
  | "composing"
  | "signing-commit"
  | "broadcasting-commit"
  | "signing-reveal"
  /** Slipstream only: MARA cannot price the reveal until the commit is mined. */
  | "awaiting-commit"
  | "broadcasting-reveal"
  | "done";

export interface MintPlan {
  mode: MintMode;
  /** The name actually composed — the drawn one when the request left it empty. */
  asset: string;
  /** fairminter: what was deployed. */
  preset?: FairminterPreset;
  fairminter?: FairminterParams;
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
  /** Core's adjusted vsize for the commit — what `commitFee` was computed over. */
  commitVsize: number;
  /** Value of the reveal's outputs (0 native, 546 ord); the rest of the commit is fee. */
  revealOutputs: number;
}

export interface MintResult extends MintPlan {
  commitBroadcast: string;
  revealBroadcast: string;
}

/* -------------------------------------------------------------------- */
/* Compose                                                              */
/* -------------------------------------------------------------------- */

/**
 * Compose the inscribed transaction for the mode.
 *
 * `encoding=taproot` is what makes the description land in witness data, and
 * it is the only encoding that can produce a counter: classic OP_RETURN
 * Counterparty data is ARC4-encrypted with the first input's prevout txid, so
 * it can never show the literal `CNTRPRTY` marker the counters protocol
 * requires.
 */
async function composeMint(req: MintRequest): Promise<{ compose: ComposeResult; asset: string; lpAsset?: string }> {
  // Core accepts 0 and composes a fee-less commit. Refused here, last of all.
  if (!(req.satPerVbyte >= HARD_MIN_RATE)) throw new Error("The fee rate must be above zero.");
  const { description } = encodeContent(req.body, req.mimeType);
  const asset = req.asset || randomNumericAsset();

  const common: Record<string, string> = {
    description,
    mime_type: req.mimeType,
    encoding: "taproot",
    inscription: String(req.envelope === "counterparty/ord"),
    sat_per_vbyte: String(req.satPerVbyte),
    verbose: "true",
    // A UTXO carrying an asset balance is not a coin to spend on fees; moving
    // it would move the balance with it.
    exclude_utxos_with_balances: "true",
  };

  if (req.mode === "fairminter") {
    if (!req.fairminter) throw new Error("A fairminter deploy needs its parameters.");
    const problems = fairminterProblems(req.fairminter);
    if (problems.length > 0) throw new Error(problems.join("; "));
    // The LP name is drawn here when a pool is wanted and none was given, so
    // the receipt can show what the pool's token will be.
    const lpAsset = req.fairminter.poolQuantity > 0n ? req.fairminter.lpAsset || randomNumericAsset() : undefined;
    const compose = await cpCompose(req.source, "fairminter", {
      ...fairminterComposeParams({ ...req.fairminter, lpAsset }, asset),
      ...common,
    });
    return { compose, asset, lpAsset };
  }

  // A reinscription is composed against the asset as it already is, so the
  // asset has to be read first.
  const existing = req.mode === "reinscribe" ? await fetchAsset(asset) : null;

  const compose = await cpCompose(req.source, "issuance", {
    asset,
    ...supplyParams(req, existing),
    ...common,
  });
  return { compose, asset };
}

/**
 * What an issuance says about supply — and, for a reinscription, why none of
 * it comes from the form.
 *
 * Counterparty reads a reinscription as a *reissuance*, and a reissuance may
 * not change the asset: `divisible` has to equal what the asset already is or
 * Core refuses the compose with `cannot change divisibility`, and `lock` is
 * the supply lock, which is permanent. Leaving them out is not an option
 * either — Core defaults a missing `divisible` to **true** and would fail the
 * same way on an indivisible asset.
 *
 * So a reinscription sends quantity 0, the asset's own divisibility, and no
 * new lock: the description is the only thing that changes. The form does not
 * show supply fields in this mode, and this makes sure whatever they happen to
 * hold cannot reach the wire — including the supply lock, which defaults to on
 * and would otherwise freeze the asset's supply forever as a side effect of
 * putting a new file on it.
 */
export function supplyParams(
  req: Pick<MintRequest, "mode" | "quantity" | "divisible" | "lockQuantity">,
  existing: Pick<AssetInfo, "divisible"> | null,
): Record<string, string> {
  if (req.mode !== "reinscribe") {
    return { quantity: req.quantity.toString(), divisible: String(req.divisible), lock: String(req.lockQuantity) };
  }
  if (!existing) throw new Error("A reinscription needs an asset that already exists.");
  return { quantity: "0", divisible: String(existing.divisible), lock: "false" };
}

/**
 * The reveal's weight, known before anything is signed.
 *
 * Core's `signed_reveal_rawtransaction` is a complete reveal with its own
 * (discarded) key's signature, and the re-keyed reveal has the same shape —
 * only the 32-byte key inside the leaf changes, never the length. The one
 * byte of difference is the sighash flag: Core signs SIGHASH_DEFAULT (64-byte
 * signature), the wallet signs SIGHASH_ALL (65). So this is exact, not an
 * estimate, and it is what lets a >400k WU reveal be refused before the
 * commit has cost anyone anything.
 */
export function revealWeightOf(compose: ComposeResult): number {
  const tx = Transaction.fromRaw(hexToBytes(compose.signed_reveal_rawtransaction!), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
  return tx.weight + 1;
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
  // Slipstream's ACCEPTANCE floor, checked before composing because the commit
  // output is sized here for the reveal's fee and cannot be resized once the
  // commit is on chain. `submitFloor` is the gate; `mineable` is only how long
  // the wait will be. A rate between them is accepted and then waits for the
  // market — legitimate, and not something to silently round away — but a rate
  // BELOW the floor buys a reveal MARA will never take, with the commit spent.
  if (req.route === "slipstream") {
    const rates = await slipstreamRates().catch(() => null);
    if (rates && !meetsFloor(req.satPerVbyte, rates)) {
      throw new BelowSlipstreamFloorError(req.satPerVbyte, rates.submitFloor, rates.mineable);
    }
  }

  onStage?.("composing");
  const { compose, asset, lpAsset } = await composeMint(req);
  const fairminter = req.fairminter ? { ...req.fairminter, lpAsset } : undefined;

  if (!compose.envelope_script || !compose.signed_reveal_rawtransaction) {
    throw new Error(
      "Core returned no commit/reveal pair. The node must be v11+ with taproot envelopes enabled.",
    );
  }

  // Decided here, before the commit exists, rather than after it is on chain.
  // Past the standard relay cap the public network will not carry the reveal at
  // any fee rate — the limit is policy on witness weight, not price — so the
  // choice of route has to be settled while nothing has been signed.
  const revealWeight = revealWeightOf(compose);
  const fit = routeFor(revealWeight);
  if (fit === "too-large") {
    // Beyond MARA's own policy cap. No route exists; refuse before spending.
    throw new OversizedRevealError(revealWeight);
  }
  if (fit === "slipstream-only" && req.route !== "slipstream") {
    throw new NonStandardRevealError(revealWeight, "");
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
  // How a commit gets past a wallet's gate on BTC moving for reasons the bytes
  // cannot prove is the wallet's business, not this file's: the adapter is
  // handed the envelope AND the output, and picks whichever its wallet can
  // check. See `signCommit` in the adapter contract.
  const signedCommit = await wallet.signCommit(
    commitPsbt,
    { [req.source]: compose.inputs_values.map((_, i) => i) },
    {
      revealScript: bytesToHex(commit.leaf),
      tapInternalKey: bytesToHex(commit.internalKey),
      address: commit.address,
      valueSats: commitValue,
      asset,
    },
  );
  const commitFinal = finalize(signedCommit);

  const revealPsbt = buildRevealPsbt(compose, commitFinal.txid, commitIndex, commitValue, commit);

  // Core's reveal outputs are reproduced verbatim, so its values give the
  // reveal's fee before we hold a signed reveal of our own.
  const revealOut = revealOutputTotal(compose);

  const plan: MintPlan = {
    mode: req.mode,
    asset,
    preset: req.preset,
    fairminter,
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
    revealWeight,
    commitVsize: compose.signed_tx_estimated_size?.adjusted_vsize ?? 0,
    revealOutputs: revealOut,
  };

  // Hand the reveal PSBT out before any money moves. If the caller writes it
  // somewhere durable, a mint is never unrecoverable — the leaf names the
  // user's key, so this PSBT can be re-signed at any point in the future.
  await onRevealPsbt?.(revealPsbt, plan);

  onStage?.("broadcasting-commit");
  const commitTxid = await wallet.broadcast(commitFinal.hex);

  onStage?.("signing-reveal");
  try {
    const reveal = await finishReveal(wallet, req.source, revealPsbt, onStage, req.route, asset);
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
  route: RevealRoute = "public",
  /** Only for the server-side job's record, so a pending mint is identifiable. */
  asset = "",
): Promise<{ txid: string; hex: string; weight: number }> {
  // The reveal is a taproot script-path spend: the wallet signs input 0 against
  // the tapleaf that names its own key. Both wallets handle `tapLeafScript` —
  // it is the reason the envelope was re-keyed in the first place.
  const signed = await wallet.signPsbt(revealPsbt, { [source]: [0] });
  const final = finalize(signed);

  if (route === "slipstream") {
    if (final.weight > MAX_WEIGHT) {
      throw new OversizedRevealError(final.weight, final.hex);
    }
    return sendViaSlipstream(final, source, asset, onStage);
  }

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

/**
 * Hand the reveal to this site's own server, which finishes it from there.
 *
 * The wait is not politeness and it is not short. Slipstream resolves a
 * transaction's inputs from the chain and from its own submissions, and NEVER
 * from the public mempool — our commit went out over public relay, so MARA
 * cannot see it until it is MINED. A reveal submitted sooner prices as fee 0
 * and is refused ("Fee rate of 0 is below the threshold"), however patiently it
 * is retried.
 *
 * That wait used to run in this tab. It does not any more: the server takes the
 * signed bytes, watches for the commit, hunts a submission window and re-uploads
 * on the ambiguous 524, all without anyone keeping a page open. Handing the hex
 * over is safe — it spends exactly one output the signer already committed to,
 * so the server can stall it but can never redirect it.
 *
 * The returned txid is the reveal's own, computed from the signed bytes rather
 * than reported by anyone: nothing has been broadcast yet at this point.
 */
async function sendViaSlipstream(
  final: { txid: string; hex: string; weight: number },
  source: string,
  asset: string,
  onStage?: (stage: MintStage) => void,
): Promise<{ txid: string; hex: string; weight: number }> {
  const commitTxid = bytesToHex(RawTx.decode(hexToBytes(final.hex)).inputs[0].txid);

  onStage?.("awaiting-commit");
  await handOffReveal({ commitTxid, revealHex: final.hex, source, asset });
  return final;
}

/** What Core's reveal pays out — everything above it in the commit is fee. */
function revealOutputTotal(compose: ComposeResult): number {
  return RawTx.decode(hexToBytes(compose.signed_reveal_rawtransaction!)).outputs.reduce(
    (sum, o) => sum + Number(o.amount),
    0,
  );
}

/**
 * Lock an asset's description for good.
 *
 * Not a flag on the mint: Core has no `lock_description` on an issuance. It
 * is a follow-up issuance of quantity 0 whose description is the literal
 * `lock_description`, and it can only be composed once the asset exists —
 * i.e. after the reveal has confirmed. A plain OP_RETURN transaction, signed
 * as an ordinary PSBT by either wallet.
 */
export async function lockDescription(
  wallet: SigningWallet,
  source: string,
  asset: string,
  satPerVbyte: number,
): Promise<string> {
  if (!(satPerVbyte >= HARD_MIN_RATE)) throw new Error("The fee rate must be above zero.");
  const compose = await cpCompose(source, "issuance", {
    asset,
    quantity: "0",
    description: "lock_description",
    sat_per_vbyte: String(satPerVbyte),
    verbose: "true",
    exclude_utxos_with_balances: "true",
  });
  const psbt = buildPlainPsbt(compose);
  const signed = await wallet.signPsbt(psbt, { [source]: compose.inputs_values.map((_, i) => i) });
  const final = finalize(signed);
  const txid = await wallet.broadcast(final.hex);
  return txid || final.txid;
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
 * A reveal past MARA's own policy cap of ~99.8% of a block. Nothing can carry
 * it — not the public network, not Slipstream — so the mint is refused before
 * any money moves. The only remedy is a smaller file.
 */
export class OversizedRevealError extends Error {
  constructor(
    readonly weight: number,
    readonly hex: string = "",
  ) {
    super(
      `This reveal is ${weight.toLocaleString("en-US")} weight units, past the ` +
        `${MAX_WEIGHT.toLocaleString("en-US")} limit Slipstream itself enforces. No route can ` +
        "carry it. Use a smaller file.",
    );
    this.name = "OversizedRevealError";
  }
}

/**
 * The commit is on chain but has not been mined within the waiting window, so
 * Slipstream still cannot price the reveal. Nothing is lost: the reveal is
 * signed and stored, and the commit stays spendable by it alone.
 */
export class SlipstreamPendingError extends Error {
  constructor(
    readonly weight: number,
    readonly hex: string,
    readonly commitTxid: string,
  ) {
    super(
      "The commit has not been mined yet, so Slipstream cannot price the reveal. The reveal is " +
        "signed and stored — retry once the commit is in a block.",
    );
    this.name = "SlipstreamPendingError";
  }
}

/**
 * The chosen fee rate is below Slipstream's ACCEPTANCE floor.
 *
 * Thrown before composing, because the commit output is sized for the reveal's
 * fee and cannot be resized once the commit is on chain — minting anyway would
 * buy a reveal MARA will never take, with the coins already committed.
 *
 * Distinct from paying between the floor and the mineable rate, which is
 * legitimate: that submission is accepted and waits for the market to come
 * down. Only the floor is a gate.
 */
export class BelowSlipstreamFloorError extends Error {
  constructor(
    readonly rate: number,
    readonly submitFloor: number,
    readonly mineable: number,
  ) {
    super(
      `Slipstream will not accept a submission under ${submitFloor} sat/vB, and this mint is ` +
        `paying ${rate}. It is currently mining at ${mineable} sat/vB — anything between the two ` +
        "is accepted and then waits for the market.",
    );
    this.name = "BelowSlipstreamFloorError";
  }
}

/** MARA refused the reveal outright. Retrying the same bytes cannot help. */
export class SlipstreamRejectedError extends Error {
  constructor(
    readonly reason: string,
    readonly hex: string,
  ) {
    super(`Slipstream refused the reveal: ${reason}`);
    this.name = "SlipstreamRejectedError";
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
