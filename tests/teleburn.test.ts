import { describe, expect, it } from "vitest";
import { canonicalAssetName, teleburnAddress } from "@/lib/teleburn";

/** The protocol's pinned vectors — the same ones counters/tests/test_teleburn.py
 *  holds; a change here is a change to every burn ever made. */
const VECTORS: Record<string, string> = {
  XCP: "bc1pj76jq96xhq25jcxl8qgrecz5sv2sfphj247emczw3pw6smhah6sqalf224",
  A16756519242061643639: "bc1py6gs0j0duqtyu0xr8mp3ewjhu3l0tlhdfptv8zcqyf38qvuryhsseel6e2",
  PEPECASH: "bc1p6c47mk09xk42u8aslc4c6u503n6s635st6hxmxj6p06nntjqxg2qj5wqch",
};

describe("teleburn address", () => {
  it("derives the mainnet vectors", () => {
    for (const [asset, address] of Object.entries(VECTORS)) {
      expect(teleburnAddress(asset)).toBe(address);
    }
  });

  it("changes only the prefix on testnet", () => {
    expect(teleburnAddress("XCP", "tb")).toBe(
      "tb1pj76jq96xhq25jcxl8qgrecz5sv2sfphj247emczw3pw6smhah6sq2hl9s6",
    );
  });

  it("accepts only canonical asset names", () => {
    expect(canonicalAssetName("PEPE")).toBe("PEPE");
    expect(canonicalAssetName(`A${26n ** 12n + 1n}`)).toBe(`A${26n ** 12n + 1n}`);
    for (const bad of ["", "BTC", "pepecash", "PEP", "AAAAA", "PARENT.child", "A1", "A0", "TOOLONGASSETNAME"]) {
      expect(canonicalAssetName(bad)).toBeNull();
      expect(teleburnAddress(bad)).toBeNull();
    }
  });
});
