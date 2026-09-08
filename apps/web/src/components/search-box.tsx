"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { copy } from "@content/copy";
import { mimeTag } from "@/lib/format";

interface Hit {
  number: number;
  asset: string;
  asset_longname: string | null;
  content_type: string;
}

/**
 * Find a counter by name or number. ⌘K / Ctrl-K focuses it; Enter opens the
 * first hit; arrows move. Results come from the API worker's /search, which
 * applies the same on-chain rule as every listing.
 */
export function SearchBox({ wide = false }: { wide?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(term)}`)
        .then((r) => (r.ok ? r.json() : { result: [] }))
        .then((b) => {
          if (cancelled) return;
          setHits(b.result ?? []);
          setActive(0);
          setOpen(true);
        })
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const go = (hit: Hit) => {
    setOpen(false);
    setQ("");
    router.push(`/c/${hit.number}`);
  };

  return (
    <div ref={box} className={wide ? "relative block" : "relative hidden nav:block"}>
      <div className={`flex items-center gap-2 rounded-lg border border-line bg-card focus-within:border-copper ${wide ? "px-3 py-2" : "px-2.5 py-1.5"}`}>
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden className="text-faint">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => hits.length > 0 && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === "Enter" && hits[active]) go(hits[active]);
            if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
          }}
          placeholder={copy.search.placeholder}
          className={`${wide ? "flex-1 text-[13px]" : "w-44 text-[12px]"} bg-transparent font-mono text-ink outline-none placeholder:text-faint`}
        />
        <kbd className="rounded border border-line px-1 font-mono text-[9px] text-faint">⌘K</kbd>
      </div>
      {open && q.trim() && (
        <div className={`absolute left-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-line bg-card shadow-[0_20px_60px_rgba(0,0,0,0.5)] ${wide ? "w-full max-w-[560px]" : "w-[320px]"}`}>
          {hits.length === 0 ? (
            <p className="px-3 py-2.5 font-mono text-[11px] text-faint">{copy.search.none}</p>
          ) : (
            hits.map((h, i) => (
              <button
                key={h.number}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(h)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left ${i === active ? "bg-copper-ghost" : ""}`}
              >
                <span className="w-10 font-mono text-[11px] text-faint">#{h.number}</span>
                <span className="flex-1 truncate font-mono text-[12px] text-copper2">{h.asset_longname ?? h.asset}</span>
                <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-faint">{mimeTag(h.content_type)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
