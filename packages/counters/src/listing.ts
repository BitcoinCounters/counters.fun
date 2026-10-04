/**
 * Counterparty's other two venues: the order book and dispensers.
 *
 * A pool quotes any size at a price consensus derives from reserves. A
 * listing is narrower and older than that — one person's standing offer, for
 * a stated quantity, at a price they chose. Both are ways to buy a counter
 * without opening a pool yourself, and a counter can have all three at once.
 *
 * Two things about this data resist the rest of the site's shape, and both
 * are carried rather than hidden:
 *
 * 1. **A listing is not necessarily priced in XCP.** Every price elsewhere on
 *    counters.fun is XCP per whole token, because a pool's pair is always
 *    XCP. An order's maker picks the pair — #158 GAMESOFTRUMP is offered for
 *    PEPECASH, #4 DUALPEPE for MEMEPOW — and a dispenser always prices in
 *    BTC. So a listing's price travels with the asset it is denominated in,
 *    and nothing here converts between them. A number in one unit shown in
 *    another is a lie, and the conversion rate would have to come from off
 *    this chain.
 * 2. **The two venues settle differently.** A dispenser vends on payment with
 *    no counterparty to wait for; an order rests until someone takes the
 *    other side, and a BTC-give order can expire unpaid. `kind` keeps them
 *    distinguishable rather than flattening both into "for sale".
 */

import { big, type Raw, type RawLike } from "./numeric";

export type ListingKind = "order" | "dispenser";

/**
 * Which way the offer points, from the counter's side.
 *
 * `ask` is someone selling the counter — the number a buyer pays. `bid` is
 * someone bidding for it. A dispenser is always an ask: it vends its escrow
 * and takes BTC.
 */
export type ListingSide = "ask" | "bid";

/** An open order, as `/v2/assets/<asset>/orders?status=open` returns it. */
export interface OrderRow {
  tx_hash: string;
  block_index: number;
  source?: string | null;
  give_asset: string;
  give_quantity: Raw;
  give_remaining?: Raw | null;
  get_asset: string;
  get_quantity: Raw;
  get_remaining?: Raw | null;
  give_asset_divisible?: boolean | null;
  get_asset_divisible?: boolean | null;
  /** Present on a verbose read. The longname is what a subasset is called. */
  give_asset_info?: { asset_longname?: string | null } | null;
  get_asset_info?: { asset_longname?: string | null } | null;
  expire_index?: number | null;
  status?: string;
}

/** An open dispenser, as `/v2/assets/<asset>/dispensers?status=open` returns it. */
export interface DispenserRow {
  tx_hash: string;
  block_index: number;
  source?: string | null;
  origin?: string | null;
  asset: string;
  /** Raw units vended per payment — the lot. */
  give_quantity: Raw;
  give_remaining?: Raw | null;
  /** Satoshis charged per lot. */
  satoshirate: Raw;
  status?: number | string;
}

export interface Listing {
  /** The venue's own transaction hash — stable, and its natural key. */
  id: string;
  kind: ListingKind;
  /** The counter this offer is for. */
  token_asset: string;
  side: ListingSide;
  /**
   * Price in `price_asset` per *whole* counter unit. The same "per whole
   * token" convention as a pool's price, and it carries the same divisibility
   * trap: a divisible asset's raw unit is 1e-8 of a whole one.
   */
  price: number;
  /**
   * What the price is denominated in — 'XCP', 'BTC', or any asset a maker
   * chose. A subasset is named the way a person reads it, `RARE.PEPE` rather
   * than its numeric ledger name: this is a label on a number, and nothing
   * is composed from it.
   */
  price_asset: string;
  /** Raw counter units still on offer. */
  remaining: Raw | null;
  source: string | null;
  block_index: number;
}

/** Counterparty's own name for bitcoin, which is never an asset in a pool. */
export const BTC = "BTC";

const SCALE = 1_000_000_000_000n;
const SCALE_NUM = 1e12;

const unit = (divisible: boolean): bigint => (divisible ? 100_000_000n : 1n);

/**
 * `quote` per one whole unit of `base`, as a double.
 *
 * The same shape as `priceFromReserves` in ./pool, and for the same reason:
 * both operands can exceed 2^53 (MEMENOME's open ask is 8×10^13 raw), so the
 * division happens in bigint against a fixed scale and only the result
 * becomes a Number. Null rather than 0 when either side is empty — an offer
 * of nothing has no price.
 */
export function unitPrice(
  quoteRaw: RawLike,
  quoteDivisible: boolean,
  baseRaw: RawLike,
  baseDivisible: boolean,
): number | null {
  const quote = big(quoteRaw);
  const base = big(baseRaw);
  if (quote <= 0n || base <= 0n) return null;
  // (quote / quoteUnit) / (base / baseUnit) = quote * baseUnit / (base * quoteUnit)
  return Number((quote * unit(baseDivisible) * SCALE) / (base * unit(quoteDivisible))) / SCALE_NUM;
}

