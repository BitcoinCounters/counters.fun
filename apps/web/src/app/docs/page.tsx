import { docsHtml } from "@content/docs";

export const metadata = {
  title: "counters.fun",
  description: "What a counter is, how it gets a pool, and why nothing here is hosted.",
};

/**
 * The docs page is `content/docs.md`.
 *
 * None of the prose lives here — this file is only the styling for it. Edit the
 * markdown and reload; there is no component to touch.
 */
export default async function DocsPage() {
  const html = await docsHtml();

  return (
    <article
      className={[
        "mx-auto max-w-[68ch] py-12",
        // The markdown carries no classes of its own, so the document is styled
        // from here by element. Keeping that in one place is what stops the
        // docs page drifting away from the rest of the site's typography.
        "[&_h1]:mb-9 [&_h1]:font-mono [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:leading-tight",
        "[&_h2]:mb-4 [&_h2]:mt-10 [&_h2]:font-mono [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-[0.14em] [&_h2]:text-copper2",
        "[&_p]:mb-4 [&_p]:text-[15px] [&_p]:leading-relaxed [&_p]:text-dim",
        "[&_li]:mb-3 [&_li]:text-[15px] [&_li]:leading-relaxed [&_li]:text-dim",
        "[&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_strong]:text-ink [&_em]:not-italic [&_em]:text-ink",
        "[&_a]:text-copper [&_a]:underline-offset-2 hover:[&_a]:underline",
        "[&_code]:rounded [&_code]:bg-bg2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-ink",
        "[&_pre]:mb-4 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-line [&_pre]:bg-card [&_pre]:p-4",
        "[&_blockquote]:mb-4 [&_blockquote]:border-l-2 [&_blockquote]:border-copper [&_blockquote]:pl-4 [&_blockquote]:text-dim",
        "[&_hr]:my-8 [&_hr]:border-line",
      ].join(" ")}
      // Safe here and nowhere else: this markdown ships in the repository and
      // never passes through a request. A counter's own bytes are arbitrary and
      // go through the sandboxed content proxy instead.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
