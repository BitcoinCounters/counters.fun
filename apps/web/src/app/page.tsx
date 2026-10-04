import Link from "next/link";
import { getHome, getStats, OFFERS_PAGE } from "@/lib/api";
import { DispenserCard, MintingCard, PooledCard, totalDepth } from "@/components/counter-card";
import { OrderRows } from "@/components/order-rows";
import { fmtCompact, fmtSize } from "@/lib/format";
import { SortSelect } from "@/components/sort-select";
import { VenueToggle } from "@/components/venue-toggle";
import { copy } from "@content/copy";

export const revalidate = 30;

/**
 * The home page.
 *
 * Ordered by what is true rather than by what would look busiest. The first
 * section is what can be bought, on one venue at a time: the pool leads
 * because it is the thing this site is about, and the DEX and dispensers are
 * a toggle away rather than stacked under it — they are weaker offers, one
 * person's stated quantity rather than a price consensus will honour at any
 * size. The DEX is a row per open order and the dispensers a card per open
 * dispenser, newest first, so a counter on several venues — or with several
 * offers on one — appears once for each; they are different offers on it,
 * not one listed three times. Under that, the launches on their way to a
 * consensus-seeded pool.
 */
const SORTS = copy.home.pooled.sort.options;
const DEFAULT_SORT = SORTS[0].value;

/** The first section's anchor, which the pager sends the reader back to. */
const LISTINGS_ID = "listings";

