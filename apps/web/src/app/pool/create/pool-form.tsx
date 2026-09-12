"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet/wallet-context";
import { big, parseUnitsToRaw } from "@counters/core/numeric";
import { isqrt, orientDepositQuote, orientPool, orientWithdrawQuote, type Pool } from "@counters/core/pool";
import { classifyAssetName, isNumericAssetName, randomNumericAsset } from "@counters/core/assetnames";
import { seedsPool } from "@counters/core/fairminter";
import {
  composeDeposit,
  composeLpLock,
  composeWithdraw,
  estimateDepositXcpFee,
  estimateWithdrawXcpFee,
  fetchBalance,
  fetchDepositQuote,
  fetchPool,
  fetchWithdrawQuote,
  rawToUnits,
  withSlippage,
  type ComposedTx,
} from "@/lib/pool-compose";
import { fetchAsset, fetchAssetFairminters, type AssetInfo } from "@/lib/cp";
import { describeError, isCancellation, reportHandled } from "@/lib/errors";
import { ConnectInline } from "@/components/connect-inline";
import { FeeRateField, useFeeRate } from "@/components/fee-rate";
import { copy } from "@content/copy";
import { buildPlainPsbt, finalize } from "@/lib/inscribe/psbt";
import { fmtCompact, fmtPrice, fmtQty } from "@/lib/format";
import { XCP_POOL_FEE_BPS, mempoolTxUrl } from "@/lib/constants";

/**
 * Create or add to a counter's XCP pool; withdraw from it; lock what you hold.
 *
 * The page turns on one distinction, and it is the thing most liquidity UIs
 * bury: whether a pool already exists. A first deposit *is* the price. A
 * later deposit is matched to the pool's ratio by the node, and the amounts
 * composed are maximums that consensus debits proportionally.
 *
 * Nothing about the pool is stated until the node has answered. "unknown"
 * and "error" are distinct from "no pool": a request that failed is not a
 * pool that does not exist, and saying so would put a first-deposit price on
 * a pair that is already trading.
 */

type PoolState = "unknown" | "error" | Pool | null;
type Tab = "deposit" | "withdraw";
type Receipt = { kind: "opened" | "added" | "withdrawn" | "locked"; txid: string };

const SLIPPAGE_PRESETS = [0.5, 1, 3];
const LP_DECIMALS = 8;

