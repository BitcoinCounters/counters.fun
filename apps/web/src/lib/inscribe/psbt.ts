/**
 * Transaction surgery on Counterparty's composed commit/reveal pair.
 *
 * Ported from `/home/node/counters/mintapp2/lib/launch.ts`, where every one of
 * these safeguards was learned expensively. The logic is asset-shape agnostic —
 * it operates on whatever `compose/*` returned — so it serves the counter mint
 * here exactly as it served the fairminter deploy there.
 *
 * The premise, in one paragraph: Core composes an inscription by generating a
 * random private key, putting its x-only pubkey in the envelope leaf's
 * OP_CHECKSIG and using the same key as the commit address's taproot internal
 * key, then discarding it. A browser wallet cannot fund that — XCP Wallet's
 * inscription gate requires the BIP-341 NUMS internal key and the *signer's*
 * own taproot output key in the leaf. So Core's message bytes are kept and only
 * the 32-byte key is swapped, which leaves the script length, the reveal's
 * vsize and the commit value Core computed all exactly unchanged.
 *
 * A side effect worth having: because the leaf then names the user's key, a
 * reveal that fails to broadcast can be rebuilt and re-signed. Core's own
 * reveal cannot — its key is gone, which is why a stranded commit is
 * unrecoverable on the CLI path.
 */

import { RawTx, SigHash, Transaction, p2tr } from "@scure/btc-signer";
import { LEAF_VERSION, bytesToHex, commitEnvelope, hexToBytes } from "./envelope";
import { OutdatedNodeError } from "./node-version";

/** Counterparty's dust threshold for the outputs it composes. */
const DUST = 546;

