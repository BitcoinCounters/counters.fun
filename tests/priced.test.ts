/**
 * The DEX filter: which denominations the book shows orders in.
 *
 * XCP alone by default — the orders a reader can rank against a pool's
 * quote — and the three hundred editions priced in their parent only when
 * asked for. The URL form stays out of the address for the default and
 * says `all` for everything, so the plain home page is still `/`.
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
  it("names the three denominations", () => {
    expect(priceClass("XCP")).toBe("xcp");
    expect(priceClass("BTC")).toBe("btc");
    expect(priceClass("RARE.PEPE")).toBe("other");
    expect(priceClass("A8964522775354514455")).toBe("other");
  });

  it("reads the URL, falling back to what the caller shows by default", () => {
    expect(parsePriced(undefined, DEFAULT_PRICED)).toEqual(["xcp"]);
    expect(parsePriced(undefined)).toEqual([...PRICE_CLASSES]);         // the API: everything
    expect(parsePriced("all", DEFAULT_PRICED)).toEqual([...PRICE_CLASSES]);
    expect(parsePriced("btc,xcp", DEFAULT_PRICED)).toEqual(["xcp", "btc"]); // canonical order
    expect(parsePriced(" Other ", DEFAULT_PRICED)).toEqual(["other"]);
    expect(parsePriced("eur", DEFAULT_PRICED)).toEqual(["xcp"]);        // nothing recognised
    expect(parsePriced("", DEFAULT_PRICED)).toEqual(["xcp"]);
  });

  it("keeps the default out of the URL and says all for everything", () => {
    expect(pricedParam(["xcp"])).toBeNull();
    expect(pricedParam([...PRICE_CLASSES])).toBe("all");
    expect(pricedParam(["other", "xcp"])).toBe("xcp,other");
    expect(pricedParam(["btc"])).toBe("btc");
  });

  it("flips one switch at a time, and no switch ticked means no filter", () => {
    expect(togglePriced(["xcp"], "btc")).toEqual(["xcp", "btc"]);
    expect(togglePriced(["xcp", "btc"], "xcp")).toEqual(["btc"]);
    expect(togglePriced(["xcp"], "xcp")).toEqual([...PRICE_CLASSES]);    // the explorer's rule
    expect(togglePriced([...PRICE_CLASSES], "other")).toEqual(["xcp", "btc"]);
    // A round trip through the URL lands where it left.
    const set = togglePriced(togglePriced(["xcp"], "other"), "btc");
    expect(parsePriced(pricedParam(set) ?? undefined, DEFAULT_PRICED)).toEqual(set);
  });
});
