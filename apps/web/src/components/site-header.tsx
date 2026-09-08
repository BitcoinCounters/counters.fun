"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { WalletButton } from "@/components/wallet-button";
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
          <Mark />
          <span className="font-mono text-[15px] font-semibold tracking-[0.02em]">counters</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">fun</span>
        </Link>

        <nav className="ml-1.5 hidden gap-1 nav:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 font-mono text-[12.5px] uppercase tracking-[0.06em] transition-colors hover:bg-card hover:text-ink ${
                pathname === item.href ? "text-copper" : "text-dim"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
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

      {open && (
        <nav className="border-t border-line bg-bg px-5 py-2 nav:hidden">
          {NAV.map((item) => (
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
          ))}
        </nav>
      )}
    </header>
  );
}

/** A counter's housing, empty — the odometer digit with nothing in it yet. */
function Mark() {
  return (
    <svg width="18" height="20" viewBox="0 0 18 20" fill="none" aria-hidden>
      <rect
        x="0.5"
        y="0.5"
        width="17"
        height="19"
        rx="4"
        fill="#211c15"
        stroke="var(--color-line)"
      />
      <path d="M5 13.5 L9 5.5 L13 13.5" stroke="var(--color-copper)" strokeWidth="1.6" fill="none" />
    </svg>
  );
}
