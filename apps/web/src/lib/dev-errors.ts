/**
 * Where a local run writes what went wrong.
 *
 * Running the site locally scatters its failures across three places nobody is
 * looking at: the browser console, the Next server's stdout, and the worker's.
 * A client-side exception in particular leaves no trace at all outside the tab
 * it happened in. This collects all of them into one newline-delimited JSON
 * file so a `tail -f` — a person's or an agent's — sees everything at once.
 *
 * **Development only.** `report()` and the route that calls it refuse outside
 * `next dev`: this writes to the working directory, keeps no bounds a hosted
 * process should trust, and an error log that anyone on the internet can append
 * to is a liability rather than a feature. Production reporting, if it is ever
 * wanted, belongs behind a real service.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEV_ONLY = process.env.NODE_ENV !== "production";

/**
 * `.logs/` under the repo root — `.gitignore`d, next to the other local logs.
 * Next runs with the app as its working directory, so the default climbs out of
 * `apps/web`; `DEV_ERROR_LOG` overrides it for anything that does not.
 */
const LOG_PATH =
  process.env.DEV_ERROR_LOG ??
  (process.cwd().endsWith(join("apps", "web"))
    ? join(process.cwd(), "..", "..", ".logs", "errors.log")
    : join(process.cwd(), ".logs", "errors.log"));

export interface DevError {
  /** Where it happened: the browser, the Next server, or a page render. */
  source: "client" | "server" | "route";
  kind: string;
  message: string;
  /** The page it happened on, when there is one. */
  url?: string;
  stack?: string;
  detail?: Record<string, unknown>;
}

/** Trim anything unbounded — a stack, a message built from a response body. */
function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Append one error. Never throws: a logger that can break the thing it is
 * watching is worse than no logger.
 */
export async function report(error: DevError): Promise<void> {
  if (!DEV_ONLY) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    source: error.source,
    kind: clip(error.kind, 200) ?? "Error",
    message: clip(error.message, 2000) ?? "",
    ...(error.url ? { url: clip(error.url, 500) } : {}),
    ...(error.stack ? { stack: clip(error.stack, 4000) } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
  });
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, `${line}\n`, "utf8");
  } catch {
    // The log is a convenience; losing a line is not worth an exception in a
    // request path that was already handling one.
  }
}

/** One line, as `tail -f` should print it. Kept here so both writers agree. */
export function formatDevError(error: DevError): string {
  return `${error.source} ${error.kind}: ${error.message}${error.url ? ` (${error.url})` : ""}`;
}
