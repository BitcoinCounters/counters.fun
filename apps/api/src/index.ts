/**
 * counters.fun API worker.
 *
 * It answers one question the upstreams cannot: which counters have an XCP
 * pool. The counters server knows about files and numbers and nothing about
 * markets; Counterparty knows about pools and nothing about counter numbers.
 * The join lives here, in D1, refreshed on a cron.
 *
 * Everything transactional — balances, fee rates, composes, broadcasts —
 * still goes straight from the browser to Counterparty. An unsigned
 * transaction never passes through this worker.
 */

import { Hono } from "hono";
import type { Env } from "#api/env";
import { countersRoutes } from "#api/read/counters";
import { serveContent } from "#api/content";
import { sync } from "#api/indexer/sync";
import { withLock } from "#api/scheduler/lock";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("access-control-allow-origin", "*");
});

app.get("/", (c) =>
  c.json({
    name: "counters.fun",
    what: "counters with XCP liquidity pools",
    rule: "only counters whose file is on Bitcoin are served",
    routes: ["/counters", "/counters/:id", "/counters/:id/pool", "/counters/:id/history", "/activity", "/stats", "/search", "/content/:n", "/preview/:n", "/stamp/:n"],
  }),
);

app.route("/", countersRoutes());

/** On-chain bytes, re-served same-origin and sandboxed. See src/content.ts. */
app.get("/content/:n{[0-9]+}", (c) =>
  serveContent(c.env, c.executionCtx, c.req.raw, Number(c.req.param("n")), "content"),
);
app.get("/preview/:n{[0-9]+}", (c) =>
  serveContent(c.env, c.executionCtx, c.req.raw, Number(c.req.param("n")), "preview"),
);

/** A stamp's decoded image — the counter's `STAMP:<base64>` text as the file
 *  it encodes. 404s for a counter that is not stamp-like. */
app.get("/stamp/:n{[0-9]+}", (c) =>
  serveContent(c.env, c.executionCtx, c.req.raw, Number(c.req.param("n")), "stamp"),
);

/** Manual resync, for a cold database or after a schema change. */
app.post("/admin/sync", async (c) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const ran = await withLock(c.env.DB, 300, () => sync(c.env));
  return c.json({ ran });
});

export default {
  fetch: app.fetch,

  /**
   * Blocks land every ten minutes and both upstreams are cheap to poll, but
   * the counters index only moves a few times a day. Five minutes keeps the
   * listing current well inside a block time without paying for it.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // The lease means a slow tick can't overlap the next one; a skipped tick
    // costs at most five minutes of staleness.
    ctx.waitUntil(withLock(env.DB, 280, () => sync(env)));
  },
} satisfies ExportedHandler<Env>;
