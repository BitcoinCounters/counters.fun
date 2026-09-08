/**
 * BTC and XCP prices for the header.
 *
 * Prices are the one thing this site reads from outside the box: an
 * on-chain XCP "price" from dispensers or the DEX is an ask somebody set,
 * not a market, and it produced a $0.69 XCP from a stale dispenser. So the
 * quote comes from CoinGecko, server-side and cached a minute; the local
 * mempool backend covers BTC if that fails. Nothing here touches a wallet
 * or a transaction, which is why it is allowed to leave the machine.
 */

export const dynamic = "force-dynamic";

const MEMPOOL = (process.env.MEMPOOL_API_BASE ?? "http://127.0.0.1:8999/api").replace(/\/+$/, "");
const GECKO = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,counterparty&vs_currencies=usd,btc&include_24hr_change=true";

interface Quote {
  usd: number;
  change24h: number | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" }, next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function fromCoinGecko(): Promise<{ btc: Quote; xcp: (Quote & { btc: number; sats: number }) | null }> {
  const g = await getJson<Record<string, { usd?: number; btc?: number; usd_24h_change?: number }>>(GECKO);
  const b = g.bitcoin;
  const x = g.counterparty;
  if (!b?.usd) throw new Error("no bitcoin quote");
  return {
    btc: { usd: b.usd, change24h: b.usd_24h_change ?? null },
    xcp: x?.usd ? { usd: x.usd, change24h: x.usd_24h_change ?? null, btc: x.btc ?? x.usd / b.usd, sats: Math.round((x.btc ?? x.usd / b.usd) * 1e8) } : null,
  };
}

async function btcFromMempool(): Promise<Quote> {
  const now = await getJson<{ USD: number }>(`${MEMPOOL}/v1/prices`);
  let change24h: number | null = null;
  try {
    const ts = Math.floor(Date.now() / 1000) - 86_400;
    const hist = await getJson<{ prices?: { USD?: number }[] }>(`${MEMPOOL}/v1/historical-price?currency=USD&timestamp=${ts}`);
    const dayAgo = hist.prices?.[0]?.USD;
    if (dayAgo) change24h = ((now.USD - dayAgo) / dayAgo) * 100;
  } catch {
    // No history, no badge.
  }
  return { usd: now.USD, change24h };
}

export async function GET() {
  try {
    const q = await fromCoinGecko();
    return Response.json({ ...q, source: "coingecko", at: Math.floor(Date.now() / 1000) }, { headers: { "cache-control": "public, max-age=60" } });
  } catch {
    try {
      const btc = await btcFromMempool();
      return Response.json({ btc, xcp: null, source: "mempool", at: Math.floor(Date.now() / 1000) }, { headers: { "cache-control": "public, max-age=60" } });
    } catch (cause) {
      return Response.json({ error: (cause as Error).message }, { status: 502, headers: { "cache-control": "no-store" } });
    }
  }
}
