-- Teleburn state (counters build reference v3 §10.3): the asset's one
-- unspendable address, and whether its ownership and supply have gone there.
-- Copied from the reference indexer on every sync, like `locked`; NULL until
-- the upstream carries it. The address is also derived in the web app from
-- the asset name, so a page never waits on this column for it.
ALTER TABLE counters ADD COLUMN teleburn_address TEXT;
ALTER TABLE counters ADD COLUMN teleburn_owner INTEGER;   -- owner is the address
ALTER TABLE counters ADD COLUMN teleburn_supply INTEGER;  -- no unit circulates outside it
ALTER TABLE counters ADD COLUMN teleburned INTEGER;       -- both, and the supply locked
