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
    const base = { is_pointer_like: false, size: 1000 };

    expect(renderMode({ ...base, content_type: "image/png" })).toBe("image");
    expect(renderMode({ ...base, content_type: "image/jpeg" })).toBe("image");
    // SVG is an image element's job everywhere else and a script host here.
    expect(renderMode({ ...base, content_type: "image/svg+xml" })).toBe("sandbox");
    expect(renderMode({ ...base, content_type: "text/html" })).toBe("sandbox");

    // A pointer renders as nothing at all, whatever it claims to be.
    expect(renderMode({ is_pointer_like: true, size: 64, content_type: "image/png" })).toBe("none");
  });

  it("shows textual content as text rather than in a browser's inspector", () => {
    const base = { is_pointer_like: false, size: 1000 };

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

  it("badges inscriptions by weight", () => {
    expect(sizeBadge(295)).toBeNull();
    expect(sizeBadge(130_803)).toBeNull();
    expect(sizeBadge(3_858_946)).toBe("whole block");
    expect(sizeBadge(500_000)).toBe("large");
  });
});
