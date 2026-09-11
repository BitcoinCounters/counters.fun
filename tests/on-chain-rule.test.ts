/**
 * The rule counters.fun is built on: only counters whose file is actually on
 * Bitcoin are displayed.
 *
 * This runs against the live counters index rather than a fixture, because
 * the rule is about real data and the interesting cases keep arriving. On the
 * index as of block 965,850 it separates 70 genuine on-chain files from 98
 * counters whose "content" is a 64-byte ipfs:// or https:// URL — more than
 * half the index. A regression here would not look like a broken test in
 * production; it would look like counters.fun quietly fetching art from
 * somebody else's server.
 */

import { describe, expect, it } from "vitest";
import { isOnChain, renderMode, sizeBadge, undisplayableReason, type Counter } from "../packages/counters/src/counter";

const COUNTERS_API = process.env.COUNTERS_API_BASE ?? "http://127.0.0.1:8081";

async function fullIndex(): Promise<Counter[]> {
  const all: Counter[] = [];
  let before: number | undefined;

  // `before=<number>`, never `offset` — the server accepts an offset
  // parameter and silently ignores it, so an offset loop never terminates.
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (before !== undefined) query.set("before", String(before));
    const res = await fetch(`${COUNTERS_API}/counters?${query}`);
    const body = (await res.json()) as { counters: Counter[] };
    if (!body.counters?.length) break;
    all.push(...body.counters);
    const last = body.counters[body.counters.length - 1]!;
    if (last.number <= 0) break;
    before = last.number;
  }
  return all;
}

describe("the on-chain rule", () => {
  it("splits the live index into files and pointers", async () => {
    const index = await fullIndex();
    expect(index.length).toBeGreaterThan(160);

    const onChain = index.filter(isOnChain);
    const pointers = index.filter((c) => !isOnChain(c));

    // Both sides must be non-empty, or the predicate has stopped discriminating.
    expect(onChain.length).toBeGreaterThan(0);
    expect(pointers.length).toBeGreaterThan(0);
    expect(onChain.length + pointers.length).toBe(index.length);

    // Every excluded counter is excluded for a stated reason.
    for (const c of pointers) {
      expect(undisplayableReason(c)).not.toBeNull();
    }
    for (const c of onChain) {
      expect(undisplayableReason(c)).toBeNull();
    }
  }, 60_000);

  it("never marks a URL-bodied counter as on-chain", async () => {
    const index = await fullIndex();

    for (const c of index) {
      if (!c.body) continue;
      const looksLikeUrl = /^(https?|ipfs|ar):/i.test(c.body.trim());
      if (looksLikeUrl) {
        expect(isOnChain(c), `#${c.number} ${c.asset} body=${c.body.slice(0, 40)}`).toBe(false);
      }
    }
  }, 60_000);

  it("routes markup to the sandbox, never to an img tag", () => {
    const base = { is_pointer_like: false, size: 1000, stamp_mime: null };

    expect(renderMode({ ...base, content_type: "image/png" })).toBe("image");
    expect(renderMode({ ...base, content_type: "image/jpeg" })).toBe("image");
    // SVG is an image element's job everywhere else and a script host here.
    expect(renderMode({ ...base, content_type: "image/svg+xml" })).toBe("sandbox");
    expect(renderMode({ ...base, content_type: "text/html" })).toBe("sandbox");

    // A pointer renders as nothing at all, whatever it claims to be.
    expect(
      renderMode({ is_pointer_like: true, size: 64, content_type: "image/png", stamp_mime: null }),
    ).toBe("none");
  });

  it("shows textual content as text rather than in a browser's inspector", () => {
    const base = { is_pointer_like: false, size: 1000, stamp_mime: null };

    // A browser handed application/json in a frame renders its own JSON
    // inspector, with a "Pretty print" checkbox floating over the content;
    // text/javascript gets displayed as plain text anyway, since a browser
    // never executes a top-level JS document. Both are safe either way — this
    // is about showing the file rather than a browser's opinion of it.
    expect(renderMode({ ...base, content_type: "text/plain" })).toBe("text");
    expect(renderMode({ ...base, content_type: "application/json" })).toBe("text");
    expect(renderMode({ ...base, content_type: "text/javascript" })).toBe("text");
    expect(renderMode({ ...base, content_type: "text/markdown" })).toBe("text");

    // A PDF or a sound file in a frame is a browser toolbar, not the file.
    expect(renderMode({ ...base, content_type: "application/pdf" })).toBe("document");
    expect(renderMode({ ...base, content_type: "audio/opus" })).toBe("document");
    expect(renderMode({ ...base, content_type: "video/mp4" })).toBe("document");

    // MIME parameters must not defeat the match — Core's extended MIME support
    // explicitly tolerates them (`audio/ogg;codecs=opus`).
    expect(renderMode({ ...base, content_type: "text/plain; charset=utf-8" })).toBe("text");
    expect(renderMode({ ...base, content_type: "audio/ogg;codecs=opus" })).toBe("document");
  });

  it("shows a stamp as its decoded image, not as the base64 it is written in", () => {
    const base = { is_pointer_like: false, size: 3750, content_type: "text/plain" };

    // #188 LORDFUN: 3,750 bytes of `STAMP:<base64>` text encoding a 2,808-byte
    // GIF. Rendered as the text it literally is, it is a wall of noise.
    expect(renderMode({ ...base, stamp_mime: "image/gif" })).toBe("stamp");
    expect(renderMode({ ...base, stamp_mime: "image/png" })).toBe("stamp");

    // The same bytes without a successful decode stay text. `stamp_mime` is
    // null exactly when the indexer's strict base64 check failed — #54
    // MAGICEGG's stray space, #59 XCPFTW's stray prefix — and damaged data is
    // never repaired here either.
    expect(renderMode({ ...base, stamp_mime: null })).toBe("text");

    // The rule still comes first: a pointer renders as nothing, stamp or not.
    expect(
      renderMode({ is_pointer_like: true, size: 64, content_type: "text/plain", stamp_mime: "image/gif" }),
    ).toBe("none");
  });

  it("renders every stamp in the live index as an image", async () => {
    const index = await fullIndex();
    const stamps = index.filter((c) => isOnChain(c) && c.stamp_mime);

    // 13 of 189 as of block 966,579. If this reaches zero the field has stopped
    // arriving and every stamp has silently gone back to rendering as base64.
    expect(stamps.length).toBeGreaterThan(0);

    for (const c of stamps) {
      expect(renderMode(c), `#${c.number} ${c.asset}`).toBe("stamp");
      // Upstream only sets the field after sniffing the decoded bytes, so a
      // stamp is always safe to put in an <img>.
      expect(c.stamp_mime, `#${c.number} ${c.asset}`).toMatch(/^image\//);
    }
  }, 60_000);

  it("badges inscriptions by weight", () => {
    expect(sizeBadge(295)).toBeNull();
    expect(sizeBadge(130_803)).toBeNull();
    expect(sizeBadge(3_858_946)).toBe("whole block");
    expect(sizeBadge(500_000)).toBe("large");
  });
});
