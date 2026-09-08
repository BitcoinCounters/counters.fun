"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet/wallet-context";
import { big, parseUnitsToRaw } from "@counters/core/numeric";
import { inputForOutput, orientPool, type Pool } from "@counters/core/pool";
import { cpCompose, cpGet, fetchBalance } from "@/lib/cp";
import { describeError, isCancellation } from "@/lib/errors";
import { withSlippage, rawToUnits } from "@/lib/pool-compose";
import { buildPlainPsbt, finalize } from "@/lib/inscribe/psbt";
import { FeeRateField, useFeeRate } from "@/components/fee-rate";
import { ConnectInline } from "@/components/connect-inline";
import { fmtPrice, fmtQty } from "@/lib/format";
import { mempoolTxUrl } from "@/lib/constants";
import { copy } from "@content/copy";

/**
 * Swap against a counter's XCP pool.
 *
 * There is no "swap" message in Counterparty. A swap is an ORDER on the
 * distributed exchange — give this, get at least that, valid for N blocks —
 * and consensus routes it: the AMM pool fills it at once while the pool's
 * marginal price is better than the order's limit, resting book orders take
 * what is better still, and whatever is left waits on the book until the
 * order expires and is returned. That is how every swap on xcp.fun lands
 * on chain, most with a one-block expiry.
 *
 * So the two numbers that matter are the quote (`/pools/GIVE/GET/quote`,
 * which already accounts for pool and book) and the limit, which is the
 * quote less the slippage the person accepts. The limit is not a floor on
 * what they get; it is the price past which the pool stops filling.
 *
 * Either side can lead. The node only quotes from the amount SOLD, so a
 * typed receive amount is inverted locally through the pool's constant
 * product (fee on the input, as consensus applies it), then confirmed with
 * a real quote and nudged up if the book or rounding left it short.
 */

interface SwapQuote {
  estimated_output: string | number;
  pool_output: string | number;
  book_output: string | number;
  give_remaining: string | number;
  effective_price: number;
  price_impact: number;
  pool_exists: boolean;
  fee_bps: number;
  fee_amount: string | number;
}

const SLIPPAGE_PRESETS = [0.5, 1, 3];
const EXPIRY_PRESETS = [1, 3, 10];

