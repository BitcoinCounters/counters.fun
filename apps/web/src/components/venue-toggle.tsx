import Link from "next/link";

interface Option {
  readonly value: string;
  readonly label: string;
  /** How many counters are on this venue, stated on the toggle itself. */
  readonly count: number;
  readonly href: string;
}

/**
 * The venue switch over the home page's first section: pool, dex, dispenser.
 *
 * Links rather than buttons, for the same reason `SortSelect` keeps its order
 * in the URL: the venue is a `?venue=` the server reads, so the page stays a
 * server component, the switch works before any JavaScript has loaded, and a
 * venue is something somebody can send. It is a `<nav>` with `aria-current`
 * for that reason too — these are three addresses, not three states of a
 * widget.
 *
 * Each segment carries its count, so an empty venue says so before it is
 * opened rather than after.
 *
 * `scroll={false}` because the section stays where it is; only its contents
 * change.
 */
export function VenueToggle({
  options,
  value,
  label,
}: {
  options: readonly Option[];
  value: string;
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-bg2 p-0.5 font-mono text-[11px] uppercase tracking-[0.08em]"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Link
            key={o.value}
            href={o.href}
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={`rounded-md px-2.5 py-1 transition-colors ${
              active ? "bg-copper-ghost text-copper2" : "text-dim hover:text-ink"
            }`}
          >
            {o.label}
            <span className={`ml-1.5 ${active ? "text-copper" : "text-faint"}`}>{o.count}</span>
          </Link>
        );
      })}
    </nav>
  );
}
