-- Provisioning (raft-agent-provider.v1, 2026-09-28): Raft creates an agent on antiproton and runs it,
-- with no hand in between. Two control-plane tables, read and written by cf/src/control-plane.ts
-- (d1ProviderTokens, d1ProvisionedAgents); a column changed here is changed there, and
-- test/control-plane-d1.sh runs both against real D1.
--
-- A provider token IS a tenant: Raft holds one per server and never sends a tenant id. It is bound to
-- the Raft origin it was minted for, so a mount it creates can only ever point at that Raft, and a
-- leaked token cannot aim an agent's credential at another address. Only the hash is stored; the
-- token is shown once, when it is issued (cf/src/provider-token.ts).
CREATE TABLE IF NOT EXISTS provider_tokens (
  hash         TEXT PRIMARY KEY,   -- SHA-256 of the token, hex (cf/src/agents-api/keys.ts hashApiKey)
  label        TEXT NOT NULL,      -- what the operator called it, e.g. the Raft server's name
  tenant_id    TEXT NOT NULL,
  raft_origin  TEXT NOT NULL,      -- the only serverUrl a mount made under this token may carry
  created_at   INTEGER NOT NULL,   -- ms since the epoch
  revoked_at   INTEGER,            -- null while the token is live
  last_used_at INTEGER             -- written at most once an hour per token
);

-- One row per Raft agent the provider made: the Raft id it answers to, the antiproton agent it is,
-- and what Raft asked for, so a replay of the same request can be told from a different one (409).
-- The credential is never here: it is sealed in the agent's own object.
CREATE TABLE IF NOT EXISTS provisioned_agents (
  tenant_id       TEXT NOT NULL,
  raft_agent_id   TEXT NOT NULL,
  agent_id        TEXT NOT NULL,           -- raft_<raft_agent_id>, deterministic (provision/handlers.ts)
  raft_server_id  TEXT NOT NULL,
  raft_origin     TEXT NOT NULL,
  name            TEXT NOT NULL,
  instructions    TEXT NOT NULL,
  status          TEXT NOT NULL,           -- provisioning | active | deleted
  push_registered INTEGER NOT NULL DEFAULT 0,
  push_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  PRIMARY KEY (tenant_id, raft_agent_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS provisioned_agents_by_agent ON provisioned_agents(tenant_id, agent_id);
