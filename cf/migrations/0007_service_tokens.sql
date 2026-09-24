-- Service tokens (task #7): operator-issued, named, revocable credentials that stand where the
-- single QA key stood — a console identity each, never the operator.
--
-- Control-plane data, beside the API keys: who may present a token, and as which (tenant, agent).
-- Read and written by cf/src/control-plane.ts (d1ServiceTokens): a column changed here is changed
-- there, and test/control-plane-d1.sh runs both against real D1. Only the hash is stored; the
-- token is shown once, when it is issued (cf/src/service-tokens.ts).
CREATE TABLE IF NOT EXISTS service_tokens (
  hash         TEXT PRIMARY KEY,   -- SHA-256 of the token, hex (cf/src/agents-api/keys.ts hashApiKey)
  label        TEXT NOT NULL,      -- what the operator called it; shown as the viewer's name
  tenant_id    TEXT NOT NULL,
  agent_id     TEXT NOT NULL,      -- the agent this token is: one per token unless the operator pinned one
  created_at   INTEGER NOT NULL,   -- ms since the epoch
  revoked_at   INTEGER,            -- null while the token is live
  last_used_at INTEGER             -- written at most once an hour per token (d1ServiceTokens touch)
);
