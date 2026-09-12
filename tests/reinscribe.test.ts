/**
 * A reinscription may not change the asset.
 *
 * Counterparty reads it as a reissuance, and a reissuance that disagrees with
 * the asset is refused: a different `divisible` is `cannot change
 * divisibility`, and `lock` — which the counter form defaults to on — freezes
 * the supply forever. The form hides its supply fields in this mode; these
 * pin that they cannot reach the wire anyway.
 */

import { describe, expect, it } from "vitest";
import { supplyParams, type MintRequest } from "../apps/web/src/lib/inscribe/mint";

const form: Pick<MintRequest, "mode" | "quantity" | "divisible" | "lockQuantity"> = {
  mode: "counter",
  quantity: 1n,
  divisible: false,
  lockQuantity: true,
};

describe("the supply an issuance asks for", () => {
  it("is the form's, for a new counter", () => {
    expect(supplyParams(form, null)).toEqual({ quantity: "1", divisible: "false", lock: "true" });
  });

  it("copies the asset's divisibility on a reinscription, whichever way the form is set", () => {
    const req = { ...form, mode: "reinscribe" as const };
    expect(supplyParams(req, { divisible: true })).toMatchObject({ divisible: "true" });
    expect(supplyParams({ ...req, divisible: true }, { divisible: false })).toMatchObject({ divisible: "false" });
  });

  it("never locks the supply or moves it on a reinscription", () => {
    const req = { ...form, mode: "reinscribe" as const, quantity: 21_000_000n, lockQuantity: true };
    expect(supplyParams(req, { divisible: false })).toEqual({ quantity: "0", divisible: "false", lock: "false" });
  });

  it("refuses to compose a reinscription of an asset that does not exist", () => {
    expect(() => supplyParams({ ...form, mode: "reinscribe" }, null)).toThrow(/already exists/);
  });
});
