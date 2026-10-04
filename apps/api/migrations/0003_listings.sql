-- Counterparty's other two venues: open orders and open dispensers, for the
-- assets that are counters.
--
-- A pool row is a fact about consensus — reserves, one pair, one price. A
-- listing is one person's standing offer, and there can be several per
-- counter in units that cannot be compared with each other (XCP, BTC,
-- PEPECASH, another counter). So the denomination is stored per row and
-- nothing converts between them; see packages/counters/src/listing.ts.

CREATE TABLE listings (
  -- The venue's own tx_hash, which is not unique on its own: one order can
  -- name a counter on *both* sides — #4 DUALPEPE is offered for #135 MEMEPOW
  -- today — and that is genuinely two listings, an ask on one counter and a
  -- bid on the other. Keyed by tx_hash alone the second write overwrites the
  -- first, and the counter that was offered disappears from the section.
  id           TEXT    NOT NULL,
  kind         TEXT    NOT NULL,          -- 'order' | 'dispenser'
  -- The counter the offer is on, by the name `counters.asset` holds — for a
  -- subasset that is RARE.PEPE, not the numeric name the ledger files it
  -- under, so that every join against `counters` is a plain equality.
  token_asset  TEXT    NOT NULL,
  side         TEXT    NOT NULL,          -- 'ask' | 'bid'; a dispenser is always an ask
  -- Price in `price_asset` per *whole* counter unit, on the same convention
  -- as pools.price. REAL because it is for display and ordering only —
  -- nothing is ever composed from it.
  price        REAL    NOT NULL,
  price_asset  TEXT    NOT NULL,          -- 'XCP' | 'BTC' | whatever the maker chose
  -- Raw counter units still on offer. TEXT for the same reason every other
  -- quantity here is: 10^16 raw rounds during JSON.parse, not after.
  remaining    TEXT,
  source       TEXT,
  block_index  INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (id, token_asset)
);

-- Every read is "the open offers for this counter, cheapest comparable ask
-- first", which is exactly this index.
CREATE INDEX listings_token ON listings (token_asset, side, price);

-- When each asset was last asked about.
--
-- The sweep is per asset and Counterparty has no bulk route narrow enough to
-- use instead: chain-wide there are ~2,600 open orders and ~26,000 open
-- dispensers, against a few hundred counter assets. Each tick reads the
-- assets with no row here first, then the stalest. A missing row is how an
-- asset is marked due: a brand-new counter has none, and the sync deletes the
-- row of any asset a block's order or dispenser events named (NULL sorts
-- first).
CREATE TABLE listing_sweeps (
  asset       TEXT    PRIMARY KEY,
  checked_at  INTEGER NOT NULL
);
