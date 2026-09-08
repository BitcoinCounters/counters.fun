"use client";

import { useEffect, useState } from "react";
import { copy } from "@content/copy";

interface Prices {
  btc: { usd: number; change24h: number | null };
  xcp: { btc: number; usd: number; sats: number; source: "dispenser" | "dex" } | null;
}

/**
 * BTC and XCP in the header, from /api/prices — the local mempool backend
 * and the node's own dispensers. Refreshed every minute; absent, not fake,
 * when nothing local can answer.
 */
export function PriceTicker() {
  const [prices, setPrices] = useState<Prices | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/prices", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => !cancelled && p && !p.error && setPrices(p))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!prices) return null;
  const usd = (v: number, digits: number) => v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (
    <div className="hidden items-center gap-2 nav:flex">
      <Pill icon="₿" tone="text-gold" label="BTC" value={`$${usd(prices.btc.usd, 0)}`} change={prices.btc.change24h} />
      {prices.xcp && (
        <Pill
          icon="X"
          tone="text-copper"
          label="XCP"
          value={`$${usd(prices.xcp.usd, 2)}`}
          sub={`${prices.xcp.sats.toLocaleString("en-US")} sat`}
          title={prices.xcp.source === "dispenser" ? copy.prices.xcpDispenser : copy.prices.xcpDex}
        />
      )}
    </div>
  );
}

function Pill({ icon, tone, label, value, change, sub, title }: { icon: string; tone: string; label: string; value: string; change?: number | null; sub?: string; title?: string }) {
  return (
    <span title={title ?? label} className="flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 font-mono text-[11px] text-ink">
      <span className={`font-semibold ${tone}`}>{icon}</span>
      <span>{value}</span>
      {typeof change === "number" && (
        <span className={change >= 0 ? "text-patina" : "text-bad"}>
          {change >= 0 ? "+" : ""}
          {change.toFixed(1)}%
        </span>
      )}
      {sub && <span className="text-faint">{sub}</span>}
    </span>
  );
}
