-- Inbound event hooks (src/runtime/inbound.ts): which agent's mount a public hook URL reaches.
--
-- Control-plane data like api_keys: the Worker reads it before any object is chosen, because the URL is
-- all a service sends. The secret is not here; it is sealed in the agent's own store under the hook id.
-- Read and written by cf/src/control-plane.ts (d1InboundHooks); test/control-plane-d1.sh runs both.
CREATE TABLE IF NOT EXISTS inbound_hooks (
  hook_id    TEXT PRIMARY KEY,   -- 32 random bytes, base64url: the only thing in the URL
  tenant_id  TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  alias      TEXT NOT NULL,      -- the mount the events are for
  created_at INTEGER NOT NULL,   -- ms since the epoch
  revoked_at INTEGER             -- null while the hook is live
);

CREATE INDEX IF NOT EXISTS inbound_hooks_by_agent ON inbound_hooks (tenant_id, agent_id);
