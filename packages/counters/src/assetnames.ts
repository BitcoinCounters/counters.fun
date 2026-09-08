/**
 * Counterparty asset names, as consensus accepts them.
 *
 * Three shapes. A *named* asset is 4–12 uppercase letters not starting with
 * A (that prefix is reserved) and costs 0.5 XCP, burned. A *numeric* asset is
 * `A` followed by an integer in (26^12, 2^64) and is free — Core never picks
 * one for you, so a "leave it blank" flow has to draw the number client-side.
 * A *subasset* is `PARENT.child`, free since block 866,000, and only the
 * parent's owner can issue it.
 */

export const NUMERIC_MIN = 26n ** 12n + 1n;
export const NUMERIC_MAX = 2n ** 64n - 1n;

/** Names consensus will never let anyone issue. */
export const RESERVED = new Set(["BTC", "XCP"]);

const NAMED = /^[B-Z][A-Z]{3,11}$/;
const NUMERIC = /^A\d{1,20}$/;
/** Counterparty's subasset alphabet; the whole longname is capped at 250. */
const SUBASSET_CHILD = /^[a-zA-Z0-9.\-_@!]{1,250}$/;

export type AssetNameKind = "numeric" | "named" | "subasset";

export type AssetNameCheck =
  | { ok: true; kind: AssetNameKind; parent?: string }
  | { ok: false; reason: AssetNameProblem };

export type AssetNameProblem =
  | "reserved"
  | "numeric-out-of-range"
  | "named-shape"
  | "subasset-parent"
  | "subasset-child"
  | "subasset-length";

export function isNumericAssetName(name: string): boolean {
  if (!NUMERIC.test(name)) return false;
  const value = BigInt(name.slice(1));
  return value >= NUMERIC_MIN && value <= NUMERIC_MAX;
}

/** Classify a name the way `assetnames.py` will, before the node has to. */
export function classifyAssetName(raw: string): AssetNameCheck {
  const name = raw.trim();
  if (RESERVED.has(name)) return { ok: false, reason: "reserved" };

  const dot = name.indexOf(".");
  if (dot >= 0) {
    const parent = name.slice(0, dot);
    const child = name.slice(dot + 1);
    const parentCheck = classifyAssetName(parent);
    if (!parentCheck.ok || parentCheck.kind === "subasset") {
      return { ok: false, reason: "subasset-parent" };
    }
    if (!SUBASSET_CHILD.test(child)) return { ok: false, reason: "subasset-child" };
    if (name.length > 250) return { ok: false, reason: "subasset-length" };
    return { ok: true, kind: "subasset", parent };
  }

  if (name.startsWith("A") && /^A\d*$/.test(name)) {
    return isNumericAssetName(name)
      ? { ok: true, kind: "numeric" }
      : { ok: false, reason: "numeric-out-of-range" };
  }

  if (NAMED.test(name)) return { ok: true, kind: "named" };
  return { ok: false, reason: "named-shape" };
}

/**
 * A numeric asset name drawn with real randomness. Front-running protection:
 * a predictable name can be issued out from under a launch. Uniform over the
 * valid range up to the (negligible) modulo bias of 64 random bits.
 */
export function randomNumericAsset(): string {
  const span = NUMERIC_MAX - NUMERIC_MIN;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return `A${NUMERIC_MIN + (value % span)}`;
}

/** Cost in XCP to issue a name of this kind, burned. Numeric and subassets are free. */
export function issuanceBurnXcp(kind: AssetNameKind): number {
  return kind === "named" ? 0.5 : 0;
}
