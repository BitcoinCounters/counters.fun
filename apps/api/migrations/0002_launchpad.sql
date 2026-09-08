-- Which launchpad a counter's deploy came through ('xcp.fun'), or NULL.
-- Written by the sync from the fairminter's shape and description (see
-- packages/counters/src/launchpad.ts); read straight off the row.
ALTER TABLE counters ADD COLUMN launchpad TEXT;
CREATE INDEX counters_launchpad ON counters (launchpad);