export interface ComposeResult {
  rawtransaction: string;
  envelope_script?: string;
  /**
   * Core v11.5.0+: the UNSIGNED reveal, with the control block of the single-
   * leaf commit `P2TR(reveal_pubkey, [envelope])` and the x-only key Core
   * closed the envelope with — a key of the source, which signs the leaf.
   */
  reveal_rawtransaction?: string;
  reveal_control_block?: string;
  reveal_pubkey?: string;
  reveal_lock_scripts?: string[];
  reveal_inputs_values?: number[];
  /**
   * Core before v11.5.0: a reveal the node signed with a throwaway key. The
   * network has ignored those since block 969,320; its presence without
   * `reveal_rawtransaction` identifies an outdated node and is refused.
   */
  signed_reveal_rawtransaction?: string;
  btc_fee: number;
  btc_in: number;
  btc_out: number;
  btc_change: number;
  inputs_values: number[];
  lock_scripts: string[];
  psbt?: string;
  data?: string;
  /** Core's own sizing of the commit; `adjusted_vsize` is what its fee was computed over. */
  signed_tx_estimated_size?: { vsize: number; adjusted_vsize: number; sigops_count: number };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Core's reveal, as the template every size and value below is read from.
 *
 * v11.5.0 returns it unsigned in `reveal_rawtransaction`. A compose carrying
 * only `signed_reveal_rawtransaction` comes from a node older than the
 * `require_reveal_source_signature` rule, whose reveals the network ignores:
 * refused here, before anything is signed, rather than mis-sized downstream.
 */
export function coreReveal(compose: ComposeResult): { raw: Uint8Array; tx: ReturnType<typeof RawTx.decode> } {
  if (!compose.reveal_rawtransaction) {
    if (compose.signed_reveal_rawtransaction) {
      throw new OutdatedNodeError(
        "The Counterparty node composed a reveal signed with a throwaway key, which only a node " +
          "older than v11.5.0 does. The network has ignored such reveals since block 969,320, so " +
          "nothing was signed. The node must be upgraded.",
      );
    }
    throw new Error("Core returned no reveal transaction. The node must be v11.5.0 or newer.");
  }
  const raw = hexToBytes(compose.reveal_rawtransaction);
  return { raw, tx: RawTx.decode(raw) };
}

/** Witness bytes of a finished reveal: `<sig> <leaf> <control block>`, plus the stack count. */
export function revealWitnessBytes(leafLength: number, signatureBytes: number): number {
  const compact = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
  return 1 + (1 + signatureBytes) + (compact(leafLength) + leafLength) + (1 + 33);
}

/**
 * The reveal's weight once signed, from Core's UNSIGNED reveal: its base
 * serialization counts four times, the segwit marker and flag and the witness
 * once. `signatureBytes` is 64 for SIGHASH_DEFAULT and 65 for SIGHASH_ALL,
 * which is what the wallets here sign with. Exact, not an estimate: the
 * re-keyed leaf has the same length as Core's.
 */
export function revealWeightFor(compose: ComposeResult, signatureBytes = 65): number {
  const { raw } = coreReveal(compose);
  const leaf = hexToBytes(compose.envelope_script!);
  const unsigned = Transaction.fromRaw(raw, {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
  const base = unsigned.unsignedTx.length;
  return base * 4 + 2 + revealWitnessBytes(leaf.length, signatureBytes);
}

/**
 * Re-derive the commit address Core built, so its output is found by identity
 * rather than by position. The internal key is read from Core's control block
 * when it sent one (v11.5.0: the source key, which is also the leaf's key),
 * else taken from the leaf as the older Cores built it.
 */
export function coreCommitScript(envelopeScript: Uint8Array, controlBlock?: Uint8Array): Uint8Array {
  const internal =
    controlBlock && controlBlock.length >= 33
      ? controlBlock.subarray(1, 33)
      : envelopeScript.subarray(envelopeScript.length - 33, envelopeScript.length - 1);
  return p2tr(internal, { script: envelopeScript, leafVersion: LEAF_VERSION }, undefined, true)
    .script;
}

/** An ord envelope opens `OP_FALSE OP_IF "ord"`; the native one goes straight to its data. */
export function detectOrdEnvelope(envelopeScript: Uint8Array): boolean {
  return (
    envelopeScript.length > 6 &&
    envelopeScript[0] === 0x00 &&
    envelopeScript[1] === 0x63 &&
    envelopeScript[2] === 0x03 &&
    envelopeScript[3] === 0x6f &&
    envelopeScript[4] === 0x72 &&
    envelopeScript[5] === 0x64
  );
}

/**
 * How many more satoshis the commit needs than Core funded.
 *
 * Core budgets the reveal for a SIGHASH_DEFAULT signature of 64 bytes. XCP
 * Wallet accepts only SIGHASH_ALL, whose signature carries a trailing flag
 * byte and is 65. That one witness byte is not in Core's arithmetic, and a
 * reveal paying under the rate it claimed is a reveal that can sit unconfirmed
 * indefinitely.
 */
export function commitTopUp(compose: ComposeResult, satPerVbyte: number): number {
  // Core's OWN leaf, read from the compose rather than taken as an argument.
  // Locating the funded output derives an address from the leaf's trailing key,
  // so passing the re-keyed leaf finds nothing, reads `funded` as 0, and
  // returns the entire commit value as a "top-up" — silently doubling the cost
  // of the mint. Not a mistake a caller should be able to make.
  const coreLeaf = hexToBytes(compose.envelope_script!);
  const { tx: reveal } = coreReveal(compose);

  let outputsValue = 0;
  for (const output of reveal.outputs) outputsValue += Number(output.amount);

  const vsize = Math.ceil(revealWeightFor(compose, 65) / 4);
  // `ceil` on both sides: a fractional rate (0.37 sat/vB is a legitimate
  // choice on a node that relays down to 0) never rounds the reveal below
  // the rate it claimed. It may round a satoshi above; that is the cheap side.
  const needed = outputsValue + Math.ceil(vsize * satPerVbyte);

  const coreControl = compose.reveal_control_block ? hexToBytes(compose.reveal_control_block) : undefined;
  const funded = Number(
    RawTx.decode(hexToBytes(compose.rawtransaction)).outputs.find((o) =>
      sameBytes(o.script, coreCommitScript(coreLeaf, coreControl)),
    )?.amount ?? 0n,
  );

  // Never a reduction: underpaying strands the commit, overpaying costs a few
  // satoshis.
  return Math.max(0, needed - funded);
}

/** Core puts change last; take the final output that is not the commit. */
function lastChangeIndex(outputs: { amount: bigint }[], commitIndex: number): number {
  for (let i = outputs.length - 1; i >= 0; i -= 1) if (i !== commitIndex) return i;
  return -1;
}

/**
 * Build the commit PSBT: Core's transaction with its commit output redirected
 * to our address.
 *
 * Inputs, change and fee are Core's arithmetic untouched. `valueDelta` moves
 * satoshis from the change into the commit, which leaves the total spent — and
 * therefore the miner fee — unchanged.
 */
export function buildCommitPsbt(
  compose: ComposeResult,
  ourCommitScript: Uint8Array,
  valueDelta = 0,
): { psbt: string; commitValue: number; commitIndex: number } {
  const core = RawTx.decode(hexToBytes(compose.rawtransaction));
  const oldScript = coreCommitScript(
    hexToBytes(compose.envelope_script!),
    compose.reveal_control_block ? hexToBytes(compose.reveal_control_block) : undefined,
  );
  const tx = new Transaction({
    allowUnknownOutputs: true,
    version: core.version,
    lockTime: core.lockTime,
  });

  core.inputs.forEach((input, i) => {
    const script = compose.lock_scripts?.[i];
    const value = compose.inputs_values?.[i];
    if (script === undefined || value === undefined) {
      throw new Error(
        `Core returned no prevout for input ${i}, so the commit cannot be signed safely.`,
      );
    }
    tx.addInput({
      txid: input.txid,
      index: input.index,
      sequence: input.sequence,
      witnessUtxo: { script: hexToBytes(script), amount: BigInt(value) },
      // XCP Wallet refuses anything else: "Input with not allowed sigHash=0.
      // Allowed: 1".
      sighashType: SigHash.ALL,
    });
  });

  let commitIndex = -1;
  core.outputs.forEach((output, i) => {
    if (!sameBytes(output.script, oldScript)) return;
    if (commitIndex !== -1) throw new Error("Core composed more than one commit output");
    commitIndex = i;
  });
  if (commitIndex === -1) {
    throw new Error(
      "Could not find the commit output in the composed transaction. Nothing was signed.",
    );
  }

  const changeIndex = valueDelta === 0 ? -1 : lastChangeIndex(core.outputs, commitIndex);
  if (valueDelta !== 0 && changeIndex === -1) {
    throw new Error(
      "This envelope needs more in the commit than Core funded, and there is no change output.",
    );
  }

  const commitValue = Number(core.outputs[commitIndex]!.amount) + valueDelta;
  core.outputs.forEach((output, i) => {
    if (i === commitIndex) {
      tx.addOutput({ script: ourCommitScript, amount: BigInt(commitValue) });
      return;
    }
    if (i === changeIndex) {
      const change = Number(output.amount) - valueDelta;
      if (change < DUST) throw new Error("Topping up the commit would push the change below dust.");
      tx.addOutput({ script: output.script, amount: BigInt(change) });
      return;
    }
    tx.addOutput({ script: output.script, amount: output.amount });
  });

  return { psbt: bytesToHex(tx.toPSBT()), commitValue, commitIndex };
}

/**
 * Build the reveal PSBT: spend the commit through the envelope leaf,
 * reproducing Core's outputs.
 *
 * Core's own reveal is discarded — its witness is signed by a key nobody has
 * any more — but its OUTPUTS are consensus-relevant and are copied verbatim.
 */
export function buildRevealPsbt(
  compose: ComposeResult,
  commitTxid: string,
  commitIndex: number,
  commitValue: number,
  commit: ReturnType<typeof commitEnvelope>,
): string {
  const { tx: template } = coreReveal(compose);
  const tx = new Transaction({
    allowUnknownOutputs: true,
    version: template.version,
    lockTime: template.lockTime,
  });

  tx.addInput({
    // NOT reversed. `@scure/btc-signer` takes a txid in display order and
    // serialises it itself; reversing here produces an input pointing at a
    // transaction that has never existed, which the network reports as
    // `missing-inputs` long after the commit is on chain.
    txid: hexToBytes(commitTxid),
    index: commitIndex,
    witnessUtxo: { script: commit.script, amount: BigInt(commitValue) },
    tapLeafScript: [
      [
        { version: commit.controlVersion, internalKey: commit.internalKey, merklePath: [] },
        new Uint8Array([...commit.leaf, LEAF_VERSION]),
      ],
    ],
    tapInternalKey: commit.internalKey,
    sighashType: SigHash.ALL,
  });

  for (const output of template.outputs) {
    tx.addOutput({ script: output.script, amount: output.amount });
  }
  return bytesToHex(tx.toPSBT());
}

/**
 * Build a PSBT from a plain Counterparty compose — no envelope, no surgery.
 *
 * Counterparty hands back a finished raw transaction, and the XCP path could
 * sign that directly with `xcp_signTransaction`. Horizon Wallet has no
 * raw-transaction signing at all, so every flow goes through a PSBT instead.
 * The prevouts come from the compose's own `lock_scripts` and `inputs_values`
 * (which is why every compose asks for `verbose=true`), so nothing has to be
 * looked up to sign safely.
 */
export function buildPlainPsbt(compose: ComposeResult): string {
  const core = RawTx.decode(hexToBytes(compose.rawtransaction));
  const tx = new Transaction({
    allowUnknownOutputs: true,
    version: core.version,
    lockTime: core.lockTime,
  });

  core.inputs.forEach((input, i) => {
    const script = compose.lock_scripts?.[i];
    const value = compose.inputs_values?.[i];
    if (script === undefined || value === undefined) {
      throw new Error(
        `Core returned no prevout for input ${i}; the transaction cannot be signed safely.`,
      );
    }
    tx.addInput({
      txid: input.txid,
      index: input.index,
      sequence: input.sequence,
      witnessUtxo: { script: hexToBytes(script), amount: BigInt(value) },
      sighashType: SigHash.ALL,
    });
  });

  for (const output of core.outputs) {
    tx.addOutput({ script: output.script, amount: output.amount });
  }
  return bytesToHex(tx.toPSBT());
}

/** Finalize a PSBT the wallet signed but deliberately left unfinalized. */
export function finalize(signedPsbtHex: string): { hex: string; txid: string; weight: number } {
  const tx = Transaction.fromPSBT(hexToBytes(signedPsbtHex), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    allowLegacyWitnessUtxo: true,
  });
  tx.finalize();
  return { hex: bytesToHex(tx.extract()), txid: tx.id, weight: tx.weight };
}

/**
 * Sign the reveal here, with the key the leaf names.
 *
 * Used when the leaf carries a key of this mint's own rather than the wallet's
 * (see `newRevealKey`): the reveal is a script-path spend, and whoever holds
 * that key can produce the signature — no wallet, no dialog, nothing to
 * approve. It is the same spend the wallet would have made.
 */
export function signRevealLocally(revealPsbt: string, privateKey: Uint8Array): string {
  const tx = Transaction.fromPSBT(hexToBytes(revealPsbt), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    allowLegacyWitnessUtxo: true,
  });
  // A key that does not appear in the leaf is a mismatch either way: scure
  // throws ("No taproot scripts signed") where another version might return
  // false. Both mean the same thing, and neither says it usefully.
  let signed = false;
  try {
    // The allowed sighashes have to be spelled out. The reveal input declares
    // SIGHASH_ALL — the wallets require it, and Core's commit was funded for
    // the 65-byte signature it produces — while scure defaults to permitting
    // SIGHASH_DEFAULT alone and silently signs nothing when the input asks for
    // anything else. "Nothing signed" and "wrong key" then look identical.
    signed = tx.signIdx(privateKey, 0, [SigHash.DEFAULT, SigHash.ALL]);
  } catch (cause) {
    throw new Error("The reveal key does not match the envelope it is meant to open.", { cause });
  }
  if (!signed) throw new Error("The reveal key does not match the envelope it is meant to open.");
  return bytesToHex(tx.toPSBT());
}

/**
 * The txid the reveal will have once signed.
 *
 * A taproot script-path spend commits to nothing in the txid but its inputs
 * and outputs — the witness is not part of it — so this is exact, not a guess,
 * and can be shown to the user before either half is broadcast.
 */
export function unsignedRevealTxid(revealPsbt: string): string {
  const tx = Transaction.fromPSBT(hexToBytes(revealPsbt), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    allowLegacyWitnessUtxo: true,
  });
  return tx.id;
}
