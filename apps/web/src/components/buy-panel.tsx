"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet/wallet-context";
import { dispenseTerms } from "@counters/core/listing";
import { cpCompose, fetchBtcFunds } from "@/lib/cp";
import { describeError, isCancellation, reportHandled } from "@/lib/errors";
import { buildPlainPsbt, finalize, type ComposeResult } from "@/lib/inscribe/psbt";
import { FeeRateField, useFeeRate } from "@/components/fee-rate";
import { ConnectInline } from "@/components/connect-inline";
import { fmtQty } from "@/lib/format";
import { mempoolTxUrl } from "@/lib/constants";
import { copy } from "@content/copy";

/**
 * Buy from a dispenser.
 *
 * A dispenser vends in lots: `give_quantity` units for `satoshirate` sats,
 * as many lots as the payment covers, in the block the payment confirms in.
 * So the one choice here is how many lots, and the price is arithmetic —
 * there is no quote to fetch and no slippage to accept.
 *
 * The payment is not a plain BTC send. Since `disable_vanilla_btc_dispense`
 * (block 866,000) a bare payment to a dispenser's address buys nothing;
 * consensus wants a *dispense* message alongside it, which Core composes:
 * the payment output plus the OP_RETURN that names what it is for. The
 * compose is rebuilt as a PSBT and signed by the wallet, like every other
 * transaction on this site, so the wallet sees the exact payment it makes.
 *
 * The compose happens before the confirmation rather than after it: Core's
 * compose is also the fee quote, and the person should see the whole cost —
 * price plus miner fee — before being asked.
 */