/**
 * One open order, seen from a counter's side — or null when the order does
 * not involve it at all.
 *
 * `tokenAsset` is the counter's *ledger* name (`ledgerAssetName` in
 * ./counter), because that is what `give_asset` and `get_asset` hold; for a
 * subasset the dotted name matches neither side and the order would be
 * dropped as somebody else's.
 *
 * Which side the counter is on decides everything: an order *giving* the
 * counter is an ask priced in what it asks for, and one *getting* it is a bid
 * priced in what it offers. Divisibility comes from the row (Core sends
 * `give_asset_divisible` / `get_asset_divisible` on both the per-asset and
 * the chain-wide route); when it is absent the caller's knowledge of the
 * counter is used for the counter's side and the other side is assumed
 * divisible, which is true of XCP and of every asset with a pool.
 */
export function listingFromOrder(
  order: OrderRow,
  tokenAsset: string,
  tokenDivisible: boolean,
): Listing | null {
  const giving = order.give_asset === tokenAsset;
  const getting = order.get_asset === tokenAsset;
  // A pair of the counter against itself is not a thing Core will compose,
  // and an order naming neither side belongs to another asset entirely.
  if (giving === getting) return null;

  const counterDivisible =
    (giving ? order.give_asset_divisible : order.get_asset_divisible) ?? tokenDivisible;
  const otherDivisible = (giving ? order.get_asset_divisible : order.give_asset_divisible) ?? true;

  const price = giving
    ? unitPrice(order.get_quantity, otherDivisible, order.give_quantity, counterDivisible)
    : unitPrice(order.give_quantity, otherDivisible, order.get_quantity, counterDivisible);
  if (price === null) return null;

  return {
    id: order.tx_hash,
    kind: "order",
    token_asset: tokenAsset,
    side: giving ? "ask" : "bid",
    price,
    price_asset: giving
      ? (order.get_asset_info?.asset_longname ?? order.get_asset)
      : (order.give_asset_info?.asset_longname ?? order.give_asset),
    // What is left on the counter's side of the offer, which for a bid is
    // what the maker still wants rather than what they hold.
    remaining: (giving ? order.give_remaining : order.get_remaining) ?? null,
    source: order.source ?? null,
    block_index: order.block_index,
  };
}

/**
 * One open dispenser as an ask in BTC.
 *
 * `satoshirate` is per *lot*, not per unit, and the lot is `give_quantity`
 * raw units — so LORDFUN's 5,500 sats buys 1.00000000 LORDFUN and
 * GAMESOFTRUMP's 3,000,000 buys exactly one indivisible token. Dividing by
 * the lot is what makes the two comparable, and satoshis are BTC's raw unit
 * on the same 1e8 scale every divisible asset uses.
 */
export function listingFromDispenser(
  dispenser: DispenserRow,
  tokenDivisible: boolean,
): Listing | null {
  const price = unitPrice(dispenser.satoshirate, true, dispenser.give_quantity, tokenDivisible);
  if (price === null) return null;

  return {
    id: dispenser.tx_hash,
    kind: "dispenser",
    token_asset: dispenser.asset,
    side: "ask",
    price,
    price_asset: BTC,
    remaining: dispenser.give_remaining ?? null,
    // `origin` is the address that opened it; `source` on a refilled
    // dispenser is the last transaction's sender, which is not the operator.
    source: dispenser.origin ?? dispenser.source ?? null,
    block_index: dispenser.block_index,
  };
}

/**
 * How the site ranks denominations when it has to pick one ask to show.
 *
 * XCP first because every other price on the site is in XCP and a reader
 * comparing cards is comparing XCP; BTC next because a dispenser is the
 * firmest offer there is — it vends on payment. Anything else is a real
 * offer in a unit nobody can rank against the others, so it sorts last and
 * is shown with its unit spelled out.
 */
export function denominationRank(asset: string): number {
  if (asset === "XCP") return 0;
  if (asset === BTC) return 1;
  return 2;
}

/**
 * The ask a card should show: cheapest, preferring the denomination a reader
 * can compare. Bids are ignored — a card states what it costs to buy, and a
 * bid is what someone else would pay.
 */
export function bestAsk(listings: readonly Listing[]): Listing | null {
  let best: Listing | null = null;
  for (const listing of listings) {
    if (listing.side !== "ask") continue;
    if (best === null) {
      best = listing;
      continue;
    }
    const rank = denominationRank(listing.price_asset) - denominationRank(best.price_asset);
    if (rank < 0 || (rank === 0 && listing.price < best.price)) best = listing;
  }
  return best;
}
