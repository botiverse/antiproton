-- A provisioned agent's connections to other services (Connect GitHub first), made through a
-- one-time link Raft asks for. The credential itself is sealed on the agent's mount, in the agent's
-- own object; this row holds only what Raft may show: the account, who connected it, and when.
CREATE TABLE IF NOT EXISTS provisioned_connections (
  tenant_id TEXT NOT NULL,
  raft_agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account TEXT,
  connected_by TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, raft_agent_id, provider)
);

-- A connect link is used once: its nonce is recorded when the browser opens it, so a link that
-- was forwarded or replayed within its ten minutes starts nothing.
CREATE TABLE IF NOT EXISTS connect_links (
  nonce TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);