const VENUES = copy.home.venues.options;
type Venue = (typeof VENUES)[number]["value"];
const DEFAULT_VENUE = VENUES[0].value;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; venue?: string; page?: string }>;
}) {
  // Anything unrecognised falls back rather than 404s: ?sort=, ?venue= and
  // ?page= are things people edit by hand, and the listing is still correct
  // under the default.
  const { sort: requested, venue: requestedVenue, page: requestedPage } = await searchParams;
  const sort = SORTS.some((o) => o.value === requested) ? requested! : DEFAULT_SORT;
  const venue: Venue = VENUES.find((o) => o.value === requestedVenue)?.value ?? DEFAULT_VENUE;
  // The pool is one list; only the offer venues have pages.
  const page = venue === "pool" ? 1 : Math.min(2_000, Math.max(1, Math.trunc(Number(requestedPage)) || 1));

  const [home, stats] = await Promise.all([
    getHome(sort, (page - 1) * OFFERS_PAGE),
    getStats(),
  ]);

  const counts: Record<Venue, number> = home.counts;

  // Defaults stay out of the URL, so the plain home page is still `/`. The
  // sort rides along under the other venues, where it does nothing, so that
  // coming back to the pool finds it as it was left. The page does not ride
  // along: page three of the DEX is not page three of anything else.
  const venueHref = (next: Venue, nextPage = 1) => {
    const query = new URLSearchParams();
    if (next !== DEFAULT_VENUE) query.set("venue", next);
    if (sort !== DEFAULT_SORT) query.set("sort", sort);
    if (nextPage > 1) query.set("page", String(nextPage));
    return query.size > 0 ? `/?${query}` : "/";
  };

  const toggle = (
    <VenueToggle
      label={copy.home.venues.label}
      value={venue}
      options={VENUES.map((o) => ({ ...o, count: counts[o.value], href: venueHref(o.value) }))}
    />
  );

  const offers = venue === "dex" ? home.dex : home.dispensers;
  const offersCopy = venue === "dex" ? copy.home.dex : copy.home.dispensers;
  const total = venue === "pool" ? 0 : counts[venue];

  return (
    <>
      {/* One line: what is on Bitcoin, and the block. The prices and the
          search live in the header, the same on every page; the introduction
          lives behind "about" there too. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-4 pb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
        <span className="whitespace-nowrap">
          <span className="text-[13px] font-semibold tracking-normal text-ink">{fmtSize(stats.bytes_on_chain)}</span> {copy.home.stats.bytes}
        </span>
        <span className="text-line">·</span>
        <span className="whitespace-nowrap">
          {copy.home.chainLine} <span className="text-[13px] font-semibold tracking-normal text-ink">{stats.tip.toLocaleString("en-US")}</span>
        </span>
      </div>

      {venue === "pool" ? (
        <Section
          id={LISTINGS_ID}
          eyebrow={copy.home.listingsEyebrow}
          title={copy.home.pooled.title}
          toolbar={toggle}
          control={
            home.pooled.length > 1 ? (
              <SortSelect
                options={SORTS}
                value={sort}
                label={copy.home.pooled.sort.label}
              />
            ) : undefined
          }
          meta={
            home.pooled.length > 0
              ? copy.home.pooled.meta(fmtCompact(totalDepth(home.pooled)))
              : undefined
          }
        >
          {home.pooled.length === 0 ? (
            <Empty>
              {copy.home.pooled.empty}{" "}
              <Link href="/pool/create" className="text-copper underline-offset-2 hover:underline">
                {copy.home.pooled.emptyLink}
              </Link>{" "}
              {copy.home.pooled.emptyAfter}
            </Empty>
          ) : (
            <Grid>
              {home.pooled.map((c) => (
                <PooledCard key={c.number} counter={c} />
              ))}
            </Grid>
          )}
        </Section>
      ) : (
        <Section
          id={LISTINGS_ID}
          eyebrow={copy.home.listingsEyebrow}
          title={offersCopy.title}
          toolbar={toggle}
        >
          {offers.length === 0 ? (
            <Empty>{offersCopy.empty}</Empty>
          ) : venue === "dex" ? (
            <OrderRows offers={offers} />
          ) : (
            <Grid>
              {offers.map((o) => (
                <DispenserCard key={`${o.offer_id}:${o.number}`} offer={o} />
              ))}
            </Grid>
          )}
          {total > OFFERS_PAGE && (
            <Pager
              page={page}
              shown={offers.length}
              total={total}
              href={(n) => `${venueHref(venue, n)}#${LISTINGS_ID}`}
            />
          )}
        </Section>
      )}

      {home.minting.length > 0 && (
        <Section
          title={copy.home.minting.title}
          meta={copy.home.minting.meta}
        >
          <Grid>
            {home.minting.map((c) => (
              <MintingCard key={c.number} counter={c} tip={stats.tip} />
            ))}
          </Grid>
        </Section>
      )}
    </>
  );
}

function Section({
  id,
  title,
  meta,
  eyebrow,
  control,
  toolbar,
  children,
}: {
  id?: string;
  title: string;
  meta?: string;
  /** Labels the run of sections that follows, not just this one — so it is
   *  passed to the first section only, and sits in its header's top margin
   *  rather than opening a band of its own. */
  eyebrow?: string;
  /** A control for this section's listing, right-aligned before the meta. */
  control?: React.ReactNode;
  /** A row of its own above the heading — the venue toggle. The choice comes
   *  first and the heading under it names what was chosen. */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4">
      <div className="mb-4 mt-12">
        {eyebrow && (
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.22em] text-copper">
            {eyebrow}
          </p>
        )}
        {toolbar && <div className="mb-4 flex">{toolbar}</div>}
        {/* items-center rather than items-baseline once a control is in the
            row: a bordered box has no baseline worth aligning to, and hanging
            it off the heading's would sit it low. */}
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <h2 className="font-mono text-sm font-semibold uppercase tracking-[0.14em]">{title}</h2>
          <span className="hidden h-px flex-1 bg-line sm:block" />
          {control}
          {meta && <span className="font-mono text-xs text-faint">{meta}</span>}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * Newer / older under a venue that runs past one page. Links, like the venue
 * toggle and for the same reasons: the page is in the URL, the server does
 * the paging, and a page of the order book is something somebody can send.
 *
 * Unlike the toggle these do move the reader — to the top of the listing,
 * by its id. The control is under fifty rows, and staying put would open the
 * next page at its last one.
 */
function Pager({
  page,
  shown,
  total,
  href,
}: {
  page: number;
  shown: number;
  total: number;
  href: (page: number) => string;
}) {
  const from = (page - 1) * OFFERS_PAGE + 1;
  const to = from + shown - 1;
  const link =
    "rounded-lg border border-line bg-bg2 px-2.5 py-1 text-dim transition-colors hover:border-copper hover:text-ink";

  return (
    <nav className="mt-4 flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.08em]">
      {page > 1 ? (
        <Link href={href(page - 1)} className={link}>
          {copy.home.venues.pager.newer}
        </Link>
      ) : (
        <span />
      )}
      <span className="text-faint">{shown > 0 && copy.home.venues.pager.range(from, to, total)}</span>
      {shown === OFFERS_PAGE && to < total ? (
        <Link href={href(page + 1)} className={link}>
          {copy.home.venues.pager.older}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-4">{children}</div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-card/40 p-8 text-center text-sm text-dim">
      {children}
    </div>
  );
}
