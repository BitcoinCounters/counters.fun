/**
 * Slipstream (MARA), server-side.
 *
 * Three things force this onto the server rather than into the page:
 * slipstream.mara.com sends no CORS headers, a multi-megabyte reveal needs a
 * far longer upload timeout than a browser fetch allows, and an API key — when
 * one exists — must not ship to a browser.
 *
 * A key is optional. Every endpoint here answers unauthenticated; the key only
 * buys whatever fee discount MARA has assigned it, and its absence never blocks
 * a submission.
 *
 * `POST` deliberately returns the raw verdict rather than throwing on a
 * non-200. The caller cannot decide anything without the status code and the
 * elapsed time — a 524 after a full upload means the opposite of a fast one —
 * so the classification lives in `@counters/core/slipstream` and this route
 * reports what happened rather than interpreting it.
 */

import { classify, parseRates } from "@counters/core/slipstream";

export const dynamic = "force-dynamic";

const BASE = (process.env.SLIPSTREAM_API_URL ?? "https://slipstream.mara.com").replace(/\/+$/, "");
const KEY = process.env.SLIPSTREAM_API_KEY || null;

/** A multi-megabyte upload plus the origin's think time on thousands of inputs. */
const SUBMIT_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 20_000;

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
  };
}

/** POST to Slipstream and report what happened, without throwing. */
async function post(
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number | null; body: string; seconds: number }> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: headers(),
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
    // No answer at all — a timeout, a dead connection, a DNS failure. The
    // caller treats every one of these the same way: the body never landed.
    return {
      status: null,
      body: `${(cause as Error).name}: ${(cause as Error).message}`,
      seconds: (Date.now() - started) / 1000,
    };
  }
}

/**
 * Is the origin answering right now?
 *
 * Slipstream sits behind Cloudflare, which answers even when the origin does
 * not — so reachability proves nothing. A deserialization error does: only the
 * origin can produce one. `"00"` is the cheapest way to ask, and a FAST such
 * answer is the signal, because a slow one means the origin is already
 * struggling and a real submission would likely die mid-upload.
 */
async function probe() {
  const { status, seconds } = await post(
    { tx_hex: "00", ...(KEY ? { client_code: KEY } : {}) },
    PROBE_TIMEOUT_MS,
  );
  return { alive: status === 400 && seconds < 2, status, seconds };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const action = params.get("action") ?? "rates";

  try {
    if (action === "rates") {
      const res = await fetch(`${BASE}/api/rates`, { headers: headers(), cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(`Slipstream /api/rates failed (${res.status})`);
      }
      return Response.json(
        { ...parseRates(body), haveKey: KEY !== null },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (action === "probe") {
      return Response.json(await probe(), { headers: { "cache-control": "no-store" } });
    }

    if (action === "status") {
      const txid = params.get("txid");
      if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) {
        return Response.json({ error: "a 64-character txid is required" }, { status: 400 });
      }
      const res = await fetch(
        `${BASE}/api/transactions/status?tx_id=${encodeURIComponent(txid)}`,
        { headers: headers(), cache: "no-store" },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`Slipstream status failed (${res.status})`);
      // Never a decision, only a display: this endpoint has reported "not
      // found" for transactions that later mined.
      return Response.json(body ?? {}, { headers: { "cache-control": "no-store" } });
    }

    return Response.json({ error: `unknown action ${action}` }, { status: 400 });
  } catch (cause) {
    return Response.json({ error: (cause as Error).message }, { status: 502 });
  }
}

/**
 * Submit a signed transaction.
 *
 * Answers 200 with a verdict in every case Slipstream itself answered, because
 * "rejected" and "probably accepted" are both real outcomes the caller must act
 * on differently. Only a malformed request is a 4xx here.
 */
export async function POST(request: Request) {
  let hex: unknown;
  try {
    hex = (await request.json())?.hex;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  if (typeof hex !== "string" || !/^[0-9a-fA-F]+$/.test(hex) || hex.length < 20) {
    return Response.json({ error: "hex must be a raw transaction" }, { status: 400 });
  }

  const { status, body, seconds } = await post(
    { tx_hex: hex, ...(KEY ? { client_code: KEY } : {}) },
    SUBMIT_TIMEOUT_MS,
  );
  const verdict = classify(status, body, seconds);
  return Response.json(
    { verdict, status, seconds, message: body.slice(0, 400) },
    { headers: { "cache-control": "no-store" } },
  );
}
