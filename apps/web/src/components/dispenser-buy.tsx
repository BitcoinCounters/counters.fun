"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DISPENSER_CLOSED, DISPENSER_CLOSING, DISPENSER_OPEN } from "@counters/core/listing";
import { big } from "@counters/core/numeric";
import type { DispenserDetail, Offer } from "@/lib/api";
import { dispenserUrl } from "@/lib/constants";
import { fmtAsk } from "@/lib/format";
import { BuyPanel } from "@/components/buy-panel";
import { copy } from "@content/copy";

/**
 * The buy under a dispenser card: it buys here, in a dialog over the page,
 * rather than sending the reader to the dispenser's page to do it.
 *
 * The card knows the listing — price per unit, what is left — and the buy
 * needs the lot and the rate, which are Core's live row; so opening the
 * dialog asks the worker for the dispenser (through this origin, like the
 * search) and hands the answer to the same panel the dispenser page uses.
 * A dispenser that has closed since the index last looked says so here
 * rather than composing a payment that would buy nothing.
 *
 * A native <dialog>: it traps focus, closes on Escape, and sits over the
 * grid without the grid having to make room.
 */
export function DispenserBuy({ offer }: { offer: Offer }) {
  const t = copy.dispenser;
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DispenserDetail | null>(null);
  const [failed, setFailed] = useState(false);

  // Opening asks again if the last look failed: a blip reaching the node
  // should cost a click, not a page reload.
  const show = useCallback(() => {
    setFailed(false);
    setOpen(true);
    ref.current?.showModal();
  }, []);
  const retry = useCallback(() => {
    setDetail(null);
    setFailed(false);
  }, []);
  const hide = useCallback(() => {
    ref.current?.close();
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open || detail || failed) return;
    let cancelled = false;
    fetch(`/api/dispenser/${offer.offer_id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { result: DispenserDetail };
      })
      .then((body) => !cancelled && setDetail(body.result))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [open, detail, failed, offer.offer_id]);

  const live = detail?.live ?? null;
  const status = live ? live.status : DISPENSER_OPEN;
  const isOpen = status === DISPENSER_OPEN || status === DISPENSER_CLOSING;
  const address = live?.source ?? null;
  const buyable = detail !== null && live !== null && isOpen && !live.oracle_address && address !== null;

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="rounded-xl border border-copper bg-copper-ghost px-4 py-2 text-center font-mono text-[11px] uppercase tracking-[0.1em] text-copper2 transition-colors hover:bg-copper hover:text-bg"
      >
        {copy.home.dispensers.buy}
      </button>

      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // The backdrop is the dialog element itself; a click inside its
          // box lands on a child.
          if (e.target === ref.current) hide();
        }}
        className="m-auto w-[min(440px,calc(100vw-32px))] rounded-2xl border border-line bg-bg p-0 text-ink shadow-[0_24px_60px_-20px_#000] backdrop:bg-black/70 backdrop:backdrop-blur-sm"
      >
        <div className="p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{t.eyebrow}</div>
              <div className="truncate font-mono text-lg font-semibold text-copper2">{offer.asset}</div>
              <div className="mt-0.5 font-mono text-[11px] text-dim">{fmtAsk(offer.offer_price, offer.offer_asset)}</div>
            </div>
            <button
              type="button"
              onClick={hide}
              aria-label={t.buy.close}
              className="rounded-md px-2 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-faint hover:text-ink"
            >
              {t.buy.close}
            </button>
          </div>

          {open && buyable && live && address && (
            <BuyPanel
              dispenser={address}
              asset={offer.asset}
              divisible={offer.divisible === 1}
              giveQuantity={big(live.give_quantity).toString()}
              satoshirate={big(live.satoshirate).toString()}
              giveRemaining={live.give_remaining == null ? null : big(live.give_remaining).toString()}
            />
          )}
          {open && !detail && !failed && <p className="text-sm text-dim">{t.buy.loading}</p>}
          {open && (failed || (detail && !live)) && (
            <p className="text-sm text-dim">
              {t.nodeAway}{" "}
              <button type="button" onClick={retry} className="font-mono text-[11px] uppercase tracking-[0.1em] text-copper2 underline-offset-2 hover:underline">
                {t.buy.retry}
              </button>
            </p>
          )}
          {open && detail && live && status === DISPENSER_CLOSED && <p className="text-sm text-dim">{t.closed}</p>}
          {open && detail && live && isOpen && live.oracle_address && <p className="text-sm text-dim">{t.oracle}</p>}

          <Link
            href={dispenserUrl(offer.offer_id)}
            className="mt-4 inline-block font-mono text-[11px] text-copper underline-offset-2 hover:underline"
          >
            {t.buy.page} →
          </Link>
        </div>
      </dialog>
    </>
  );
}
