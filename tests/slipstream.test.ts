/**
 * Slipstream rules, against responses the live API actually returns.
 *
 * The probe and rate values here were read off slipstream.mara.com directly: an
 * unauthenticated submit of `"00"` answers `400 {"status":"error","message":
 * "Failed to deserialize transaction"}` in about half a second, and `/api/rates`
 * published `submit_fee_rate: 1.0` against `effective_rate: 3.0` — a spread that
 * is exactly the case the two-rate rule exists for.
 */
import { describe, expect, it } from "vitest";
import {
  FULL_UPLOAD_SECONDS,
  MAX_WEIGHT,
  STANDARD_MAX_WEIGHT,
  classify,
  meetsFloor,
  parseRates,
  routeFor,
} from "../packages/counters/src/slipstream";

describe("classifying a submission response", () => {
  it("takes 200 and 201 as accepted", () => {
    expect(classify(200, '{"tx_id":"ab"}', 3)).toBe("accepted");
    expect(classify(201, "", 3)).toBe("accepted");
  });

  it("treats 'already known' as accepted, because resubmitting is the error", () => {
    expect(classify(400, "Transaction already known", 1)).toBe("accepted");
    expect(classify(400, "already in mempool", 1)).toBe("accepted");
  });

  it("stops on a real rejection", () => {
    expect(classify(400, "Failed to deserialize transaction", 0.4)).toBe("rejected");
    // The refusal a reveal gets when its commit is only in the public mempool.
    expect(classify(400, "Fee rate of 0 is below the threshold", 1.2)).toBe("rejected");
  });

  it("reads a 524 after a full upload as probably accepted", () => {
    // Every accepted large submission looked like this: Cloudflare gives up
    // while the origin is still validating a body it already has.
    expect(classify(524, "error", 126)).toBe("probably-accepted");
    expect(classify(524, "", FULL_UPLOAD_SECONDS + 0.1)).toBe("probably-accepted");
  });

  it("reads a FAST 524 as ambiguous — the body never landed", () => {
    expect(classify(524, "error", 12)).toBe("ambiguous");
    expect(classify(524, "", FULL_UPLOAD_SECONDS)).toBe("ambiguous");
  });

  it("keeps 'not found' ambiguous rather than fatal", () => {
    // Slipstream has reported this for transactions that later mined.
    expect(classify(400, "Transaction not found", 0.5)).toBe("ambiguous");
  });

  it("keeps timeouts and dead connections ambiguous", () => {
    expect(classify(408, "timeout", 30)).toBe("ambiguous");
    expect(classify(502, "bad gateway", 5)).toBe("ambiguous");
    expect(classify(null, "TypeError: fetch failed", 5)).toBe("ambiguous");
  });
});

describe("reading the two rates", () => {
  it("keeps the floor and the mineable rate apart", () => {
    const r = parseRates({
      submit_fee_rate: 1.0,
      effective_rate: 3.0,
      market_rate: 3.0,
      multiplier: 1.0,
    });
    expect(r.submitFloor).toBe(1.0);
    expect(r.mineable).toBe(3.0);
    // Paying 1.0 here is accepted and then waits — it must not be rounded up.
    expect(meetsFloor(1.0, r)).toBe(true);
    expect(meetsFloor(0.999, r)).toBe(false);
  });

  it("falls back to the mineable rate when no floor is published", () => {
    // Erring toward overpaying beats erring toward rejection.
    const r = parseRates({ effective_rate: 2.5 });
    expect(r.submitFloor).toBe(2.5);
    expect(r.marketRate).toBeNull();
  });

  it("refuses a response with no effective_rate", () => {
    expect(() => parseRates({ submit_fee_rate: 1 })).toThrow(/effective_rate/);
    expect(() => parseRates({})).toThrow(/effective_rate/);
  });
});

describe("which route a reveal can take", () => {
  it("sends standard weights down the public network", () => {
    expect(routeFor(452)).toBe("public");
    expect(routeFor(STANDARD_MAX_WEIGHT)).toBe("public");
  });

  it("requires Slipstream past the standard relay cap", () => {
    expect(routeFor(STANDARD_MAX_WEIGHT + 1)).toBe("slipstream-only");
    expect(routeFor(1_500_000)).toBe("slipstream-only");
    expect(routeFor(MAX_WEIGHT)).toBe("slipstream-only");
  });

  it("refuses what nothing can carry", () => {
    expect(routeFor(MAX_WEIGHT + 1)).toBe("too-large");
  });
});
