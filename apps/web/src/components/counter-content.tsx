/**
 * A counter, rendered from Bitcoin.
 *
 * There is exactly one source of bytes here — `/content/<n>` on this origin,
 * which the API worker fills from the counters server and caches in R2. No
 * CDN, no gateway, no hosted thumbnail. If this component ever renders
 * something, that something is in a Bitcoin block.
 *
 * How it renders depends on what the bytes are, and the image/sandbox split is
 * a security boundary rather than a styling choice: an `<img>` cannot execute
 * anything, and everything that could — HTML, JavaScript, SVG — goes in a
 * frame sandboxed by the CSP the proxy serves (`sandbox allow-scripts`, no
 * `allow-same-origin`, `default-src 'none'`). On-chain content is arbitrary
 * and permanent; some of it is a program. It renders itself and reaches
 * nothing.
 */

import { renderMode } from "@counters/core/counter";
import type { Delegate } from "@/lib/api";
import { contentUrl, stampUrl } from "@/lib/constants";
import { fmtSize, mimeTag, shortMime } from "@/lib/format";

/**
 * What is actually drawn for a counter: its own file, or — for a delegate —
 * the file of the counter it names, with the display fragment on the URL.
 *
 * This is the reference explorer's rule 9, and the resolution is the
 * indexer's: `delegate` arrives already resolved to an indexed counter, and
 * nothing here reads a body to decide it. The fragment is what makes 300
 * editions out of one file — RARE.PEPE's SVG styles itself by `:target`, so
 * `/content/219#edition-5` is edition five of it. The bytes are still the
 * same on-chain bytes, through the same proxy and into the same sandbox; the
 * fragment never reaches a server.
 */
export function rendered(counter: {
  number: number;
  contentType: string;
  size: number;
  stampMime?: string | null;
  delegate?: Delegate | null;
}): { number: number; contentType: string; size: number; stampMime: string | null; fragment: string } {
  const d = counter.delegate;
  if (!d) {
    return {
      number: counter.number,
      contentType: counter.contentType,
      size: counter.size,
      stampMime: counter.stampMime ?? null,
      fragment: "",
    };
  }
  return {
    number: d.number,
    contentType: d.content_type,
    size: d.size,
    stampMime: null,
    // The indexer validates the fragment's charset; checked again because it
    // is about to be part of a URL, and an unexpected one is simply dropped.
    fragment: d.fragment && /^[A-Za-z0-9._~-]{1,64}$/.test(d.fragment) ? `#${d.fragment}` : "",
  };
}

interface Props {
  number: number;
  asset: string;
  contentType: string;
  size: number;
  isPointerLike: boolean;
  /** Set when the description is a `STAMP:<base64>` payload the indexer
   *  decoded to an image; the image's MIME, not the counter's. */
  stampMime?: string | null;
  /** Inline body the indexer already returned, for small textual counters. */
  body?: string | null;
  /** The counter whose file this one renders in place of its own. */
  delegate?: Delegate | null;
  /** Cards are a picture of the thing; a detail page is the thing. */
  interactive?: boolean;
  className?: string;
}

