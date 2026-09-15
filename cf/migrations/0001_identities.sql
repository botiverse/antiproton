-- The control plane's first table: who may sign in with GitHub, and as which (tenant, agent).
--
-- It lived inside one agent object (tenant "demo", agent "identities") until task #18, and keeps the
-- columns it had there. Production's 17 rows were copied across once, on 2026-09-15; the object still
-- holds its old copy, and nothing reads it.
-- Depends on: nothing outside this repo. Read and written by cf/src/control-plane.ts: a column changed
-- here is changed there, and test/control-plane-d1.sh runs both against real D1.
CREATE TABLE IF NOT EXISTS identities (
  provider_key TEXT PRIMARY KEY,   -- github:<numeric id>, never the login, which can be renamed
  agent_id     TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  added_by     TEXT NOT NULL,      -- "automation" (the operator's route) or "self" (open sign-up)
  created_at   INTEGER NOT NULL    -- ms since the epoch
);

-- Counting and listing per tenant is what the control plane is for.
CREATE INDEX IF NOT EXISTS identities_by_tenant ON identities (tenant_id);
