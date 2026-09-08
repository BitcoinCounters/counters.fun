import Link from "next/link";
import { getHome, getStats } from "@/lib/api";
import { MintingCard, PooledCard, UnpooledCard, totalDepth } from "@/components/counter-card";
import { Meter } from "@/components/meter";
import { fmtCompact, fmtSize } from "@/lib/format";
import { copy } from "@content/copy";
import { fill } from "@content/fill";

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
  const chain = copy.home.chainLine(stats.counters_total - stats.counters_on_chain);

  return (
    <>
      <section className="border-b border-line py-14">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.22em] text-copper">
          {copy.home.eyebrow}
        </p>
        <h1 className="mb-2 max-w-[20ch] font-mono text-[clamp(26px,4.4vw,40px)] font-semibold leading-[1.12] tracking-[-0.01em]">
          {copy.home.headline} <span className="text-dim">{copy.home.headlineDim}</span>
        </h1>
        <p className="mb-9 max-w-[58ch] text-base text-dim">{fill(copy.home.lede)}</p>

        <div className="flex flex-wrap items-end gap-9">
          <Stat label={copy.home.stats.pooled} value={stats.pooled} accent />
          <Stat label={copy.home.stats.minting} value={stats.minting} />
          <Stat label={copy.home.stats.onChain} value={stats.counters_on_chain} />
          <div>
            <div className="font-mono text-[26px] font-semibold text-ink">
              {fmtSize(stats.bytes_on_chain)}
            </div>
            <div className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
              {copy.home.stats.bytes}
            </div>
          </div>
        </div>

        <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
          {chain.before} <span className="text-dim">{stats.tip.toLocaleString("en-US")}</span>
          <span className="mx-2 text-line">·</span>
          {/* The index holds more counters than it shows. Saying so is more
              honest than quietly presenting the filtered count as the total. */}
          <span className="text-dim">{chain.middle}</span> {chain.after}
        </p>
      </section>

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

      <Section title={copy.home.unpooled.title} meta={copy.home.unpooled.meta(home.unpooled.length)}>
        <Grid>
          {home.unpooled.map((c) => (
            <UnpooledCard key={c.number} counter={c} />
          ))}
        </Grid>
      </Section>
    </>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <Meter value={value} size={26} />
      <div
        className={`mt-1.5 font-mono text-[11px] uppercase tracking-[0.16em] ${
          accent ? "text-copper" : "text-faint"
        }`}
      >
        {label}
      </div>
    </div>
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
