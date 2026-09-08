"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { copy } from "@content/copy";

interface Prices {
  btc: { usd: number; change24h: number | null; change30d: number | null; source: string };
  xcp: { usd: number; btc: number; sats: number; change24h: number | null; change30d: number | null; trades24h: number } | null;
}

/**
 * BTC and XCP in the header, as xcp.fun shows them: an exchange quote for
 * BTC, the on-chain dispense price for XCP, both with a 30-day change.
 * Refreshed every minute; absent, not fake, when nothing answers.
 */
export function PriceTicker({ placement = "header" }: { placement?: "header" | "row" }) {
  const [prices, setPrices] = useState<Prices | null>(null);
  const pathname = usePathname();

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

  // The home page carries the prices in its own stats row.
  if (!prices || (placement === "header" && pathname === "/")) return null;
  const usd = (v: number, digits: number) => v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
  return (
    <div className={placement === "header" ? "hidden items-center gap-2 nav:flex" : "flex items-center gap-2"}>
      <Pill icon="₿" tone="text-gold" value={`$${usd(prices.btc.usd, 0)}`} change={prices.btc.change30d} title={copy.prices.btc(pct(prices.btc.change24h), prices.btc.source)} />
      {prices.xcp && (
        <Pill
          icon="X"
          tone="text-copper"
          value={`$${usd(prices.xcp.usd, 2)}`}
          change={prices.xcp.change30d}
          sub={`${prices.xcp.sats.toLocaleString("en-US")} sat`}
          title={copy.prices.xcp(pct(prices.xcp.change24h), prices.xcp.trades24h)}
        />
      )}
    </div>
  );
}

function Pill({ icon, tone, value, change, sub, title }: { icon: string; tone: string; value: string; change: number | null; sub?: string; title: string }) {
  return (
    <span title={title} className="flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 font-mono text-[11px] text-ink">
      <span className={`font-semibold ${tone}`}>{icon}</span>
      <span>{value}</span>
      {change !== null && (
        <span className={change >= 0 ? "text-patina" : "text-bad"}>
          {change >= 0 ? "+" : ""}
          {change.toFixed(1)}%
        </span>
      )}
      {sub && <span className="text-faint">{sub}</span>}
    </span>
  );
}
