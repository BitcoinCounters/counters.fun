import "server-only";

/**
 * Reveals waiting on the box, not in a tab.
 *
 * Once a commit is broadcast, the pre-signed reveal is the ONLY transaction
 * that can ever spend its output: Counterparty signs the envelope with an
 * ephemeral key it discards, the 0-value OP_RETURN forecloses CPFP and the
 * 64-byte signature forecloses RBF. Lose that hex and the coins are stranded
 * for good.
 *
 * A Slipstream reveal cannot be sent when it is signed, either — MARA prices a
 * reveal from the chain and from its own submissions, never from the public
 * mempool, so the commit must be MINED first. That wait is open-ended. Doing it
 * in the browser means the person has to leave a tab open for hours, so it
 * happens here instead: the hex lives on disk beside this server and a timer
 * finishes the job whether or not anyone is watching.
 *
 * The lifecycle is deliberately narrow:
 *
 *   - **Nothing is stored before the commit is broadcast.** Until then no coins
 *     have moved and there is nothing to protect.
 *   - **Once the commit is mined the record is permanent.** It is the only key
 *     to those coins.
 *   - **A record is deleted only when the reveal is provably worthless** — when
 *     one of the commit's inputs has been spent by a DIFFERENT transaction, so
 *     the commit can never confirm.
 *
 * A commit merely missing from the mempool proves nothing: nodes restart,
 * low-fee transactions get evicted, and a rebroadcast brings it back with the
 * reveal still valid. Absence therefore KEEPS the record.
 *
 * Storage is plain files rather than a database: a multi-megabyte reveal hex is
 * exactly what a file is for, and this needs no schema, no migration and no new
 * dependency.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RawTx, Transaction } from "@scure/btc-signer";
import { classify, type Verdict } from "@counters/core/slipstream";
import { COUNTERPARTY_API_BASE } from "@/lib/constants";

/** Where jobs live. Beside the server, not in the repo, and not in /tmp. */
const DIR = process.env.REVEAL_JOBS_DIR ?? join(process.cwd(), ".reveal-jobs");

const SLIPSTREAM = (process.env.SLIPSTREAM_API_URL ?? "https://slipstream.mara.com").replace(
  /\/+$/,
  "",
);
const KEY = process.env.SLIPSTREAM_API_KEY || null;

/** A multi-MB upload plus the origin's think time on thousands of inputs. */
const SUBMIT_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 20_000;
/** After an ambiguous 524, re-upload no more often than this, and no more than this often. */
const RESUBMIT_EVERY_MS = 30 * 60_000;
const RESUBMIT_MAX = 6;
/** Give up hunting for a submission window after this long, and try again next tick. */
const PROBE_CAP = 1200;

export type JobPhase =
  | "awaiting-commit"
  | "probing"
  | "watching"
  | "confirmed"
  | "rejected"
  | "dead";

const TERMINAL = new Set<JobPhase>(["confirmed", "rejected", "dead"]);

export interface RevealJob {
  commitTxid: string;
  revealTxid: string;
  source: string;
  asset: string | null;
  /** The commit's first input — the outpoint that decides `dead` from `absent`. */
  sentinel: { txid: string; vout: number };
  phase: JobPhase;
  submitted: boolean;
  /** True after a 524 that may or may not have landed. Drives slow re-upload. */
  ambiguous: boolean;
  probes: number;
  streak: number;
  attempts: number;
  resubmits: number;
  lastUpload: number | null;
  blockHeight: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  log: string[];
}

/* ------------------------------------------------------------------ */
/* The node — the only authority on what actually happened            */
/* ------------------------------------------------------------------ */

interface RawTx {
  confirmations?: number;
  blockhash?: string;
  vin?: { txid: string; vout: number }[];
}

