/**
 * Core sorts every pair, so a counter that sorts after "XCP" is `asset_b` in
 * its own pool. The MEMENOME numbers are the live ones; the ZELD case is the
 * same record with the names the node would actually return for it.
 */
import { describe, expect, it } from "vitest";
import { orientDepositQuote, orientPool, orientWithdrawQuote, poolPrice, priceFromReserves, sortedPair, tokenIsA } from "../packages/counters/src/pool";

describe("pair orientation", () => {
  it("sorts the way Core does", () => {
    expect(sortedPair("MEMENOME", "XCP")).toEqual(["MEMENOME", "XCP"]);
    expect(sortedPair("ZELD", "XCP")).toEqual(["XCP", "ZELD"]);
    expect(tokenIsA("MEMENOME")).toBe(true);
    expect(tokenIsA("XDUALS")).toBe(false);
  });

  it("reads a pool record by name, not position", () => {
    const memenome = { asset_a: "MEMENOME", asset_b: "XCP", reserve_a: "4981932395674824", reserve_b: "44688202231", lp_asset: "A1" };
    expect(orientPool(memenome, "MEMENOME")).toEqual({ token: "MEMENOME", tokenReserve: 4981932395674824n, xcpReserve: 44688202231n, lpAsset: "A1" });

    const zeld = { asset_a: "XCP", asset_b: "ZELD", reserve_a: "44688202231", reserve_b: "4981932395674824" };
    expect(orientPool(zeld, "ZELD")).toMatchObject({ tokenReserve: 4981932395674824n, xcpReserve: 44688202231n });
    expect(orientPool(zeld, "MEMENOME")).toBeNull();
  });

  it("reads quotes by name, falling back to the sort rule", () => {
    const q = { first_deposit: false, asset_a: "XCP", asset_b: "ZELD", quantity_a_required: 898, quantity_b_required: "100000000", quantity_minted_estimate: 298984 };
    expect(orientDepositQuote(q, "ZELD")).toEqual({ firstDeposit: false, tokenRequired: 100000000n, xcpRequired: 898n, minted: 298984n });
    const unnamed = { first_deposit: false, quantity_a_required: 898, quantity_b_required: 100000000, quantity_minted_estimate: 1 };
    expect(orientDepositQuote(unnamed, "ZELD").tokenRequired).toBe(100000000n);
    expect(orientDepositQuote(unnamed, "MEMENOME").tokenRequired).toBe(898n);

    const w = { asset_a: "XCP", asset_b: "ZELD", supply: "14895226279172", quantity_a_estimate: 3, quantity_b_estimate: 334465 };
    expect(orientWithdrawQuote(w, "ZELD")).toEqual({ tokenOut: 334465n, xcpOut: 3n, supply: 14895226279172n });
  });

  it("prices an indivisible token by its whole units", () => {
    // BONPARTY: 500 indivisible tokens against 100 XCP is 0.2 XCP each.
    const bonparty = { asset_a: "BONPARTY", asset_b: "XCP", reserve_a: "500", reserve_b: "10000000000" };
    expect(poolPrice(bonparty, false)).toBeCloseTo(0.2, 9);
    expect(poolPrice(bonparty, true)).toBeCloseTo(20_000_000, 0);
    // MEMENOME, divisible: raw/raw and whole/whole agree.
    const memenome = { asset_a: "MEMENOME", asset_b: "XCP", reserve_a: "4981932395674824", reserve_b: "44688202231" };
    expect(poolPrice(memenome, true)).toBeCloseTo(8.970053e-6, 12);
    expect(priceFromReserves(4981932395674824n, 44688202231n, true)).toBeCloseTo(8.970053e-6, 12);
    // And a pool where XCP sorts first still prices the token.
    expect(poolPrice({ asset_a: "XCP", asset_b: "ZELD", reserve_a: "10000000000", reserve_b: "500" }, false)).toBeCloseTo(0.2, 9);
  });
});
