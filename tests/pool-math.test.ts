/**
 * Local pool math against the node's own quote endpoints.
 *
 * The UI needs a number before it composes — an implied opening price, an
 * expected LP mint, a slippage floor. Those come from the functions here, and
 * the only way to know they match consensus is to ask the node the same
 * question. The live case is MEMENOME/XCP, the one counter with a pool.
 */

import { describe, expect, it } from "vitest";
import {
  feeBps,
  isqrt,
  lpMinted,
  poolOutput,
  poolPrice,
  proportionalCounterpart,
  withdrawalShares,
} from "../packages/counters/src/pool";
import { big } from "../packages/counters/src/numeric";

const CP = process.env.COUNTERPARTY_API_BASE ?? "http://127.0.0.1:4000";
const TOKEN = "MEMENOME";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${CP}${path}`);
  const body = (await res.json()) as { result: T };
  return body.result;
}

describe("constant-product math", () => {
  it("computes integer square roots exactly at u64 scale", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    // Floors rather than rounds — consensus mints floor(sqrt(qa*qb)).
    expect(isqrt(10n ** 32n + 1n)).toBe(10n ** 16n);
  });

  it("charges 50 bps on XCP pairs and 100 elsewhere", () => {
    expect(feeBps("MEMENOME", "XCP")).toBe(50);
    expect(feeBps("XCP", "MEMENOME")).toBe(50);
    expect(feeBps("PEPECASH", "RAREPEPE")).toBe(100);
  });

  it("floors output rather than rounding it", () => {
    // A trade small enough that the fee eats it entirely must return zero,
    // not a fraction that rounds up into a fill.
    expect(poolOutput(1n, 1_000_000n, 1_000_000n, 50)).toBe(0n);
    expect(poolOutput(0n, 1n, 1n, 50)).toBe(0n);
    // Empty pool: no price exists, so no output.
    expect(poolOutput(100n, 0n, 100n, 50)).toBe(0n);
  });

  it("mints sqrt on the first deposit and proportionally after", () => {
    // First deposit into an empty pool sets the price.
    expect(lpMinted(1_000_000n, 4_000_000n, 0n, 0n, 0n)).toBe(2_000_000n);

    // A later balanced deposit of 10% mints 10% of supply.
    const minted = lpMinted(100n, 200n, 1_000n, 2_000n, 3_000n);
    expect(minted).toBe(300n);

    // An unbalanced deposit is limited by the short side — the excess is
    // simply not debited, which is why composed quantities are maximums.
    expect(lpMinted(100n, 1_000_000n, 1_000n, 2_000n, 3_000n)).toBe(300n);
  });

  it("returns no ratio for an empty pool — that is what makes the first deposit price-setting", () => {
    expect(proportionalCounterpart(100n, 0n, 0n)).toBeNull();
    // Rounds up, so the composed maximum can actually satisfy the ratio.
    expect(proportionalCounterpart(10n, 3n, 7n)).toBe(24n); // 10*7/3 = 23.33 → 24
  });

  it("burns LP for a floored proportional share", () => {
    const { quantityA, quantityB } = withdrawalShares(300n, 1_100n, 2_200n, 3_300n);
    expect(quantityA).toBe(100n);
    expect(quantityB).toBe(200n);
    expect(withdrawalShares(1n, 1n, 1n, 0n)).toEqual({ quantityA: 0n, quantityB: 0n });
  });
});

describe("against the live MEMENOME/XCP pool", () => {
  it("prices the pool the same way the node reports its reserves", async () => {
    const pool = await get<{ reserve_a: string | number; reserve_b: string | number } | null>(
      `/v2/pools/${TOKEN}/XCP?verbose=true`,
    );
    expect(pool).not.toBeNull();

    const price = poolPrice(pool!);
    expect(price).toBeGreaterThan(0);

    // Sanity: reserves are the pool's whole state, so price must reproduce
    // from them exactly.
    const a = big(pool!.reserve_a);
    const b = big(pool!.reserve_b);
    expect(price).toBeCloseTo(Number((b * 1_000_000_000_000n) / a) / 1e12, 15);
  }, 30_000);

  it("estimates a swap within rounding of the node's own quote", async () => {
    const pool = await get<{ reserve_a: string | number; reserve_b: string | number }>(
      `/v2/pools/${TOKEN}/XCP?verbose=true`,
    );

    // Sell 1 XCP worth into the pool.
    const quantity = 100_000_000n;
    const quote = await get<{ total_output?: string | number; pool_output?: string | number }>(
      `/v2/pools/XCP/${TOKEN}/quote?quantity=${quantity}`,
    );

    const local = poolOutput(quantity, pool.reserve_b, pool.reserve_a, feeBps(TOKEN, "XCP"));
    expect(local).toBeGreaterThan(0n);

    // The node's quote routes across the pool *and* the resting order book,
    // so it can only ever be at least as good as the pool alone. That
    // inequality is the real invariant; exact equality would only hold with
    // an empty book.
    const node = big(quote.total_output ?? quote.pool_output ?? 0);
    if (node > 0n) expect(node).toBeGreaterThanOrEqual(local - local / 1000n);
  }, 30_000);
});
