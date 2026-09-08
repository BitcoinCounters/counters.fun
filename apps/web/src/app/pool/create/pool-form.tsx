"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet/wallet-context";
import { randomLpAsset } from "@counters/core/fairminter";
import { big, parseUnitsToRaw } from "@counters/core/numeric";
import { isqrt } from "@counters/core/pool";
import type { Pool } from "@counters/core/pool";
import {
  composeDeposit,
  estimateDepositXcpFee,
  fetchBalance,
  fetchDepositQuote,
  fetchPool,
  withSlippage,
  type DepositQuote,
} from "@/lib/pool-compose";
import { ConnectInline } from "@/components/connect-inline";
import { copy } from "@content/copy";
import { buildPlainPsbt, finalize } from "@/lib/inscribe/psbt";
import { fmtCompact, fmtPrice, fmtQty } from "@/lib/format";
import { XCP_POOL_FEE_BPS, mempoolTxUrl } from "@/lib/constants";

/**
 * Create or add to a counter's XCP pool.
 *
 * The page turns on one distinction, and it is the thing most liquidity UIs
 * bury: whether a pool already exists.
 *
 * **First deposit.** There is no ratio to match, so the two amounts *are* the
 * price. Whatever is put in decides what the counter is worth to the next
 * buyer, and it cannot be undone by depositing differently afterwards — an
 * arbitrageur will simply take the difference. The implied price is therefore
 * the loudest thing on the page, and the confirm step restates it.
 *
 * **Later deposits.** The composed quantities are *maximums*. Consensus debits
 * only the proportional amounts, so putting in too much of one side does not
 * move the price; it just leaves the excess untouched.
 */

