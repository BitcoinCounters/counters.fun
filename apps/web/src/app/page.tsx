import Link from "next/link";
import { getHome, getStats } from "@/lib/api";
import { MintingCard, PooledCard, UnpooledCard, totalDepth } from "@/components/counter-card";
import { fmtCompact, fmtSize } from "@/lib/format";
import { PriceTicker } from "@/components/price-ticker";
import { SearchBox } from "@/components/search-box";
import { copy } from "@content/copy";

export const revalidate = 30;

/**
 * The home page.
 *
 * Ordered by what is true rather than by what would look busiest. Pooled
 * counters lead because they are the thing this site is about; there is one
 * of them today, and padding that section with off-chain launches to make it
 * look fuller would break the only promise the site makes. The sections under
 * it are where the first section comes from — launches on their way to a
 * consensus-seeded pool, and on-chain counters one deposit away from one.
 */
export default async function HomePage() {
  const [home, stats] = await Promise.all([getHome(), getStats()]);

  return (
    <>
      {/* One line: the prices, what is on Bitcoin, and the block. The
          introduction lives behind "about" in the header. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-4 font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
        <span className="whitespace-nowrap">
          <span className="text-[13px] font-semibold tracking-normal text-ink">{fmtSize(stats.bytes_on_chain)}</span> {copy.home.stats.bytes}
        </span>
        <span className="text-line">·</span>
        <span className="whitespace-nowrap">
          {copy.home.chainLine} <span className="text-[13px] font-semibold tracking-normal text-ink">{stats.tip.toLocaleString("en-US")}</span>
        </span>
        <span className="ml-auto">
          <PriceTicker placement="row" />
        </span>
      </div>

      <div className="border-b border-line py-3">
        <SearchBox wide />
      </div>

      <Section
        title={copy.home.pooled.title}
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

      {/* Collapsed by default: the header and count stay visible, the grid
          is a click away. Sixty-odd cards under one pool would otherwise
          make the page look like it is about the wrong thing. */}
      <CollapsibleSection
        title={copy.home.unpooled.title}
        meta={copy.home.unpooled.meta(home.unpooled.length)}
      >
        <Grid>
          {home.unpooled.map((c) => (
            <UnpooledCard key={c.number} counter={c} />
          ))}
        </Grid>
      </CollapsibleSection>
    </>
  );
}

function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 mt-12 flex items-baseline gap-3.5">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-[0.14em]">{title}</h2>
        <span className="h-px flex-1 bg-line" />
        {meta && <span className="font-mono text-xs text-faint">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * A Section that starts closed. Native <details> so the page stays a server
 * component and the state survives without JavaScript; the marker is drawn
 * by hand so the header lines up with the sections above it.
 */
function CollapsibleSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group">
      <summary className="mb-4 mt-12 flex cursor-pointer list-none items-baseline gap-3.5 select-none [&::-webkit-details-marker]:hidden">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-[0.14em]">{title}</h2>
        <span className="h-px flex-1 bg-line" />
        {meta && <span className="font-mono text-xs text-faint">{meta}</span>}
        <span
          aria-hidden
          className="font-mono text-xs text-faint transition-transform group-open:rotate-90"
        >
          ›
        </span>
      </summary>
      {children}
    </details>
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
