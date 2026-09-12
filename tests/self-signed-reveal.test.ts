/**
 * The reveal this page signs itself.
 *
 * A native envelope on a wallet whose parser only reads ord ones cannot be
 * revealed by that wallet — so the leaf names a key made for the mint instead
 * of the signer's, and the page produces the script-path signature. Everything
 * else is unchanged: Core's envelope bytes, its length, the commit derivation
 * under NUMS, the reveal's shape.
 *
 * What this pins is that the signature is real and that the spend is the one
 * the commit committed to: a three-item witness of signature, the exact leaf,
 * and a control block for the NUMS point.
 */

import { describe, expect, it } from "vitest";
import { RawTx, Transaction, taprootNumsKey } from "@scure/btc-signer";
import {
  LEAF_VERSION,
  bytesToHex,
  commitEnvelope,
  hexToBytes,
  newRevealKey,
  reKeyEnvelope,
  revealKeyFromHex,
} from "../apps/web/src/lib/inscribe/envelope";
import { finalize, signRevealLocally } from "../apps/web/src/lib/inscribe/psbt";

/** Core's native envelope, from a live compose. */
const CORE_ENVELOPE =
  "00632516871a0d95873d00f5f4f46a746578742f706c61696e4e68656c6c6f20636f756e74657273" +
  "68" +
  "2047a2a087d277149825acfe4485802dfd86f88668c058eba017a5716710f8905fac";

const COMMIT_TXID = "a".repeat(64);
const COMMIT_VALUE = 1753;

/** The reveal as `buildRevealPsbt` makes it: one script-path input, one OP_RETURN. */
function revealPsbt(commit: ReturnType<typeof commitEnvelope>): string {
  const tx = new Transaction({ allowUnknownOutputs: true, version: 2, lockTime: 0 });
  tx.addInput({
    txid: hexToBytes(COMMIT_TXID),
    index: 0,
    witnessUtxo: { script: commit.script, amount: BigInt(COMMIT_VALUE) },
    tapLeafScript: [
      [
        { version: commit.controlVersion, internalKey: commit.internalKey, merklePath: [] },
        new Uint8Array([...commit.leaf, LEAF_VERSION]),
      ],
    ],
    tapInternalKey: commit.internalKey,
  });
  // The literal CNTRPRTY marker, which is what makes the reveal a counter.
  tx.addOutput({ script: hexToBytes("6a08434e545250525459"), amount: 0n });
  return bytesToHex(tx.toPSBT());
}

describe("a reveal signed by the page", () => {
  const key = newRevealKey();
  const leaf = reKeyEnvelope(hexToBytes(CORE_ENVELOPE), key.xOnly);
  const commit = commitEnvelope(leaf);

  it("names its own key in the leaf and keeps Core's bytes and length", () => {
    const core = hexToBytes(CORE_ENVELOPE);
    expect(leaf).toHaveLength(core.length);
    expect(bytesToHex(leaf.subarray(leaf.length - 33, leaf.length - 1))).toBe(bytesToHex(key.xOnly));
    expect(bytesToHex(leaf.subarray(0, leaf.length - 34))).toBe(bytesToHex(core.subarray(0, core.length - 34)));
    // Still unspendable except by revealing: the commit's internal key is NUMS.
    expect(bytesToHex(commit.internalKey)).toBe(bytesToHex(taprootNumsKey()));
  });

  it("produces a spendable script-path witness without any wallet", () => {
    const signed = signRevealLocally(revealPsbt(commit), key.privateKey);
    const final = finalize(signed);

    const tx = RawTx.decode(hexToBytes(final.hex));
    const witness = tx.witnesses?.[0];
    expect(witness).toHaveLength(3);
    // Schnorr signature, then the leaf verbatim, then the control block.
    expect([64, 65]).toContain(witness![0]!.length);
    expect(bytesToHex(witness![1]!)).toBe(bytesToHex(leaf));
    expect(witness![2]).toHaveLength(33);
    expect(witness![2]![0]).toBe(commit.controlVersion);
    expect(bytesToHex(witness![2]!.subarray(1))).toBe(bytesToHex(commit.internalKey));
  });

  it("refuses a key that does not open this envelope", () => {
    const stranger = newRevealKey();
    expect(() => signRevealLocally(revealPsbt(commit), stranger.privateKey)).toThrow(/does not match/i);
  });

  it("round-trips through the hex the pending mint stores", () => {
    const restored = revealKeyFromHex(bytesToHex(key.privateKey));
    expect(bytesToHex(restored.xOnly)).toBe(bytesToHex(key.xOnly));
    expect(() => signRevealLocally(revealPsbt(commit), restored.privateKey)).not.toThrow();
  });
});
