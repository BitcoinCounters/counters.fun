/**
 * Since Counterparty Core v11.5.0 (`require_reveal_source_signature`, mainnet
 * block 969,320) a reveal counts only when its envelope leaf is signed by a
 * key of the source. Core stopped signing the reveal and returns it unsigned
 * with `envelope_script`, `reveal_control_block` and `reveal_pubkey`; the
 * wallet signs. Fifteen counters were lost in the first ten days to reveals
 * closed by other keys, so the mint now refuses every shape that would be
 * ignored, before anything is signed:
 *
 *   - a compose carrying only `signed_reveal_rawtransaction` (an outdated node),
 *   - a compose whose `reveal_pubkey` is not the key the wallet signs with,
 *   - a wallet that cannot sign the native envelope (no page-held key any more),
 *   - a pending mint whose reveal was to be signed by the page.
 *
 * And it sizes the reveal from the UNSIGNED template exactly.
 */
import { describe, expect, it } from "vitest";
import { Transaction, p2tr, SigHash } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import { LEAF_VERSION, bytesToHex, commitEnvelope, hexToBytes, reKeyEnvelope } from "../apps/web/src/lib/inscribe/envelope";
import {
  buildRevealPsbt,
  coreCommitScript,
  coreReveal,
  finalize,
  revealWeightFor,
  revealWitnessBytes,
  unsignedRevealTxid,
  type ComposeResult,
} from "../apps/web/src/lib/inscribe/psbt";
import { revealWeightOf, finishReveal, WalletCannotSignNativeRevealError } from "../apps/web/src/lib/inscribe/mint";
import { MIN_CORE_VERSION, nodeVersionProblem, parseVersion, OutdatedNodeError } from "../apps/web/src/lib/inscribe/node-version";

/** Core's native envelope, from a live compose, closed by some key. */
const CORE_ENVELOPE =
  "00632516871a0d95873d00f5f4f46a746578742f706c61696e4e68656c6c6f20636f756e74657273" +
  "68" +
  "2047a2a087d277149825acfe4485802dfd86f88668c058eba017a5716710f8905fac";

const SOURCE_SECRET = new Uint8Array(32).fill(7);
const SOURCE_XONLY = schnorr.getPublicKey(SOURCE_SECRET);

/** The compose Core v11.5.0 returns: commit funded to P2TR(source, [envelope]), reveal unsigned. */
function composeV115(leaf: Uint8Array): ComposeResult {
  const commit = p2tr(SOURCE_XONLY, { script: leaf, leafVersion: LEAF_VERSION }, undefined, true);
  const control = commit.tapLeafScript![0]![0];
  const controlBlock = new Uint8Array(33);
  controlBlock[0] = LEAF_VERSION | (control.version & 1);
  controlBlock.set(SOURCE_XONLY, 1);

  const commitTx = new Transaction({ allowUnknownOutputs: true });
  commitTx.addInput({ txid: hexToBytes("b".repeat(64)), index: 1 });
  commitTx.addOutput({ script: commit.script, amount: 1753n });
  commitTx.addOutput({ script: hexToBytes("0014" + "11".repeat(20)), amount: 50_000n });

  const reveal = new Transaction({ allowUnknownOutputs: true, version: 2, lockTime: 0 });
  reveal.addInput({ txid: hexToBytes(commitTx.id), index: 0, sequence: 0xfffffffd });
  reveal.addOutput({ script: hexToBytes("6a08434e545250525459"), amount: 0n });

  return {
    rawtransaction: bytesToHex(commitTx.unsignedTx),
    envelope_script: bytesToHex(leaf),
    reveal_rawtransaction: bytesToHex(reveal.unsignedTx),
    reveal_control_block: bytesToHex(controlBlock),
    reveal_pubkey: bytesToHex(SOURCE_XONLY),
    reveal_lock_scripts: [bytesToHex(commit.script)],
    reveal_inputs_values: [1753],
    btc_fee: 300,
    btc_in: 60_000,
    btc_out: 51_753,
    btc_change: 50_000,
    inputs_values: [60_000],
    lock_scripts: ["5120" + "22".repeat(32)],
  };
}

const LEAF = reKeyEnvelope(hexToBytes(CORE_ENVELOPE), SOURCE_XONLY);

