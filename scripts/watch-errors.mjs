#!/usr/bin/env node
/**
 * One stream of everything wrong with a local run.
 *
 * Two files feed it and they answer different questions:
 *
 * - `.logs/errors.log` — what the *site* did wrong: an exception in a tab, a
 *   promise nobody caught, a page or route that threw on the server. Written
 *   by `apps/web/src/lib/dev-errors.ts`; one JSON object per line.
 * - `.logs/local.log` — what the *stack* did wrong: a dev server that could not
 *   take its port, a child that exited, a module that would not load. Written
 *   by `scripts/local.mjs`, and mostly ordinary request logging, so only the
 *   lines that mean something is broken are passed through.
 *
 * The second half matters more than it looks. Watching only the error log makes
 * a crashed server indistinguishable from a quiet one — both are silence.
 *
 *   node scripts/watch-errors.mjs        # follow
 *   node scripts/watch-errors.mjs --all  # replay what is already there first
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, closeSync, openSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = join(ROOT, ".logs");
const REPLAY = process.argv.includes("--all");

/** Signatures that mean the stack itself is in trouble, not merely chatty. */
const STACK_TROUBLE =
  /EADDRINUSE|exited with|Cannot find module|MODULE_NOT_FOUND|FATAL|⨯|Unhandled|ECONNREFUSED|did not come up/;

/** `tail -F`: follows across the truncation a restart does. */
function follow(file, onLine) {
  // Touch it, so tail does not spend the first seconds complaining.
  mkdirSync(LOGS, { recursive: true });
  closeSync(openSync(file, "a"));
  const tail = spawn("tail", [REPLAY ? "-n+1" : "-n0", "-F", file], { stdio: ["ignore", "pipe", "ignore"] });
  createInterface({ input: tail.stdout }).on("line", onLine);
  return tail;
}

/** A stack that scrolls is not a summary; the first line of ours is enough. */
function firstFrame(stack) {
  if (!stack) return "";
  const frame = stack
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .find((l) => l.includes("/src/") || l.includes("/apps/")) ?? "";
  return frame ? ` — ${frame.replace(/^at\s+/, "").replace(ROOT, "")}` : "";
}

follow(join(LOGS, "errors.log"), (line) => {
  if (!line.trim()) return;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    console.log(`[site] ${line.slice(0, 400)}`);
    return;
  }
  const where = e.url ? ` (${e.url})` : "";
  console.log(`[site] ${e.source} ${e.kind}: ${e.message}${where}${firstFrame(e.stack)}`);
});

follow(join(LOGS, "local.log"), (line) => {
  if (STACK_TROUBLE.test(line)) console.log(`[stack] ${line.trim().slice(0, 400)}`);
});
