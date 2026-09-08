-- counters.fun index: counters × pools × pool fairminters.
--
-- Two upstreams are joined here so the site can answer "which counters have
-- an XCP pool" in one query. Neither upstream can answer it: the counters
-- server knows nothing about markets, and Counterparty knows nothing about
-- counter numbers.
--
-- Quantities that can exceed 2^53 (supply, reserves, caps) are TEXT holding
-- decimal digits. SQLite INTEGER is 64-bit and would hold them, but they
-- arrive from JSON and leave as JSON, and a round-trip through a JS number
-- would round them silently. Blocks, sizes and counts stay INTEGER.

CREATE TABLE counters (
  number            INTEGER PRIMARY KEY,
  asset             TEXT    NOT NULL,
  asset_id          TEXT,
  asset_longname    TEXT,
  kind              TEXT    NOT NULL,          -- 'issuance' | 'fairminter'
  content_type      TEXT    NOT NULL,
  content_type_raw  TEXT,
  size              INTEGER NOT NULL,
  -- The rule. 1 = the description is a URL, not a file; never displayed.
  is_pointer_like   INTEGER NOT NULL,
  stamp_mime        TEXT,
  envelope          TEXT,
  owner             TEXT,
  source            TEXT,
  txid              TEXT    NOT NULL,
  msg_index         INTEGER NOT NULL,
  block             INTEGER NOT NULL,
  tx_index          INTEGER NOT NULL,
  sha256            TEXT,
  rolling_hash      TEXT,
  supply            TEXT,
  divisible         INTEGER,
  locked            INTEGER,
  burned            TEXT,
  fee               INTEGER,
  tx_size           INTEGER,
  xcp_burned        TEXT,
  body              TEXT,
  block_time        INTEGER,
  seen_at           INTEGER NOT NULL
);

-- Every listing filters on-chain first, then orders. The partial index keeps
-- the 98 pointer rows out of the hot path entirely rather than scanning past
-- them: on the live index that is 58% of the table.
CREATE INDEX counters_onchain_recent
  ON counters (block DESC, tx_index DESC) WHERE is_pointer_like = 0;
CREATE INDEX counters_onchain_size
  ON counters (size DESC) WHERE is_pointer_like = 0;
CREATE INDEX counters_asset ON counters (asset);

CREATE TABLE pools (
  asset_a       TEXT    NOT NULL,
  asset_b       TEXT    NOT NULL,
  lp_asset      TEXT    NOT NULL,
  reserve_a     TEXT    NOT NULL,
  reserve_b     TEXT    NOT NULL,
  -- The non-XCP side, denormalised so the join to counters is a plain
  -- equality rather than a CASE over both columns on every listing.
  token_asset   TEXT,
  source        TEXT,
  tx_hash       TEXT    NOT NULL,
  tx_index      INTEGER,
  block_index   INTEGER NOT NULL,
  block_time    INTEGER,
  -- Rollups, recomputed each sync. NULL until there is history to compute.
  volume_24h    TEXT,
  price         REAL,
  price_24h_ago REAL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (asset_a, asset_b)
);

CREATE INDEX pools_token ON pools (token_asset);

CREATE TABLE pool_matches (
  id          TEXT    PRIMARY KEY,   -- tx_hash:index, the API's natural key
  asset_a     TEXT    NOT NULL,
  asset_b     TEXT    NOT NULL,
  token_asset TEXT,
  block_index INTEGER NOT NULL,
  block_time  INTEGER,
  tx_hash     TEXT,
  source      TEXT,
  -- Signed from the token's point of view: forward = token bought with XCP.
  give_asset  TEXT,
  give_qty    TEXT,
  get_asset   TEXT,
  get_qty     TEXT
);

CREATE INDEX pool_matches_token_time ON pool_matches (token_asset, block_index DESC);

CREATE TABLE price_snapshots (
  token_asset TEXT    NOT NULL,
  block_index INTEGER NOT NULL,
  reserve_a   TEXT    NOT NULL,
  reserve_b   TEXT    NOT NULL,
  price       REAL,
  block_time  INTEGER,
  PRIMARY KEY (token_asset, block_index)
);

-- In-flight launches: fairminters that will open a pool at soft cap. Kept
-- whether or not the deploy is itself a counter, because `counter_number`
-- can only be filled once the counters server has numbered it, which lags
-- the fairminter by up to one sync tick.
CREATE TABLE fairminters (
  tx_hash                 TEXT PRIMARY KEY,
  asset                   TEXT    NOT NULL,
  asset_longname          TEXT,
  source                  TEXT,
  status                  TEXT    NOT NULL,
  description             TEXT,
  mime_type               TEXT,
  block_index             INTEGER,
  start_block             INTEGER,
  soft_cap_deadline_block INTEGER,
  hard_cap                TEXT,
  soft_cap                TEXT,
  pool_quantity           TEXT,
  lp_asset                TEXT,
  price                   TEXT,
  quantity_by_price       TEXT,
  max_mint_per_address    TEXT,
  premint_quantity        TEXT,
  earned_quantity         TEXT,
  paid_quantity           TEXT,
  divisible               INTEGER,
  -- Filled by the join; NULL means "not (yet) a counter".
  counter_number          INTEGER,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX fairminters_status ON fairminters (status, start_block);
CREATE INDEX fairminters_asset ON fairminters (asset);

-- Sync cursors and the cron lease. `withLock` expects this exact table.
CREATE TABLE chain_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
