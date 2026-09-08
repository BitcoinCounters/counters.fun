/**
 * The read routes. All SQL lives in src/queries/counters.ts, which is where
 * the on-chain rule is enforced — nothing here re-derives a filter.
 */

import { J, router, type ReadApp } from "#api/read/respond";
import type { Env } from "#api/env";
import { one } from "#api/db";
import {
  counterByAsset,
  counterByNumber,
  counterSiblings,
  counterVisibility,
  heaviestCounters,
  mintingCounters,
  pooledCounters,
  stats,
  unpooledCounters,
  type PooledSort,
} from "#api/queries/counters";
import { Counterparty } from "#api/upstream/counterparty";
import { CountersServer } from "#api/upstream/counters-server";
import { BURN_ADDRESS } from "@counters/core/counter";
import { big } from "@counters/core/numeric";

const SORTS = new Set<PooledSort>(["depth", "volume", "change", "number", "newest"]);

export function countersRoutes(): ReadApp {
  const app = router();

  /**
   * The home page in one call. Three sections, because they are always
   * rendered together and three round trips to fill one screen is three
   * chances for it to arrive in pieces.
   */
  app.get("/counters", async (c) => {
    const filter = c.req.query("filter") ?? "all";
    const sortParam = c.req.query("sort") ?? "depth";
    const sort = SORTS.has(sortParam as PooledSort) ? (sortParam as PooledSort) : "depth";
    const limit = clamp(Number(c.req.query("limit") ?? 100), 1, 200);
    const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;

    if (filter === "pooled") return J(c, { result: await pooledCounters(c.env.DB, sort, limit) });
    if (filter === "unpooled") return J(c, { result: await unpooledCounters(c.env.DB, limit, before) });
    if (filter === "minting") return J(c, { result: await mintingCounters(c.env.DB, limit) });
    if (filter === "heaviest") return J(c, { result: await heaviestCounters(c.env.DB, limit) });

    const [pooled, minting, unpooled] = await Promise.all([
      pooledCounters(c.env.DB, sort, limit),
      mintingCounters(c.env.DB, 50),
      unpooledCounters(c.env.DB, limit, before),
    ]);
    return J(c, { result: { pooled, minting, unpooled } });
  });

  app.get("/stats", async (c) => J(c, { result: await stats(c.env.DB) }, 30));

  /**
   * One counter. A pointer-like counter is not 404 — it exists, it is just
   * not something this site will render — so it comes back with an explicit
   * reason and its raw description, and the page says so plainly.
   */
  app.get("/counters/:id", async (c) => {
    const id = c.req.param("id");
    const isNumber = /^\d+$/.test(id);

    const counter = isNumber
      ? await counterByNumber(c.env.DB, Number(id))
      : await counterByAsset(c.env.DB, id.toUpperCase());

    if (!counter) {
      if (isNumber) {
        const raw = await counterVisibility(c.env.DB, Number(id));
        if (raw) {
          return J(
            c,
            {
              result: {
                number: raw.number,
                asset: raw.asset,
                displayable: false,
                reason: raw.is_pointer_like ? "pointer" : "empty",
                // The raw description is shown as text, never dereferenced.
                description: raw.body,
              },
            },
            300,
          );
        }
      }
      return c.json({ error: "not found" }, 404);
    }

    const [pool, siblings, blockTime] = await Promise.all([
      poolFor(c.env.DB, counter.asset),
      counterSiblings(c.env.DB, counter.asset),
      backfillBlockTime(c.env, counter.number, counter.block_time),
    ]);

    return J(
      c,
      { result: { ...counter, block_time: blockTime, displayable: true, pool, siblings } },
      30,
    );
  });

  /** Reserve snapshots for the chart. */
  app.get("/counters/:id/history", async (c) => {
    const counter = await resolve(c.env.DB, c.req.param("id"));
    if (!counter) return c.json({ error: "not found" }, 404);

    const rows = await c.env.DB.prepare(
      `SELECT block_index, block_time, reserve_a, reserve_b, price
         FROM price_snapshots WHERE token_asset = ?1
        ORDER BY block_index ASC LIMIT 1000`,
    )
      .bind(counter.asset)
      .all();

    return J(c, { result: rows.results }, 60);
  });

  /**
   * The pool, plus the lock proof: how much of the LP supply sits at the
   * unspendable address. For a fairminter-seeded pool that is all of it, and
   * saying so is more useful than saying "liquidity locked" and asking to be
   * believed.
   */
  app.get("/counters/:id/pool", async (c) => {
    const counter = await resolve(c.env.DB, c.req.param("id"));
    if (!counter) return c.json({ error: "not found" }, 404);

    const pool = await poolFor(c.env.DB, counter.asset);
    if (!pool) return J(c, { result: null }, 30);

    const cp = new Counterparty(c.env.COUNTERPARTY_API_BASE);
    const holders = await cp.assetBalances(pool.lp_asset, 200).catch(() => []);

    let locked = 0n;
    let total = 0n;
    for (const h of holders) {
      const qty = big(h.quantity);
      total += qty;
      if (h.address === BURN_ADDRESS) locked += qty;
    }

    return J(
      c,
      {
        result: {
          ...pool,
          lp_supply: total.toString(),
          lp_locked: locked.toString(),
          fully_locked: total > 0n && locked === total,
        },
      },
      30,
    );
  });

  /** Merged tape: swaps against pools, newest first. */
  app.get("/activity", async (c) => {
    const limit = clamp(Number(c.req.query("limit") ?? 50), 1, 200);
    const rows = await c.env.DB.prepare(
      `SELECT m.*, c.number AS counter_number, c.content_type
         FROM pool_matches m
         JOIN counters c ON c.asset = m.token_asset AND c.is_pointer_like = 0
        WHERE c.number = (SELECT MIN(c2.number) FROM counters c2
                           WHERE c2.asset = c.asset AND c2.is_pointer_like = 0)
        ORDER BY m.block_index DESC
        LIMIT ?1`,
    )
      .bind(limit)
      .all();

    return J(c, { result: rows.results }, 30);
  });

  return app;
}

