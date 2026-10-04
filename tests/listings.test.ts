/**
 * The DEX and dispenser venues' arithmetic: what an open order or dispenser
 * costs per whole counter, which name it is found under, and which of
 * several offers is the best ask.
 *
 * The fixtures are live offers — GAMESOFTRUMP's dispenser, MEMEPOW's asks,
 * the DUALPEPE↔MEMEPOW order — because the interesting cases here are the
 * ones the chain actually produced: an indivisible lot, a divisible one, and
 * an order whose *both* sides are counters.
 */

import { describe, expect, it } from "vitest";
import { ledgerAssetName } from "../packages/counters/src/counter";
import {
  bestAsk,
  denominationRank,
  listingFromDispenser,
  listingFromOrder,
  unitPrice,
  type Listing,
} from "../packages/counters/src/listing";

const CP = process.env.COUNTERPARTY_API_BASE ?? "http://127.0.0.1:4000";

describe("what an offer costs", () => {
  it("prices a lot by the units in it, not by the lot", () => {
    // #158 GAMESOFTRUMP: 3,000,000 sats buys one indivisible token.
    expect(
      listingFromDispenser(
        { tx_hash: "a", block_index: 966817, asset: "GAMESOFTRUMP", give_quantity: 1, satoshirate: 3_000_000 },
        false,
      ),
    ).toMatchObject({ side: "ask", price: 0.03, price_asset: "BTC", kind: "dispenser" });

    // #188 LORDFUN: 5,500 sats buys 1.00000000 of a divisible token, so the
    // lot is 1e8 raw and the price per whole token is the same 5,500 sats.
    // Dividing by the raw lot instead would price it at 5.5e-13 BTC.
    expect(
      listingFromDispenser(
        { tx_hash: "b", block_index: 967323, asset: "LORDFUN", give_quantity: "100000000", satoshirate: 5_500 },
        true,
      )?.price,
    ).toBeCloseTo(0.000055, 12);
  });

  it("reads an order from the counter's side of it", () => {
    // MEMEPOW gives 2 for 60 XCP — an ask at 30 XCP each.
    const ask = listingFromOrder(
      {
        tx_hash: "c",
        block_index: 961372,
        give_asset: "MEMEPOW",
        give_quantity: 2,
        give_remaining: 2,
        get_asset: "XCP",
        get_quantity: "6000000000",
        get_remaining: "6000000000",
        give_asset_divisible: false,
        get_asset_divisible: true,
      },
      "MEMEPOW",
      false,
    );
    expect(ask).toMatchObject({ side: "ask", price: 30, price_asset: "XCP", remaining: 2 });

    // The same order book seen from the other direction: 5 XCP offered for 1
    // MEMEPOW is a bid at 5, and the price is still XCP per whole MEMEPOW.
    const bid = listingFromOrder(
      {
        tx_hash: "d",
        block_index: 967334,
        give_asset: "XCP",
        give_quantity: "500000000",
        give_remaining: "500000000",
        get_asset: "MEMEPOW",
        get_quantity: 1,
        get_remaining: 1,
        give_asset_divisible: true,
        get_asset_divisible: false,
      },
      "MEMEPOW",
      false,
    );
    expect(bid).toMatchObject({ side: "bid", price: 5, price_asset: "XCP" });

    // An order that names neither side of this counter is not its listing.
    expect(
      listingFromOrder(
        { tx_hash: "e", block_index: 1, give_asset: "XCP", give_quantity: 1, get_asset: "PEPECASH", get_quantity: 1 },
        "MEMEPOW",
        false,
      ),
    ).toBeNull();
  });

  it("makes two listings out of one order between two counters", () => {
    // #4 DUALPEPE for #135 MEMEPOW, one for one. It is an ask on DUALPEPE and
    // a bid on MEMEPOW — the same tx_hash, two different offers. Keyed by
    // tx_hash alone in D1 they overwrite each other and the offered counter
    // vanishes from the section, which is why `listings` is keyed by
    // (id, token_asset).
    const order = {
      tx_hash: "f",
      block_index: 961441,
      give_asset: "DUALPEPE",
      give_quantity: 1,
      give_remaining: 1,
      get_asset: "MEMEPOW",
      get_quantity: 1,
      get_remaining: 1,
      give_asset_divisible: false,
      get_asset_divisible: false,
    };

    const asDualpepe = listingFromOrder(order, "DUALPEPE", false)!;
    const asMemepow = listingFromOrder(order, "MEMEPOW", false)!;

    expect(asDualpepe).toMatchObject({ side: "ask", price_asset: "MEMEPOW", token_asset: "DUALPEPE" });
    expect(asMemepow).toMatchObject({ side: "bid", price_asset: "DUALPEPE", token_asset: "MEMEPOW" });
    expect(asDualpepe.id).toBe(asMemepow.id);
  });

  it("finds a subasset's offers under the name the ledger uses", () => {
    // #219 RARE.PEPE is `A8964522775354514455` on the ledger, and that is the
    // name in every order and dispenser on it. Asked for by the dotted name,
    // Core returns an empty list — the site showed none of its three
    // dispensers or the 268 orders that want it.
    expect(ledgerAssetName({ asset: "RARE.PEPE", asset_id: "8964522775354514455" })).toBe(
      "A8964522775354514455",
    );
    // Anything without a dot is already its own ledger name.
    expect(ledgerAssetName({ asset: "MEMEPOW", asset_id: "30279039522" })).toBe("MEMEPOW");
    expect(
      ledgerAssetName({ asset: "A18189972090142917414", asset_id: "18189972090142917414" }),
    ).toBe("A18189972090142917414");

    // #224 RARE.PEPE.5, offered one for one RARE.PEPE.
    const order = {
      tx_hash: "g",
      block_index: 968740,
      give_asset: "A12967860361007831721",
      give_quantity: 1,
      give_remaining: 1,
      get_asset: "A8964522775354514455",
      get_quantity: 1,
      get_remaining: 1,
      give_asset_divisible: false,
      get_asset_divisible: false,
      give_asset_info: { asset_longname: "RARE.PEPE.5" },
      get_asset_info: { asset_longname: "RARE.PEPE" },
    };

    // By the dotted name the order matches neither side and is dropped.
    expect(listingFromOrder(order, "RARE.PEPE.5", false)).toBeNull();
    // By the ledger name it is an ask, and the price is labelled the way a
    // person reads the asset rather than by its number.
    expect(listingFromOrder(order, "A12967860361007831721", false)).toMatchObject({
      side: "ask",
      price: 1,
      price_asset: "RARE.PEPE",
    });
    expect(listingFromOrder(order, "A8964522775354514455", false)).toMatchObject({
      side: "bid",
      price_asset: "RARE.PEPE.5",
    });
  });

  it("keeps twelve figures on quantities past 2^53", () => {
    // MEMENOME's open ask: 800,000 divisible tokens for 15.73956024 XCP.
    expect(unitPrice("1573956024", true, "80000000000000", true)).toBeCloseTo(1.967445e-5, 12);
    // Nothing to price is null rather than zero.
    expect(unitPrice(0, true, 100, false)).toBeNull();
    expect(unitPrice(100, true, 0, false)).toBeNull();
  });
});

