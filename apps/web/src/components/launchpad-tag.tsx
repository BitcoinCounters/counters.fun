import { launchpadOf } from "@counters/core/launchpad";

/**
 * A small pill naming the launchpad a counter came through, or nothing.
 *
 * The API stamps `launchpad` from the deploying fairminter's shape — that is
 * what catches a launch whose inscribed file is the art itself. The on-chain
 * body is the fallback, for a row the sync has not tagged yet and for the
 * manifest counters where the JSON in the block says so directly.
 *
 * Drawn as xcp.fun draws itself: the party popper, XCP in white, .FUN in
 * orange.
 */
export function LaunchpadTag({
  counter,
  size = "sm",
}: {
  counter: { launchpad?: string | null; body: string | null | undefined };
  size?: "sm" | "md";
}) {
  const launchpad = counter.launchpad ?? launchpadOf({ body: counter.body });
  if (launchpad !== "xcp.fun") return null;
  const sizing = size === "md" ? "gap-1.5 px-2 py-0.5 text-[12px]" : "gap-1 px-1.5 py-px text-[10px]";
  return (
    <span
      title="Deployed through xcp.fun"
      className={`inline-flex shrink-0 items-center rounded-md border border-line bg-bg2 font-mono font-semibold uppercase tracking-[0.06em] ${sizing}`}
    >
      <span aria-hidden className="leading-none">
        🎉
      </span>
      <span className="text-ink">XCP</span>
      <span className="text-[#f7931a]">.FUN</span>
    </span>
  );
}
