/**
 * Teleburn addresses — the counters protocol's one unspendable Bitcoin
 * address per Counterparty asset (build reference v3 §10.3). Anything sent
 * there is burned *into* the asset: its supply, its ownership, other assets,
 * sats, inscriptions.
 *
 *   m    = tagged_hash("CountersTeleburn", asset_name)   // ASCII, Core's canonical `asset`
 *   t    = tagged_hash("TapTweak", H.x || m)             // BIP341 tweak
 *   Q    = H + t·G                                       // H = BIP341's NUMS point
 *   addr = bech32m(hrp, 1, Q.x)
 *
 * Derived here, from the asset name, so every counter page shows it without
 * waiting on the index; the worker also carries the address the reference
 * indexer derived, and the two must agree. The reference implementation and
 * the pinned vectors are counters/teleburn.py and tests/test_teleburn.py in
 * the counters repo; tests/teleburn.test.ts here pins the same vectors.
 */

import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { bech32m } from "@scure/base";

export const TELEBURN_TAG = "CountersTeleburn";

/** BIP341's "nothing up my sleeve" point: sha256(uncompressed G), lifted. */
const NUMS_X = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

const NAMED = /^[B-Z][A-Z]{3,11}$/;
const NUMERIC = /^A[1-9][0-9]*$/;
const NUMERIC_MIN = 26n ** 12n + 1n;
const NUMERIC_MAX = 2n ** 64n - 1n;

/**
 * Counterparty's canonical `asset` field, or null. XCP; four to twelve
 * capitals not starting with A; or A + an integer above 26^12 within 64 bits
 * (every subasset is one of these underneath its longname). Case is not
 * folded and a longname is refused: a slip must derive nothing rather than
 * something plausible.
 */
export function canonicalAssetName(name: string | null | undefined): string | null {
  if (!name) return null;
  if (name === "XCP" || NAMED.test(name)) return name;
  if (NUMERIC.test(name)) {
    const n = BigInt(name.slice(1));
    if (n >= NUMERIC_MIN && n <= NUMERIC_MAX) return name;
  }
  return null;
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

/** The 32-byte x-only output key, or null for a name that is not canonical. */
export function teleburnXonly(asset: string): Uint8Array | null {
  const name = canonicalAssetName(asset);
  if (name === null) return null;
  const m = schnorr.utils.taggedHash(TELEBURN_TAG, new TextEncoder().encode(name));
  const t = schnorr.utils.taggedHash("TapTweak", bytesOf(NUMS_X), m);
  const H = secp256k1.ProjectivePoint.fromHex("02" + NUMS_X);
  const Q = H.add(secp256k1.ProjectivePoint.BASE.multiply(BigInt("0x" + hexOf(t))));
  return Q.toRawBytes(true).slice(1);
}

/** The bech32m address for `hrp` (bc, tb, bcrt), or null. */
export function teleburnAddress(asset: string, hrp = "bc"): string | null {
  const x = teleburnXonly(asset);
  return x === null ? null : bech32m.encode(hrp, [1, ...bech32m.toWords(x)], 90);
}
