/**
 * The small pieces a detail page is built from — a section head, a figure,
 * a facts table — shared by the counter page and the dispenser page so the
 * two read as one site.
 */

export function SectionHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="mb-4 flex items-baseline gap-3.5">
      <h2 className="font-mono text-sm font-semibold uppercase tracking-[0.14em]">{title}</h2>
      <span className="h-px flex-1 bg-line" />
      {meta && <span className="font-mono text-xs text-faint">{meta}</span>}
    </div>
  );
}

export function Figure({
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

export function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-5">
      {rows.map(([label, value]) => (
        <Fact key={label} label={label} value={value} />
      ))}
    </div>
  );
}

export function Fact({
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
