-- Whole days of usage, folded out of usage_hourly once they are old enough
-- (cf/src/usage-d1.ts, foldUsage). 0005 said of usage_hourly: "No retention:
-- nothing deletes or folds these rows yet." This is that fold.
--
-- Same columns as usage_hourly, with the bucket's name saying what it is: a
-- row here is a whole UTC day, not something that happened at midnight. The
-- alternative — rewriting a day's rows onto its 00:00Z hour, in place — needs
-- no table and no reader change, and that is exactly its defect: every reader
-- would then see a day's total sitting in an hour without anything saying so.
CREATE TABLE IF NOT EXISTS usage_daily (
  tenant_id TEXT NOT NULL,
  day       INTEGER NOT NULL,   -- start of the UTC day, ms since the epoch
  agent_id  TEXT NOT NULL,
  resource  TEXT NOT NULL,
  key       TEXT NOT NULL,
  unit      TEXT NOT NULL,
  quantity  REAL NOT NULL,
  PRIMARY KEY (tenant_id, day, agent_id, resource, key, unit)
);
