-- Hook secrets a service brings itself (Raft, task #47): the service generates the secret and writes it
-- once, with a single-use grant an operator issued. Read and written by cf/src/control-plane.ts
-- (d1InboundHooks); test/control-plane-d1.sh runs both.

-- Null while the hook waits for its first secret: such a hook answers like one that does not exist,
-- so a URL that works always has a secret behind it. Every hook before this migration had its
-- secret from the start.
ALTER TABLE inbound_hooks ADD COLUMN activated_at INTEGER;
UPDATE inbound_hooks SET activated_at = created_at WHERE activated_at IS NULL;

CREATE TABLE IF NOT EXISTS hook_grants (
  grant_hash  TEXT PRIMARY KEY,  -- sha256 of the grant; the grant itself is kept nowhere
  hook_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,  -- the one secret version this grant may write
  nonce       TEXT NOT NULL,     -- the writer repeats it, binding the write to this issue
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,           -- set once, before the secret is stored: a grant never writes twice
  outcome     TEXT               -- 'stored', or why the write failed after the grant was used
);

CREATE INDEX IF NOT EXISTS hook_grants_by_hook ON hook_grants (hook_id);