describe("which offer a card quotes", () => {
  const ask = (price: number, price_asset: string): Listing => ({
    id: `${price_asset}-${price}`,
    kind: "order",
    token_asset: "T",
    side: "ask",
    price,
    price_asset,
    remaining: null,
    source: null,
    block_index: 1,
  });

  it("prefers a denomination the reader can compare, then the cheaper offer", () => {
    expect(denominationRank("XCP")).toBeLessThan(denominationRank("BTC"));
    expect(denominationRank("BTC")).toBeLessThan(denominationRank("PEPECASH"));

    // A cheap-looking BTC number does not beat an XCP one: they are not
    // comparable, and every other price on the site is in XCP.
    expect(bestAsk([ask(0.00005, "BTC"), ask(30, "XCP")])).toMatchObject({ price_asset: "XCP" });
    expect(bestAsk([ask(2, "XCP"), ask(0.5, "XCP")])).toMatchObject({ price: 0.5 });
    expect(bestAsk([ask(1, "MEMEPOW"), ask(0.03, "BTC")])).toMatchObject({ price_asset: "BTC" });
  });

  it("never quotes a bid as a price to buy at", () => {
    const bid: Listing = { ...ask(5, "XCP"), side: "bid", id: "bid" };
    expect(bestAsk([bid])).toBeNull();
    expect(bestAsk([bid, ask(30, "XCP")])).toMatchObject({ price: 30 });
    expect(bestAsk([])).toBeNull();
  });
});

describe("against the live node", () => {
  it("reads open offers on a counter and prices every one of them", async () => {
    // GAMESOFTRUMP has carried a dispenser and an order since block 966,817.
    // The assertion is deliberately about shape rather than about a
    // particular offer: makers cancel, and a test that pins one price fails
    // for the wrong reason.
    const [orders, dispensers] = await Promise.all([
      fetch(`${CP}/v2/assets/GAMESOFTRUMP/orders?status=open&limit=50`).then((r) => r.json()),
      fetch(`${CP}/v2/assets/GAMESOFTRUMP/dispensers?status=open&limit=50`).then((r) => r.json()),
    ]);

    const listings = [
      ...(orders.result ?? []).map((o: never) => listingFromOrder(o, "GAMESOFTRUMP", false)),
      ...(dispensers.result ?? []).map((d: never) => listingFromDispenser(d, false)),
    ].filter((l): l is Listing => l !== null);

    expect(listings.length).toBeGreaterThan(0);
    for (const listing of listings) {
      expect(listing.token_asset).toBe("GAMESOFTRUMP");
      expect(listing.price).toBeGreaterThan(0);
      expect(listing.price_asset).not.toBe("GAMESOFTRUMP");
      expect(Number.isFinite(listing.price)).toBe(true);
    }

    // A dispenser is always an ask, whoever opened it.
    for (const listing of listings.filter((l) => l.kind === "dispenser")) {
      expect(listing.side).toBe("ask");
      expect(listing.price_asset).toBe("BTC");
    }
  }, 30_000);
});
