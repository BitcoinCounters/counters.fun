-- Counters that name an icon: a small picture for the places too small for
-- the file itself — a row in the order book, a badge by a name.
--
-- An asset-info JSON counter may carry an `images` entry of type `icon`
-- naming an ordinals inscription (every RARE.PEPE edition does: a 48×48 PNG,
-- seventy to a reveal). The counters server reads those bytes out of the
-- inscription's reveal witness through its own bitcoind and serves them as
-- /icon/<n>; the proxy here re-serves them from R2. Nothing in this path
-- touches the gateway the JSON's URL names, so the rule holds: the icon is
-- shown because it is on Bitcoin.
--
-- Without it, every RARE.PEPE.N row on the DEX framed the 3.96 MB SVG the
-- edition delegates to, three hundred times down the page.
--
-- Its own table, for the reason 0004 gives: a read on `counters` must not
-- fail for a column a deploy is ahead of.
CREATE TABLE icons (
  number         INTEGER PRIMARY KEY,   -- the counter
  inscription_id TEXT    NOT NULL       -- <txid>i<n> of the icon's inscription
);