export function SwapPanel({ asset, divisible }: { asset: string; divisible: boolean }) {
  const wallet = useWallet();
  const fee = useFeeRate();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [receive, setReceive] = useState("");
  const [lead, setLead] = useState<"pay" | "receive">("pay");
  const [pool, setPool] = useState<Pool | null>(null);
  const [slippage, setSlippage] = useState(1);
  const [customSlippage, setCustomSlippage] = useState("");
  const [expiry, setExpiry] = useState(1);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [txid, setTxid] = useState<string | null>(null);

  const giveAsset = side === "buy" ? "XCP" : asset;
  const getAsset = side === "buy" ? asset : "XCP";
  const giveDecimals = giveAsset === "XCP" || divisible ? 8 : 0;
  const getDecimals = getAsset === "XCP" || divisible ? 8 : 0;
  const rawGive = useMemo(() => parseUnitsToRaw(amount, giveDecimals) ?? 0n, [amount, giveDecimals]);
  const rawReceive = useMemo(() => parseUnitsToRaw(receive, getDecimals) ?? 0n, [receive, getDecimals]);

  useEffect(() => {
    let cancelled = false;
    cpGet<Pool>(`pools/${encodeURIComponent(asset)}/XCP?verbose=true`)
      .then((p) => !cancelled && setPool(p))
      .catch(() => !cancelled && setPool(null));
    return () => {
      cancelled = true;
    };
  }, [asset, txid]);

  // A typed receive amount: invert through the reserves, then let the node
  // confirm. If its quote lands short (book orders, integer rounding), scale
  // the input up by the shortfall and ask once more.
  useEffect(() => {
    if (lead !== "receive") return;
    if (rawReceive <= 0n || !pool) {
      if (rawReceive <= 0n) setAmount("");
      return;
    }
    const oriented = orientPool(pool, asset);
    if (!oriented) return;
    const [reserveIn, reserveOut] = side === "buy" ? [oriented.xcpReserve, oriented.tokenReserve] : [oriented.tokenReserve, oriented.xcpReserve];
    let cancelled = false;
    const timer = setTimeout(async () => {
      let input = inputForOutput(rawReceive, reserveIn, reserveOut, 50);
      if (input === null) {
        if (!cancelled) setAmount("");
        return;
      }
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const q = await cpGet<SwapQuote>(`pools/${encodeURIComponent(giveAsset)}/${encodeURIComponent(getAsset)}/quote?quantity=${input}`);
          if (cancelled) return;
          const got = big(q.estimated_output);
          if (got >= rawReceive || got <= 0n) break;
          input = (input * rawReceive + got - 1n) / got;
        }
      } catch {
        // The forward quote below will report the failure.
      }
      if (!cancelled) setAmount(rawToUnits(input, giveDecimals));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lead, rawReceive, pool, asset, side, giveAsset, getAsset, giveDecimals]);
  const effectiveSlippage = customSlippage ? Math.min(50, Math.max(0, Number(customSlippage) || 0)) : slippage;

  useEffect(() => {
    if (!wallet.address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    fetchBalance(wallet.address, giveAsset)
      .then((b) => !cancelled && setBalance(b))
      .catch(() => !cancelled && setBalance(null));
    return () => {
      cancelled = true;
    };
  }, [wallet.address, giveAsset, txid]);

  useEffect(() => {
    if (rawGive <= 0n) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      cpGet<SwapQuote>(`pools/${encodeURIComponent(giveAsset)}/${encodeURIComponent(getAsset)}/quote?quantity=${rawGive}`)
        .then((q) => {
          if (cancelled) return;
          setQuote(q);
          if (lead === "pay") setReceive(rawToUnits(big(q.estimated_output), getDecimals));
        })
        .catch(() => !cancelled && setQuote(null))
        .finally(() => !cancelled && setQuoting(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [giveAsset, getAsset, rawGive, lead, getDecimals]);

  const estimated = quote ? big(quote.estimated_output) : 0n;
  const minimum = withSlippage(estimated, effectiveSlippage);
  const remainder = quote ? big(quote.give_remaining) : 0n;

  // Buying an indivisible token: the pool sells whole units only and takes
  // just the input those units cost; what is left of the order comes back at
  // expiry. Say what the whole units actually cost, and offer to pay exactly that.
  const exactInput = useMemo(() => {
    if (!quote || !pool || side !== "buy" || divisible || estimated <= 0n) return null;
    const oriented = orientPool(pool, asset);
    if (!oriented) return null;
    const exact = inputForOutput(estimated, oriented.xcpReserve, oriented.tokenReserve, quote.fee_bps || 50);
    return exact !== null && exact < rawGive ? exact : null;
  }, [quote, pool, side, divisible, estimated, asset, rawGive]);
  const short = balance !== null && rawGive > balance;
  const ready = wallet.address !== null && rawGive > 0n && quote !== null && estimated > 0n && !short && fee.ok && !busy && !quoting;

  const swap = useCallback(async () => {
    if (!wallet.address || !wallet.adapter || !quote) return;
    setBusy(true);
    setError(null);
    try {
      const composed = await cpCompose(wallet.address, "order", {
        give_asset: giveAsset,
        give_quantity: rawGive.toString(),
        get_asset: getAsset,
        // The limit: the quote less the accepted slippage. The pool fills at
        // its own (better) price up to here; past it, the rest waits.
        get_quantity: minimum.toString(),
        expiration: String(expiry),
        fee_required: "0",
        sat_per_vbyte: String(fee.rate ?? 0),
        exclude_utxos_with_balances: "true",
        verbose: "true",
      });
      const psbt = buildPlainPsbt(composed);
      const signed = await wallet.adapter.signPsbt(psbt, { [wallet.address]: composed.inputs_values.map((_, i) => i) });
      const final = finalize(signed);
      const sent = await wallet.adapter.broadcast(final.hex);
      setTxid(sent || final.txid);
      setConfirming(false);
    } catch (err) {
      setError(isCancellation(err) ? { message: copy.errors.cancelled(), detail: null } : describeError(err));
    } finally {
      setBusy(false);
    }
  }, [expiry, fee.rate, getAsset, giveAsset, minimum, quote, rawGive, wallet.adapter, wallet.address]);

  if (txid) {
    return (
      <div className="mt-5 rounded-xl border border-patina/40 bg-patina/5 p-4">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-patina">{copy.swap.receipt}</p>
        <p className="mb-2 text-[12px] text-dim">{copy.swap.receiptBody}</p>
        <a href={mempoolTxUrl(txid)} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-copper2 underline-offset-2 hover:underline">
          {txid.slice(0, 20)}…
        </a>
        <button onClick={() => { setTxid(null); setAmount(""); }} className="ml-3 font-mono text-[11px] text-faint hover:text-copper2">
          again
        </button>
      </div>
    );
  }

  return (
    <div className="mt-5 border-t border-line2 pt-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{copy.swap.label}</span>
        <div className="flex gap-1 rounded-lg border border-line p-0.5">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setSide(s); setAmount(""); setReceive(""); setLead("pay"); setConfirming(false); setError(null); }}
              className={`rounded-md px-3 py-1 font-mono text-[11px] uppercase tracking-[0.1em] ${side === s ? "bg-copper-ghost text-copper2" : "text-faint"}`}
            >
              {copy.swap[s]} {asset}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-line bg-bg2 p-3">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{copy.swap.youPay}</div>
        <div className="flex items-baseline justify-between gap-3">
          <input
            value={amount}
            inputMode="decimal"
            onChange={(e) => { setLead("pay"); setAmount(e.target.value.replace(/[^\d.]/g, "")); setConfirming(false); }}
            placeholder="0"
            className={`min-w-0 flex-1 bg-transparent font-mono text-xl outline-none placeholder:text-faint ${short ? "text-bad" : "text-ink"}`}
          />
          <span className="font-mono text-sm text-copper2">{giveAsset}</span>
        </div>
        <div className="mt-1 font-mono text-[10px] text-faint">
          balance {balance === null ? "—" : fmtQty(balance, giveDecimals === 8)}
          {short && <span className="ml-2 text-bad">not enough</span>}
          {balance !== null && balance > 0n && (
            <button onClick={() => { setLead("pay"); setAmount(rawToUnits(balance, giveDecimals)); }} className="ml-2 text-faint hover:text-copper2">
              max
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 rounded-xl border border-line bg-bg2 p-3">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{lead === "receive" ? copy.swap.youReceiveExact : copy.swap.youReceive}</div>
        <div className="flex items-baseline justify-between gap-3">
          <input
            value={receive}
            inputMode="decimal"
            onChange={(e) => { setLead("receive"); setReceive(e.target.value.replace(/[^\d.]/g, "")); setConfirming(false); }}
            placeholder="0"
            className={`min-w-0 flex-1 bg-transparent font-mono text-xl outline-none placeholder:text-faint ${quoting && lead === "pay" ? "text-faint" : "text-ink"}`}
          />
          <span className="font-mono text-sm text-copper2">{getAsset}</span>
        </div>
        {quote && estimated > 0n && (
          <div className="mt-1 font-mono text-[10px] text-faint">{copy.swap.minimum(fmtQty(minimum, getDecimals === 8), getAsset)}</div>
        )}
      </div>

      {quote && estimated > 0n && (
        <div className="mt-3 flex flex-col gap-1.5 text-[11px]">
          <Row label={copy.swap.price}>
            <span className="font-mono text-ink">
              {/* effective_price is raw-out per raw-in. XCP is 1e8 raw per unit; an
                  indivisible token is 1 raw per unit, so it needs the 1e8 correction. */}
              {fmtPrice(side === "buy" ? 1 / (quote.effective_price * (divisible ? 1 : 1e8)) : quote.effective_price * (divisible ? 1 : 1e-8))} XCP / {asset}
            </span>
          </Row>
          <Row label={copy.swap.impact}>
            <span className={`font-mono ${quote.price_impact >= 5 ? "text-bad" : quote.price_impact >= 1 ? "text-gold" : "text-dim"}`}>{quote.price_impact.toFixed(2)}%</span>
          </Row>
          <Row label={copy.swap.poolFee}>
            <span className="font-mono text-dim">{quote.fee_bps} bps · {fmtQty(big(quote.fee_amount), giveDecimals === 8)} {giveAsset}</span>
          </Row>
          <Row label={copy.swap.slippage}>
            <span className="flex items-center gap-1">
              {SLIPPAGE_PRESETS.map((s) => (
                <button key={s} onClick={() => { setSlippage(s); setCustomSlippage(""); }} className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${!customSlippage && slippage === s ? "border-copper text-copper2" : "border-line text-faint"}`}>
                  {s}%
                </button>
              ))}
              <input value={customSlippage} inputMode="decimal" placeholder="custom" onChange={(e) => setCustomSlippage(e.target.value.replace(/[^\d.]/g, ""))} className={`w-16 rounded-md border bg-bg2 px-2 py-0.5 text-right font-mono text-[11px] text-ink outline-none placeholder:text-faint ${customSlippage ? "border-copper" : "border-line"}`} />
            </span>
          </Row>
          <Row label={copy.swap.expiry}>
            <span className="flex items-center gap-1">
              {EXPIRY_PRESETS.map((b) => (
                <button key={b} onClick={() => setExpiry(b)} className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${expiry === b ? "border-copper text-copper2" : "border-line text-faint"}`}>
                  {b} {b === 1 ? "block" : copy.swap.blocks}
                </button>
              ))}
            </span>
          </Row>
          <p className="text-[11px] leading-relaxed text-faint">{copy.swap.expiryHint}</p>
          {remainder > 0n && <p className="text-[11px] leading-relaxed text-gold">{copy.swap.remainder(fmtQty(remainder, giveDecimals === 8), giveAsset)}</p>}
          {exactInput !== null && (
            <p className="text-[11px] leading-relaxed text-gold">
              {copy.swap.wholeUnits(fmtQty(estimated, false), asset, fmtQty(exactInput, true))}{" "}
              <button onClick={() => { setLead("pay"); setAmount(rawToUnits(exactInput, 8)); }} className="font-mono text-copper2 underline-offset-2 hover:underline">
                {copy.swap.useExact}
              </button>
            </p>
          )}
          {quote.price_impact >= 5 && <p className="text-[11px] leading-relaxed text-bad">{copy.swap.highImpact(quote.price_impact.toFixed(1))}</p>}
          <FeeRateField fee={fee} xcpWallet={wallet.adapter?.id === "xcp"} />
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-xl border border-bad/40 bg-bad/5 p-3 text-[12px] text-bad">
          {error.message}
          {error.detail && error.detail !== error.message && <p className="mt-1 break-words font-mono text-[10px] text-bad/70">{error.detail}</p>}
        </div>
      )}

      <div className="mt-3">
        {!wallet.address ? (
          <ConnectInline />
        ) : confirming ? (
          <div className="rounded-xl border border-copper/40 bg-copper-ghost p-4">
            <p className="mb-3 text-sm text-ink">{copy.swap.confirm(fmtQty(rawGive, giveDecimals === 8), giveAsset, fmtQty(minimum, getDecimals === 8), getAsset)}</p>
            <div className="flex gap-2">
              <button onClick={swap} disabled={busy} className="flex-1 rounded-xl border border-copper bg-copper-ghost px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-copper2">
                {busy ? "composing…" : copy.swap.cta}
              </button>
              <button onClick={() => setConfirming(false)} className="rounded-xl border border-line px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-faint">
                back
              </button>
            </div>
          </div>
        ) : (
          <button
            disabled={!ready}
            onClick={() => setConfirming(true)}
            className="w-full rounded-xl border border-copper bg-copper-ghost px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-copper2 transition-colors enabled:hover:bg-copper enabled:hover:text-bg disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
          >
            {quoting ? copy.swap.quoting : `${copy.swap[side]} ${asset}`}
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</span>
      {children}
    </div>
  );
}
