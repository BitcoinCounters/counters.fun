/**
 * The commit, as XCP Wallet checks it.
 *
 * The wallet will not sign BTC moving for a reason the bytes cannot prove, and
 * its one exception is an inscription commit that verifies against the signing
 * address. Its check (`verifyInscriptionCommit`) is short and exact:
 *
 *   1. the declared `tapInternalKey` is the BIP-341 NUMS point;
 *   2. the leaf's `OP_CHECKSIG` key is `Address().decode(signer).pubkey` — the
 *      taproot OUTPUT key, i.e. the address's own witness program;
 *   3. every output is either the commit address that leaf derives to, or the
 *      signer's change, and the commit is paid exactly once.
 *
 * Fail (2) and the refusal does not name the key: the commit falls through to
 * the blanket "Blocked: Not a Counterparty Transaction", because a commit
 * carries no Counterparty message of its own. That is what a leaf re-keyed to
 * the wallet's *reported* public key produced — wallets report the derived
 * (internal) key, and the tweaked one is what the leaf has to name.
 *
 * The envelope below is Core's, captured from a live `encoding=taproot`
 * compose, so what is re-keyed here is the real shape and not a hand-built one.
 */

import { describe, expect, it } from "vitest";
import { Address, taprootNumsKey } from "@scure/btc-signer";
import { bytesToHex, commitEnvelope, hexToBytes, reKeyEnvelope } from "../apps/web/src/lib/inscribe/envelope";
import { detectOrdEnvelope } from "../apps/web/src/lib/inscribe/psbt";
import { taprootOutputKey } from "../apps/web/src/lib/wallet/adapter";

/** A v11 native envelope from Core, ending in `<ephemeral key> OP_CHECKSIG`. */
const CORE_ENVELOPE =
  "00632516871a0d95873d00f5f4f46a746578742f706c61696e4e68656c6c6f20636f756e74657273" +
  "68" +
  "2047a2a087d277149825acfe4485802dfd86f88668c058eba017a5716710f8905fac";

/** The same compose with `inscription=true`: Core's envelope inside an ord one. */
const ORD_ENVELOPE =
  "0063036f726401070378637001010a746578742f706c61696e" +
  "01050b86161a0d95873d00f5f4f4" +
  "000e68656c6c6f20636f756e7465727368" +
  "207b02f4fb55ea1c56ff99e70be4a454049ec43b1c296babfadd74bffb187d93cfac";

/** BIP-86's test address, and the internal key a wallet would report for it. */
const ADDRESS = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const REPORTED_INTERNAL_KEY = "cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115";

/** The leaf's trailing `<32-byte push> <key> OP_CHECKSIG`, as the wallet reads it. */
function checksigKey(leaf: Uint8Array): string {
  expect(leaf[leaf.length - 1]).toBe(0xac);
  expect(leaf[leaf.length - 34]).toBe(0x20);
  return bytesToHex(leaf.subarray(leaf.length - 33, leaf.length - 1));
}

describe("the commit the wallet is asked to sign", () => {
  const outputKey = taprootOutputKey(ADDRESS)!;
  const leaf = reKeyEnvelope(hexToBytes(CORE_ENVELOPE), outputKey);
  const commit = commitEnvelope(leaf);

  it("names the signer's taproot output key in the leaf", () => {
    expect(checksigKey(leaf)).toBe(bytesToHex(outputKey));
  });

  it("does NOT name the public key the wallet reports", () => {
    // The regression this pins: same address, key taken from `account.publicKey`
    // instead of the address, and the wallet refuses the commit.
    expect(checksigKey(leaf)).not.toBe(REPORTED_INTERNAL_KEY);
    expect(checksigKey(reKeyEnvelope(hexToBytes(CORE_ENVELOPE), hexToBytes(REPORTED_INTERNAL_KEY)))).toBe(
      REPORTED_INTERNAL_KEY,
    );
  });

  it("commits under the NUMS point, so the coins cannot be taken without revealing", () => {
    expect(bytesToHex(commit.internalKey)).toBe(bytesToHex(taprootNumsKey()));
    expect(Address().decode(commit.address).type).toBe("tr");
  });

  it("keeps Core's message bytes and its length, so every fee Core computed still holds", () => {
    const core = hexToBytes(CORE_ENVELOPE);
    expect(leaf).toHaveLength(core.length);
    // Everything before the trailing `<push> <key> OP_CHECKSIG` is untouched.
    expect(bytesToHex(leaf.subarray(0, leaf.length - 34))).toBe(bytesToHex(core.subarray(0, core.length - 34)));
  });
});

/**
 * XCP Wallet's inscription verifier is an ord-envelope parser, and that is the
 * whole of its tolerance: it requires the leaf to open `OP_FALSE OP_IF "ord"`,
 * then reads the metaprotocol (tag 7), the MIME type (tag 1) and the
 * Counterparty message out of ord's CBOR metadata (tag 5). Core's native
 * envelope goes straight to its data after `OP_IF`, so the parser gives up at
 * the third opcode and the commit falls through to the blanket block.
 *
 * Both envelopes below came from the same live compose, one with
 * `inscription=true` and one without.
 */
describe("the envelope a commit is carried in", () => {
  it("is ord-shaped only in the ord style", () => {
    expect(detectOrdEnvelope(hexToBytes(ORD_ENVELOPE))).toBe(true);
    expect(detectOrdEnvelope(hexToBytes(CORE_ENVELOPE))).toBe(false);
  });

  it("opens exactly as the wallet's parser demands", () => {
    const ord = hexToBytes(ORD_ENVELOPE);
    // OP_FALSE, OP_IF, push "ord", push <7> (ord's metaprotocol tag).
    expect([...ord.subarray(0, 8)]).toEqual([0x00, 0x63, 0x03, 0x6f, 0x72, 0x64, 0x01, 0x07]);
    // The native one is a data push where "ord" would be.
    expect(hexToBytes(CORE_ENVELOPE)[2]).not.toBe(0x03);
  });

  it("re-keys in place whichever style it is", () => {
    const outputKey = taprootOutputKey(ADDRESS)!;
    const ord = hexToBytes(ORD_ENVELOPE);
    const reKeyed = reKeyEnvelope(ord, outputKey);
    expect(reKeyed).toHaveLength(ord.length);
    expect(checksigKey(reKeyed)).toBe(bytesToHex(outputKey));
    expect(detectOrdEnvelope(reKeyed)).toBe(true);
  });
});
