import { MintForm } from "./mint-form";
import { copy } from "@content/copy";
import { fill } from "@content/fill";

export const metadata = {
  title: "counters.fun",
  description: "Put a file in Bitcoin's witness data and issue the asset that owns it.",
};

export default function MintPage() {
  return (
    <div className="mx-auto max-w-[640px] py-12">
      <p className="mb-4 font-mono text-xs uppercase tracking-[0.22em] text-copper">{copy.mint.eyebrow}</p>
      <h1 className="mb-3 font-mono text-3xl font-semibold leading-tight">{copy.mint.headline}</h1>
      <p className="mb-9 text-dim">{fill(copy.mint.lede)}</p>
      <MintForm />
    </div>
  );
}
