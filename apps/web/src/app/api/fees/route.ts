/**
 * Fee context from the node's own bitcoind.
 *
 * Counterparty's `/v2/bitcoin/estimatesmartfee` floors its answer at 1,024
 * sat/kB, which hides every sub-1 estimate — and this node relays down to 0.
 * So the numbers come straight from bitcoind, over a fixed list of three
 * read-only RPCs; nothing here is a passthrough. Credentials are server-side
 * env (`BITCOIN_RPC_URL`, `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASSWORD`). If
 * bitcoind does not answer, the local mempool backend (`MEMPOOL_API_BASE`,
 * the one Service-Manager runs on :8999) supplies its precise estimates —
 * also sub-1 capable. Nothing off this machine is ever asked.
 */

import { btcPerKvbToRate } from "@counters/core/fees";

export const dynamic = "force-dynamic";

const URL_ = process.env.BITCOIN_RPC_URL ?? "";
const USER = process.env.BITCOIN_RPC_USER ?? "";
const PASSWORD = process.env.BITCOIN_RPC_PASSWORD ?? "";
const MEMPOOL = (process.env.MEMPOOL_API_BASE ?? "http://127.0.0.1:8999/api").replace(/\/+$/, "");

const TARGETS: { key: "fast" | "normal" | "economy"; target: number }[] = [
  { key: "fast", target: 1 },
  { key: "normal", target: 3 },
  { key: "economy", target: 144 },
];

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: "fees", method, params }),
    signal: AbortSignal.timeout(4000),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } | null };
  if (body.error) throw new Error(body.error.message ?? method);
  return body.result as T;
}

/** The mempool backend's `fees/precise`: fractional sat/vB, `minimumFee` being its node's mempool floor. */
async function fromMempoolBackend() {
  const res = await fetch(`${MEMPOOL}/v1/fees/precise`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`mempool backend ${res.status}`);
  const f = (await res.json()) as Record<string, number>;
  const preset = (rate: number | undefined, blocks: number) =>
    rate !== undefined && Number.isFinite(rate) && rate > 0 ? { rate: Math.round(rate * 1000) / 1000, blocks } : null;
  return Response.json(
    {
      source: "mempool",
      floor: { minRelay: f.minimumFee ?? 0, mempoolMin: f.minimumFee ?? 0 },
      presets: { fast: preset(f.fastestFee, 1), normal: preset(f.halfHourFee, 3), economy: preset(f.economyFee, 144) },
    },
    { headers: { "cache-control": "public, max-age=15" } },
  );
}

export async function GET() {
  if (!URL_) {
    try {
      return await fromMempoolBackend();
    } catch (cause) {
      return Response.json({ source: "unavailable", reason: `no BITCOIN_RPC_URL; ${(cause as Error).message}` }, { headers: { "cache-control": "no-store" } });
    }
  }
  try {
    const [mempool, network, ...estimates] = await Promise.all([
      rpc<{ mempoolminfee: number; minrelaytxfee: number; incrementalrelayfee: number }>("getmempoolinfo"),
      rpc<{ version: number; relayfee: number }>("getnetworkinfo"),
      ...TARGETS.map((t) => rpc<{ feerate?: number; blocks?: number; errors?: string[] }>("estimatesmartfee", [t.target, "ECONOMICAL"])),
    ]);
    const presets: Record<string, { rate: number; blocks: number } | null> = {};
    TARGETS.forEach((t, i) => {
      const e = estimates[i];
      const rate = e?.feerate !== undefined ? btcPerKvbToRate(e.feerate) : null;
      presets[t.key] = rate !== null && rate > 0 ? { rate, blocks: e.blocks ?? t.target } : null;
    });
    return Response.json(
      {
        source: "node",
        version: network.version,
        floor: {
          minRelay: btcPerKvbToRate(mempool.minrelaytxfee) ?? 0,
          mempoolMin: btcPerKvbToRate(mempool.mempoolminfee) ?? 0,
        },
        incremental: btcPerKvbToRate(mempool.incrementalrelayfee) ?? 1,
        presets,
      },
      { headers: { "cache-control": "public, max-age=15" } },
    );
  } catch (cause) {
    try {
      return await fromMempoolBackend();
    } catch (fallback) {
      return Response.json(
        { source: "unavailable", reason: `${(cause as Error).message}; ${(fallback as Error).message}` },
        { headers: { "cache-control": "no-store" } },
      );
    }
  }
}
