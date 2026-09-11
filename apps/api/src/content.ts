/**
 * On-chain bytes, re-served from this origin.
 *
 * Three reasons this proxy exists rather than pointing `src` at the counters
 * server directly:
 *
 * 1. **Framing.** The upstream sends `X-Frame-Options: DENY` and a
 *    `frame-ancestors` list that does not include counters.fun. Images are
 *    fine in an `<img>`, but the HTML, JavaScript, SVG and PDF counters —
 *    which include MEMENOME, the only pooled counter — cannot be iframed
 *    cross-origin at all. Re-serving them here makes them same-origin.
 * 2. **Sandboxing.** On-chain content is arbitrary and permanent; some of it
 *    is executable. It is served with a CSP that gives the document no
 *    network, no storage and a unique opaque origin, so a counter can render
 *    itself and reach nothing else.
 * 3. **Cost.** Content is immutable and content-addressed, so a hit is served
 *    from R2 and never touches the upstream again.
 *
 * The one thing this proxy will not do is serve a pointer-like counter. Its
 * "content" is a URL; fetching it would put a third-party server in the
 * render path, which is the whole thing counters.fun refuses to do.
 */

import type { Env } from "#api/env";
import { one } from "#api/db";
import { CountersServer } from "#api/upstream/counters-server";

/**
 * Deny everything, then allow only what a self-contained document needs:
 * inline styles and scripts it carried on chain, plus data: images. No
 * `connect-src`, so no fetch, XHR or WebSocket. `sandbox` without
 * `allow-same-origin` puts the document in an opaque origin, which also
 * denies it storage.
 */
function sandboxCsp(frameAncestors: string): string {
  return [
    "default-src 'none'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "style-src 'unsafe-inline' data:",
    "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
    "sandbox allow-scripts",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

/** Types safe to hand a browser without a download prompt. */
const INLINE_SAFE = /^(image|audio|video|text|application\/(json|pdf|javascript))/;

/** Just the slice of ExecutionContext this needs. Hono's `c.executionCtx` is
 *  its own narrower type, and asking for the full one only creates a cast. */
interface Waiter {
  waitUntil(promise: Promise<unknown>): void;
}

export async function serveContent(
  env: Env,
  ctx: Waiter,
  request: Request,
  number: number,
  variant: "content" | "preview" | "stamp",
): Promise<Response> {
  // Only this site may frame a counter. The upstream's blanket
  // X-Frame-Options: DENY is what made this proxy necessary in the first
  // place; repeating it verbatim would defeat the point.
  const frameAncestors = env.WEB_ORIGIN || "'self'";

  const row = await one<{
    is_pointer_like: number;
    content_type: string;
    stamp_mime: string | null;
    sha256: string | null;
    size: number;
  }>(
    env.DB,
    `SELECT is_pointer_like, content_type, stamp_mime, sha256, size FROM counters WHERE number = ?1`,
    number,
  );

  if (!row) return new Response("unknown counter", { status: 404 });
  if (row.is_pointer_like) {
    // 415, not 404: the counter is real, its bytes are not on Bitcoin.
    return new Response("off-chain pointer — counters.fun does not fetch it", {
      status: 415,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (variant === "stamp" && !row.stamp_mime) {
    // Not an error in the counter — it simply is not a stamp, so there is no
    // decoded image to serve. Matches the upstream route's own answer.
    return new Response("not stamp-like", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // What this variant actually serves. A stamp is the one variant whose bytes
  // are not the counter's bytes: `content_type` describes the `STAMP:<base64>`
  // text and `size` measures it, while the response is the image that text
  // decodes to — 2,808 bytes of image/gif behind 3,750 bytes of text/plain for
  // #188 LORDFUN. Declaring the row's length here would leave a browser
  // waiting on 942 bytes that never arrive.
  const declaredType = variant === "stamp" ? row.stamp_mime! : row.content_type;

  // Content-addressed: the same bytes are the same object no matter which
  // number asked for them, so a reinscription of identical content is stored
  // once. Previews are derived, so they key on the variant too.
  const key = row.sha256 ? `${variant}/${row.sha256}` : `${variant}/n/${number}`;
  const range = request.headers.get("range");

  // Range requests bypass R2's object cache and stream from the upstream:
  // R2 supports ranged reads, but only for a body we have already stored, and
  // the seek-into-a-large-PDF case is exactly the one we do not want to
  // block on a full download of.
  if (!range) {
    const hit = await env.CONTENT.get(key);
    // `hit.size` rather than `row.size`: R2 knows exactly what it stored, which
    // for a derived variant (a stamp's image, a preview's wrapper) is not the
    // counter's own byte count.
    if (hit) return respond(hit.body, declaredType, hit.size, frameAncestors, { cached: true });
  }

  const server = new CountersServer(env.COUNTERS_API_BASE);
  const upstream = variant === "preview"
    ? await server.preview(number, request)
    : variant === "stamp"
      ? await server.stamp(number, request)
      : await server.content(number, request);

  if (!upstream.ok && upstream.status !== 206) {
    return new Response("upstream unavailable", { status: 502 });
  }

  const type = upstream.headers.get("content-type") ?? declaredType;

  if (range || upstream.status === 206) {
    // Pass a partial straight through, headers and all — re-deriving
    // Content-Range here would only be a chance to get it wrong.
    const headers = securityHeaders(type, frameAncestors);
    for (const h of ["content-range", "content-length", "accept-ranges"]) {
      const value = upstream.headers.get(h);
      if (value) headers.set(h, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // Only the identity variant can fall back to the row's size; for a derived
  // one an absent content-length means "unknown", and 0 suppresses the header
  // rather than asserting a wrong number.
  const fallbackLength = variant === "content" ? row.size : 0;
  const length = Number(upstream.headers.get("content-length") ?? fallbackLength);

  // A HEAD gets no body to tee, so there is nothing to store — and trying
  // would hang the put on a stream that never delivers. Answer from the
  // headers and leave the cache to the next GET.
  if (request.method === "HEAD") {
    return respond(null, type, length, frameAncestors, { cached: false });
  }

  // Tee: one branch to the client now, one into R2. The write must be held
  // open with waitUntil — a tee branch is only drained while the request
  // context is alive, so without it the put races the response and loses,
  // which shows up as every fetch reporting a cache miss.
  const [toClient, toStore] = upstream.body!.tee();
  ctx.waitUntil(
    env.CONTENT.put(key, toStore, {
      httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
    }).catch(() => {
      // A failed cache write is not a failed request; the next hit re-fetches.
    }),
  );

  return respond(toClient, type, length, frameAncestors, { cached: false });
}

function respond(
  body: ReadableStream | null,
  type: string,
  length: number,
  frameAncestors: string,
  meta: { cached: boolean },
): Response {
  const headers = securityHeaders(type, frameAncestors);
  if (length > 0) headers.set("content-length", String(length));
  headers.set("x-counters-cache", meta.cached ? "hit" : "miss");
  return new Response(body, { headers });
}

function securityHeaders(type: string, frameAncestors: string): Headers {
  const safe = INLINE_SAFE.test(type) ? type : "application/octet-stream";
  return new Headers({
    "content-type": safe,
    // Immutable in the strongest sense available: these bytes are in a
    // Bitcoin block and cannot change.
    "cache-control": "public, max-age=31536000, immutable",
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "content-security-policy": sandboxCsp(frameAncestors),
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
  });
}