export function CounterContent({
  number,
  asset,
  contentType,
  size,
  isPointerLike,
  stampMime,
  body: ownBody,
  delegate,
  interactive = false,
  className = "",
}: Props) {
  const shown = rendered({ number, contentType, size, stampMime, delegate });
  // A delegate's own body is the reference, not the file it shows.
  const body = delegate ? null : ownBody;
  const src = `${contentUrl(shown.number)}${shown.fragment}`;
  const mode = renderMode({
    is_pointer_like: isPointerLike,
    size: shown.size,
    content_type: shown.contentType,
    stamp_mime: shown.stampMime,
  });

  if (mode === "none") return <PointerRefusal body={body} className={className} />;

  // A stamp: the counter's bytes are `STAMP:<base64>` text, and the file they
  // encode is an image. Rendering the text verbatim is technically honest and
  // practically useless — a wall of base64 where a picture belongs. The decode
  // is the indexer's, served through this origin's proxy like every other
  // byte here, so nothing about the premise changes: no server is supplying
  // the picture, one is only unwrapping what the chain already holds.
  if (mode === "stamp") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- same reason as
      // the `image` branch below: these bytes are already immutable and
      // cached, and the Next pipeline would resize content whose exact pixels
      // are the point.
      <img
        src={stampUrl(shown.number)}
        alt={`Counter #${number} — ${asset}`}
        loading="lazy"
        decoding="async"
        className={`counter-image ${className}`}
      />
    );
  }

  if (mode === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- the bytes come
      // from this origin's content proxy, already immutable and cached; the
      // Next image pipeline would add a resize step in front of content whose
      // exact pixels are the point.
      <img
        src={src}
        alt={`Counter #${number} — ${asset}`}
        loading="lazy"
        decoding="async"
        className={`counter-image ${className}`}
      />
    );
  }

  if (mode === "text") {
    if (body) return <pre className={`counter-text ${className}`}>{body}</pre>;

    // The indexer withholds inline bodies for large counters. On a card that
    // is where it ends — pulling a megabyte of text to fill a 168px tile is
    // not worth it. On a detail page the file is the point, so fetch it: a
    // browser handed text/* renders it as text, and the sandbox keeps that
    // true even if the bytes claim otherwise.
    if (!interactive) return <Opaque contentType={shown.contentType} size={shown.size} className={className} />;
    return (
      <iframe
        src={src}
        title={`Counter #${number} — ${asset} (${shortMime(shown.contentType)})`}
        sandbox="allow-scripts"
        className={`counter-frame ${className}`}
      />
    );
  }

  if (mode === "document") {
    // A PDF or an audio file in a frame is a browser toolbar, not the file.
    // Cards get an honest placeholder; the detail page gets the real viewer.
    if (!interactive) return <Opaque contentType={shown.contentType} size={shown.size} className={className} />;
    return (
      <iframe
        src={src}
        title={`Counter #${number} — ${asset} (${shortMime(shown.contentType)})`}
        sandbox="allow-scripts"
        className={`counter-frame ${className}`}
      />
    );
  }

  return (
    <iframe
      src={src}
      title={`Counter #${number} — ${asset} (${shortMime(shown.contentType)})`}
      loading="lazy"
      // Belt and braces: the proxy's CSP already sandboxes the document, and
      // this attribute means a misconfigured proxy still cannot give on-chain
      // JavaScript this origin. `allow-scripts` without `allow-same-origin` is
      // the combination that lets a counter animate itself and nothing else.
      sandbox="allow-scripts"
      style={interactive ? undefined : { pointerEvents: "none" }}
      className={`counter-frame ${className}`}
    />
  );
}

/**
 * A file that exists on chain but has no useful thumbnail — a PDF, a sound,
 * a text body too large to inline. Naming the format and the weight is more
 * informative than a generic file glyph, and the weight is the interesting
 * number here: these are bytes someone paid Bitcoin miner fees to store
 * forever.
 */
function Opaque({
  contentType,
  size,
  className = "",
}: {
  contentType: string;
  size: number;
  className?: string;
}) {
  return (
    <div
      className={`counter-fill flex h-full flex-col items-center justify-center gap-1.5 bg-bg2 ${className}`}
    >
      <span className="font-mono text-2xl font-semibold uppercase text-copper2">
        {mimeTag(contentType)}
      </span>
      <span className="font-mono text-[11px] text-faint">{fmtSize(size)}</span>
      <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-faint">
        on chain
      </span>
    </div>
  );
}

/**
 * What a pointer-like counter gets instead of a render.
 *
 * Not an error and not a broken image — the counter is real, numbered and
 * permanent. Its description is a URL, and following it would put someone
 * else's server in the render path. The URL is shown as text so the reader can
 * see exactly what was inscribed, and is deliberately not a link.
 */
function PointerRefusal({ body, className = "" }: { body?: string | null; className?: string }) {
  return (
    <div
      className={`counter-fill flex h-full flex-col items-center justify-center gap-2 bg-bg2 p-4 text-center ${className}`}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        off-chain pointer
      </span>
      <span className="max-w-full break-all font-mono text-[11px] text-dim">
        {body?.trim() || "the description names a URL, not a file"}
      </span>
      <span className="text-[11px] text-faint">counters.fun does not fetch it</span>
    </div>
  );
}
