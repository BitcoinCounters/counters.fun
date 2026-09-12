import Link from "next/link";
import { circulatingSupply, sizeBadge } from "@counters/core/counter";
import { marketCap } from "@counters/core/pool";
import type { CounterRow, MintingCounter, PooledCounter } from "@/lib/api";
import { fmtBlocks, fmtCompact, fmtPct, fmtPrice, fmtSize, mimeTag, pctChange } from "@/lib/format";
import { CounterContent } from "@/components/counter-content";
import { LaunchpadTag } from "@/components/launchpad-tag";
import { Meter } from "@/components/meter";
import { mintProgress } from "@counters/core/fairminter";
import { big } from "@counters/core/numeric";

/**
 * The card. One shape across all three home-page sections, because they are
 * the same object in different states — a counter, on its way to having a
 * pool, or with one.
 *
 * The whole tile carries `holo-border`: every counter that reaches this
 * component has already passed the on-chain filter in the API's SQL, so the
 * badge marks a property that is true of all of them and cannot be applied to
 * the 98 pointer counters the index also holds.
 */

function Shell({
  counter,
  children,
}: {
  counter: CounterRow;
  children: React.ReactNode;
}) {
  const badge = sizeBadge(counter.size);

  return (
    <Link
      href={`/c/${counter.number}`}
      className="holo-border hover-pop group flex flex-col overflow-hidden rounded-2xl"
    >
      <div className="counter-stage aspect-square border-b border-line2 bg-bg2">
        <CounterContent
          number={counter.number}
          asset={counter.asset}
          contentType={counter.content_type}
          size={counter.size}
          isPointerLike={counter.is_pointer_like === 1}
          stampMime={counter.stamp_mime}
          body={counter.body}
        />
        <span className="absolute right-2 top-2 rounded-md border border-line bg-black/60 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-dim">
          {/* The badge labels the tile under it, so a stamp reads GIF rather
              than PLAIN. The counter's own `text/plain` is not hidden — the
              detail page still states what the witness actually holds. */}
          {mimeTag(counter.stamp_mime ?? counter.content_type)}
        </span>
        {badge && (
          <span className="absolute left-2 top-2 rounded-md border border-gold/40 bg-black/60 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-gold">
            {badge}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <Meter value={counter.number} size={13} />
          <span className="font-mono text-[10px] text-faint">{fmtSize(counter.size)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[13px] text-copper2">{counter.asset}</span>
          <LaunchpadTag counter={counter} />
        </div>
        {children}
      </div>
    </Link>
  );
}

/** A counter with a live XCP pool. */
export function PooledCard({ counter }: { counter: PooledCounter }) {
  const change = pctChange(counter.price, counter.price_24h_ago);
  // The XCP side of the pair — how much real liquidity is behind it. Both
  // sides are worth the same at the pool's own price, so this is half the
  // pool and the honest half to quote: it is the side you are paid in.
  const liquidity = counter.asset_b === "XCP" ? counter.reserve_b : counter.reserve_a;
  const mcap = marketCap(
    counter.price,
    circulatingSupply(counter.supply ?? 0, counter.burned),
    counter.divisible !== 0,
  );

  return (
    <Shell counter={counter}>
      <div className="flex items-baseline justify-between gap-2 border-t border-line2 pt-2">
        <span className="font-mono text-[11px] text-dim">{fmtPrice(counter.price)} XCP</span>
        <span
          className={`font-mono text-[11px] ${
            change === null ? "text-faint" : change >= 0 ? "text-patina" : "text-bad"
          }`}
        >
          {/* No baseline yet reads as "—", not as 0% — a new pool has not been
              flat, it has no history. */}
          {fmtPct(change)}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">liquidity</span>
        <span className="font-mono text-[11px] text-ink">{fmtCompact(liquidity)} XCP</span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">marketcap</span>
        {/* Back to raw so both rows go through the same formatter and line up
            in the same units; marketCap returns whole XCP. */}
        <span className="font-mono text-[11px] text-ink">
          {mcap === null ? "—" : `${fmtCompact(Math.round(mcap * 1e8))} XCP`}
        </span>
      </div>
    </Shell>
  );
}

/**
 * A launch in flight. The progress bar is the soft cap, which for a pool
 * fairminter is the whole public sale: reaching it *is* selling out, and
 * consensus opens the pool in the same block.
 */
export function MintingCard({ counter, tip }: { counter: MintingCounter; tip: number }) {
  const progress = mintProgress({
    earned_quantity: counter.earned_quantity,
    soft_cap: counter.soft_cap ?? 0,
  });
  const pending = counter.status === "pending";
  const blocks = pending
    ? (counter.start_block ?? 0) - tip
    : (counter.soft_cap_deadline_block ?? 0) - tip;

  return (
    <Shell counter={counter}>
      <div className="flex flex-col gap-1.5 border-t border-line2 pt-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
            {pending ? "opens in" : "minting"}
          </span>
          <span className="font-mono text-[11px] text-ink">
            {pending ? fmtBlocks(Math.max(0, blocks)) : `${(progress * 100).toFixed(1)}%`}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-line2">
          <div
            className="h-full rounded-full bg-copper transition-[width]"
            style={{ width: `${Math.min(100, progress * 100)}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
            pool at close
          </span>
          <span className="font-mono text-[11px] text-patina">
            {fmtCompact(counter.pool_quantity)} + XCP
          </span>
        </div>
      </div>
    </Shell>
  );
}

/**
 * An on-chain counter with no pool. The CTA is the whole point of the
 * section: with seventy on-chain counters and one pool, this is where the
 * listing above comes from.
 */
export function UnpooledCard({ counter }: { counter: CounterRow }) {
  return (
    <Shell counter={counter}>
      <div className="flex items-baseline justify-between gap-2 border-t border-line2 pt-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">supply</span>
        <span className="font-mono text-[11px] text-dim">
          {fmtCompact(counter.supply, counter.divisible === 1)}
        </span>
      </div>
      <span className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-copper opacity-0 transition-opacity group-hover:opacity-100">
        create lp →
      </span>
    </Shell>
  );
}

/** Total XCP behind a set of pools, for a section header. */
export function totalDepth(pools: PooledCounter[]): bigint {
  return pools.reduce((sum, p) => sum + big(p.asset_b === "XCP" ? p.reserve_b : p.reserve_a), 0n);
}
