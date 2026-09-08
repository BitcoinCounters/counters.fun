/**
 * Slippage bounds, and the one value they must never take.
 *
 * Every caller feeds this into a `min_*` field on a Counterparty order: the
 * least you will accept. Zero there does not mean "no tolerance" — it means the
 * order accepts any fill at all, including nothing. Integer division makes that
 * easy to hit: buying a single indivisible token with 1% slippage is
 * (1 * 9900) / 10000, which floors to 0.
 */
import { describe, expect, it } from "vitest";
import { withSlippage } from "../apps/web/src/lib/pool-compose";

describe("withSlippage", () => {
  it("never floors a positive quantity to zero", () => {
    // The reported bug: buying 1 MEMEPOW showed "at least 0 MEMEPOW".
    expect(withSlippage(1n, 1)).toBe(1n);
    expect(withSlippage(1n, 0.5)).toBe(1n);
    expect(withSlippage(1n, 3)).toBe(1n);
    expect(withSlippage(1n, 50)).toBe(1n);
    // Small indivisible amounts round up to the last meaningful unit, not zero.
    expect(withSlippage(2n, 50)).toBe(1n);
    expect(withSlippage(10n, 99)).toBe(1n);
  });

  it("still reduces amounts large enough to carry the percentage", () => {
    expect(withSlippage(100n, 1)).toBe(99n);
    expect(withSlippage(1000n, 3)).toBe(970n);
    expect(withSlippage(100_000_000n, 0.5)).toBe(99_500_000n);
    expect(withSlippage(25_12562816n, 1)).toBe(24_87437187n);
  });

  it("leaves a quantity alone at zero slippage", () => {
    expect(withSlippage(1n, 0)).toBe(1n);
    expect(withSlippage(12_345n, 0)).toBe(12_345n);
  });

  it("keeps zero at zero — there is nothing to protect", () => {
    expect(withSlippage(0n, 1)).toBe(0n);
  });
});
