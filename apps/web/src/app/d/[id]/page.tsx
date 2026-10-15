import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  DISPENSER_CLOSED,
  DISPENSER_CLOSING,
  DISPENSER_OPEN,
  dispenseTerms,
  unitPrice,
} from "@counters/core/listing";
import { big } from "@counters/core/numeric";
import { circulatingSupply } from "@counters/core/counter";
import { pricePerKb } from "@counters/core/pool";
import { getDispenser } from "@/lib/api";
import { copy } from "@content/copy";
import { CounterContent } from "@/components/counter-content";
import { BuyPanel } from "@/components/buy-panel";
import { Meter } from "@/components/meter";
import { Fact, Figure } from "@/components/detail-bits";
import { fmtAsk, fmtCompact, fmtDate, fmtPerKb, fmtQty, trunc } from "@/lib/format";
import { SITE_URL, mempoolAddressUrl, mempoolBlockUrl, mempoolTxUrl, xcpAssetUrl } from "@/lib/constants";

export const revalidate = 30;

/**
 * A dispenser's own page.
 *
 * A dispenser card on the home page says one thing — this counter, at this
 * price, this many left — and used to land on the counter's page, whose
 * first panel is the pool. The thing that was clicked shrank to one row in
 * "open offers". This page is about the offer: its terms, what is left, how
 * often it has vended, and the buy. The counter is beside it for context,
 * and its own page is a link away for the pool and the provenance.
 *
 * Two sources, either of which may be away. The listing is what this index
 * holds (price per unit, remaining, operator); Core's live row has the lot
 * and rate the buy needs. A closed dispenser has no listing — the sync
 * drops it — but Core still knows it, so the page says closed rather than
 * 404ing a link somebody saved.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const d = await getDispenser(id).catch(() => null);
  if (!d) return {};
  const divisible = d.counter.divisible === 1;
  const price = d.listing?.price ?? (d.live ? unitPrice(d.live.satoshirate, true, d.live.give_quantity, divisible) : null);
  const remaining = d.live?.give_remaining ?? d.listing?.remaining ?? null;
  const title = copy.site.dispenser.title(d.counter.asset);
  const description = copy.site.dispenser.description(
    d.counter.asset,
    fmtAsk(price, "BTC"),
    fmtCompact(remaining, divisible),
  );
  return {
    title,
    description,
    openGraph: { title, description, type: "article", url: `${SITE_URL}/d/${d.id}`, siteName: copy.site.title },
    twitter: { card: "summary", title, description },
  };
}

export default async function DispenserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getDispenser(id).catch(() => null);
  if (!d) notFound();

  const { counter, listing, live } = d;
  const divisible = counter.divisible === 1;
  const t = copy.dispenser;

  const status = live ? live.status : DISPENSER_OPEN; // a listing exists only while open
  const open = status === DISPENSER_OPEN || status === DISPENSER_CLOSING;
  const statusWord =
    status === DISPENSER_CLOSED ? t.status.closed : status === DISPENSER_CLOSING ? t.status.closing : t.status.open;

  const price = listing?.price ?? (live ? unitPrice(live.satoshirate, true, live.give_quantity, divisible) : null);
  const remaining = live?.give_remaining ?? listing?.remaining ?? null;
  const lot = live ? dispenseTerms(live, 1) : null;
  const address = live?.source ?? listing?.source ?? null;
  const operator = live?.origin ?? listing?.source ?? null;

  const buyable = open && live !== null && lot !== null && !live.oracle_address;
  const perKb = pricePerKb(price, circulatingSupply(counter.supply ?? 0, counter.burned), divisible, counter.asset_bytes ?? counter.size);

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-8 py-10 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Link href={`/c/${counter.number}`} className="holo-border hover-pop block min-w-0 overflow-hidden rounded-2xl">
            <div className="counter-stage aspect-square">
              <CounterContent
                number={counter.number}
                asset={counter.asset}
                contentType={counter.content_type}
                size={counter.size}
                isPointerLike={false}
                stampMime={counter.stamp_mime}
                body={counter.body}
                delegate={counter.delegate}
              />
            </div>
          </Link>
          <Link href={`/c/${counter.number}`} className="font-mono text-[11px] text-copper underline-offset-2 hover:underline">
            {t.counterLink(counter.number)} →
          </Link>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <div>
            <div className="mb-3 flex items-center gap-3">
              <Meter value={counter.number} size={22} />
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">{t.eyebrow}</span>
            </div>
            <h1 className="font-mono text-3xl font-semibold text-copper2">{counter.asset}</h1>
            <p className="mt-2 text-sm text-dim">
              {lot
                ? t.summary(fmtQty(lot.receive, divisible), counter.asset, `${fmtQty(lot.pay, true)} BTC`)
                : t.summaryListingOnly(fmtAsk(price, "BTC"), counter.asset)}
            </p>
          </div>

          <div className="rounded-2xl border border-line bg-card p-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
              <Figure label={t.figures.price} value={fmtAsk(price, "BTC")} />
              <Figure label={t.figures.perKb} value={fmtPerKb(perKb, "BTC")} tone={perKb === null ? "faint" : "ink"} />
              <Figure label={t.figures.remaining} value={`${fmtQty(remaining, divisible)} ${counter.asset}`} tone={remaining !== null && big(remaining) <= 0n ? "faint" : "ink"} />
              <Figure label={t.figures.dispensed} value={live ? `${live.dispense_count}×` : "—"} />
              <Figure label={t.figures.status} value={statusWord} tone={status === DISPENSER_OPEN ? "good" : status === DISPENSER_CLOSED ? "faint" : "ink"} />
            </div>
          </div>

          {status === DISPENSER_CLOSED && <p className="text-sm text-dim">{t.closed}</p>}
          {status === DISPENSER_CLOSING && <p className="text-sm text-gold">{t.closing}</p>}
          {open && live?.oracle_address && <p className="text-sm text-dim">{t.oracle}</p>}
          {open && !live && <p className="text-sm text-dim">{t.nodeAway}</p>}

          {buyable && address && (
            <BuyPanel
              dispenser={address}
              asset={counter.asset}
              divisible={divisible}
              giveQuantity={big(live.give_quantity).toString()}
              satoshirate={big(live.satoshirate).toString()}
              giveRemaining={live.give_remaining == null ? null : big(live.give_remaining).toString()}
            />
          )}

          <div className="rounded-2xl border border-line bg-card p-5">
            {address && <Fact label={t.facts.address} value={trunc(address, 12, 10)} href={mempoolAddressUrl(address)} />}
            {operator && operator !== address && <Fact label={t.facts.operator} value={trunc(operator, 12, 10)} href={mempoolAddressUrl(operator)} />}
            {lot && <Fact label={t.facts.lot} value={`${fmtQty(lot.receive, divisible)} ${counter.asset} for ${fmtQty(lot.pay, true)} BTC`} />}
            {live && <Fact label={t.facts.escrowed} value={`${fmtQty(live.escrow_quantity, divisible)} ${counter.asset}`} />}
            <Fact
              label={t.facts.opened}
              value={(live?.block_index ?? listing?.block_index ?? 0).toLocaleString("en-US") + (live?.block_time ? ` · ${fmtDate(live.block_time)}` : "")}
              href={mempoolBlockUrl(live?.block_index ?? listing?.block_index ?? 0)}
            />
            {live?.close_block_index != null && (
              <Fact label={t.facts.closed} value={live.close_block_index.toLocaleString("en-US")} href={mempoolBlockUrl(live.close_block_index)} />
            )}
            <Fact label={t.facts.hash} value={trunc(d.id, 12, 10)} href={mempoolTxUrl(d.id)} />
          </div>

          <p className="max-w-[52ch] text-xs text-faint">{t.note}</p>
          <a href={xcpAssetUrl(counter.asset)} target="_blank" rel="noreferrer" className="inline-block font-mono text-[11px] text-copper underline-offset-2 hover:underline">
            {copy.counter.offers.venue} →
          </a>
        </div>
      </div>
    </>
  );
}
