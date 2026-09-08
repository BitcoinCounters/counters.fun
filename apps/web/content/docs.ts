import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { marked } from "marked";
import { fill } from "./fill";

/**
 * The docs page, as HTML.
 *
 * Read from disk at render time, so editing `content/docs.md` and reloading is
 * the whole workflow.
 *
 * The markdown is authored in this repository by whoever deploys it — it is not
 * user input and never passes through a request — so rendering it as HTML is
 * safe in a way that rendering a counter's on-chain bytes would not be. Those
 * go through the sandboxed proxy instead; see `apps/api/src/content.ts`.
 *
 * `server-only` is imported for its side effect: it makes importing this from a
 * client component a build error with a clear message, rather than the opaque
 * bundler failure that `node:fs` produces on its own.
 */
export async function docsHtml(): Promise<string> {
  const path = join(process.cwd(), "content", "docs.md");
  const source = await readFile(path, "utf8");
  return marked.parse(fill(source), { async: false });
}
