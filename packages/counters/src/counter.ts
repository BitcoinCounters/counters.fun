/**
 * A Counter, as the counters server records it, plus the one predicate this
 * whole site turns on.
 *
 * Shape mirrors `record_dict()` in the reference indexer
 * (`counters/counters/server/app.py`). Quantities that can exceed 2^53 —
 * `supply`, `burned` — are {@link Raw}; sizes, blocks and fees are counts far
 * below the boundary and stay numbers.
 */

import { big, type Raw } from "./numeric";

/** How the counter reached the chain. Fairmints never qualify. */
export type CounterKind = "issuance" | "fairminter";

export interface Counter {
  /** Gap-free inscription number, assigned in (block, tx_index, msg_index) order. */
  number: number;
  asset: string;
  asset_id: string;
  asset_longname?: string | null;
  kind: CounterKind;
  /** MIME the indexer derived from the description bytes. */
  content_type: string;
  content_type_raw: string | null;
  /** Content length in bytes. */
  size: number;
  /**
   * True when the "file" is really a URL pointing somewhere else — ipfs://,
   * ar://, http(s)://. These are the counters this site refuses to render.
   */
  is_pointer_like: boolean;
  stamp_mime: string | null;
  envelope: string | null;
  owner: string;
  source: string;
  txid: string;
  msg_index: number;
  block: number;
  tx_index: number;
  sha256: string;
  rolling_hash: string;
  supply: Raw;
  divisible: boolean;
  locked: boolean | null;
  burned: Raw | null;
  /** Bitcoin miner fee paid by the reveal, in satoshis. */
  fee: number;
  tx_size: number;
  xcp_burned: Raw | null;
  /** Inline body for small textual counters; null when the indexer withheld it. */
  body: string | null;
  block_time?: number;
  original?: boolean;
}

/* -------------------------------------------------------------------- */
/* The rule                                                             */
/* -------------------------------------------------------------------- */

/**
 * counters.fun displays a counter only when its content is genuinely stored
 * in Bitcoin. A pointer-like counter's description is a URL — the bytes live
 * on somebody's server, and rendering it would mean fetching from that
 * server, which is precisely what this site exists not to do.
 *
 * Enforced at the query layer (see `apps/api/src/queries/counters.ts`) so a
 * caller cannot opt out of it, and asserted over the full live index in
 * `tests/on-chain-rule.test.ts`.
 */
export function isOnChain(counter: Pick<Counter, "is_pointer_like" | "size">): boolean {
  return !counter.is_pointer_like && counter.size > 0;
}

/**
 * Why a counter is not displayable, for the refusal state on a deep link.
 * Returns null when it is displayable.
 */
export function undisplayableReason(
  counter: Pick<Counter, "is_pointer_like" | "size">,
): "pointer" | "empty" | null {
  if (counter.is_pointer_like) return "pointer";
  if (counter.size <= 0) return "empty";
  return null;
}

/* -------------------------------------------------------------------- */
/* Rendering                                                            */
/* -------------------------------------------------------------------- */

/**
 * How a counter's bytes should be put on screen.
 *
 * The split between `image` and `sandbox` is a security boundary: an `<img>`
 * cannot execute anything, and everything that could — HTML, JavaScript, SVG —
 * has to go in a sandboxed frame. The rest is about not lying about the
 * content. A browser handed `application/json` in a frame renders its own JSON
 * inspector, complete with a "Pretty print" checkbox; a PDF gets a full
 * viewer with a toolbar. Neither is the file. Textual formats are shown as
 * text, and documents get an honest placeholder on a card and a real viewer
 * on a page.
 *
 * `stamp` is the one mode whose bytes are not the bytes on chain. See
 * {@link renderMode}.
 */
export type RenderMode = "image" | "stamp" | "sandbox" | "text" | "document" | "none";

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/** Textual formats a browser would otherwise dress up in an inspector. */
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/javascript",
  "application/javascript",
  "text/css",
  "application/xml",
  "text/xml",
]);

export function renderMode(
  counter: Pick<Counter, "is_pointer_like" | "size" | "content_type" | "stamp_mime">,
): RenderMode {
  if (!isOnChain(counter)) return "none";

  // A stamp's description is `STAMP:<base64>` — genuinely on chain, and
  // genuinely `text/plain`, but the file it encodes is an image. Shown as the
  // base64 it literally is, the counter reads as a wall of noise; 13 of the
  // 189 counters indexed today are in this shape.
  //
  // `stamp_mime` is non-null only when the indexer's own decode succeeded, so
  // trusting it here inherits its strictness for free — a damaged payload
  // (#54 MAGICEGG's stray space, #59 XCPFTW's stray prefix) leaves the field
  // null and falls back to text, which is what the reference explorer does.
  // Nothing in this file decodes base64; that would be a second, divergent
  // implementation of a rule the indexer already owns.
  if (counter.stamp_mime) return "stamp";

  const mime = (counter.content_type || "").split(";")[0]!.trim().toLowerCase();

  if (IMAGE_TYPES.has(mime)) return "image";
  // SVG is an image everywhere else and a script host here.
  if (mime === "image/svg+xml") return "sandbox";
  if (TEXT_TYPES.has(mime)) return "text";
  if (mime === "application/pdf") return "document";
  // Audio and video have their own elements, but they are still opaque
  // binaries that a card cannot usefully show a frame of.
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "document";
  return "sandbox";
}

/* -------------------------------------------------------------------- */
/* Badges                                                               */
/* -------------------------------------------------------------------- */

/** Size thresholds carried over from the reference explorer's card badges. */
export const LARGE_BYTES = 400_000;
export const WHOLE_BLOCK_BYTES = 3_500_000;

export type SizeBadge = "whole block" | "large" | null;

export function sizeBadge(size: number): SizeBadge {
  if (size > WHOLE_BLOCK_BYTES) return "whole block";
  if (size > LARGE_BYTES) return "large";
  return null;
}

/* -------------------------------------------------------------------- */
/* Identifiers                                                          */
/* -------------------------------------------------------------------- */

/**
 * Resolve a path segment to a counter number or an asset name, matching the
 * reference indexer's `store.find()`: an all-digit token is a number,
 * anything else is an asset (numeric assets are `A` + digits, subassets
 * contain a dot).
 */
export function parseCounterId(id: string): { number: number } | { asset: string } {
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return { number: Number(trimmed) };
  return { asset: trimmed.toUpperCase() };
}

/** Counterparty's unspendable address — LP tokens sent here prove a locked pool. */
export const BURN_ADDRESS = "1CounterpartyXXXXXXXXXXXXXXXUWLpVr";

/** Assets that can never be a counter. */
export const RESERVED_ASSETS = new Set(["BTC", "XCP"]);

/** Issued supply minus what has been sent to the unspendable address. */
export function circulatingSupply(total: Raw, burned: Raw | null): bigint {
  const remaining = big(total) - big(burned ?? 0);
  return remaining > 0n ? remaining : 0n;
}
