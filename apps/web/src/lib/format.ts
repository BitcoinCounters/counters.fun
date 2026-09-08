/**
 * Display formatting. Ported from the reference explorer's `fmtSize`,
 * `fmtQty`, `fmtSupply` and `fmtDate` so a counter's numbers read the same
 * here as they do on bitcoincounters.com.
 *
 * Everything that touches a quantity takes it raw and converts once, at the
 * edge. Raw values never round-trip through a formatted string.
 */

import { big } from "@counters/core/numeric";

/**
 * Bytes, in the units people actually say them in — and in the same units
 * bitcoincounters.com uses, decimal: 1,000 bytes to the KB. MEMEPOW is
 * 3,900,359 bytes, which the protocol's own explorer calls 3.9 MB; dividing
 * by 1,024 twice made it 3.72 MB here, a mismatch with no information in it.
 */
export function fmtSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

/**
 * A raw u64 quantity as a decimal string, respecting divisibility. Divisible
 * assets carry eight decimal places; indivisible ones are whole units and a
 * decimal point on them is a lie.
 */
export function fmtQty(rawValue: string | number | bigint | null, divisible = true): string {
  if (rawValue === null || rawValue === undefined) return "—";
  const value = big(rawValue);
  if (!divisible) return value.toLocaleString("en-US");

  const whole = value / 100_000_000n;
  const frac = value % 100_000_000n;
  if (frac === 0n) return whole.toLocaleString("en-US");

  const digits = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}.${digits}`;
}

/** Compact form for a card: 44.5M rather than 44,560,376.86826705. */
export function fmtCompact(rawValue: string | number | bigint | null, divisible = true): string {
  if (rawValue === null || rawValue === undefined) return "—";
  const units = divisible ? Number(big(rawValue)) / 1e8 : Number(big(rawValue));
  if (!Number.isFinite(units)) return "—";

  const abs = Math.abs(units);
  if (abs >= 1e9) return `${(units / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(units / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(units / 1e3).toFixed(1)}k`;
  if (abs >= 1) return units.toFixed(2);
  if (abs === 0) return "0";
  // Sub-unit prices are the normal case for a token that costs a fraction of
  // an XCP; significant figures matter more than a fixed decimal count.
  return units.toPrecision(3);
}

/** A pool price in XCP per whole token. */
export function fmtPrice(price: number | null): string {
  if (price === null || !Number.isFinite(price) || price <= 0) return "—";
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toExponential(3);
}

/** Signed percentage change, or null when there is no baseline to compare to. */
export function pctChange(now: number | null, then: number | null): number | null {
  if (now === null || then === null || then === 0) return null;
  return ((now - then) / then) * 100;
}

export function fmtPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function fmtDate(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** ~7 days, at a block every ten minutes. Blocks are the honest unit here —
 *  a countdown in hours implies a precision the chain does not offer. */
export function fmtBlocks(blocks: number | null): string {
  if (blocks === null) return "—";
  if (blocks <= 0) return "now";
  const hours = (blocks * 10) / 60;
  if (hours < 48) return `${blocks} blocks · ~${Math.round(hours)}h`;
  return `${blocks} blocks · ~${Math.round(hours / 24)}d`;
}

/** Truncate a hash or address for a table cell without losing recognisability. */
export function trunc(value: string | null, head = 8, tail = 6): string {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** The MIME without its parameters — `audio/ogg;codecs=opus` → `audio/ogg`. */
export function shortMime(contentType: string): string {
  return contentType.split(";")[0]!.trim();
}

/** The part people read off a card: `png`, `html`, `pdf`. */
export function mimeTag(contentType: string): string {
  const mime = shortMime(contentType);
  const sub = mime.split("/")[1] ?? mime;
  return sub.replace(/^x-/, "").replace(/\+.*$/, "");
}
