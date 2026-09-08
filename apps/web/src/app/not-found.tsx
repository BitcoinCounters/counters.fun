import Link from "next/link";
import { Meter } from "@/components/meter";
import { copy } from "@content/copy";

/**
 * Next's built-in 404 is an unstyled white page — on a dark, committed site it
 * does not read as "wrong address", it reads as "the site is broken".
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-[52ch] py-24 text-center">
      <div className="mb-6 flex justify-center">
        <Meter value={404} size={30} />
      </div>
      <h1 className="mb-3 font-mono text-2xl font-semibold">{copy.notFound.headline}</h1>
      <p className="mb-8 text-dim">{copy.notFound.body}</p>
      <Link
        href="/"
        className="inline-block rounded-xl border border-copper px-5 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-copper2 transition-colors hover:bg-copper hover:text-bg"
      >
        {copy.notFound.cta}
      </Link>
    </div>
  );
}
