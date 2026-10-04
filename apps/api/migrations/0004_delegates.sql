-- Counters that render another counter's file.
--
-- A delegate's own body is a reference — an inscription id, bare or inside a
-- small JSON object — and the protocol's explorer shows the *target's* file
-- in its place, with an optional display fragment on the URL: RARE.PEPE.5 is
-- 1 KB of JSON naming #219 RARE.PEPE's SVG and `edition-5`, the variant that
-- SVG shows when it is the `:target`. 300 counters are editions of that one
-- file, and without this they are 300 tiles of JSON.
--
-- Its own table rather than columns on `counters`, deliberately. Every read
-- on the site selects from `counters`, so a column the database does not
-- have yet fails every one of them; a table that is not there yet fails one
-- lookup, which is caught, and the editions show as JSON until it is.
--
-- The target's type and size are stored here as the counters server reports
-- them rather than joined for: they decide how the frame is sandboxed and
-- what it will download, and a delegate is only ever stored once resolved.
CREATE TABLE delegates (
  number         INTEGER PRIMARY KEY,   -- the delegate
  target_number  INTEGER NOT NULL,      -- the counter whose file it renders
  target_type    TEXT    NOT NULL,      -- that counter's content type
  target_size    INTEGER NOT NULL,      -- and byte length
  fragment       TEXT                   -- display fragment, without the '#'
);
