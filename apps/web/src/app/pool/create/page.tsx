import { PoolForm } from "./pool-form";
import { copy } from "@content/copy";
import { fill } from "@content/fill";

export const metadata = {
  title: "counters.fun",
  description: "Open a counter's constant-product pool against XCP, or add to one.",
};

export default async function NewPoolPage({
  searchParams,
}: {
  searchParams: Promise<{ asset?: string }>;
}) {
  const { asset } = await searchParams;

  return (
    <div className="mx-auto max-w-[560px] py-12">
      <p className="mb-4 font-mono text-xs uppercase tracking-[0.22em] text-copper">{copy.pool.eyebrow}</p>
      <h1 className="mb-3 font-mono text-3xl font-semibold leading-tight">{copy.pool.headline}</h1>
      <p className="mb-9 text-dim">{fill(copy.pool.lede)}</p>
      <PoolForm initialAsset={(asset ?? "").toUpperCase()} />
    </div>
  );
}
