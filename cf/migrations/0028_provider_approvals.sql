-- Held calls of the agents a Raft provisioned, as their objects last published them (cf/src/approvals.ts): what
-- `GET /provision/approvals` pages through, so Raft can reconcile every server's cards without asking each agent.
-- The agent's own object is the source of truth (its `approvals` table); this is its copy for the provider, written
-- after every change of state and never moved back from an end to `pending`.
--
-- `item` is the JSON the per-agent route answers (cf/src/approvals.ts `ApprovalItem`), arguments already redacted
-- and bounded. `raft_origin` is the origin of the token the agent was made with: a platform token lists its origin's
-- rows, a tenant token its tenant's.
CREATE TABLE provider_approvals (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  raft_origin TEXT NOT NULL,
  raft_server_id TEXT NOT NULL,
  raft_agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  item TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, operation_id)
);
CREATE INDEX provider_approvals_origin ON provider_approvals(raft_origin, updated_at, tenant_id, agent_id, operation_id);
CREATE INDEX provider_approvals_tenant ON provider_approvals(tenant_id, updated_at, agent_id, operation_id);
