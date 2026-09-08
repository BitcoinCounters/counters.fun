"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchFeeContext, type FeeContext } from "@/lib/esplora";
import { formatFeeRate, judgeRate, parseFeeRate, type ParsedRate, type RateVerdict } from "@counters/core/fees";
import { copy } from "@content/copy";

/**
 * A sat/vB rate, chosen by preset or typed, with the node's floors applied.
 *
 * Presets come from the site's own bitcoind (fast / normal / economy at 1, 3
 * and 144 blocks); the economy one is routinely under 1 sat/vB. Anything
 * positive can be typed. What the control refuses is a rate the relaying
 * node would refuse: below its `minrelaytxfee`, or below the current
 * `mempoolminfee` when the mempool is full. A sub-1 rate that passes still
 * gets a note, because the wider network is only partly there yet.
 */
export interface FeeRateState {
  text: string;
  setText: (next: string) => void;
  parsed: ParsedRate;
  /** The usable rate, or null while the text is not a valid one. */
  rate: number | null;
  verdict: RateVerdict | null;
  context: FeeContext | null;
  /** True when the rate can be used: valid and not below a floor. */
  ok: boolean;
}

export function useFeeRate(initial = ""): FeeRateState {
  const [text, setText] = useState(initial);
  const [context, setContext] = useState<FeeContext | null>(null);
  const [touched, setTouched] = useState(initial !== "");

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchFeeContext().then((ctx) => {
        if (!cancelled) setContext(ctx);
      });
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Default to the normal preset once it is known, unless the person typed.
  useEffect(() => {
    if (touched || !context) return;
    const rate = context.presets.normal?.rate ?? context.presets.fast?.rate ?? context.presets.economy?.rate;
    if (rate !== undefined) setText(formatFeeRate(rate));
  }, [context, touched]);

  const parsed = useMemo(() => parseFeeRate(text), [text]);
  const rate = parsed.ok ? parsed.rate : null;
  const verdict = rate !== null && context ? judgeRate(rate, context.floor) : rate !== null ? "ok" : null;

  return {
    text,
    setText: (next) => {
      setTouched(true);
      setText(next.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1"));
    },
    parsed,
    rate,
    verdict,
    context,
    ok: rate !== null && verdict === "ok",
  };
}

export function FeeRateField({ fee, disabled = false, xcpWallet = false }: { fee: FeeRateState; disabled?: boolean; xcpWallet?: boolean }) {
  const { text, setText, parsed, rate, verdict, context } = fee;
  const presets = context
    ? (["fast", "normal", "economy"] as const)
        .map((key) => ({ key, preset: context.presets[key] }))
        .filter((p): p is { key: "fast" | "normal" | "economy"; preset: { rate: number; blocks: number } } => p.preset !== null)
    : [];
  // Fast and normal often coincide; show one button with both labels.
  const shown: { label: string; rate: number }[] = [];
  for (const p of presets) {
    const existing = shown.find((s) => s.rate === p.preset.rate);
    if (existing) existing.label += `/${copy.fee.presets[p.key]}`;
    else shown.push({ label: copy.fee.presets[p.key], rate: p.preset.rate });
  }

  let note: { tone: "bad" | "gold" | "faint"; text: string } | null = null;
  if (!parsed.ok) {
    note = parsed.reason === "empty" ? null : { tone: "bad", text: copy.fee.invalid[parsed.reason] };
  } else if (verdict === "below-mempool-min" && context) {
    note = { tone: "bad", text: copy.fee.belowMempoolMin(formatFeeRate(context.floor.mempoolMin)) };
  } else if (verdict === "below-relay-min" && context) {
    note = { tone: "bad", text: copy.fee.belowRelayMin(formatFeeRate(context.floor.minRelay)) };
  } else if (rate !== null && rate < 1) {
    note = { tone: "gold", text: copy.fee.subOne + (xcpWallet ? ` ${copy.fee.subOneXcpWallet}` : "") };
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4 py-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{copy.fee.label}</span>
        <span className="flex items-center gap-1.5">
          <input
            value={text}
            disabled={disabled}
            inputMode="decimal"
            onChange={(e) => setText(e.target.value)}
            className={`w-20 rounded-lg border bg-bg2 px-2 py-1 text-right font-mono text-xs text-ink outline-none focus:border-copper disabled:opacity-60 ${note?.tone === "bad" ? "border-bad" : "border-line"}`}
          />
          <span className="font-mono text-[11px] text-faint">sat/vB</span>
        </span>
      </div>
      {shown.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center justify-end gap-1">
          {shown.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              onClick={() => setText(formatFeeRate(p.rate))}
              className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${rate === p.rate ? "border-copper text-copper2" : "border-line text-faint hover:text-copper2"}`}
            >
              {p.label} {formatFeeRate(p.rate)}
            </button>
          ))}
          <span className="ml-1 font-mono text-[10px] text-faint">{copy.fee.source(context?.source ?? "none")}</span>
        </div>
      )}
      {note && <p className={`mt-1.5 text-right text-[11px] leading-relaxed ${note.tone === "bad" ? "text-bad" : note.tone === "gold" ? "text-gold" : "text-faint"}`}>{note.text}</p>}
    </div>
  );
}
