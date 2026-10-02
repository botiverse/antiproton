-- Usage per tenant, by the hour (usage dashboard; design by Nova, approved by tygg 2026-09-17).
-- Each agent's object sends its outbox (src/usage/outbox.ts) here once per turn; cf/src/usage-d1.ts
-- reads and writes it, and test/control-plane-d1.sh runs both.

-- No retention: nothing deletes or folds these rows yet. It grows with
-- tenants x agents x hours x (resource, key, unit). See README, "What is not done".
CREATE TABLE IF NOT EXISTS usage_hourly (
  tenant_id TEXT NOT NULL,
  hour      INTEGER NOT NULL,   -- start of the hour, ms since the epoch (UTC)
  agent_id  TEXT NOT NULL,
  resource  TEXT NOT NULL,      -- model.tokens, tool.call, js.run, ...
  key       TEXT NOT NULL,      -- which one within the resource
  unit      TEXT NOT NULL,      -- what quantity counts; one key may have several (calls and ms)
  quantity  REAL NOT NULL,
  PRIMARY KEY (tenant_id, hour, agent_id, resource, key, unit)
);

-- How far each agent's outbox has been counted. A send applies only if this still holds the value the
-- agent read, so a retried or doubled send counts nothing twice.
CREATE TABLE IF NOT EXISTS usage_cursor (
  tenant_id TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  last_seq  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
);

-- Credits per unit, from a date on. No row: free. Cost is worked out when read, so a price change never
-- rewrites what was used.
--
-- A key that is a SUBSET of another key (model.tokens' cache_write_1h of cache_write, reasoning of
-- output — pi-ai types the former "Subset of cacheWrite") is priced at the DIFFERENCE, not its own
-- rate: cache_write at the short-write rate, cache_write_1h at (long − short). Every cost reader is
-- a plain per-row price × quantity sum (cf/src/usage-d1.ts readUsage; the dashboard's money()), and
-- delta pricing keeps that sum correct — short×shortRate + subset×(longRate − shortRate) equals
-- pricing the parts separately, which is how pi's own cost function does it. Pricing a subset key
-- at its full rate double-counts it, because the total key already carries it.
-- Corollary for the wildcard below: priceFor tries an exact key before '*', so explicit rows
-- override the fallback — a resource that HAS subset keys (model.tokens) must give those keys
-- explicit delta-priced rows, and must never let '*' be their only price, or the wildcard
-- charges the subset at the full rate and the double count is back.
CREATE TABLE IF NOT EXISTS usage_prices (
  resource         TEXT NOT NULL,
  key              TEXT NOT NULL,  -- '*' for every key of the resource
  unit             TEXT NOT NULL,
  credits_per_unit REAL NOT NULL,
  effective_from   INTEGER NOT NULL,
  PRIMARY KEY (resource, key, unit, effective_from)
);
