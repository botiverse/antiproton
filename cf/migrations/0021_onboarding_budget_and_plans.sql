-- Two inputs to the daily spend limits (cf/src/spend-limit.ts; docs/metering.md, "Daily limits") that only Raft knows.

-- Which daily budget a provisioned agent's spend is charged to, from its creating POST (`budget`): 'onboarding' is the
-- platform-paid onboarding pool, which neither the tenant's limit nor the platform limit counts; NULL is the tenant's
-- own, as for every row made before this column existed. Fixed at creation: a replay must repeat it, nothing updates it.
ALTER TABLE provisioned_agents ADD COLUMN budget TEXT;

-- An admin's override of a pool's daily limit (today only 'onboarding'), as spend_limits is for a tenant's. No row: the
-- deployment's var (ONBOARDING_DAILY_LIMIT_USD). `limit_usd` NULL: no limit for the pool.
CREATE TABLE IF NOT EXISTS spend_pool_limits (
  pool      TEXT PRIMARY KEY,
  limit_usd REAL,
  set_by    TEXT NOT NULL,
  set_at    INTEGER NOT NULL   -- ms since the epoch
);

-- Every set and clear of a pool's override, kept, as spend_limit_events keeps a tenant's. Never updated or deleted.
CREATE TABLE IF NOT EXISTS spend_pool_limit_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  pool      TEXT NOT NULL,
  action    TEXT NOT NULL,     -- 'set' or 'clear'
  limit_usd REAL,              -- the new limit for 'set' (NULL: unlimited); NULL for 'clear'
  previous  TEXT NOT NULL,     -- JSON: {"limitUsd": number|null} when a row was replaced or cleared, {} when there was none
  by        TEXT NOT NULL,
  at        INTEGER NOT NULL
);

-- The Raft server's plan, as Raft last said it (`plan` on POST /provision/agents, PUT /provision/servers/:id/plan): it
-- picks the tenant's default daily limit. No row: 'free'. One row per tenant, the latest write wins.
CREATE TABLE IF NOT EXISTS tenant_plans (
  tenant_id TEXT PRIMARY KEY,
  plan      TEXT NOT NULL,     -- 'free' or 'pro'
  set_by    TEXT NOT NULL,     -- the provider token's hash, as the provider routes' audit lines name it
  set_at    INTEGER NOT NULL
);
