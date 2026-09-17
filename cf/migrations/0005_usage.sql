-- Usage per tenant, by the hour (usage dashboard; design by Nova, approved by tygg 2026-09-17).
-- Each agent's object sends its outbox (src/usage/outbox.ts) here once per turn; cf/src/usage-d1.ts
-- reads and writes it, and test/control-plane-d1.sh runs both.

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
CREATE TABLE IF NOT EXISTS usage_prices (
  resource         TEXT NOT NULL,
  key              TEXT NOT NULL,  -- '*' for every key of the resource
  unit             TEXT NOT NULL,
  credits_per_unit REAL NOT NULL,
  effective_from   INTEGER NOT NULL,
  PRIMARY KEY (resource, key, unit, effective_from)
);
