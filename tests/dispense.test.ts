/**
 * Buying from a dispenser: what a number of lots costs and delivers.
 *
 * The fixtures are real dispensers — GAMESOFTRUMP's (3,000,000 sats for one
 * indivisible token) and LORDFUN's (5,500 sats for 1.00000000) — because the
 * lot is where people get it wrong: a payment short of one buys nothing.
 */

import { describe, expect, it } from "vitest";
import { dispenseTerms } from "../packages/counters/src/listing";

describe("what lots cost", () => {
  it("multiplies the lot, not the unit", () => {
    const t = dispenseTerms({ give_quantity: 1, satoshirate: 3_000_000, give_remaining: 5 }, 2);
    expect(t).toEqual({ lots: 2n, pay: 6_000_000n, receive: 2n, maxLots: 5n });
  });

  it("handles a divisible lot and big raw values losslessly", () => {
    const t = dispenseTerms({ give_quantity: "100000000", satoshirate: "5500", give_remaining: "12345678900000000" }, 3n);
    expect(t?.pay).toBe(16_500n);
    expect(t?.receive).toBe(300_000_000n);
    expect(t?.maxLots).toBe(123_456_789n);
  });

  it("knows when the remainder is unknown, and refuses a dispenser with no terms", () => {
    expect(dispenseTerms({ give_quantity: 1, satoshirate: 100 }, 1)?.maxLots).toBeNull();
    expect(dispenseTerms({ give_quantity: 0, satoshirate: 100 }, 1)).toBeNull();
    expect(dispenseTerms({ give_quantity: 1, satoshirate: 0 }, 1)).toBeNull();
    expect(dispenseTerms({ give_quantity: 1, satoshirate: 100 }, -3)?.lots).toBe(0n);
  });
});
