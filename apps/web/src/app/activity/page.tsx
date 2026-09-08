import Link from "next/link";
import { getActivity, getStats } from "@/lib/api";
import { fmtCompact, fmtDate, mimeTag, trunc } from "@/lib/format";
import { mempoolTxUrl } from "@/lib/constants";
import { copy } from "@content/copy";

export const revalidate = 30;

export const metadata = {
  title: "Activity — counters.fun",
  description: "Swaps against counter pools, newest first.",
};

/**
 * The tape. Every swap that has been executed against a counter's pool.
 *
 * Sides are named from the counter's point of view — "bought" when XCP went in
 * and the counter came out — rather than by which asset the protocol happened
 * to record as `give`. A reader here is watching a counter, not a pair.
 */
export default async function ActivityPage() {
  const [rows, stats] = await Promise.all([getActivity(100), getStats()]);

  return (
    <div className="py-12">
      <p className="mb-4 font-mono text-xs uppercase tracking-[0.22em] text-copper">{copy.activity.eyebrow}</p>
      <h1 className="mb-3 font-mono text-3xl font-semibold leading-tight">{copy.activity.headline}</h1>
      <p className="mb-9 max-w-[62ch] text-dim">{copy.activity.lede(stats.pooled)}</p>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-card/40 p-10 text-center text-sm text-dim">
          {copy.activity.empty}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-card">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                {["counter", "side", "size", "block", "when", "tx"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left font-mono text-[10px] uppercase tracking-[0.14em] font-medium text-faint"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const bought = row.get_asset === row.token_asset;
                const xcpAmount = bought ? row.give_qty : row.get_qty;
                return (
                  <tr key={row.id} className="border-b border-line2 last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        href={`/c/${row.counter_number}`}
                        className="font-mono text-xs text-copper2 hover:underline"
                      >
                        #{row.counter_number} {row.token_asset}
                      </Link>
                      <span className="ml-2 font-mono text-[10px] uppercase text-faint">
                        {mimeTag(row.content_type)}
                      </span>
                    </td>
                    <td
                      className={`px-4 py-3 font-mono text-xs ${bought ? "text-patina" : "text-bad"}`}
                    >
                      {bought ? "bought" : "sold"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-ink">
                      {fmtCompact(xcpAmount)} XCP
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-dim">
                      {row.block_index.toLocaleString("en-US")}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-faint">
                      {fmtDate(row.block_time)}
                    </td>
                    <td className="px-4 py-3">
                      {row.tx_hash ? (
                        <a
                          href={mempoolTxUrl(row.tx_hash)}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="font-mono text-[11px] text-dim hover:text-copper2"
                        >
                          {trunc(row.tx_hash, 6, 4)}
                        </a>
                      ) : (
                        <span className="font-mono text-[11px] text-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
