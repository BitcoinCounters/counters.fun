/**
 * The taproot envelope, rebuilt around the user's own key.
 *
 * Counterparty Core composes an inscription by generating a random private key, putting that
 * key's x-only pubkey in the envelope leaf's OP_CHECKSIG, using the SAME key as the commit
 * address's taproot INTERNAL key, and handing back a reveal it has already signed — then
 * discarding the key (`lib/api/composer.py`, `generate_envelope_script`; the local variable is
 * misleadingly named `source_pubkey`, but it is `generate_random_private_key()`).
 *
 * A browser wallet cannot be asked to fund that. XCP Wallet's provider gate refuses BTC moving
 * for reasons the bytes cannot prove, and its inscription escape hatch demands two things Core's
 * construction does not satisfy (`core/counterparty/providerInscriptions.ts`):
 *
 *   1. the commit's internal key must be the BIP-341 unspendable NUMS point, so nobody can
 *      key-path spend the commit out from under the inscription; and
 *   2. the leaf's OP_CHECKSIG key must be the SIGNER's own taproot output key, so the committed
 *      coins stay spendable by that wallet alone.
 *
 * Core fails both: its internal key is a real key, and its leaf key is ephemeral.
 *
 * So we keep Core's message bytes and replace only the key. The leaf is
 * `OP_FALSE OP_IF <data...> OP_ENDIF <32-byte x-only key> OP_CHECKSIG`; swapping a 32-byte key
 * for a 32-byte key leaves the script length — and therefore the reveal's vsize, and therefore
 * the commit value Core computed to pay the reveal's fee — exactly unchanged. Core itself
 * compares envelope scripts with the trailing key and OP_CHECKSIG sliced off
 * (`composer.py` ~1208), so the swap is a substitution the protocol already expects.
 *
 * Two properties follow, and both are improvements on the CLI path:
 *   - the reveal is signed by the USER, so a reveal that fails to broadcast can simply be rebuilt
 *     and re-signed. Core's ephemeral reveal cannot: the key is gone, which is why a stranded
 *     commit is unrecoverable there.
 *   - nothing but the user's key can ever spend the commit output.
 */

import { p2tr, taprootNumsKey, utils as btcUtils } from '@scure/btc-signer';

/** Push of a 32-byte x-only key, then OP_CHECKSIG — the last 34 bytes of every envelope leaf. */
const KEY_SUFFIX_LEN = 34;
const OP_PUSH32 = 0x20;
const OP_CHECKSIG = 0xac;
export const LEAF_VERSION = 0xc0;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex');
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Replace the ephemeral key in Core's `envelope_script` with `userXOnly`.
 *
 * Throws if the script does not end in the expected key push, rather than silently producing a
 * leaf that commits to nothing spendable — a wrong leaf here becomes a commit address whose coins
 * no one can reach.
 */
export function reKeyEnvelope(envelopeScript: Uint8Array, userXOnly: Uint8Array): Uint8Array {
  if (userXOnly.length !== 32) {
    throw new Error(`expected a 32-byte x-only key, got ${userXOnly.length}`);
  }
  if (envelopeScript.length < KEY_SUFFIX_LEN) {
    throw new Error('envelope script is too short to carry a key');
  }
  const suffix = envelopeScript.length - KEY_SUFFIX_LEN;
  if (envelopeScript[suffix] !== OP_PUSH32 || envelopeScript[envelopeScript.length - 1] !== OP_CHECKSIG) {
    throw new Error(
      'envelope script does not end in <32-byte key> OP_CHECKSIG — Counterparty Core built ' +
        'something this app does not recognize, so the key was not swapped'
    );
  }
  const leaf = new Uint8Array(envelopeScript.length);
  leaf.set(envelopeScript.subarray(0, suffix), 0);
  leaf[suffix] = OP_PUSH32;
  leaf.set(userXOnly, suffix + 1);
  leaf[leaf.length - 1] = OP_CHECKSIG;
  return leaf;
}

export interface CommitEnvelope {
  /** The re-keyed leaf script. */
  leaf: Uint8Array;
  /** bech32m address the commit must pay. */
  address: string;
  /** scriptPubKey of that address. */
  script: Uint8Array;
  /** Control block proving the leaf, for the reveal's witness. */
  controlBlock: Uint8Array;
  /**
   * Leaf version with the output key's parity bit — `0xc0` or `0xc1`.
   *
   * Not a detail to assume: the parity comes out of the tweak and differs per envelope, and a
   * control block carrying the wrong bit describes a different output key than the one the commit
   * actually pays, so the reveal would not validate.
   */
  controlVersion: number;
  /** The NUMS internal key, as the wallet's inscription context wants it. */
  internalKey: Uint8Array;
}

/**
 * Derive the commit output for a re-keyed leaf: a single-leaf taproot tree under the NUMS point.
 *
 * `allowUnknownOutputs` is on because the leaf is an inscription envelope, not a standard script
 * template scure recognizes.
 */
export function commitEnvelope(leaf: Uint8Array): CommitEnvelope {
  const internalKey = taprootNumsKey();
  const payment = p2tr(internalKey, { script: leaf, leafVersion: LEAF_VERSION }, undefined, true);
  const tapLeaf = payment.tapLeafScript?.[0];
  if (!payment.address || !tapLeaf) {
    throw new Error('could not derive the commit address from the envelope');
  }
  const [control] = tapLeaf;
  const controlVersion = LEAF_VERSION | (control.version & 1);
  const controlBlock = new Uint8Array(33);
  controlBlock[0] = controlVersion;
  controlBlock.set(internalKey, 1);
  return {
    leaf,
    address: payment.address,
    script: payment.script,
    controlBlock,
    controlVersion,
    internalKey,
  };
}

/**
 * A key for the leaf that belongs to nobody but this mint.
 *
 * The leaf's `OP_CHECKSIG` key decides who can open the commit, and there are
 * two sensible answers. Naming the SIGNER's key is the better one — the wallet
 * proves the commit from it, and the coins are always theirs — but it also
 * means the reveal can only ever be signed by that wallet, and a wallet that
 * will not read the envelope will not sign the reveal either.
 *
 * The other answer is the one every ordinals inscriber uses and the one
 * Counterparty Core uses itself: a key made for this transaction and used for
 * nothing else. The page holds it, so the page can sign the reveal without
 * asking anyone, and the commit is then just a payment the wallet can approve
 * as a payment. Core throws its copy away, which is why a Core reveal can
 * never be re-signed; this one is kept with the pending mint until the reveal
 * is on chain, so a failed broadcast is still recoverable.
 *
 * It guards one output, for minutes, and it is never sent anywhere.
 */
export interface RevealKey {
  privateKey: Uint8Array;
  /** x-only public key — what goes in the leaf. */
  xOnly: Uint8Array;
}

export function newRevealKey(): RevealKey {
  const privateKey = btcUtils.randomPrivateKeyBytes();
  return { privateKey, xOnly: btcUtils.pubSchnorr(privateKey) };
}

export function revealKeyFromHex(hex: string): RevealKey {
  const privateKey = hexToBytes(hex);
  if (privateKey.length !== 32) throw new Error('a reveal key is 32 bytes');
  return { privateKey, xOnly: btcUtils.pubSchnorr(privateKey) };
}
