/**
 * BTC and XCP prices for the header, the way xcp.fun prices them.
 *
 * BTC/USD is an exchange quote (CoinGecko, server-side, cached a minute;
 * the local mempool backend if that fails). XCP is NOT an exchange print:
 * it is what people actually pay for XCP on-chain — the volume-weighted
 * price of the last day's dispenses, which the node records as completed
 * BTC-for-XCP trades. Exchanges quote XCP a good deal lower than it costs
 * to obtain on Bitcoin, and for someone minting or swapping here the
 * on-chain price is the one that matters. The change badges are 30-day,
 * as on xcp.fun; 24-hour figures ride along for the tooltip.
 */

import { COUNTERPARTY_API_BASE } from "@/lib/constants";

export const dynamic = "force-dynamic";

const MEMPOOL = (process.env.MEMPOOL_API_BASE ?? "http://127.0.0.1:8999/api").replace(/\/+$/, "");
const GECKO = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h,30d";
const BLOCKS_PER_DAY = 144;

interface Dispense {
  block_index: number;
  dispense_quantity: number;
  btc_amount: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" }, next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function btcUsd(): Promise<{ usd: number; change24h: number | null; change30d: number | null; source: string }> {
  try {
    const [b] = await getJson<{ current_price: number; price_change_percentage_24h_in_currency?: number; price_change_percentage_30d_in_currency?: number }[]>(GECKO);
    if (b?.current_price) {
      return { usd: b.current_price, change24h: b.price_change_percentage_24h_in_currency ?? null, change30d: b.price_change_percentage_30d_in_currency ?? null, source: "coingecko" };
    }
  } catch {
    // Local fallback below.
  }
  const now = await getJson<{ USD: number }>(`${MEMPOOL}/v1/prices`);
  return { usd: now.USD, change24h: null, change30d: null, source: "mempool" };
}

/** Volume-weighted BTC per XCP over a block window, or null when too thin. */
function vwap(rows: Dispense[], from: number, to: number, minTrades = 5): number | null {
  const inWindow = rows.filter((d) => d.block_index >= from && d.block_index < to);
  if (inWindow.length < minTrades) return null;
  const xcp = inWindow.reduce((s, d) => s + d.dispense_quantity, 0);
  const btc = inWindow.reduce((s, d) => s + d.btc_amount, 0);
  return xcp > 0 ? btc / xcp : null;
}

async function xcpBtc(): Promise<{ btc: number; change24h: number | null; change30d: number | null; trades24h: number } | null> {
  const [tipBody, body] = await Promise.all([
    getJson<{ result: { counterparty_height: number } }>(`${COUNTERPARTY_API_BASE}/`),
    getJson<{ result: Dispense[] }>(`${COUNTERPARTY_API_BASE}/assets/XCP/dispenses?limit=1000`),
  ]);
  const tip = tipBody.result.counterparty_height;
  const rows = body.result;

  // Today: the last day of trades, widening to a week when a day is thin.
  const day = vwap(rows, tip - BLOCKS_PER_DAY, tip + 1);
  const now = day ?? vwap(rows, tip - 7 * BLOCKS_PER_DAY, tip + 1);
  if (now === null) return null;

  const dayAgo = vwap(rows, tip - 2 * BLOCKS_PER_DAY, tip - BLOCKS_PER_DAY) ?? vwap(rows, tip - 8 * BLOCKS_PER_DAY, tip - BLOCKS_PER_DAY);
  const monthAgo = vwap(rows, tip - 37 * BLOCKS_PER_DAY, tip - 30 * BLOCKS_PER_DAY);
  const pct = (then: number | null) => (then && then > 0 ? ((now - then) / then) * 100 : null);
  return {
    btc: now,
    change24h: pct(dayAgo),
    change30d: pct(monthAgo),
    trades24h: rows.filter((d) => d.block_index >= tip - BLOCKS_PER_DAY).length,
  };
}

export async function GET() {
  try {
    const [btc, xcp] = await Promise.all([btcUsd(), xcpBtc().catch(() => null)]);
    return Response.json(
      {
        btc: { usd: btc.usd, change24h: btc.change24h, change30d: btc.change30d, source: btc.source },
        xcp: xcp
          ? { usd: xcp.btc * btc.usd, btc: xcp.btc, sats: Math.round(xcp.btc * 1e8), change24h: xcp.change24h, change30d: xcp.change30d, trades24h: xcp.trades24h, source: "dispenses" }
          : null,
        at: Math.floor(Date.now() / 1000),
      },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (cause) {
    return Response.json({ error: (cause as Error).message }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
