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
