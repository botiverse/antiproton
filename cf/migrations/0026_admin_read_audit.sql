-- Who read an agent's conversation, and why (cf/src/read-audit.ts): one row per read of a route that returns what an
-- agent was told or said — /admin/transcript, the /agent/* reads, the console's /ui/transcript, and the provisioning
-- eval transcript and model-input — or per attempt refused. Kept in D1, not the Workers log, which drops lines.
-- Metadata only: never the content read. `assistant` marks an agent that is someone's personal assistant, whose reads
-- need a `reason` and fail closed when this row cannot be written.
CREATE TABLE admin_read_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  route TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session TEXT,
  token_kind TEXT NOT NULL,
  token_label TEXT,
  reason TEXT,
  assistant INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL
);
CREATE INDEX admin_read_audit_agent ON admin_read_audit(tenant_id, agent_id, at);
