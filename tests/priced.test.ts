/**
 * The DEX filter: which denominations the book shows orders in.
 *
 * XCP alone by default — the orders a reader can rank against a pool's
 * quote — and everything else (the three hundred editions priced in their
 * parent, the odd order in BTC) only when asked for. The URL form stays out
 * of the address for the default and says `all` for everything, so the
 * plain home page is still `/`.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICED,
  PRICE_CLASSES,
  parsePriced,
  priceClass,
  pricedParam,
  togglePriced,
} from "../packages/counters/src/listing";

describe("what an order is priced in", () => {
  it("is XCP, or something else", () => {
    expect(priceClass("XCP")).toBe("xcp");
    expect(priceClass("BTC")).toBe("other");
    expect(priceClass("RARE.PEPE")).toBe("other");
    expect(priceClass("A8964522775354514455")).toBe("other");
  });

  it("reads the URL, falling back to what the caller shows by default", () => {
    expect(parsePriced(undefined, DEFAULT_PRICED)).toEqual(["xcp"]);
    expect(parsePriced(undefined)).toEqual([...PRICE_CLASSES]);         // the API: everything
    expect(parsePriced("all", DEFAULT_PRICED)).toEqual([...PRICE_CLASSES]);
    expect(parsePriced("other,xcp", DEFAULT_PRICED)).toEqual(["xcp", "other"]); // canonical order
    expect(parsePriced(" Other ", DEFAULT_PRICED)).toEqual(["other"]);
    expect(parsePriced("btc", DEFAULT_PRICED)).toEqual(["xcp"]);        // no such switch
    expect(parsePriced("", DEFAULT_PRICED)).toEqual(["xcp"]);
  });

  it("keeps the default out of the URL and says all for everything", () => {
    expect(pricedParam(["xcp"])).toBeNull();
    expect(pricedParam([...PRICE_CLASSES])).toBe("all");
    expect(pricedParam(["other"])).toBe("other");
  });

  it("flips one switch at a time, and no switch ticked means no filter", () => {
    expect(togglePriced(["xcp"], "other")).toEqual(["xcp", "other"]);
    expect(togglePriced(["xcp", "other"], "xcp")).toEqual(["other"]);
    expect(togglePriced(["xcp"], "xcp")).toEqual([...PRICE_CLASSES]);    // the explorer's rule
    expect(togglePriced([...PRICE_CLASSES], "other")).toEqual(["xcp"]);
    // A round trip through the URL lands where it left.
    const set = togglePriced(["xcp"], "other");
    expect(parsePriced(pricedParam(set) ?? undefined, DEFAULT_PRICED)).toEqual(set);
  });
});