/**
 * Fill in a counter's `block_time`, which the listing endpoint does not carry.
 *
 * `/counters` returns a compact row; only `/counter/<id>` includes the block
 * time. Rather than pay a request per counter during sync — 168 of them, for a
 * field almost nobody looks at — the detail route fetches it once, on first
 * view, and writes it back. Every later view reads it from D1.
 *
 * A failure here is not an error: the page renders without an inscription date,
 * which is what it did before this existed.
 */
async function backfillBlockTime(
  env: Env,
  number: number,
  current: number | null,
): Promise<number | null> {
  if (current) return current;
  try {
    const server = new CountersServer(env.COUNTERS_API_BASE);
    const full = await server.counter(number);
    const blockTime = full?.block_time ?? null;
    if (blockTime) {
      await env.DB.prepare(`UPDATE counters SET block_time = ?1 WHERE number = ?2`)
        .bind(blockTime, number)
        .run();
    }
    return blockTime;
  } catch {
    return null;
  }
}

async function resolve(db: D1Database, id: string) {
  return /^\d+$/.test(id) ? counterByNumber(db, Number(id)) : counterByAsset(db, id.toUpperCase());
}

function poolFor(db: D1Database, asset: string) {
  return one<{
    asset_a: string;
    asset_b: string;
    lp_asset: string;
    reserve_a: string;
    reserve_b: string;
    price: number | null;
    price_24h_ago: number | null;
    volume_24h: string | null;
    block_index: number;
  }>(
    db,
    `SELECT asset_a, asset_b, lp_asset, reserve_a, reserve_b, price,
            price_24h_ago, volume_24h, block_index
       FROM pools WHERE token_asset = ?1`,
    asset,
  );
}

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
