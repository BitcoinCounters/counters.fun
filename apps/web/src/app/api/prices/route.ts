/**
 * BTC and XCP prices, from this machine only.
 *
 * BTC/USD comes from the local mempool backend, which keeps its own quote
 * and a day of history. XCP has no local fiat quote, but it trades for BTC
 * on Counterparty's own rails, and the node indexes them: the cheapest open
 * XCP dispenser that can still dispense is a live on-chain ask, and the
 * best open DEX sell order is the fallback. XCP/USD is the product. It is a
 * price someone would actually pay right now, not an exchange print.
 */

import { COUNTERPARTY_API_BASE } from "@/lib/constants";

export const dynamic = "force-dynamic";

const MEMPOOL = (process.env.MEMPOOL_API_BASE ?? "http://127.0.0.1:8999/api").replace(/\/+$/, "");
const SATS = 1e8;

interface Dispenser {
  satoshirate: number;
  give_quantity: number;
  give_remaining: number;
  status: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function btcUsd(): Promise<{ now: number; dayAgo: number | null }> {
  const now = await getJson<{ USD: number }>(`${MEMPOOL}/v1/prices`);
  let dayAgo: number | null = null;
  try {
    const ts = Math.floor(Date.now() / 1000) - 86_400;
    const hist = await getJson<{ prices?: { USD?: number }[] }>(`${MEMPOOL}/v1/historical-price?currency=USD&timestamp=${ts}`);
    dayAgo = hist.prices?.[0]?.USD ?? null;
  } catch {
    // No history is fine; the change badge is simply omitted.
  }
  return { now: now.USD, dayAgo };
}

/** BTC per XCP: the cheapest dispenser that can still hand out a full lot. */
async function xcpBtc(): Promise<{ price: number; source: "dispenser" | "dex" } | null> {
  try {
    const body = await getJson<{ result: Dispenser[] }>(`${COUNTERPARTY_API_BASE}/assets/XCP/dispensers?status=0&limit=200`);
    const asks = body.result
      .filter((d) => d.status === 0 && d.give_quantity > 0 && d.give_remaining >= d.give_quantity)
      // Ignore asks under a tenth of a cent's worth of sats per XCP: those are
      // test or broken dispensers, not a market.
      .map((d) => d.satoshirate / d.give_quantity)
      .filter((p) => p > 1e-6)
      .sort((a, b) => a - b);
    if (asks.length > 0) return { price: asks[0]!, source: "dispenser" };
  } catch {
    // Fall through to the DEX.
  }
  try {
    const body = await getJson<{ result: { give_asset: string; get_asset: string; give_quantity: number; get_quantity: number; give_remaining: number }[] }>(
      `${COUNTERPARTY_API_BASE}/orders?status=open&limit=500`,
    );
    const asks = body.result
      .filter((o) => o.give_asset === "XCP" && o.get_asset === "BTC" && o.give_remaining > 0)
      .map((o) => o.get_quantity / o.give_quantity)
      .sort((a, b) => a - b);
    if (asks.length > 0) return { price: asks[0]!, source: "dex" };
  } catch {
    // Nothing local can price it.
  }
  return null;
}

export async function GET() {
  try {
    const [btc, xcp] = await Promise.all([btcUsd(), xcpBtc()]);
    const btcChange = btc.dayAgo && btc.dayAgo > 0 ? ((btc.now - btc.dayAgo) / btc.dayAgo) * 100 : null;
    return Response.json(
      {
        btc: { usd: btc.now, change24h: btcChange },
        xcp: xcp ? { btc: xcp.price, usd: xcp.price * btc.now, sats: Math.round(xcp.price * SATS), source: xcp.source } : null,
        at: Math.floor(Date.now() / 1000),
      },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (cause) {
    return Response.json({ error: (cause as Error).message }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
