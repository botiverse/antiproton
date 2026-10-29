-- Every attempt at an operator route that acts on an agent, and every run of a cleanup that drops records, audited in
-- D1 rather than the Workers log, which drops lines: today POST /admin/withdraw-egress, the preview-only verification
-- hook (#1130, to be removed by #1132), and the daily cleanup of resolved egress_residue rows (below).
-- One row per attempt, refused ones included (401, 400, 405, an id this deployment never provisioned), written before
-- the agent's object is called and updated after it.
--
-- Metadata only: never a token, a credential, or anything a provider answered. `claimed_caller` is who the caller
-- says it is (a header), not who it is. `counts` is numbers only, as JSON.
--
-- A row whose outcome is still 'started' was written and never finished: the Worker died mid-call, or the object
-- threw before the update landed. It is unconfirmed, never "nothing happened": anything that counts or summarises
-- these rows treats it as possibly done.
CREATE TABLE IF NOT EXISTS admin_audit (
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
CREATE INDEX IF NOT EXISTS admin_audit_agent ON admin_audit(tenant_id, agent_id, at);

-- Project-scope registrations found carrying a box's placeholder after an agent's delete or the egress hook (#1130):
-- a token run9 still injects into the boxes a label matches, which antiproton never removes (the run9 project is shared
-- with production). Kept here, not in the agent's object or its mount, so a record outlives the mount and the agent:
-- this is what #1128's List reads. One row per (tenant, agent, secret); names match that List: box_id, secret_id,
-- title, reason_code.
--
-- Read by its own columns only, never joined to the agents' registry: a deleted agent's residue, its registry row gone,
-- is listed all the same. No environment column: preview and production have separate D1 databases
-- (antiproton-preview-control, antiproton-control), so rows of the two never mix.
--
-- IF NOT EXISTS throughout: a migration's file name is its only identity, so one renamed would run again where it was
-- already applied; this makes that harmless.
--
-- A row is resolved only with evidence: `resolved_by` says how (listing_absent: a complete, readable project listing
-- no longer had it; operator_excluded and provider_reclaimed are reserved for #1128), `resolved_ref` by what (the
-- call that saw it gone). Resolved rows are kept, and dropped 180 days after resolution by the daily cron, each run
-- recorded in admin_audit; unresolved rows are never dropped. Ids and names only: never a value, never run9's text.
CREATE TABLE IF NOT EXISTS egress_residue (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  box_id TEXT NOT NULL,
  secret_id TEXT NOT NULL,
  title TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT,
  resolved_ref TEXT,
  -- How often a resolved row was seen again and reopened, and what overturned it last: a row that keeps reopening says
  -- run9's "absent from a complete listing" is not to be trusted, not that this code is wrong.
  reopened_count INTEGER NOT NULL DEFAULT 0,
  last_overturned_ref TEXT,
  PRIMARY KEY (tenant_id, agent_id, secret_id)
);
CREATE INDEX IF NOT EXISTS egress_residue_open ON egress_residue(tenant_id, agent_id, alias, resolved_at);
CREATE INDEX IF NOT EXISTS egress_residue_resolved ON egress_residue(resolved_at) WHERE resolved_at IS NOT NULL;
