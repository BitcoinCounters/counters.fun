"use client";

import { useEffect, useRef, useState } from "react";
import { HomeLede } from "@/components/home-lede";
import { copy } from "@content/copy";

/**
 * The site's introduction, behind an "about" button at the top right.
 *
 * It used to be the home page's hero. Moving it here keeps the pools above
 * the fold and keeps the text one click away on every page, not just the
 * first. Closes on an outside click or Escape.
 */
export function AboutPanel() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`rounded-md px-3 py-1.5 font-mono text-[12.5px] uppercase tracking-[0.06em] transition-colors hover:bg-card hover:text-ink ${open ? "text-copper" : "text-dim"}`}
      >
        {copy.about.label}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(92vw,560px)] rounded-2xl border border-line bg-card p-6 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.22em] text-copper">{copy.home.eyebrow}</p>
          <h2 className="mb-3 font-mono text-[clamp(22px,3vw,30px)] font-semibold leading-[1.12] tracking-[-0.01em] text-ink">
            {copy.home.headline} <span className="text-dim">{copy.home.headlineDim}</span>
          </h2>
          <HomeLede />
        </div>
      )}
    </div>
  );
}