describe("a compose from Core v11.5.0", () => {
  const compose = composeV115(LEAF);

  it("is read from the unsigned reveal", () => {
    const { tx } = coreReveal(compose);
    expect(tx.inputs).toHaveLength(1);
    expect(tx.outputs).toHaveLength(1);
    expect(bytesToHex(tx.outputs[0]!.script)).toBe("6a08434e545250525459");
  });

  it("locates Core's commit output by the control block's internal key, the source", () => {
    const script = coreCommitScript(LEAF, hexToBytes(compose.reveal_control_block!));
    expect(bytesToHex(script)).toBe(compose.reveal_lock_scripts![0]);
    // the same key closes the leaf, so the older derivation agrees
    expect(bytesToHex(coreCommitScript(LEAF))).toBe(compose.reveal_lock_scripts![0]);
  });

  it("sizes the signed reveal exactly from the unsigned template", () => {
    // Sign the same reveal for real (script path, SIGHASH_ALL, 65-byte sig) and compare.
    const commit = commitEnvelope(LEAF);
    const psbt = buildRevealPsbt(compose, "a".repeat(64), 0, 1753, commit);
    const tx = Transaction.fromPSBT(hexToBytes(psbt));
    tx.signIdx(SOURCE_SECRET, 0, [SigHash.ALL]);
    const signedWeight = finalize(bytesToHex(tx.toPSBT())).weight;
    expect(revealWeightFor(compose, 65)).toBe(signedWeight);
    expect(revealWeightOf(compose)).toBe(signedWeight);
    // and the SIGHASH_DEFAULT budget Core itself computed is one byte lighter
    expect(revealWeightFor(compose, 64)).toBe(signedWeight - 1);
    expect(revealWitnessBytes(LEAF.length, 65)).toBe(1 + 66 + (LEAF.length < 0xfd ? 1 : 3) + LEAF.length + 34);
    expect(revealWitnessBytes(70_000, 64)).toBe(1 + 65 + 5 + 70_000 + 34);
  });

  it("keeps the reveal's txid across signing, which only touches the witness", () => {
    const commit = commitEnvelope(LEAF);
    const psbt = buildRevealPsbt(compose, "a".repeat(64), 0, 1753, commit);
    const tx = Transaction.fromPSBT(hexToBytes(psbt));
    tx.signIdx(SOURCE_SECRET, 0, [SigHash.ALL]);
    const done = finalize(bytesToHex(tx.toPSBT()));
    expect(unsignedRevealTxid(psbt)).toBe(done.txid);
    expect(done.weight).toBe(revealWeightOf(compose));
  });
});

describe("what is refused before anything is signed", () => {
  it("a node-signed reveal, which only a pre-v11.5.0 node produces", () => {
    const compose = { ...composeV115(LEAF), reveal_rawtransaction: undefined, signed_reveal_rawtransaction: "02000000" };
    expect(() => coreReveal(compose)).toThrow(OutdatedNodeError);
    expect(() => revealWeightOf(compose)).toThrow(/older than v11.5.0/);
  });

  it("a compose with no reveal at all", () => {
    const compose = { ...composeV115(LEAF), reveal_rawtransaction: undefined };
    expect(() => coreReveal(compose)).toThrow(/no reveal transaction/);
  });

  it("a pending mint that was to be signed by the page", async () => {
    const wallet = {
      signPsbt: async () => {
        throw new Error("the wallet must not be asked");
      },
      broadcast: async () => "",
    } as never;
    await expect(finishReveal(wallet, "bc1p…", "70736274ff", undefined, "public", "X", "ab".repeat(32))).rejects.toThrow(
      /ignored by the network/,
    );
  });

  it("names the wallet that cannot sign a native reveal", () => {
    const err = new WalletCannotSignNativeRevealError("XCP Wallet");
    expect(err.message).toMatch(/XCP Wallet can only sign the counterparty\/ord envelope/);
    expect(err.message).toMatch(/v11\.5\.0/);
  });
});

describe("the node version gate", () => {
  it("reads versions the way Core reports them", () => {
    expect(parseVersion("11.5.0")).toEqual([11, 5, 0]);
    expect(parseVersion("v11.4.0-rc.1")).toEqual([11, 4, 0]);
    expect(parseVersion(undefined)).toBeNull();
    expect(MIN_CORE_VERSION).toEqual([11, 5, 0]);
  });

  it("refuses the node the DEGENT reveals were composed on", () => {
    expect(nodeVersionProblem("11.4.0")).toMatch(/older than v11\.5\.0/);
    expect(nodeVersionProblem("11.4.0")).toMatch(/969,320/);
    expect(nodeVersionProblem(null)).toMatch(/refusing to compose blind/);
  });

  it("lets a current node through", () => {
    expect(nodeVersionProblem("11.5.0")).toBeNull();
    expect(nodeVersionProblem("11.6.2")).toBeNull();
    expect(nodeVersionProblem("12.0.0")).toBeNull();
  });
});
