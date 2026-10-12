-- Daily spend limits (credits phase 2): a per-tenant limit with an admin's override, and a platform-wide one.
-- The limits themselves are deployment vars (DAILY_LIMIT_USD, PLATFORM_DAILY_LIMIT_USD,
-- DAILY_LIMIT_EXEMPT_TENANTS); only an admin's per-tenant override is stored. Read and written by
-- cf/src/spend-limit.ts; docs/metering.md, "Daily limits", says what is counted and when a call is refused.

-- One row per tenant whose limit is not the deployment's default. `limit_usd` NULL: no per-tenant limit at all
-- (the platform limit still applies). No row: DAILY_LIMIT_USD.
CREATE TABLE IF NOT EXISTS spend_limits (
  tenant_id TEXT PRIMARY KEY,
  limit_usd REAL,
  set_by    TEXT NOT NULL,
  set_at    INTEGER NOT NULL   -- ms since the epoch
);

-- Every set and clear, kept: who moved a tenant's limit, from what, to what. Never updated or deleted.
CREATE TABLE IF NOT EXISTS spend_limit_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  action    TEXT NOT NULL,     -- 'set' or 'clear'
  limit_usd REAL,              -- the new limit for 'set' (NULL: unlimited); NULL for 'clear'
  previous  TEXT NOT NULL,     -- JSON: {"limitUsd": number|null} when a row was replaced or cleared, {} when there was none
  by        TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_limit_events_by_tenant ON spend_limit_events (tenant_id, at);

-- The platform total reads one UTC day of every tenant's hours; the primary key leads with the tenant, so
-- without this that read is a scan of every hour kept (KEEP_HOURLY_DAYS).
CREATE INDEX IF NOT EXISTS usage_hourly_by_hour ON usage_hourly (hour);
