-- Every attempt at an operator route that acts on an agent and is audited in D1 rather than the Workers log, which
-- drops lines: today POST /admin/withdraw-egress, the preview-only verification hook (#1130, to be removed by #1132).
-- One row per attempt, refused ones included (401, 400, 405, an id this deployment never provisioned), written before
-- the agent's object is called and updated after it.
--
-- Metadata only: never a token, a credential, or anything a provider answered. `claimed_caller` is who the caller
-- says it is (a header), not who it is. `counts` is numbers only, as JSON.
--
-- A row whose outcome is still 'started' was written and never finished: the Worker died mid-call, or the object
-- threw before the update landed. It is unconfirmed, never "nothing happened": anything that counts or summarises
-- these rows treats it as possibly done.
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  route TEXT NOT NULL,
  tenant_id TEXT,
  agent_id TEXT,
  claimed_caller TEXT,
  outcome TEXT NOT NULL,
  counts TEXT,
  finished_at INTEGER
);
CREATE INDEX admin_audit_agent ON admin_audit(tenant_id, agent_id, at);
