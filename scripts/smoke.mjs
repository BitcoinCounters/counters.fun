#!/usr/bin/env node
/**
 * Post-deploy gate. Asserts the things that would be silently wrong rather
 * than loudly broken.
 *
 * The first check is the important one: a route returning a pointer-like
 * counter would not look like a failure — it would look like counters.fun
 * fetching art from someone else's server, which is the one thing the site
 * exists not to do. It is checked here, in the deploy path, as well as in the
 * SQL and the unit tests.
 *
 *   node scripts/smoke.mjs [api-base]
 */

const BASE = process.argv[2] ?? process.env.COUNTERS_API_BASE ?? "http://127.0.0.1:8787";

let failures = 0;

function check(name, ok, detail = "") {
  const mark = ok ? "[32m✓[0m" : "[31m✗[0m";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function json(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()).result;
}

const counters = await json(`/counters?cb=${Date.now()}`);
const all = [...counters.pooled, ...counters.minting, ...counters.unpooled];

check(
  "no route returns an off-chain pointer",
  all.every((c) => c.is_pointer_like === 0),
  `${all.length} rows checked`,
);
check(
  "no route returns an empty counter",
  all.every((c) => c.size > 0),
);

const stats = await json(`/stats?cb=${Date.now()}`);
check("the index has synced", stats.counters_total > 0, `${stats.counters_total} counters`);
check(
  "on-chain counters are a strict subset",
  stats.counters_on_chain > 0 && stats.counters_on_chain < stats.counters_total,
  `${stats.counters_on_chain} of ${stats.counters_total}`,
);
check("the chain tip is recorded", stats.tip > 900_000, `block ${stats.tip}`);
check(
  "the sync ran recently",
  Date.now() / 1000 - stats.synced_at < 3600,
  `${Math.round(Date.now() / 1000 - stats.synced_at)}s ago`,
);

// The content proxy is the only thing standing between an on-chain program and
// this origin. A missing CSP here is a live cross-site scripting hole.
if (counters.pooled.length > 0 || counters.unpooled.length > 0) {
  const sample = (counters.pooled[0] ?? counters.unpooled[0]).number;
  const res = await fetch(`${BASE}/content/${sample}`);
  const csp = res.headers.get("content-security-policy") ?? "";
  check("content is served", res.ok, `#${sample} ${res.headers.get("content-type")}`);
  check("content is sandboxed", csp.includes("sandbox"), csp.slice(0, 60));
  check("content has no network", csp.includes("default-src 'none'"));
  check("content is frame-limited", csp.includes("frame-ancestors"));
  check("content supports Range", res.headers.get("accept-ranges") === "bytes");
}

// A pointer's "content" is a URL. Serving it would mean fetching from whatever
// server it names — the refusal is load-bearing, not cosmetic.
const pointer = await fetch(`${BASE}/content/77`);
check("the proxy refuses a pointer", pointer.status === 415, `got ${pointer.status}`);

console.log(failures === 0 ? "\nall good" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
