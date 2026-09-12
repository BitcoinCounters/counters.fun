"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { WalletButton } from "@/components/wallet-button";
import { AboutPanel } from "@/components/about-panel";
import { SearchBox } from "@/components/search-box";
import { PriceTicker } from "@/components/price-ticker";
import { copy } from "@content/copy";

const NAV = copy.nav;

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Navigating closes the menu; without this a tap opens the page behind a
  // panel that is still covering it.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-[10px]">
      <div className="mx-auto flex h-[62px] w-full max-w-[1120px] items-center gap-4 px-5">
        <Link href="/" className="flex flex-shrink-0 items-center gap-2.5">
          <span className="font-mono text-[15px] font-semibold tracking-[0.02em]">
            counters<span className="text-faint">.</span>
            {/* Animated rainbow through the logo's disc colours; see .rainbow-text in globals.css. */}
            <span className="rainbow-text">FUN</span>
          </span>
        </Link>

        <nav className="ml-1.5 hidden gap-1 nav:flex">
          {NAV.map((item) =>
            item.href.startsWith("http") ? (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="whitespace-nowrap rounded-md px-3 py-1.5 font-mono text-[12.5px] uppercase tracking-[0.06em] text-dim transition-colors hover:bg-card hover:text-ink"
              >
                {item.label}
              </a>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname === item.href ? "page" : undefined}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 font-mono text-[12.5px] uppercase tracking-[0.06em] transition-colors hover:bg-card hover:text-ink ${
                  pathname === item.href ? "text-copper" : "text-dim"
                }`}
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <AboutPanel />
          <WalletButton />
          {/* Below the nav breakpoint the links are hidden, and without this
              there is no navigation on a phone at all beyond the logo. */}
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="rounded-lg border border-line p-1.5 text-dim transition-colors hover:border-copper hover:text-ink nav:hidden"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path
                d={open ? "M3 3l10 10M13 3L3 13" : "M2 4h12M2 8h12M2 12h12"}
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Search gets its own row: a wide field reads as a search, not a
          filter. The prices ride along at its right rather than in the row
          above — the nav and both pills do not fit across 1120px together,
          and the nav wrapping mid-item is what made the header look like a
          different header on every page. Identical on every page, home
          included, so nothing here depends on the route. */}
      <div className="border-t border-line/60">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2">
          <div className="min-w-[220px] flex-1">
            <SearchBox wide />
          </div>
          <PriceTicker placement="row" />
        </div>
      </div>

      {open && (
        <nav className="border-t border-line bg-bg px-5 py-2 nav:hidden">
          {NAV.map((item) =>
            item.href.startsWith("http") ? (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-md px-2 py-2.5 font-mono text-sm uppercase tracking-[0.06em] text-dim"
              >
                {item.label}
              </a>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname === item.href ? "page" : undefined}
                className={`block rounded-md px-2 py-2.5 font-mono text-sm uppercase tracking-[0.06em] ${
                  pathname === item.href ? "text-copper" : "text-dim"
                }`}
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>
      )}
    </header>
  );
}

/** A counter's housing, empty — the odometer digit with nothing in it yet. */
