import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { renderMode } from "@counters/core/counter";
import { getCounter, getPool, isDisplayable } from "@/lib/api";
import { copy } from "@content/copy";
import { CounterContent } from "@/components/counter-content";
import { SwapPanel } from "@/components/swap-panel";
import { LaunchpadTag } from "@/components/launchpad-tag";
import { Meter } from "@/components/meter";
import {
  fmtCompact,
  fmtDate,
  fmtPct,
  fmtPrice,
  fmtQty,
  fmtSize,
  pctChange,
  shortMime,
  trunc,
} from "@/lib/format";
import {
  BURN_ADDRESS,
  XCP_POOL_FEE_BPS,
  SITE_URL,
  contentUrl,
  countersExplorerUrl,
  mempoolBlockUrl,
  mempoolTxUrl,
  stampUrl,
} from "@/lib/constants";
import { big } from "@counters/core/numeric";

export const revalidate = 30;

/**
 * What a shared link to this counter looks like in a chat client.
 *
 * The picture is the counter's own bytes wherever they can be one. That is
 * the site's whole claim made visible in a place people actually look: the
 * image in the preview is served from `/content` or `/stamp`, which is to say
 * out of a Bitcoin block, not from a render farm that made a card about it.
 *
 * `renderMode` decides, rather than a second list of MIME types here. It
 * already knows which counters are a raster image and which are a program,
 * and its `image` and `stamp` modes are exactly the ones a crawler can
 * display — HTML, JavaScript, SVG and PDF counters have no still frame to
 * offer, so they fall back to the site card. SVG is in that group on purpose:
 * it renders as markup, and no crawler will take it as og:image.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const counter = await getCounter(id).catch(() => null);
  if (!counter) return {};

  const title = copy.site.counter.title(counter.number, counter.asset);
  const alt = copy.site.counter.imageAlt(counter.number, counter.asset);

  if (!isDisplayable(counter)) {
    // The site card rather than nothing: a preview with no image at all reads
    // as a broken link, and this counter is neither broken nor absent — it is
    // real, numbered, and deliberately not rendered.
    const pointer = copy.site.counter.pointer(counter.asset);
    return {
      title,
      description: pointer,
      openGraph: {
        title,
        description: pointer,
        type: "article",
        url: `${SITE_URL}/c/${counter.number}`,
        siteName: copy.site.title,
        images: [{ url: "/og.png", alt: copy.site.ogImageAlt }],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description: pointer,
        images: [{ url: "/og.png", alt: copy.site.ogImageAlt }],
      },
    };
  }

  const mode = renderMode({
    is_pointer_like: counter.is_pointer_like === 1,
    size: counter.size,
    content_type: counter.content_type,
    stamp_mime: counter.stamp_mime,
  });
  const image =
    mode === "stamp"
      ? stampUrl(counter.number)
      : mode === "image"
        ? contentUrl(counter.number)
        : "/og.png";
  const ownArt = image !== "/og.png";

  const description = counter.pool
    ? copy.site.counter.pooled(
        counter.asset,
        fmtPrice(counter.pool.price),
        fmtCompact(
          counter.pool.asset_b === "XCP" ? counter.pool.reserve_b : counter.pool.reserve_a,
        ),
        fmtSize(counter.size),
        shortMime(counter.content_type),
      )
    : copy.site.counter.unpooled(
        counter.asset,
        fmtSize(counter.size),
        shortMime(counter.content_type),
        counter.block.toLocaleString("en-US"),
      );

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      url: `${SITE_URL}/c/${counter.number}`,
      siteName: copy.site.title,
      images: [{ url: image, alt: ownArt ? alt : copy.site.ogImageAlt }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: image, alt: ownArt ? alt : copy.site.ogImageAlt }],
    },
  };
}

export default async function CounterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const counter = await getCounter(id).catch(() => null);
  if (!counter) notFound();

  // A pointer-like counter is real and numbered — it is just not something
  // this site will render. Saying that plainly is more useful than a 404 that
  // implies the counter does not exist.
  if (!isDisplayable(counter)) return <PointerPage counter={counter} />;

  const pool = counter.pool ? await getPool(String(counter.number)).catch(() => null) : null;
  const change = pctChange(counter.pool?.price ?? null, counter.pool?.price_24h_ago ?? null);

  return (
    <>
      {/* minmax(0, …) on every column, including the single one below lg:
          a grid column's default minimum is its content's min-content width,
          and a counter's body can be one unbroken 60 KB line. */}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-8 py-10 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="holo-border min-w-0 overflow-hidden rounded-2xl">
          <div className="counter-stage aspect-square">
            <CounterContent
              number={counter.number}
              asset={counter.asset}
              contentType={counter.content_type}
              size={counter.size}
              isPointerLike={false}
              stampMime={counter.stamp_mime}
              body={counter.body}
              interactive
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <div>
            <div className="mb-3 flex items-center gap-3">
              <Meter value={counter.number} size={22} />
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
                {counter.kind}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-mono text-3xl font-semibold text-copper2">{counter.asset}</h1>
              <LaunchpadTag counter={counter} size="md" />
            </div>
            <p className="mt-2 text-sm text-dim">
              {fmtSize(counter.size)} of {shortMime(counter.content_type)} in Bitcoin witness data,
              block {counter.block.toLocaleString("en-US")}.
            </p>
          </div>

          {pool ? (
            <PoolPanel pool={pool} change={change} asset={counter.asset} divisible={counter.divisible === 1} />
          ) : (
            <NoPoolPanel asset={counter.asset} />
          )}

          <Facts
            rows={[
              ["supply", fmtQty(counter.supply, counter.divisible === 1)],
              ["divisible", counter.divisible === 1 ? "yes" : "no"],
              ["locked", counter.locked === 1 ? "yes" : "no"],
              ["owner", trunc(counter.owner, 10, 8)],
            ]}
          />
        </div>
      </div>

      <Provenance counter={counter} />

      {counter.siblings.length > 1 && (
        <section className="mt-10">
          <SectionHead title="Reinscriptions" meta={`${counter.siblings.length} on this asset`} />
          <p className="mb-4 max-w-[62ch] text-sm text-dim">
            One asset can carry many counters. Each reinscription earns its own permanent number;
            the lowest is the original. Nothing is renumbered, ever.
          </p>
          <div className="flex flex-wrap gap-2">
            {counter.siblings.map((s) => (
              <Link
                key={s.number}
                href={`/c/${s.number}`}
                className={`rounded-xl border px-3 py-2 font-mono text-xs transition-colors ${
                  s.number === counter.number
                    ? "border-copper text-copper"
                    : "border-line text-dim hover:border-copper hover:text-ink"
                }`}
              >
                #{s.number} · {shortMime(s.content_type)} · {fmtSize(s.size)}
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/* -------------------------------------------------------------------- */

function PoolPanel({
  pool,
  change,
  asset,
  divisible,
}: {
  pool: NonNullable<Awaited<ReturnType<typeof getPool>>>;
  change: number | null;
  asset: string;
  divisible: boolean;
}) {
  const depth = pool.asset_b === "XCP" ? pool.reserve_b : pool.reserve_a;
  const tokens = pool.asset_b === "XCP" ? pool.reserve_a : pool.reserve_b;

  const supply = big(pool.lp_supply);
  const locked = big(pool.lp_locked);
  const lockedPct = supply > 0n ? Number((locked * 10_000n) / supply) / 100 : 0;

  return (
    <div className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
          {pool.asset_a}/{pool.asset_b} pool
        </span>
        <span className="font-mono text-[11px] text-faint">{XCP_POOL_FEE_BPS} bps</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Figure label="price" value={`${fmtPrice(pool.price)} XCP`} />
        <Figure
          label="24h"
          value={fmtPct(change)}
          tone={change === null ? "faint" : change >= 0 ? "good" : "bad"}
        />
        <Figure label="depth" value={`${fmtCompact(depth)} XCP`} />
        {/* The token side in the token's own units — an indivisible counter's
            raw reserve IS its unit count. */}
        <Figure label="reserve" value={fmtCompact(tokens, divisible)} />
      </div>

      {/*
        "Liquidity locked" is a claim every launchpad makes. This one is
        checkable: the LP token is an ordinary Counterparty asset, and the
        share of its supply sitting at the unspendable address is the whole
        proof. Showing the number rather than a padlock is the difference
        between a guarantee and a logo.
      */}
      <div className="mt-5 border-t border-line2 pt-4">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
            liquidity locked
          </span>
          <span
            className={`font-mono text-xs ${pool.fully_locked ? "text-patina" : "text-gold"}`}
          >
            {lockedPct.toFixed(1)}%
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-line2">
          <div
            className={`h-full rounded-full ${pool.fully_locked ? "bg-patina" : "bg-gold"}`}
            style={{ width: `${Math.min(100, lockedPct)}%` }}
          />
        </div>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-faint">
          {fmtCompact(locked)} of {fmtCompact(supply)} {pool.lp_asset} at {trunc(BURN_ADDRESS, 14, 6)}
          {pool.fully_locked
            ? " — every LP token is unspendable."
            : " — the remainder can be withdrawn by whoever holds it."}
        </p>
      </div>

      <SwapPanel asset={asset} divisible={divisible} />

      <div className="mt-5 flex gap-2">
        <Link
          href={`/pool/create?asset=${encodeURIComponent(asset)}`}
          className="flex-1 rounded-xl border border-copper bg-copper-ghost px-4 py-2.5 text-center font-mono text-xs uppercase tracking-[0.1em] text-copper2 transition-colors hover:bg-copper hover:text-bg"
        >
          add liquidity
        </Link>
      </div>
    </div>
  );
}

function NoPoolPanel({ asset }: { asset: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-card/40 p-5">
      <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-faint">no pool</p>
      <p className="mb-4 max-w-[52ch] text-sm text-dim">
        Nobody has opened an XCP pool for this counter. The first deposit sets the price — there is
        no ratio to match until one exists.
      </p>
      <Link
        href={`/pool/create?asset=${encodeURIComponent(asset)}`}
        className="inline-block rounded-xl border border-copper bg-copper-ghost px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-copper2 transition-colors hover:bg-copper hover:text-bg"
      >
        create the pool
      </Link>
    </div>
  );
}

/**
 * What makes a counter a counter. None of this is metadata about the file —
 * it is the file's position in Bitcoin, which is the whole claim the protocol
 * makes.
 */
function Provenance({ counter }: { counter: Extract<Awaited<ReturnType<typeof getCounter>>, { displayable: true }> }) {
  return (
    <section className="mt-10">
      <SectionHead title="Provenance" meta="verifiable against the chain" />
      <div className="grid gap-x-8 gap-y-0 rounded-2xl border border-line bg-card p-5 sm:grid-cols-2">
        <Fact label="counter number" value={String(counter.number)} />
        <Fact label="content sha256" value={counter.sha256 ?? "—"} mono />
        <Fact
          label="reveal tx"
          value={trunc(counter.txid, 12, 10)}
          href={mempoolTxUrl(counter.txid)}
        />
        <Fact
          label="block"
          value={counter.block.toLocaleString("en-US")}
          href={mempoolBlockUrl(counter.block)}
        />
        <Fact label="position in block" value={String(counter.tx_index)} />
        <Fact label="inscribed" value={fmtDate(counter.block_time)} />
        <Fact label="reveal size" value={counter.tx_size ? fmtSize(counter.tx_size) : "—"} />
        <Fact
          label="miner fee"
          value={counter.fee ? `${counter.fee.toLocaleString("en-US")} sat` : "—"}
        />
        {/* The rolling hash chains every counter to every counter before it:
            change one and every number after it stops verifying. */}
        <Fact label="rolling hash" value={counter.rolling_hash ?? "—"} mono />
        <Fact
          label="protocol record"
          value={`bitcoincounters.com/c/${counter.number}`}
          href={countersExplorerUrl(counter.number)}
        />
      </div>
    </section>
  );
}

function PointerPage({
  counter,
}: {
  counter: Extract<Awaited<ReturnType<typeof getCounter>>, { displayable: false }>;
}) {
  return (
    <div className="mx-auto max-w-[62ch] py-20">
      <div className="mb-4 flex items-center gap-3">
        <Meter value={counter.number} size={22} />
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
          off-chain pointer
        </span>
      </div>
      <h1 className="mb-4 font-mono text-3xl font-semibold text-dim">{counter.asset}</h1>
      <p className="mb-5 text-dim">
        Counter #{counter.number} is real, numbered and permanent. Its description is not a file —
        it is an address somewhere else, so there is nothing in Bitcoin to show you.
      </p>
      <div className="mb-5 rounded-xl border border-line bg-card p-4">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
          what was inscribed
        </div>
        {/* Shown as text, deliberately not a link. Following it is the one
            thing this site does not do. */}
        <code className="block break-all font-mono text-xs text-dim">
          {counter.description ?? "(empty)"}
        </code>
      </div>
      <p className="text-sm text-faint">
        counters.fun does not fetch it. Ninety-eight of the index&rsquo;s counters are pointers like
        this one; the{" "}
        <Link href="/" className="text-copper underline-offset-2 hover:underline">
          seventy that are files
        </Link>{" "}
        are what this site is for.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------- */

function SectionHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="mb-4 flex items-baseline gap-3.5">
      <h2 className="font-mono text-sm font-semibold uppercase tracking-[0.14em]">{title}</h2>
      <span className="h-px flex-1 bg-line" />
      {meta && <span className="font-mono text-xs text-faint">{meta}</span>}
    </div>
  );
}

function Figure({
  label,
  value,
  tone = "ink",
}: {
  label: string;
  value: string;
  tone?: "ink" | "good" | "bad" | "faint";
}) {
  const color =
    tone === "good" ? "text-patina" : tone === "bad" ? "text-bad" : tone === "faint" ? "text-faint" : "text-ink";
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        {label}
      </div>
      <div className={`font-mono text-lg ${color}`}>{value}</div>
    </div>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-5">
      {rows.map(([label, value]) => (
        <Fact key={label} label={label} value={value} />
      ))}
    </div>
  );
}

function Fact({
  label,
  value,
  href,
  mono = false,
}: {
  label: string;
  value: string;
  href?: string;
  mono?: boolean;
}) {
  const body = (
    <span className={`${mono ? "break-all font-mono text-[11px]" : "font-mono text-xs"} text-ink`}>
      {value}
    </span>
  );
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line2 py-2 last:border-0">
      <span className="flex-shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
        {label}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-right underline-offset-2 hover:underline"
        >
          {body}
        </a>
      ) : (
        <span className="text-right">{body}</span>
      )}
    </div>
  );
}
