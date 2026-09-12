"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

interface Option {
  readonly value: string;
  readonly label: string;
}

/**
 * The sort control for a listing.
 *
 * A native `<select>` rather than a custom menu: it is one element, it is
 * keyboard- and screen-reader-correct without any of that being reimplemented
 * here, and on a phone it opens the platform's own picker instead of a list
 * that has to be scrolled inside a page that also scrolls.
 *
 * The order lives in the URL, not in component state. That keeps the page a
 * server component — the rows are sorted by SQLite, which is where the
 * reserves already are, rather than fetched once and re-sorted in the browser
 * — and it makes a sorted listing a link somebody can send.
 *
 * `scroll: false` because the control sits below the fold on a phone; letting
 * the router jump to the top would move the thing that was just clicked out
 * from under the reader.
 */
export function SortSelect({
  options,
  value,
  label,
  param = "sort",
}: {
  options: readonly Option[];
  value: string;
  label: string;
  param?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function choose(next: string) {
    const query = new URLSearchParams(params);
    query.set(param, next);
    startTransition(() => router.push(`/?${query}`, { scroll: false }));
  }

  return (
    <label
      className="group relative inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-bg2 py-1 pl-2.5 pr-7 font-mono text-[11px] uppercase tracking-[0.08em] text-dim transition-colors hover:border-line2 hover:text-ink focus-within:border-copper"
      data-pending={pending ? "" : undefined}
    >
      <span className="text-faint">{label}</span>
      <select
        value={value}
        onChange={(e) => choose(e.target.value)}
        // The select carries the styling of the label around it, so it is
        // transparent and unpadded rather than invisible: a hidden control
        // cannot be focused, and this one has to be.
        className="cursor-pointer appearance-none bg-transparent pr-0 font-mono text-[11px] uppercase tracking-[0.08em] text-inherit outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-card text-ink">
            {o.label}
          </option>
        ))}
      </select>
      {/* Drawn rather than left to the platform: an appearance-none select has
          no arrow of its own, and the native one cannot be recoloured. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 10 6"
        className="pointer-events-none absolute right-2.5 h-[5px] w-[9px] fill-none stroke-current opacity-60 transition-opacity group-hover:opacity-100"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1 1l4 4 4-4" />
      </svg>
    </label>
  );
}
