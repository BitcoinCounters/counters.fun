/**
 * Core sorts every pair, so a counter that sorts after "XCP" is `asset_b` in
 * its own pool. The MEMENOME numbers are the live ones; the ZELD case is the
 * same record with the names the node would actually return for it.
 */
import { describe, expect, it } from "vitest";
import { orientDepositQuote, orientPool, orientWithdrawQuote, sortedPair, tokenIsA } from "../packages/counters/src/pool";

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
});
