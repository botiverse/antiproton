-- A tenant's connections to other services (GitHub first), shared by its agents. One person goes through
-- the provider's authorization once; any agent of the tenant can then be pointed at the connection by its
-- creator or a server admin (Raft checks that; the handler re-checks the creator). The credential is sealed
-- with SECRET_KEK, the same key the agents' own secrets are sealed with, and copied onto each agent's mount
-- when it is pointed here, so a call never reaches across objects for it.
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account TEXT,
  creator_raft_user_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connectors_by_tenant ON connectors (tenant_id, provider);

-- Which connector an agent's connection came from; null for one made before connectors.
ALTER TABLE provisioned_connections ADD COLUMN connector_id TEXT;

-- Who pointed which agent at which connector, or disconnected it, and in what capacity.
CREATE TABLE IF NOT EXISTS connector_events (
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  raft_agent_id TEXT,
  action TEXT NOT NULL,
  acting_raft_user_id TEXT NOT NULL,
  acting_role TEXT NOT NULL,
  at INTEGER NOT NULL
);
