/**
 * Server startup.
 *
 * Runs once per Next.js server instance, before it takes requests. The reveal
 * runner belongs here rather than in a route: a reveal waiting on its commit to
 * be mined has to keep being worked on whether or not anyone is asking for a
 * page, and starting it lazily on first request would mean a restarted server
 * silently stops finishing mints until someone happens to visit.
 */

export async function register(): Promise<void> {
  // Only the Node.js server runs jobs. The edge runtime has no filesystem and
  // no long-lived process, and importing the store there would fail at build.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startRunner } = await import("@/lib/server/reveal-jobs");
  startRunner();
}

/**
 * Every error Next catches on the server — a thrown page render, a route
 * handler that blew up — goes to the same local log as the browser's, so one
 * `tail -f` covers a whole run. Development only; see lib/dev-errors.ts.
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string },
  context: { routerKind?: string; routePath?: string; renderSource?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV === "production") return;
  const { report } = await import("@/lib/dev-errors");
  await report({
    source: context.renderSource ? "route" : "server",
    kind: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    url: request.path,
    stack: error instanceof Error ? error.stack : undefined,
    detail: { routePath: context.routePath, routerKind: context.routerKind },
  });
}
