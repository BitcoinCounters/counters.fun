import Link from "next/link";
import { renderMode } from "@counters/core/counter";
import type { Offer } from "@/lib/api";
import { contentUrl, stampUrl } from "@/lib/constants";
import { fmtAsk, fmtCompact, mimeTag, shortMime } from "@/lib/format";
import { Meter } from "@/components/meter";
import { rendered } from "@/components/counter-content";
import { copy } from "@content/copy";

/**
 * The DEX venue: one row per open order.
 *
 * Rows rather than tiles because an order book is a list to scan, not a
 * gallery to browse. A tile is mostly the counter's picture, and the DEX has
 * hundreds of orders that differ only in the line under it — 268 of them are
 * a RARE.PEPE.N offered for one RARE.PEPE — so as tiles the venue was the
 * same square of JSON repeated down the page with the one number that
 * mattered in 11px beneath each.
 *
 * Every price carries its unit, as on a card: an order is priced in whatever
 * its maker chose, and nothing here converts between them.
 */
export function OrderRows({ offers }: { offers: Offer[] }) {
  const columns = copy.home.dex.columns;

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card">
      <div className={`${GRID} border-b border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-faint`}>
        <span className="col-span-2">{columns.counter}</span>
        <span>{columns.side}</span>
        <span className="text-right">{columns.price}</span>
        <span className="hidden text-right sm:block">{columns.amount}</span>
        <span className="hidden text-right md:block">{columns.block}</span>
      </div>

      {offers.map((offer) => (
        <Link
          // One order can sit on two counters, so its hash alone is not a key.
          key={`${offer.offer_id}:${offer.number}`}
          href={`/c/${offer.number}`}
          className={`${GRID} border-b border-line2 px-3 py-2 transition-colors last:border-b-0 hover:bg-card-hover`}
        >
          <Thumb offer={offer} />
          <span className="flex min-w-0 items-center gap-2">
            <Meter value={offer.number} size={11} />
            <span className="truncate font-mono text-[13px] text-copper2">{offer.asset}</span>
            {offer.has_pool === 1 && (
              <span className="hidden shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-patina lg:inline">
                {copy.home.alsoPooled}
              </span>
            )}
          </span>
          <span
            className={`font-mono text-[10px] uppercase tracking-wider ${
              offer.offer_side === "ask" ? "text-copper" : "text-patina"
            }`}
          >
            {offer.offer_side === "ask" ? columns.ask : columns.bid}
          </span>
          <span className="truncate text-right font-mono text-[12px] text-ink">
            {fmtAsk(offer.offer_price, offer.offer_asset)}
          </span>
          <span className="hidden text-right font-mono text-[11px] text-dim sm:block">
            {fmtCompact(offer.offer_remaining, offer.divisible === 1)}
          </span>
          <span className="hidden text-right font-mono text-[11px] text-faint md:block">
            {offer.offer_block.toLocaleString("en-US")}
          </span>
        </Link>
      ))}
    </div>
  );
}

/** Thumb, counter, side, price — then amount from `sm` and block from `md`. */
const GRID =
  "grid items-center gap-3 grid-cols-[32px_minmax(0,1fr)_32px_minmax(0,0.9fr)] sm:grid-cols-[32px_minmax(0,1.3fr)_40px_minmax(0,1fr)_minmax(0,0.6fr)] md:grid-cols-[32px_minmax(0,1.3fr)_40px_minmax(0,1fr)_minmax(0,0.6fr)_72px]";

/**
 * A row's picture.
 *
 * An image is an `<img>`. An SVG is a frame, because here an SVG is a script
 * host and gets the same sandbox it has everywhere else on the site — and it
 * is the case that matters: every RARE.PEPE edition is a delegate of one SVG,
 * and without its picture the DEX is three hundred rows that say JSON. The
 * frame is lazy, so a row draws its file when it is near the screen rather
 * than fifty copies of a four-megabyte document loading for a page nobody
 * has scrolled. Anything else — HTML, JavaScript, text — has nothing to show
 * at 32px and gets the format's name.
 */
function Thumb({ offer }: { offer: Offer }) {
  const shown = rendered({
    number: offer.number,
    contentType: offer.content_type,
    size: offer.size,
    stampMime: offer.stamp_mime,
    delegate: offer.delegate,
  });
  const mode = renderMode({
    is_pointer_like: offer.is_pointer_like === 1,
    size: shown.size,
    content_type: shown.contentType,
    stamp_mime: shown.stampMime,
  });
  const box = "h-8 w-8 shrink-0 overflow-hidden rounded-md border border-line2 bg-bg2";

  if (mode === "image" || mode === "stamp") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- as in
      // CounterContent: these bytes are immutable and already cached, and
      // their exact pixels are the point.
      <img
        src={mode === "stamp" ? stampUrl(shown.number) : `${contentUrl(shown.number)}${shown.fragment}`}
        alt=""
        loading="lazy"
        decoding="async"
        className={`${box} object-cover [image-rendering:pixelated]`}
      />
    );
  }
  if (mode === "sandbox" && shortMime(shown.contentType) === "image/svg+xml") {
    return (
      <iframe
        src={`${contentUrl(shown.number)}${shown.fragment}`}
        title=""
        aria-hidden
        tabIndex={-1}
        loading="lazy"
        sandbox="allow-scripts"
        style={{ pointerEvents: "none" }}
        className={box}
      />
    );
  }
  return (
    <span className={`${box} flex items-center justify-center font-mono text-[7.5px] uppercase text-faint`}>
      {/* Four letters is what fits: JSON, HTML, and JAVA for the rest. */}
      {mimeTag(shown.contentType).slice(0, 4)}
    </span>
  );
}
