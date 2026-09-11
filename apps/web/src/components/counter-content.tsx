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
import { contentUrl, stampUrl } from "@/lib/constants";
import { fmtSize, mimeTag, shortMime } from "@/lib/format";

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
  body,
  interactive = false,
  className = "",
}: Props) {
  const mode = renderMode({
    is_pointer_like: isPointerLike,
    size,
    content_type: contentType,
    stamp_mime: stampMime ?? null,
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
        src={stampUrl(number)}
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
        src={contentUrl(number)}
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
    if (!interactive) return <Opaque contentType={contentType} size={size} className={className} />;
    return (
      <iframe
        src={contentUrl(number)}
        title={`Counter #${number} — ${asset} (${shortMime(contentType)})`}
        sandbox="allow-scripts"
        className={`counter-frame ${className}`}
      />
    );
  }

  if (mode === "document") {
    // A PDF or an audio file in a frame is a browser toolbar, not the file.
    // Cards get an honest placeholder; the detail page gets the real viewer.
    if (!interactive) return <Opaque contentType={contentType} size={size} className={className} />;
    return (
      <iframe
        src={contentUrl(number)}
        title={`Counter #${number} — ${asset} (${shortMime(contentType)})`}
        sandbox="allow-scripts"
        className={`counter-frame ${className}`}
      />
    );
  }

  return (
    <iframe
      src={contentUrl(number)}
      title={`Counter #${number} — ${asset} (${shortMime(contentType)})`}
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
