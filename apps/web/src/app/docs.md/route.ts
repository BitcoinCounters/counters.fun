import { docsMarkdown } from "@content/docs";

/**
 * `/docs` as Markdown: the same file, with its `{{TOKEN}}`s filled. The raw
 * `content/docs.md` is not publishable as it stands, because a token is a
 * placeholder for a protocol fact, not the fact.
 */
export const dynamic = "force-static";

export async function GET() {
  // Without the file's HTML comments: they are notes to whoever edits it.
  const md = (await docsMarkdown()).replace(/<!--[\s\S]*?-->\s*/g, "");
  return new Response(md, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
