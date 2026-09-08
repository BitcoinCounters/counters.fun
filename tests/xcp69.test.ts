import { describe, expect, it } from "vitest";
import {
  XCP69,
  isXcp69Conformant,
  matchesXcp69Template,
  xcp69ComposeParams,
  xcp69Schedule,
} from "../packages/counters/src/xcp69";

/** UPPIES (#164) as the node reports it: template params, PNG description, opened in its own block. */
const UPPIES = {
  price: 1000000,
  quantity_by_price: 100000000000,
  hard_cap: "10000000000000000",
  soft_cap: 6900000000000000,
  pool_quantity: 3100000000000000,
  premint_quantity: 0,
  max_mint_per_address: 100000000000000,
  max_mint_per_tx: 100000000000000,
  minted_asset_commission_int: 0,
  divisible: true,
  lock_quantity: true,
  lock_description: true,
  burn_payment: false,
  start_block: 965850,
  soft_cap_deadline_block: 966850,
  block_index: 965850,
};

describe("xcp69", () => {
  it("matches the template and flags the instant-open timing", () => {
    expect(matchesXcp69Template(UPPIES)).toBe(true);
    expect(isXcp69Conformant(UPPIES)).toEqual({ ok: false, problems: ["start_block"] });
    expect(isXcp69Conformant({ ...UPPIES, block_index: 965849 }).ok).toBe(true);
  });

  it("schedules from the tip with the window the standard names", () => {
    expect(xcp69Schedule(966016, 3)).toEqual({ startBlock: 966019, deadlineBlock: 967019 });
    // Never at or before the tip.
    expect(xcp69Schedule(966016, 0).startBlock).toBe(966017);
  });

  it("composes exactly the template", () => {
    const p = xcp69ComposeParams({ asset: "MYLAUNCH", startBlock: 966019, lpAsset: "A95428956661682277" });
    expect(p.lot_price).toBe(XCP69.lot_price.toString());
    expect(p.soft_cap).toBe("6900000000000000");
    expect(p.pool_quantity).toBe("3100000000000000");
    expect(p.soft_cap_deadline_block).toBe("967019");
    expect(p.lock_description).toBe("true");
    expect(p.premint_quantity).toBe("0");
    expect(p.burn_payment).toBe("false");
    // A round trip through the node's field names satisfies the check.
    expect(
      matchesXcp69Template({
        price: p.lot_price,
        quantity_by_price: p.lot_size,
        hard_cap: p.hard_cap,
        soft_cap: p.soft_cap,
        pool_quantity: p.pool_quantity,
        premint_quantity: p.premint_quantity,
        max_mint_per_address: p.max_mint_per_address,
        divisible: true,
      }),
    ).toBe(true);
  });
});
