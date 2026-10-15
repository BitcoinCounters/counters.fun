import Link from "next/link";
import {
  PRICE_CLASSES,
  pricedParam,
  togglePriced,
  type PriceClass,
} from "@counters/core/listing";

interface Option {
  readonly value: PriceClass;
  readonly label: string;
  readonly title: string;
}

/**
 * The DEX venue's filter, folded behind one word until it is wanted — the
 * protocol explorer's pattern — and open on arrival when a view comes with
 * something other than the default ticked.
 *
 * Links rather than checkboxes, for the reason the venue toggle is links:
 * the filter is a `?priced=` the server reads, so the page stays a server
 * component, a tick works before any JavaScript has loaded, and a filtered
 * book is something somebody can send. The fold is a `<details>`, which
 * needs no script either. Folded with a non-default set, the word says how
 * many are ticked.
 *
 * `href(classes)` builds the page's own link for a set, so the venue, sort
 * and first page come along as the page decides.
 */
export function DexFilters({
  label,
  group,
  options,
  value,
  href,
}: {
  label: string;
  group: string;
  options: readonly Option[];
  value: readonly PriceClass[];
  href: (classes: readonly PriceClass[]) => string;
}) {
  const isDefault = pricedParam(value) === null;
  const ticked = PRICE_CLASSES.filter((c) => value.includes(c)).length;

  return (
    <details
      open={!isDefault}
      className="group/filters inline-flex shrink-0 items-center font-mono text-[11px] uppercase tracking-[0.08em]"
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-dim transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="inline-block border-y-[4px] border-l-[5px] border-y-transparent border-l-current transition-transform group-open/filters:rotate-90"
        />
        {label}
        {!isDefault && (
          <span className="rounded-full bg-copper px-1.5 text-[9.5px] font-semibold leading-[16px] tracking-normal text-bg group-open/filters:hidden">
            {ticked}
          </span>
        )}
      </summary>
      <span className="ml-3 inline-flex items-center gap-x-3 gap-y-1">
        <span className="text-faint">{group}</span>
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <Link
              key={o.value}
              href={href(togglePriced(value, o.value))}
              scroll={false}
              title={o.title}
              role="checkbox"
              aria-checked={on}
              className="inline-flex items-center gap-1.5 whitespace-nowrap text-dim transition-colors hover:text-ink"
            >
              <span
                aria-hidden
                className={`inline-grid h-3.5 w-3.5 place-content-center rounded border transition-colors ${
                  on ? "border-copper" : "border-line2 bg-bg2"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-[2px] bg-copper transition-transform ${on ? "scale-100" : "scale-0"}`} />
              </span>
              <span className={on ? "text-ink" : undefined}>{o.label}</span>
            </Link>
          );
        })}
      </span>
    </details>
  );
}
