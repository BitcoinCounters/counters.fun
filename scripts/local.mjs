#!/usr/bin/env node
/**
 * Run counters.fun locally: the API worker, the web app, and a sync loop.
 *
 * Three things have to be true for the site to work, and running them by hand
 * gets one of them wrong every time:
 *
 * 1. **The API worker is up before the web app renders.** The home page fetches
 *    the index server-side. It degrades to an empty page rather than failing,
 *    which is right in production and confusing locally — so this waits.
 * 2. **`WEB_ORIGIN` matches the port the web app is on.** It becomes the
 *    content proxy's `frame-ancestors`; a mismatch silently stops HTML and
 *    JavaScript counters from rendering, and looks exactly like a broken
 *    renderer rather than a policy difference.
 * 3. **Something drives the cron.** `wrangler dev` registers the scheduled
 *    handler but never fires it on a timer, so a local index freezes at
 *    whatever it held when you last ran a sync. This pokes it.
 *
 *   node scripts/local.mjs            # dev server, hot reload
 *   node scripts/local.mjs --prod     # production build, served
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_PORT = Number(process.env.WEB_PORT ?? 3010);
const API_PORT = Number(process.env.API_PORT ?? 8787);
const PROD = process.argv.includes("--prod");

/** Every ten minutes: often enough that a new block shows up, cheap enough to ignore. */
const SYNC_INTERVAL_MS = 10 * 60_000;

const children = [];

function run(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `[${name}]`;
  const relay = (stream) => {
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) console.log(`${tag} ${line}`);
    });
  };
  relay(child.stdout);
  relay(child.stderr);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.log(`${tag} exited with ${code}`);
  });
  children.push(child);
  return child;
}

async function waitFor(url, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`! ${label} did not come up within ${timeoutMs / 1000}s`);
  return false;
}

/**
 * Keep `.dev.vars` in step with the port actually in use.
 *
 * Rewritten rather than merely checked: getting this wrong costs an hour of
 * debugging a renderer that is working perfectly and simply not allowed to be
 * framed.
 */
function alignDevVars() {
  const path = join(ROOT, "apps/api/.dev.vars");
  const origins = `http://localhost:${WEB_PORT} http://127.0.0.1:${WEB_PORT}`;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const line = `WEB_ORIGIN = "${origins}"`;
  const next = /^WEB_ORIGIN\s*=.*$/m.test(text)
    ? text.replace(/^WEB_ORIGIN\s*=.*$/m, line)
    : `${text.trimEnd()}\n${line}\n`;
  if (next !== text) {
    writeFileSync(path, next.startsWith("\n") ? next.slice(1) : next);
    console.log(`[local] WEB_ORIGIN → ${origins}`);
  }
}

/** Fire the worker's scheduled handler; wrangler dev registers it but never runs it. */
async function sync() {
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/cdn-cgi/handler/scheduled`, {
      signal: AbortSignal.timeout(120_000),
    });
    console.log(`[local] sync ${res.ok ? "ok" : `failed (${res.status})`}`);
  } catch (cause) {
    console.log(`[local] sync failed: ${cause.message}`);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() {
  console.log("\n[local] stopping…");
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}

// --------------------------------------------------------------------------

alignDevVars();

run("api", "npx", ["wrangler", "dev", "--port", String(API_PORT)], join(ROOT, "apps/api"));
await waitFor(`http://127.0.0.1:${API_PORT}/`, "api");

// Seed the index before the web app renders against it, so the first page load
// is not an empty one.
await sync();
setInterval(sync, SYNC_INTERVAL_MS);

if (PROD) {
  console.log("[local] building…");
  await new Promise((resolve) => {
    run("build", "npm", ["run", "build"], join(ROOT, "apps/web")).on("exit", resolve);
  });
  run("web", "npx", ["next", "start", "--port", String(WEB_PORT)], join(ROOT, "apps/web"), {
    NEXT_PUBLIC_COUNTERS_API_BASE: `http://127.0.0.1:${API_PORT}`,
  });
} else {
  run("web", "npx", ["next", "dev", "--port", String(WEB_PORT)], join(ROOT, "apps/web"), {
    NEXT_PUBLIC_COUNTERS_API_BASE: `http://127.0.0.1:${API_PORT}`,
  });
}

await waitFor(`http://127.0.0.1:${WEB_PORT}/`, "web");

console.log("");
console.log(`  counters.fun   http://localhost:${WEB_PORT}`);
console.log(`  api            http://localhost:${API_PORT}`);
console.log(`  syncing every  ${SYNC_INTERVAL_MS / 60_000} min   (npm run sync to force one)`);
console.log("");