export function BuyPanel({
  dispenser,
  asset,
  divisible,
  giveQuantity,
  satoshirate,
  giveRemaining,
}: {
  /** The address the dispenser vends from, which is where the payment goes. */
  dispenser: string;
  asset: string;
  divisible: boolean;
  /** Raw units per lot, as a string — these come through RSC props. */
  giveQuantity: string;
  /** Satoshis per lot. */
  satoshirate: string;
  /** Raw units still escrowed, or null when unknown. */
  giveRemaining: string | null;
}) {
  const wallet = useWallet();
  const fee = useFeeRate();
  const t = copy.dispenser.buy;

  const [lotsText, setLotsText] = useState("1");
  const [funds, setFunds] = useState<bigint | null>(null);
  const [prepared, setPrepared] = useState<ComposeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [txid, setTxid] = useState<string | null>(null);

  const lots = Math.max(0, Math.trunc(Number(lotsText) || 0));
  const terms = useMemo(
    () => dispenseTerms({ give_quantity: giveQuantity, satoshirate, give_remaining: giveRemaining }, lots),
    [giveQuantity, satoshirate, giveRemaining, lots],
  );
  const maxLots = terms?.maxLots ?? null;
  const soldOut = maxLots !== null && maxLots <= 0n;
  const tooMany = maxLots !== null && terms !== null && terms.lots > maxLots;

  useEffect(() => {
    if (!wallet.address) {
      setFunds(null);
      return;
    }
    let cancelled = false;
    fetchBtcFunds(wallet.address)
      .then((f) => !cancelled && setFunds(f.confirmed + f.unconfirmed))
      .catch(() => !cancelled && setFunds(null));
    return () => {
      cancelled = true;
    };
  }, [wallet.address, txid]);

  // Any change to the terms withdraws a prepared payment: what would be
  // signed is no longer what was shown.
  useEffect(() => {
    setPrepared(null);
  }, [lots, fee.rate, wallet.address]);

  const pay = terms?.pay ?? 0n;
  const short = funds !== null && pay > funds;
  const ready =
    wallet.address !== null && terms !== null && terms.lots > 0n && !soldOut && !tooMany && !short && fee.ok && !busy;

  const prepare = useCallback(async () => {
    if (!wallet.address || !terms || terms.lots <= 0n) return;
    setBusy(true);
    setError(null);
    try {
      const composed = await cpCompose(wallet.address, "dispense", {
        dispenser,
        quantity: terms.pay.toString(),
        sat_per_vbyte: String(fee.rate ?? 0),
        // A second buy may follow a first that has not confirmed: let the
        // compose spend the pending change. Core lists it at zero
        // confirmations, and the wallet signs an unconfirmed input whose
        // parent cannot have attached assets — a dispense cannot. The CLI's
        // buy sends the same.
        allow_unconfirmed_inputs: "true",
        // Coins carrying assets stay out of the payment; a UTXO that holds a
        // counter is not what anyone means to spend on one.
        exclude_utxos_with_balances: "true",
        verbose: "true",
      });
      setPrepared(composed);
    } catch (err) {
      reportHandled("dispense-compose", err);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [dispenser, fee.rate, terms, wallet.address]);

  const buy = useCallback(async () => {
    if (!wallet.address || !wallet.adapter || !prepared) return;
    setBusy(true);
    setError(null);
    try {
      const psbt = buildPlainPsbt(prepared);
      const signed = await wallet.adapter.signPsbt(psbt, {
        [wallet.address]: prepared.inputs_values.map((_, i) => i),
      });
      const final = finalize(signed);
      const sent = await wallet.adapter.broadcast(final.hex);
      setTxid(sent || final.txid);
      setPrepared(null);
    } catch (err) {
      reportHandled("dispense", err);
      setError(isCancellation(err) ? { message: copy.errors.cancelled(), detail: null } : describeError(err));
    } finally {
      setBusy(false);
    }
  }, [prepared, wallet.adapter, wallet.address]);

  if (txid) {
    return (
      <div id="buy" className="rounded-2xl border border-patina/40 bg-patina/5 p-5">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-patina">{t.receipt}</p>
        <p className="mb-2 text-[12px] text-dim">{t.receiptBody}</p>
        <a href={mempoolTxUrl(txid)} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-copper2 underline-offset-2 hover:underline">
          {txid.slice(0, 20)}…
        </a>
        <button onClick={() => setTxid(null)} className="ml-3 font-mono text-[11px] text-faint hover:text-copper2">
          again
        </button>
      </div>
    );
  }

  const minerFee = prepared ? BigInt(Math.round(prepared.btc_fee)) : null;
  const total = minerFee !== null ? pay + minerFee : null;

  return (
    <div id="buy" className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">{t.label}</span>
        <span className="font-mono text-[11px] text-faint">
          {soldOut ? t.soldOut : maxLots !== null ? t.left(maxLots.toString()) : ""}
        </span>
      </div>

      <div className="rounded-xl border border-line bg-bg2 p-3">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{t.lots}</div>
        <div className="flex items-baseline justify-between gap-3">
          <input
            value={lotsText}
            inputMode="numeric"
            onChange={(e) => setLotsText(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="1"
            disabled={soldOut}
            className={`min-w-0 flex-1 bg-transparent font-mono text-xl outline-none placeholder:text-faint ${tooMany ? "text-bad" : "text-ink"}`}
          />
          {maxLots !== null && maxLots > 0n && (
            <button onClick={() => setLotsText(maxLots.toString())} className="font-mono text-[10px] text-faint hover:text-copper2">
              max
            </button>
          )}
        </div>
        {tooMany && maxLots !== null && <div className="mt-1 font-mono text-[10px] text-bad">{t.tooMany(maxLots.toString())}</div>}
      </div>

      {terms && terms.lots > 0n && (
        <div className="mt-3 flex flex-col gap-1.5 text-[11px]">
          <Row label={t.youReceive}>
            <span className="font-mono text-ink">
              {fmtQty(terms.receive, divisible)} {asset}
            </span>
          </Row>
          <Row label={t.youPay}>
            <span className={`font-mono ${short ? "text-bad" : "text-ink"}`}>
              {fmtQty(pay, true)} BTC
              <span className="ml-2 text-faint">{pay.toLocaleString("en-US")} sat</span>
            </span>
          </Row>
          {wallet.address && (
            <Row label={t.balance}>
              <span className="font-mono text-dim">
                {funds === null ? "—" : `${fmtQty(funds, true)} BTC`}
                {short && <span className="ml-2 text-bad">{t.short}</span>}
              </span>
            </Row>
          )}
          {minerFee !== null && total !== null && (
            <>
              <Row label={t.minerFee}>
                <span className="font-mono text-dim">{minerFee.toLocaleString("en-US")} sat</span>
              </Row>
              <Row label={t.total}>
                <span className="font-mono text-ink">{fmtQty(total, true)} BTC</span>
              </Row>
            </>
          )}
          <FeeRateField fee={fee} xcpWallet={wallet.adapter?.id === "xcp"} />
          <p className="text-[11px] leading-relaxed text-faint">{t.plainSend}</p>
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
        ) : prepared && terms && total !== null ? (
          <div className="rounded-xl border border-copper/40 bg-copper-ghost p-4">
            <p className="mb-3 text-sm text-ink">{t.confirm(fmtQty(terms.receive, divisible), asset, fmtQty(total, true))}</p>
            <div className="flex gap-2">
              <button onClick={buy} disabled={busy} className="flex-1 rounded-xl border border-copper bg-copper-ghost px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-copper2">
                {busy ? t.preparing : t.confirmCta}
              </button>
              <button onClick={() => setPrepared(null)} className="rounded-xl border border-line px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-faint">
                back
              </button>
            </div>
          </div>
        ) : (
          <button
            disabled={!ready}
            onClick={prepare}
            className="w-full rounded-xl border border-copper bg-copper-ghost px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-copper2 transition-colors enabled:hover:bg-copper enabled:hover:text-bg disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
          >
            {busy ? t.preparing : `${t.cta} ${asset}`}
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