async function cp<T>(path: string): Promise<T | null> {
  // COUNTERPARTY_API_BASE already ends in /v2 — see lib/constants.
  const res = await fetch(`${COUNTERPARTY_API_BASE}/${path}`, { cache: "no-store" });
  // A transaction this node has never seen comes back 400, not 404 — both mean
  // "no such transaction" here, and neither is an error worth propagating.
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Counterparty said ${res.status} for ${path}`);
  const body = (await res.json()) as { result?: T };
  return (body.result ?? null) as T | null;
}

function txPath(txid: string): string {
  return `bitcoin/transactions/${encodeURIComponent(txid)}?verbose=true`;
}

export type ChainState = "confirmed" | "mempool" | "absent" | "conflict";

/**
 * What our node knows about a transaction.
 *
 * When it cannot be found, `sentinel` — its first input — decides between two
 * very different absences: still unspent means the transaction is merely
 * un-relayed and can go out again, while spent means something else took the
 * coin and this transaction is dead forever.
 *
 * A node that cannot answer at all returns `absent`, never `conflict`: only the
 * latter deletes anything, and a stopped node is not evidence of a double
 * spend.
 */
export async function chainState(
  txid: string,
  sentinel: { txid: string; vout: number },
): Promise<{ state: ChainState; height: number | null }> {
  let tx: RawTx | null = null;
  try {
    tx = await cp<RawTx>(txPath(txid));
  } catch {
    return { state: "absent", height: null };
  }
  if (tx) {
    if ((tx.confirmations ?? 0) > 0) {
      return { state: "confirmed", height: null };
    }
    return { state: "mempool", height: null };
  }

  // Not found by this node. That alone proves nothing — it can mean the
  // transaction was evicted at a low fee and would come straight back on a
  // rebroadcast, or it can mean something else spent its input and it is dead
  // forever. Only the second justifies deleting a reveal, and only `gettxout`
  // can tell them apart.
  //
  // Counterparty exposes no `gettxout`, so this needs bitcoind directly. When
  // that is not configured the answer is `absent`, never `conflict`: keeping a
  // reveal that turns out to be worthless costs a few kilobytes, while deleting
  // one that was still good strands the coins for good.
  const spent = await outpointSpent(sentinel);
  return { state: spent === true ? "conflict" : "absent", height: null };
}

/**
 * Is this outpoint gone from the UTXO set?
 *
 * `null` means "cannot tell" — no RPC configured, or the node did not answer —
 * and callers must treat that as "keep", never as a double spend.
 */
async function outpointSpent(out: { txid: string; vout: number }): Promise<boolean | null> {
  const url = process.env.BITCOIN_RPC_URL;
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(
          `${process.env.BITCOIN_RPC_USER ?? ""}:${process.env.BITCOIN_RPC_PASSWORD ?? ""}`,
        ).toString("base64")}`,
      },
      body: JSON.stringify({ jsonrpc: "1.0", method: "gettxout", params: [out.txid, out.vout] }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body.error) return null;
    return body.result === null;
  } catch {
    return null;
  }
}

/**
 * The reveal's own txid and the outpoint it spends, computed from the bytes.
 *
 * Done here rather than by asking the node: Counterparty's decode endpoint
 * takes the transaction in a query string, which a multi-megabyte reveal will
 * never fit. This is pure arithmetic over the bytes and has no size limit.
 *
 * The txid matters for more than a label — it is what the runner watches for on
 * chain, and it is the guard that stops an already-mined reveal from ever being
 * submitted again.
 */