export function PoolForm({ initialAsset }: { initialAsset: string }) {
  const wallet = useWallet();

  const [asset, setAsset] = useState(initialAsset);
  const [tab, setTab] = useState<Tab>("deposit");
  const [pool, setPool] = useState<PoolState>("unknown");
  const [info, setInfo] = useState<AssetInfo | null | "unknown" | "error">("unknown");
  const [xcp69, setXcp69] = useState(false);

  const [amountToken, setAmountToken] = useState("");
  const [amountXcp, setAmountXcp] = useState("");
  const [lead, setLead] = useState<"token" | "xcp">("token");
  const [slippage, setSlippage] = useState(1);
  const [customSlippage, setCustomSlippage] = useState("");
  const fee = useFeeRate();
  const [lpChoice, setLpChoice] = useState<"auto" | "custom">("auto");
  const [lpCustom, setLpCustom] = useState("");

  const [quote, setQuote] = useState<ReturnType<typeof orientDepositQuote> | null>(null);
  const [balanceToken, setBalanceToken] = useState<bigint | null>(null);
  const [balanceXcp, setBalanceXcp] = useState<bigint | null>(null);
  const [balanceLp, setBalanceLp] = useState<bigint | null>(null);
  const [xcpFee, setXcpFee] = useState<number | null>(null);
  const [withdrawXcpFee, setWithdrawXcpFee] = useState<number | null>(null);

  const [lpAmount, setLpAmount] = useState("");
  const [withdrawQuote, setWithdrawQuote] = useState<ReturnType<typeof orientWithdrawQuote> | null>(null);
  const [lockAck, setLockAck] = useState(false);

  const [confirming, setConfirming] = useState<null | "deposit" | "withdraw" | "lock">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  /* ---------------- lookups ---------------- */

  useEffect(() => {
    if (!asset || !classifyAssetName(asset).ok) {
      setPool("unknown");
      setInfo("unknown");
      setXcp69(false);
      return;
    }
    let cancelled = false;
    setPool("unknown");
    setInfo("unknown");
    setQuote(null);
    (async () => {
      const [found, meta, fairminters] = await Promise.all([
        fetchPool(asset).catch(() => "error" as const),
        fetchAsset(asset).catch(() => "error" as const),
        fetchAssetFairminters<{ pool_quantity: string | number | null }>(asset).catch(() => []),
      ]);
      if (cancelled) return;
      setPool(found);
      setInfo(meta);
      setXcp69(fairminters.some((fm) => seedsPool(fm)));
    })();
    return () => {
      cancelled = true;
    };
  }, [asset]);

  const existing = typeof pool === "object" && pool !== null ? orientPool(pool, asset) : null;
  const checked = pool !== "unknown";
  const isFirst = checked && pool === null;
  const divisible = typeof info === "object" && info !== null ? info.divisible : true;
  const metaReady = typeof info === "object";
  const decimals = divisible ? 8 : 0;

  useEffect(() => {
    if (!wallet.address || !asset || !classifyAssetName(asset).ok) return;
    let cancelled = false;
    const address = wallet.address;
    (async () => {
      const [t, x, fee, wfee] = await Promise.all([
        fetchBalance(address, asset).catch(() => null),
        fetchBalance(address, "XCP").catch(() => null),
        estimateDepositXcpFee(address).catch(() => null),
        estimateWithdrawXcpFee(address).catch(() => null),
      ]);
      if (cancelled) return;
      setBalanceToken(t);
      setBalanceXcp(x);
      setXcpFee(fee);
      setWithdrawXcpFee(wfee);
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.address, asset, receipt]);

  useEffect(() => {
    if (!wallet.address || !existing?.lpAsset) {
      setBalanceLp(null);
      return;
    }
    let cancelled = false;
    fetchBalance(wallet.address, existing.lpAsset)
      .then((b) => !cancelled && setBalanceLp(b))
      .catch(() => !cancelled && setBalanceLp(null));
    return () => {
      cancelled = true;
    };
  }, [wallet.address, existing?.lpAsset, receipt]);

  const rawToken = useMemo(() => parseUnitsToRaw(amountToken, decimals) ?? 0n, [amountToken, decimals]);
  const rawXcp = useMemo(() => parseUnitsToRaw(amountXcp, 8) ?? 0n, [amountXcp]);

  // Ask the node what a later deposit requires, from whichever side was typed.
  useEffect(() => {
    if (!existing) {
      setQuote(null);
      return;
    }
    const typed = lead === "token" ? rawToken : rawXcp;
    if (typed <= 0n) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchDepositQuote(asset, lead, typed)
        .then((q) => {
          if (cancelled) return;
          const oriented = orientDepositQuote(q, asset);
          setQuote(oriented);
          if (lead === "token") setAmountXcp(rawToUnits(oriented.xcpRequired, 8));
          else setAmountToken(rawToUnits(oriented.tokenRequired, decimals));
        })
        .catch(() => !cancelled && setQuote(null));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [asset, existing, lead, rawToken, rawXcp, decimals]);

  const rawLp = useMemo(() => parseUnitsToRaw(lpAmount, LP_DECIMALS) ?? 0n, [lpAmount]);

  useEffect(() => {
    if (tab !== "withdraw" || !existing || rawLp <= 0n) {
      setWithdrawQuote(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchWithdrawQuote(asset, rawLp)
        .then((q) => !cancelled && setWithdrawQuote(orientWithdrawQuote(q, asset)))
        .catch(() => !cancelled && setWithdrawQuote(null));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tab, asset, existing, rawLp]);

  /* ---------------- derived ---------------- */

  const effectiveSlippage = customSlippage ? Math.min(50, Math.max(0, Number(customSlippage) || 0)) : slippage;
  const priceScale = divisible ? 1e8 : 1;

  const impliedPrice = useMemo(() => {
    if (rawToken <= 0n || rawXcp <= 0n) return null;
    return Number(rawXcp) / 1e8 / (Number(rawToken) / priceScale);
  }, [rawToken, rawXcp, priceScale]);

  const poolPrice = existing && existing.tokenReserve > 0n ? Number(existing.xcpReserve) / 1e8 / (Number(existing.tokenReserve) / priceScale) : null;

  const expectedLp = useMemo(() => {
    if (rawToken <= 0n || rawXcp <= 0n) return 0n;
    if (isFirst) return isqrt(rawToken * rawXcp);
    return quote ? quote.minted : 0n;
  }, [rawToken, rawXcp, isFirst, quote]);

  const shortToken = balanceToken !== null && rawToken > balanceToken;
  const xcpNeeded = rawXcp + BigInt(Math.ceil(xcpFee ?? 0));
  const shortXcp = balanceXcp !== null && xcpNeeded > balanceXcp;
  const lpAssetValid = lpChoice === "auto" || isNumericAssetName(lpCustom);

  const depositReady =
    checked &&
    pool !== "error" &&
    metaReady &&
    wallet.address !== null &&
    rawToken > 0n &&
    rawXcp > 0n &&
    (isFirst || quote !== null) &&
    (!isFirst || lpAssetValid) &&
    !shortToken &&
    !shortXcp &&
    fee.ok &&
    !busy;

  const withdrawReady =
    existing !== null && wallet.address !== null && rawLp > 0n && balanceLp !== null && rawLp <= balanceLp && withdrawQuote !== null && fee.ok && !busy;

  /* ---------------- actions ---------------- */

  const signAndSend = useCallback(
    async (composed: ComposedTx): Promise<string> => {
      const psbt = buildPlainPsbt(composed);
      const signed = await wallet.adapter!.signPsbt(psbt, { [wallet.address!]: composed.inputs_values.map((_, i) => i) });
      const final = finalize(signed);
      const broadcast = await wallet.adapter!.broadcast(final.hex);
      return broadcast || final.txid;
    },
    [wallet.adapter, wallet.address],
  );

  const fail = useCallback((err: unknown) => {
    reportHandled("pool", err);
    setError(isCancellation(err) ? { message: copy.errors.cancelled(), detail: null } : describeError(err));
  }, []);

  const deposit = useCallback(async () => {
    if (!wallet.address || !wallet.adapter) return;
    setBusy(true);
    setError(null);
    try {
      const composed = await composeDeposit({
        address: wallet.address,
        asset,
        quantityToken: quote ? quote.tokenRequired : rawToken,
        quantityXcp: quote ? quote.xcpRequired : rawXcp,
        // A first deposit cannot slip — there is no pool to move — so the
        // floor is exact. Later ones take the slippage setting.
        minLpQuantity: isFirst ? expectedLp : withSlippage(expectedLp, effectiveSlippage),
        lpAsset: isFirst ? (lpChoice === "custom" ? lpCustom : randomNumericAsset()) : undefined,
        satPerVbyte: fee.rate ?? 0,
      });
      const txid = await signAndSend(composed);
      setReceipt({ kind: isFirst ? "opened" : "added", txid });
      setConfirming(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }, [asset, effectiveSlippage, expectedLp, fail, isFirst, lpChoice, lpCustom, quote, rawToken, rawXcp, fee.rate, signAndSend, wallet.adapter, wallet.address]);

  const withdraw = useCallback(async () => {
    if (!wallet.address || !wallet.adapter || !withdrawQuote) return;
    setBusy(true);
    setError(null);
    try {
      const composed = await composeWithdraw({
        address: wallet.address,
        asset,
        quantity: rawLp,
        minQuantityToken: withSlippage(withdrawQuote.tokenOut, effectiveSlippage),
        minQuantityXcp: withSlippage(withdrawQuote.xcpOut, effectiveSlippage),
        satPerVbyte: fee.rate ?? 0,
      });
      const txid = await signAndSend(composed);
      setReceipt({ kind: "withdrawn", txid });
      setConfirming(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }, [asset, effectiveSlippage, fail, rawLp, fee.rate, signAndSend, wallet.adapter, wallet.address, withdrawQuote]);

  const lock = useCallback(async () => {
    if (!wallet.address || !wallet.adapter || !existing?.lpAsset || balanceLp === null || balanceLp <= 0n) return;
    setBusy(true);
    setError(null);
    try {
      const composed = await composeLpLock(wallet.address, existing.lpAsset, balanceLp, fee.rate ?? 0);
      const txid = await signAndSend(composed);
      setReceipt({ kind: "locked", txid });
      setConfirming(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }, [balanceLp, existing?.lpAsset, fail, fee.rate, signAndSend, wallet.adapter, wallet.address]);

  /* ---------------- render ---------------- */

  if (receipt) {
    const label = { opened: copy.pool.receiptOpened, added: copy.pool.receiptAdded, withdrawn: copy.pool.withdraw.receipt, locked: copy.pool.lock.receipt }[receipt.kind];
    const body = receipt.kind === "withdrawn" ? copy.pool.withdraw.receiptBody : receipt.kind === "locked" ? copy.pool.lock.receiptBody : copy.pool.receiptBody;
    return (
      <div className="rounded-2xl border border-patina/40 bg-patina/5 p-6">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-patina">{label}</p>
        <h2 className="mb-4 font-mono text-2xl text-ink">{asset}/XCP</h2>
        <p className="mb-4 text-sm text-dim">{body}</p>
        <a href={mempoolTxUrl(receipt.txid)} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-copper2 underline-offset-2 hover:underline">
          {receipt.txid.slice(0, 20)}…
        </a>
      </div>
    );
  }

  const status = !asset ? null : !classifyAssetName(asset).ok ? (
    <span className="text-bad">{copy.errors.badAssetName()}</span>
  ) : pool === "error" || info === "error" ? (
    <span className="text-bad">{copy.pool.couldNotCheck}</span>
  ) : !checked || !metaReady ? (
    <span className="text-faint">{copy.pool.checking}</span>
  ) : info === null ? (
    <span className="text-bad">{copy.pool.noAsset}</span>
  ) : isFirst ? (
    <span className="text-gold">{copy.pool.noPool}</span>
  ) : (
    <>{copy.pool.existing(fmtPrice(poolPrice), fmtCompact(existing!.xcpReserve))}</>
  );

  return (
    <div className="flex flex-col gap-5">
      <Well label={copy.pool.counterLabel}>
        <input
          value={asset}
          onChange={(e) => setAsset(e.target.value.toUpperCase().trim())}
          placeholder="ASSET"
          className="w-full rounded-lg border border-line bg-bg2 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-faint focus:border-copper"
        />
        {status && <p className="mt-2 font-mono text-[11px] text-faint">{status}</p>}
        {xcp69 && <p className="mt-2 text-[11px] leading-relaxed text-faint">{copy.pool.xcp69Note}</p>}
      </Well>

      {existing && (
        <div className="flex gap-1 rounded-xl border border-line p-1">
          {(["deposit", "withdraw"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setConfirming(null);
                setError(null);
              }}
              className={`flex-1 rounded-lg px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] ${tab === t ? "bg-copper-ghost text-copper2" : "text-faint"}`}
            >
              {copy.pool.tabs[t]}
            </button>
          ))}
        </div>
      )}

      {tab === "deposit" || !existing ? (
        <>
          <Well label={isFirst ? copy.pool.depositLabelFirst : copy.pool.depositLabel}>
            <AmountRow
              symbol={asset || "COUNTER"}
              value={amountToken}
              onChange={(v) => {
                setLead("token");
                setAmountToken(v);
              }}
              balance={balanceToken === null ? "—" : fmtQty(balanceToken, divisible)}
              short={shortToken}
            />
            <div className="my-3 h-px bg-line2" />
            <AmountRow
              symbol="XCP"
              value={amountXcp}
              onChange={(v) => {
                setLead("xcp");
                setAmountXcp(v);
              }}
              balance={balanceXcp === null ? "—" : fmtQty(balanceXcp, true)}
              short={shortXcp}
            />
            {existing && <p className="mt-3 text-[11px] text-faint">{copy.pool.eitherSide}</p>}
            <div className="mt-4 border-t border-line2 pt-3">
              <FeeRateField fee={fee} xcpWallet={wallet.adapter?.id === "xcp"} />
            </div>
          </Well>

          {impliedPrice !== null && (
            <div className={`rounded-2xl border p-5 ${isFirst ? "border-gold/40 bg-gold/5" : "border-line bg-card"}`}>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                {isFirst ? copy.pool.openingPriceLabel : copy.pool.priceLabel}
              </div>
              <div className={`font-mono text-2xl ${isFirst ? "text-gold" : "text-ink"}`}>{fmtPrice(impliedPrice)} XCP</div>
              <div className="mt-1 font-mono text-[11px] text-faint">per {asset || "counter"}</div>
              {isFirst && <p className="mt-4 text-[11px] leading-relaxed text-gold/90">{copy.pool.firstDepositWarning}</p>}

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
                  <SlippageRow slippage={slippage} custom={customSlippage} onPreset={(s) => { setSlippage(s); setCustomSlippage(""); }} onCustom={setCustomSlippage} />
                )}
                {isFirst && (
                  <Row label={copy.pool.lpAsset.label}>
                    <span className="flex items-center gap-1">
                      {(["auto", "custom"] as const).map((c) => (
                        <button
                          key={c}
                          onClick={() => setLpChoice(c)}
                          className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${lpChoice === c ? "border-copper text-copper2" : "border-line text-faint"}`}
                        >
                          {copy.pool.lpAsset[c]}
                        </button>
                      ))}
                    </span>
                  </Row>
                )}
                {isFirst && lpChoice === "custom" && (
                  <div>
                    <input
                      value={lpCustom}
                      onChange={(e) => setLpCustom(e.target.value.toUpperCase().trim())}
                      placeholder="A95428956661682277"
                      className={`w-full rounded-lg border bg-bg2 px-2 py-1 font-mono text-xs text-ink outline-none focus:border-copper ${lpCustom && !lpAssetValid ? "border-bad" : "border-line"}`}
                    />
                    <p className="mt-1 text-[11px] text-faint">{copy.pool.lpAsset.hint}</p>
                  </div>
                )}
              </div>
              {!isFirst && <p className="mt-3 text-[11px] leading-relaxed text-faint">{copy.pool.maximumsNote}</p>}
            </div>
          )}

          <ErrorBox error={error} />

          {confirming === "deposit" ? (
            <ConfirmCard
              tone={isFirst ? "gold" : "copper"}
              text={
                isFirst
                  ? copy.pool.confirmFirst(asset, fmtPrice(impliedPrice))
                  : copy.pool.confirmAdd(asset, fmtQty(quote?.tokenRequired ?? rawToken, divisible), fmtQty(quote?.xcpRequired ?? rawXcp, true))
              }
              cta={isFirst ? copy.pool.confirmCta : copy.pool.confirmAddCta}
              busy={busy}
              onConfirm={deposit}
              onBack={() => setConfirming(null)}
            />
          ) : !wallet.address ? (
            <ConnectInline />
          ) : (
            <button
              disabled={!depositReady}
              onClick={() => setConfirming("deposit")}
              className="rounded-xl border border-copper bg-copper-ghost px-5 py-3 font-mono text-xs uppercase tracking-[0.12em] text-copper2 transition-colors enabled:hover:bg-copper enabled:hover:text-bg disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
            >
              {!checked || !metaReady ? "checking…" : busy ? "composing…" : isFirst ? copy.pool.ctaOpen : !quote && (rawToken > 0n || rawXcp > 0n) ? "pricing…" : copy.pool.ctaAdd}
            </button>
          )}
        </>
      ) : (
        <>
          <Well label={copy.pool.withdraw.label}>
            {balanceLp === null || balanceLp <= 0n ? (
              <p className="text-[11px] text-faint">{copy.pool.withdraw.none}</p>
            ) : (
              <>
                <AmountRow symbol="LP" value={lpAmount} onChange={setLpAmount} balance={fmtQty(balanceLp, true)} short={rawLp > balanceLp} />
                <div className="mt-2 flex gap-1">
                  {[25, 50, 75, 100].map((pct) => (
                    <button
                      key={pct}
                      onClick={() => setLpAmount(rawToUnits((balanceLp * BigInt(pct)) / 100n, LP_DECIMALS))}
                      className="rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-faint hover:border-copper hover:text-copper2"
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
                {withdrawQuote && (
                  <div className="mt-4 flex flex-col gap-1.5 border-t border-line2 pt-3">
                    <Row label={copy.pool.withdraw.receive}>
                      <span className="font-mono text-xs text-ink">
                        {fmtQty(withSlippage(withdrawQuote.tokenOut, effectiveSlippage), divisible)} {asset} + {fmtQty(withSlippage(withdrawQuote.xcpOut, effectiveSlippage), true)} XCP
                      </span>
                    </Row>
                    {withdrawXcpFee !== null && (
                      <Row label="xcp gas fee">
                        <span className="font-mono text-xs text-dim">{fmtQty(withdrawXcpFee, true)} XCP</span>
                      </Row>
                    )}
                    <SlippageRow slippage={slippage} custom={customSlippage} onPreset={(s) => { setSlippage(s); setCustomSlippage(""); }} onCustom={setCustomSlippage} />
                  </div>
                )}
              </>
            )}
            <div className="mt-4 border-t border-line2 pt-3">
              <FeeRateField fee={fee} xcpWallet={wallet.adapter?.id === "xcp"} />
            </div>
          </Well>

          {balanceLp !== null && balanceLp > 0n && (
            <Well label={copy.pool.lock.label}>
              <p className="text-[11px] leading-relaxed text-faint">{copy.pool.lock.hint}</p>
              <label className="mt-3 flex items-center gap-2 text-[11px] text-dim">
                <input type="checkbox" checked={lockAck} onChange={(e) => setLockAck(e.target.checked)} />
                {copy.pool.lock.confirmLabel}
              </label>
              <button
                disabled={!lockAck || busy}
                onClick={() => setConfirming("lock")}
                className="mt-3 rounded-xl border border-bad/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.1em] text-bad disabled:border-line disabled:text-faint"
              >
                {copy.pool.lock.cta}
              </button>
            </Well>
          )}

          <ErrorBox error={error} />

          {confirming === "withdraw" && withdrawQuote ? (
            <ConfirmCard
              tone="copper"
              text={copy.pool.withdraw.confirm(fmtQty(rawLp, true), fmtQty(withSlippage(withdrawQuote.tokenOut, effectiveSlippage), divisible) + " " + asset, fmtQty(withSlippage(withdrawQuote.xcpOut, effectiveSlippage), true))}
              cta={copy.pool.withdraw.cta}
              busy={busy}
              onConfirm={withdraw}
              onBack={() => setConfirming(null)}
            />
          ) : confirming === "lock" && balanceLp !== null ? (
            <ConfirmCard tone="bad" text={copy.pool.lock.confirm(fmtQty(balanceLp, true), asset)} cta={copy.pool.lock.cta} busy={busy} onConfirm={lock} onBack={() => setConfirming(null)} />
          ) : !wallet.address ? (
            <ConnectInline />
          ) : (
            <button
              disabled={!withdrawReady}
              onClick={() => setConfirming("withdraw")}
              className="rounded-xl border border-copper bg-copper-ghost px-5 py-3 font-mono text-xs uppercase tracking-[0.12em] text-copper2 transition-colors enabled:hover:bg-copper enabled:hover:text-bg disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
            >
              {busy ? "composing…" : rawLp > 0n && !withdrawQuote ? "pricing…" : copy.pool.withdraw.cta}
            </button>
          )}
        </>
      )}

      <p className="text-[11px] leading-relaxed text-faint">{copy.pool.footnote}</p>
    </div>
  );
}

/* -------------------------------------------------------------------- */

function SlippageRow({ slippage, custom, onPreset, onCustom }: { slippage: number; custom: string; onPreset: (s: number) => void; onCustom: (s: string) => void }) {
  return (
    <Row label="slippage">
      <span className="flex items-center gap-1">
        {SLIPPAGE_PRESETS.map((s) => (
          <button
            key={s}
            onClick={() => onPreset(s)}
            className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${!custom && slippage === s ? "border-copper text-copper2" : "border-line text-faint"}`}
          >
            {s}%
          </button>
        ))}
        <input
          value={custom}
          inputMode="decimal"
          placeholder={copy.pool.slippageCustom}
          onChange={(e) => onCustom(e.target.value.replace(/[^\d.]/g, ""))}
          className={`w-16 rounded-md border bg-bg2 px-2 py-0.5 text-right font-mono text-[11px] text-ink outline-none placeholder:text-faint ${custom ? "border-copper" : "border-line"}`}
        />
        <span className="font-mono text-[11px] text-faint">%</span>
      </span>
    </Row>
  );
}

function ConfirmCard({ tone, text, cta, busy, onConfirm, onBack }: { tone: "gold" | "copper" | "bad"; text: string; cta: string; busy: boolean; onConfirm: () => void; onBack: () => void }) {
  const border = { gold: "border-gold/40 bg-gold/5", copper: "border-copper/40 bg-copper-ghost", bad: "border-bad/40 bg-bad/5" }[tone];
  const button = { gold: "border-gold bg-gold/10 text-gold", copper: "border-copper bg-copper-ghost text-copper2", bad: "border-bad bg-bad/10 text-bad" }[tone];
  return (
    <div className={`rounded-2xl border p-5 ${border}`}>
      <p className="mb-3 text-sm text-ink">{text}</p>
      <div className="flex gap-2">
        <button onClick={onConfirm} disabled={busy} className={`flex-1 rounded-xl border px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] ${button}`}>
          {busy ? "composing…" : cta}
        </button>
        <button onClick={onBack} className="rounded-xl border border-line px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-faint">
          back
        </button>
      </div>
    </div>
  );
}

function ErrorBox({ error }: { error: { message: string; detail: string | null } | null }) {
  if (!error) return null;
  return (
    <div className="rounded-2xl border border-bad/40 bg-bad/5 p-4 text-sm text-bad">
      {error.message}
      {error.detail && error.detail !== error.message && <p className="mt-2 break-words font-mono text-[10px] text-bad/70">{error.detail}</p>}
    </div>
  );
}

function AmountRow({ symbol, value, onChange, balance, short }: { symbol: string; value: string; onChange: (v: string) => void; balance: string; short: boolean }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <input
          value={value}
          inputMode="decimal"
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="0"
          className={`min-w-0 flex-1 bg-transparent font-mono text-2xl outline-none placeholder:text-faint ${short ? "text-bad" : "text-ink"}`}
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

function Well({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{label}</div>
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
