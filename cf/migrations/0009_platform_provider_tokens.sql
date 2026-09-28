-- Provider tokens gain a scope (tygg, 2026-09-28: one key per Raft deployment, configless on Raft's side).
--   tenant   — the token IS one tenant (as before): every agent it makes lives in tenant_id.
--   platform — the token stands for a whole Raft deployment: tenant_id is NULL and the tenant of each
--              request is derived from the Raft server it names (raft_<serverId>), created on first sight,
--              so isolation and billing still follow the server while Raft holds a single key.
-- SQLite cannot relax NOT NULL in place, so the table is rebuilt; rows carry over with scope 'tenant'.
CREATE TABLE provider_tokens_v2 (
  hash         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'tenant',   -- tenant | platform
  tenant_id    TEXT,                             -- the tenant, for scope tenant; NULL for platform
  raft_origin  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_used_at INTEGER
);
INSERT INTO provider_tokens_v2 (hash, label, scope, tenant_id, raft_origin, created_at, revoked_at, last_used_at)
  SELECT hash, label, 'tenant', tenant_id, raft_origin, created_at, revoked_at, last_used_at FROM provider_tokens;
DROP TABLE provider_tokens;
ALTER TABLE provider_tokens_v2 RENAME TO provider_tokens;