function decodeReveal(hex: string): { txid: string; spends: { txid: string; vout: number } } {
  const bytes = hexToBytes(hex);
  const txid = Transaction.fromRaw(bytes, {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  }).id;
  const input = RawTx.decode(bytes).inputs[0];
  if (!input) throw new EnqueueError("the reveal has no inputs");
  return { txid, spends: { txid: bytesToHex(input.txid!), vout: input.index! } };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

const meta = (txid: string) => join(DIR, `${txid}.json`);
const hexFile = (txid: string) => join(DIR, `${txid}.hex`);

async function save(job: RevealJob): Promise<void> {
  await mkdir(DIR, { recursive: true });
  job.updatedAt = Date.now();
  // Written to a temporary name and renamed, so a crash mid-write cannot leave
  // a half-parsed job behind.
  const tmp = `${meta(job.commitTxid)}.tmp`;
  await writeFile(tmp, JSON.stringify(job, null, 2));
  await rename(tmp, meta(job.commitTxid));
}

export async function readJob(commitTxid: string): Promise<RevealJob | null> {
  try {
    return JSON.parse(await readFile(meta(commitTxid), "utf8")) as RevealJob;
  } catch {
    return null;
  }
}

export async function readHex(commitTxid: string): Promise<string | null> {
  try {
    return (await readFile(hexFile(commitTxid), "utf8")).trim();
  } catch {
    return null;
  }
}

export async function listJobs(source?: string): Promise<RevealJob[]> {
  let names: string[];
  try {
    names = await readdir(DIR);
  } catch {
    return [];
  }
  const jobs: RevealJob[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const job = await readJob(name.slice(0, -5));
    if (job && (!source || job.source === source)) jobs.push(job);
  }
  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Drop a job whose commit can never confirm.
 *
 * Refuses to touch a confirmed one: that record is the only key to real coins.
 */
async function remove(job: RevealJob): Promise<void> {
  if (job.phase === "confirmed") return;
  await unlink(meta(job.commitTxid)).catch(() => {});
  await unlink(hexFile(job.commitTxid)).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Enqueue                                                             */
/* ------------------------------------------------------------------ */

export class EnqueueError extends Error {}

/**
 * Take a signed reveal for safekeeping and start working on it.
 *
 * The reveal is decoded by the node rather than trusted: its first input must
 * be the named commit, and that commit must already be on chain. Both checks
 * come free with the lookup, and together they mean nothing is stored before
 * coins are actually at risk.
 */
export async function enqueue(input: {
  commitTxid: string;
  revealHex: string;
  source: string;
  asset?: string | null;
}): Promise<RevealJob> {
  const { commitTxid, revealHex, source } = input;
  if (!/^[0-9a-fA-F]{64}$/.test(commitTxid)) {
    throw new EnqueueError("commitTxid must be a 64-character hex txid");
  }
  if (!/^[0-9a-fA-F]+$/.test(revealHex) || revealHex.length < 20) {
    throw new EnqueueError("revealHex must be a raw transaction");
  }

  const existing = await readJob(commitTxid);
  if (existing) return existing;

  // The reveal must spend the commit it was filed under. This is what makes the
  // record trustworthy without knowing anything about who sent it.
  let decoded: ReturnType<typeof decodeReveal>;
  try {
    decoded = decodeReveal(revealHex);
  } catch (cause) {
    throw new EnqueueError(`the reveal does not decode: ${(cause as Error).message}`);
  }
  if (decoded.spends.txid !== commitTxid) {
    throw new EnqueueError(
      `this reveal spends ${decoded.spends.txid.slice(0, 16)}…, not the commit it was filed under`,
    );
  }

  const commit = await cp<RawTx>(txPath(commitTxid));
  if (!commit) {
    throw new EnqueueError(
      "this node has never seen that commit. Send a reveal only after its commit is broadcast.",
    );
  }
  const sentinel = commit.vin?.[0];
  if (!sentinel) throw new EnqueueError("the commit has no inputs");

  const job: RevealJob = {
    commitTxid,
    revealTxid: decoded.txid,
    source,
    asset: input.asset ?? null,
    sentinel: { txid: sentinel.txid, vout: sentinel.vout },
    phase: (commit.confirmations ?? 0) > 0 ? "probing" : "awaiting-commit",
    submitted: false,
    ambiguous: false,
    probes: 0,
    streak: 0,
    attempts: 0,
    resubmits: 0,
    lastUpload: null,
    blockHeight: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    log: [],
  };

  await mkdir(DIR, { recursive: true });
  await writeFile(hexFile(commitTxid), revealHex);
  await save(job);
  return job;
}

/* ------------------------------------------------------------------ */
/* Slipstream                                                          */
/* ------------------------------------------------------------------ */

async function post(
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number | null; body: string; seconds: number }> {
  const started = Date.now();
  try {
    const res = await fetch(`${SLIPSTREAM}/api/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: res.status,
      body: (await res.text()).slice(0, 600).trim(),
      seconds: (Date.now() - started) / 1000,
    };
  } catch (cause) {
    return {
      status: null,
      body: `${(cause as Error).name}: ${(cause as Error).message}`,
      seconds: (Date.now() - started) / 1000,
    };
  }
}

/** Is MARA's origin answering right now? A FAST deserialization error says yes. */
async function probe(): Promise<boolean> {
  const { status, seconds } = await post(
    { tx_hex: "00", ...(KEY ? { client_code: KEY } : {}) },
    PROBE_TIMEOUT_MS,
  );
  return status === 400 && seconds < 2;
}

async function submit(hex: string): Promise<{ verdict: Verdict; message: string }> {
  const { status, body, seconds } = await post(
    { tx_hex: hex, ...(KEY ? { client_code: KEY } : {}) },
    SUBMIT_TIMEOUT_MS,
  );
  return { verdict: classify(status, body, seconds), message: body };
}

/* ------------------------------------------------------------------ */
/* The state machine                                                   */
/* ------------------------------------------------------------------ */

function say(job: RevealJob, message: string): void {
  job.log = [...job.log, `${new Date().toISOString()}  ${message}`].slice(-200);
}

/**
 * Advance one job by one action.
 *
 * Every phase re-reads the chain first, because the cheapest way to be wrong
 * here is to act on a transaction that has already landed.
 */
export async function step(job: RevealJob): Promise<RevealJob> {
  if (TERMINAL.has(job.phase)) return job;

  // Already mined? Then nothing else matters — and never resubmit it.
  if (job.revealTxid) {
    const { state, height } = await chainState(job.revealTxid, job.sentinel);
    if (state === "confirmed") {
      job.phase = "confirmed";
      job.blockHeight = height;
      say(job, "CONFIRMED on chain");
      await save(job);
      return job;
    }
  }

  const commit = await chainState(job.commitTxid, job.sentinel);
  if (commit.state === "conflict") {
    say(job, "an input of the commit was spent by a different transaction");
    job.phase = "dead";
    job.error = "the commit was double-spent; this reveal can never confirm";
    await save(job);
    await remove(job);
    return job;
  }

  if (job.phase === "awaiting-commit") {
    if (commit.state !== "confirmed") return job; // absence is not failure
    say(job, "commit confirmed — Slipstream can price the reveal now");
    job.phase = "probing";
    await save(job);
    return job;
  }

  if (job.phase === "probing") {
    if (job.probes >= PROBE_CAP) {
      job.phase = "rejected";
      job.error = `no healthy submission window in ${job.probes} probes`;
      await save(job);
      return job;
    }
    job.probes += 1;
    job.streak = (await probe()) ? job.streak + 1 : 0;
    if (job.streak < 2) {
      await save(job);
      return job;
    }

    const hex = await readHex(job.commitTxid);
    if (!hex) {
      job.phase = "dead";
      job.error = "the signed reveal hex is missing from disk";
      await save(job);
      return job;
    }

    job.attempts += 1;
    say(job, `window open — submitting ${(hex.length / 2).toLocaleString()} bytes`);
    const { verdict, message } = await submit(hex);
    say(job, `submit -> ${verdict}: ${message.slice(0, 160)}`);
    job.lastUpload = Date.now();

    if (verdict === "rejected") {
      job.phase = "rejected";
      job.error = message.slice(0, 300);
    } else if (verdict === "ambiguous") {
      // The body never landed. Back to probing.
      job.streak = 0;
    } else {
      job.phase = "watching";
      job.submitted = true;
      job.ambiguous = verdict === "probably-accepted";
      if (job.ambiguous) {
        say(
          job,
          "524 after the full upload — the origin was still working when Cloudflare gave up. " +
            "Watching the chain, re-uploading slowly in case it did not take",
        );
      }
    }
    await save(job);
    return job;
  }

  if (job.phase === "watching" && job.ambiguous && job.resubmits < RESUBMIT_MAX) {
    if ((job.lastUpload ?? 0) + RESUBMIT_EVERY_MS < Date.now() && (await probe())) {
      const hex = await readHex(job.commitTxid);
      if (hex) {
        job.resubmits += 1;
        job.lastUpload = Date.now();
        say(job, `still not on chain — re-uploading (${job.resubmits} of ${RESUBMIT_MAX})`);
        const { verdict, message } = await submit(hex);
        say(job, `resubmit -> ${verdict}`);
        if (verdict === "rejected") {
          job.phase = "rejected";
          job.error = message.slice(0, 300);
        } else if (verdict === "accepted") {
          job.ambiguous = false;
        }
      }
    }
    await save(job);
  }
  return job;
}

/* ------------------------------------------------------------------ */
/* The runner                                                          */
/* ------------------------------------------------------------------ */

/** Seconds between passes: short while hunting a window, long while waiting on blocks. */
const PROBE_TICK_MS = 6_000;
const IDLE_TICK_MS = 30_000;

let timer: ReturnType<typeof setTimeout> | null = null;

async function pass(): Promise<number> {
  const jobs = await listJobs();
  let next = IDLE_TICK_MS;
  for (const job of jobs) {
    if (TERMINAL.has(job.phase)) continue;
    try {
      const advanced = await step(job);
      if (advanced.phase === "probing") next = Math.min(next, PROBE_TICK_MS);
    } catch {
      // A job that cannot be advanced this pass is retried on the next one;
      // nothing is lost by waiting.
    }
  }
  return next;
}

/**
 * Start the loop. Idempotent, so a hot reload cannot leave two of them running.
 */
export function startRunner(): void {
  if (timer) return;
  const tick = async () => {
    let delay = IDLE_TICK_MS;
    try {
      delay = await pass();
    } catch {
      // Never let one bad pass stop the loop.
    }
    timer = setTimeout(tick, delay);
    // Do not hold the process open for this alone.
    timer.unref?.();
  };
  timer = setTimeout(tick, 1_000);
  timer.unref?.();
}
