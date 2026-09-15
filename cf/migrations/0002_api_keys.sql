-- Agents API keys (task #17): which tenant and owner a bearer key speaks for.
--
-- Control-plane data, like the invitations beside it: who may call, and as whom. It lived in one agent
-- object (tenant "demo", agent "identities") while the Agents API was a branch; keys issued there are not
-- copied, since they were preview keys and every QA run issues its own.
-- Read and written by cf/src/control-plane.ts (d1ApiKeys): a column changed here is changed there, and
-- test/control-plane-d1.sh runs both against real D1. Only the hash is stored; the key is shown once.
CREATE TABLE IF NOT EXISTS api_keys (
  hash           TEXT PRIMARY KEY,   -- SHA-256 of the key, hex (cf/src/agents-api/keys.ts hashApiKey)
  tenant_id      TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL,
  label          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,   -- ms since the epoch
  revoked_at     INTEGER             -- null while the key is live
);

CREATE INDEX IF NOT EXISTS api_keys_by_tenant ON api_keys (tenant_id);
