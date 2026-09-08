import { describe, expect, it } from "vitest";
import {
  NUMERIC_MAX,
  NUMERIC_MIN,
  classifyAssetName,
  isNumericAssetName,
  randomNumericAsset,
} from "../packages/counters/src/assetnames";

describe("classifyAssetName", () => {
  it("accepts the three shapes", () => {
    expect(classifyAssetName("MEMENOME")).toEqual({ ok: true, kind: "named" });
    expect(classifyAssetName(`A${NUMERIC_MIN}`)).toEqual({ ok: true, kind: "numeric" });
    expect(classifyAssetName("MEMENOME.sub-1")).toEqual({ ok: true, kind: "subasset", parent: "MEMENOME" });
  });

  it("rejects what the node rejects, with the node's reason", () => {
    expect(classifyAssetName("A123")).toEqual({ ok: false, reason: "numeric-out-of-range" });
    expect(classifyAssetName("ABCD")).toEqual({ ok: false, reason: "named-shape" });
    expect(classifyAssetName("abc")).toEqual({ ok: false, reason: "named-shape" });
    expect(classifyAssetName("XCP")).toEqual({ ok: false, reason: "reserved" });
    expect(classifyAssetName("A123.x")).toEqual({ ok: false, reason: "subasset-parent" });
    expect(classifyAssetName("MEMENOME.bad space")).toEqual({ ok: false, reason: "subasset-child" });
  });

  it("draws numeric names inside the consensus range", () => {
    for (let i = 0; i < 200; i += 1) {
      const name = randomNumericAsset();
      expect(isNumericAssetName(name)).toBe(true);
      const value = BigInt(name.slice(1));
      expect(value >= NUMERIC_MIN && value <= NUMERIC_MAX).toBe(true);
    }
  });
});