export function PoolForm({ initialAsset }: { initialAsset: string }) {
  const wallet = useWallet();

  const [asset, setAsset] = useState(initialAsset);

  /**
   * Three states, not two.
   *
   * "unknown" is load-bearing: with a plain `pool === null` the page asserts
   * "no pool exists — this deposit sets the price" from the very first render,
   * before the lookup has happened. That is a claim about someone's money made
   * ahead of the check, and it is wrong for every counter that does have a
   * pool. Nothing about the pool is stated until the answer is in.
   */
  const [pool, setPool] = useState<Pool | "unknown" | null>("unknown");

  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [slippage, setSlippage] = useState(1);
  const [satPerVbyte, setSatPerVbyte] = useState("2");

  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [balanceA, setBalanceA] = useState(0n);
  const [balanceXcp, setBalanceXcp] = useState(0n);
  const [xcpFee, setXcpFee] = useState<number | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);

  // Counters are usually divisible; XCP always is.
  const [divisible, setDivisible] = useState(true);

  useEffect(() => {
    if (!asset) {
      setPool("unknown");
      return;
    }
    let cancelled = false;
    // Re-checking: forget the previous answer rather than showing it for the
    // new asset.
    setPool("unknown");
    (async () => {
      const [found, meta] = await Promise.all([
        fetchPool(asset),
        fetch(`/api/cp/assets/${encodeURIComponent(asset)}`)
          .then((r) => r.json())
          .catch(() => null),
      ]);
      if (cancelled) return;
      setPool(found);
      if (meta?.result?.divisible !== undefined) setDivisible(Boolean(meta.result.divisible));
    })();
    return () => {
      cancelled = true;
    };
  }, [asset]);

  useEffect(() => {
    if (!wallet.address || !asset) return;
    let cancelled = false;
    (async () => {
      const [a, x, fee] = await Promise.all([
        fetchBalance(wallet.address!, asset),
        fetchBalance(wallet.address!, "XCP"),
        estimateDepositXcpFee(wallet.address!).catch(() => null),
      ]);
      if (cancelled) return;
      setBalanceA(a);
      setBalanceXcp(x);
      setXcpFee(fee);
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.address, asset]);

  const rawA = useMemo(
    () => parseUnitsToRaw(amountA, divisible ? 8 : 0) ?? 0n,
    [amountA, divisible],
  );
  const rawB = useMemo(() => parseUnitsToRaw(amountB, 8) ?? 0n, [amountB]);

  const checked = pool !== "unknown";
  const existing = checked ? (pool as Pool | null) : null;
  /** Only true once we have looked and found nothing. */
  const isFirst = checked && existing === null;

  /**
   * Ask the node what this deposit actually requires and mints.
   *
   * Not computed locally, and the reason is specific: the obvious local
   * formula needs the pool's LP supply, which is not on the pool record, and
   * the tempting stand-in — `sqrt(reserve_a * reserve_b)` — is only correct in
   * the instant after a first deposit. Swaps grow the reserves while the
   * supply stays fixed, so it drifts; on the live MEMENOME pool it is already
   * 16 bps out. That number sets the slippage floor, so drifting past the
   * tolerance reverts a transaction the user has paid a miner fee for.
   *
   * Deliberately not run for a first deposit: there is nothing to match, and
   * pre-filling would disguise the fact that the person is choosing a price.
   */
  useEffect(() => {
    if (!existing || rawA <= 0n) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchDepositQuote(asset, rawA)
        .then((q) => {
          if (cancelled) return;
          setQuote(q);
          setAmountB(rawToUnits(q.quantity_b_required));
        })
        .catch(() => {
          if (!cancelled) setQuote(null);
        });
    }, 250); // typing settles first
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [asset, rawA, existing]);

  const impliedPrice = useMemo(() => {
    if (rawA <= 0n || rawB <= 0n) return null;
    // XCP per whole unit of the counter asset.
    const scale = divisible ? 1e8 : 1;
    return Number(rawB) / 1e8 / (Number(rawA) / scale);
  }, [rawA, rawB, divisible]);

  const expectedLp = useMemo(() => {
    if (rawA <= 0n || rawB <= 0n) return 0n;
    // A first deposit mints floor(sqrt(qa*qb)) — no pool state is involved, so
    // this is exact rather than an estimate.
    if (isFirst) return isqrt(rawA * rawB);
    return quote ? big(quote.quantity_minted_estimate) : 0n;
  }, [rawA, rawB, isFirst, quote]);

  const shortA = rawA > balanceA;
  // Consensus charges an XCP gas fee for a pool message *on top of* the XCP
  // being deposited. Checking only the deposit lets someone put in their whole
  // balance and have the node reject it at validation, after the miner fee is
  // spent.
  const xcpNeeded = rawB + BigInt(Math.ceil(xcpFee ?? 0));
  const shortB = xcpNeeded > balanceXcp;
  // Never actionable before the lookup lands: composing a first deposit
  // against a pair that already has a pool is a different transaction with a
  // different meaning.
  const ready =
    checked &&
    wallet.address !== null &&
    asset !== "" &&
    rawA > 0n &&
    rawB > 0n &&
    // A later deposit cannot be composed until the node has priced it — the
    // floor would otherwise be guessed.
    (isFirst || quote !== null) &&
    !shortA &&
    !shortB &&
    !busy;

  const submit = useCallback(async () => {
    if (!wallet.address || !wallet.adapter) return;
    setBusy(true);
    setError(null);
    try {
      const composed = await composeDeposit({
        address: wallet.address,
        asset,
        // For a later deposit these are the node's own required quantities,
        // which consensus treats as maximums and debits proportionally.
        quantityA: quote ? big(quote.quantity_a_required) : rawA,
        quantityB: quote ? big(quote.quantity_b_required) : rawB,
        // A first deposit cannot slip — there is no pool to move — so the
        // floor is exact. Later ones take the slippage setting.
        minLpQuantity: isFirst ? expectedLp : withSlippage(expectedLp, slippage),
        lpAsset: isFirst ? randomLpAsset() : undefined,
        satPerVbyte: Number(satPerVbyte) || 1,
      });
      // A PSBT, not the raw transaction Counterparty handed back.
      //
      // Counterparty composes a finished transaction, and XCP Wallet will sign
      // that directly — but Horizon Wallet has no raw-transaction signing at
      // all. Rebuilding it as a PSBT from the compose's own prevouts
      // (`lock_scripts` / `inputs_values`, which is why every compose asks for
      // verbose) gives one path that both wallets take.
      const psbt = buildPlainPsbt(composed);
      const signed = await wallet.adapter!.signPsbt(psbt, {
        [wallet.address]: composed.inputs_values.map((_, i) => i),
      });
      const final = finalize(signed);
      // Horizon cannot relay either; its adapter falls back to Esplora.
      const broadcast = await wallet.adapter!.broadcast(final.hex);
      setTxid(broadcast || final.txid);
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [asset, expectedLp, isFirst, quote, rawA, rawB, satPerVbyte, slippage, wallet]);

  if (txid) {
    return (
      <div className="rounded-2xl border border-patina/40 bg-patina/5 p-6">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-patina">
          {isFirst ? copy.pool.receiptOpened : copy.pool.receiptAdded}
        </p>
        <h2 className="mb-4 font-mono text-2xl text-ink">{asset}/XCP</h2>
        <p className="mb-4 text-sm text-dim">{copy.pool.receiptBody}</p>
        <a
          href={mempoolTxUrl(txid)}
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono text-xs text-copper2 underline-offset-2 hover:underline"
        >
          {txid.slice(0, 20)}…
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Well label={copy.pool.counterLabel}>
        <input
          value={asset}
          onChange={(e) => setAsset(e.target.value.toUpperCase().trim())}
          placeholder="ASSET"
          className="w-full rounded-lg border border-line bg-bg2 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-faint focus:border-copper"
        />
        {asset && (
          <p className="mt-2 font-mono text-[11px] text-faint">
            {!checked ? (
              <span className="text-faint">{copy.pool.checking}</span>
            ) : isFirst ? (
              <span className="text-gold">{copy.pool.noPool}</span>
            ) : (
              <>
                {copy.pool.existing(
                  fmtPrice(Number(big(existing!.reserve_b)) / Number(big(existing!.reserve_a))),
                  fmtCompact(existing!.reserve_b),
                )}
              </>
            )}
          </p>
        )}
      </Well>

      <Well label={isFirst ? copy.pool.depositLabelFirst : copy.pool.depositLabel}>
        <AmountRow
          symbol={asset || "COUNTER"}
          value={amountA}
          onChange={setAmountA}
          balance={fmtQty(balanceA, divisible)}
          short={shortA}
        />
        <div className="my-3 h-px bg-line2" />
        <AmountRow
          symbol="XCP"
          value={amountB}
          onChange={setAmountB}
          balance={fmtQty(balanceXcp, true)}
          short={shortB}
          // Once a pool exists the counterpart is determined by the ratio;
          // typing a different number would only be ignored by consensus.
          // Once a pool exists the counterpart is fixed by the ratio. Before
          // the lookup lands neither field is authoritative, so neither is
          // locked.
          readOnly={checked && !isFirst}
        />
      </Well>

      {impliedPrice !== null && (
        <div
          className={`rounded-2xl border p-5 ${
            isFirst ? "border-gold/40 bg-gold/5" : "border-line bg-card"
          }`}
        >
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
            {isFirst ? copy.pool.openingPriceLabel : copy.pool.priceLabel}
          </div>
          <div className={`font-mono text-2xl ${isFirst ? "text-gold" : "text-ink"}`}>
            {fmtPrice(impliedPrice)} XCP
          </div>
          <div className="mt-1 font-mono text-[11px] text-faint">per {asset || "counter"}</div>

          {isFirst && (
            <p className="mt-4 text-[11px] leading-relaxed text-gold/90">
              {/* The single most consequential sentence on this page. */}
              {copy.pool.firstDepositWarning}
            </p>
          )}

          <div className="mt-4 flex flex-col gap-1.5 border-t border-line2 pt-3">
            <Row label="lp tokens minted">
              <span className="font-mono text-xs text-ink">{fmtCompact(expectedLp)}</span>
            </Row>
            <Row label="swap fee">
              <span className="font-mono text-xs text-dim">{XCP_POOL_FEE_BPS} bps</span>
            </Row>
            {xcpFee !== null && (
              <Row label="xcp gas fee">
                <span className="font-mono text-xs text-dim">{fmtQty(xcpFee, true)} XCP</span>
              </Row>
            )}
            {!isFirst && (
              <Row label="slippage">
                <span className="flex gap-1">
                  {[0.5, 1, 3].map((s) => (
                    <button
                      key={s}
                      onClick={() => setSlippage(s)}
                      className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                        slippage === s ? "border-copper text-copper2" : "border-line text-faint"
                      }`}
                    >
                      {s}%
                    </button>
                  ))}
                </span>
              </Row>
            )}
          </div>

          {!isFirst && (
            <p className="mt-3 text-[11px] leading-relaxed text-faint">{copy.pool.maximumsNote}</p>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-bad/40 bg-bad/5 p-4 text-sm text-bad">{error}</div>
      )}

      {confirming && isFirst ? (
        <div className="rounded-2xl border border-gold/40 bg-gold/5 p-5">
          <p className="mb-3 text-sm text-ink">
            {copy.pool.confirmFirst(asset, fmtPrice(impliedPrice))}
          </p>
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="flex-1 rounded-xl border border-gold bg-gold/10 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-gold"
            >
              {busy ? "composing…" : copy.pool.confirmCta}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded-xl border border-line px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-faint"
            >
              back
            </button>
          </div>
        </div>
      ) : !wallet.address ? (
        <ConnectInline />
      ) : (
        <button
          disabled={!ready}
          onClick={() => (isFirst ? setConfirming(true) : submit())}
          className="rounded-xl border border-copper bg-copper-ghost px-5 py-3 font-mono text-xs uppercase tracking-[0.12em] text-copper2 transition-colors enabled:hover:bg-copper enabled:hover:text-bg disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
        >
          {!checked
            ? "checking…"
            : busy
              ? "composing…"
              : isFirst
                ? copy.pool.ctaOpen
                : !quote
                  ? "pricing…"
                  : copy.pool.ctaAdd}
        </button>
      )}

      <p className="text-[11px] leading-relaxed text-faint">{copy.pool.footnote}</p>
    </div>
  );
}

/* -------------------------------------------------------------------- */

function AmountRow({
  symbol,
  value,
  onChange,
  balance,
  short,
  readOnly = false,
}: {
  symbol: string;
  value: string;
  onChange: (v: string) => void;
  balance: string;
  short: boolean;
  readOnly?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <input
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="0"
          className={`min-w-0 flex-1 bg-transparent font-mono text-2xl outline-none placeholder:text-faint ${
            short ? "text-bad" : "text-ink"
          } ${readOnly ? "cursor-default" : ""}`}
        />
        <span className="flex-shrink-0 font-mono text-sm text-copper2">{symbol}</span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-faint">
        balance {balance}
        {short && <span className="ml-2 text-bad">not enough</span>}
      </div>
    </div>
  );
}

/** Raw XCP to a trimmed decimal string for the mirrored field. */
function rawToUnits(raw: string | number): string {
  const value = big(raw);
  const whole = value / 100_000_000n;
  const frac = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

function Well({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        {label}
      </div>
      {children}
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
