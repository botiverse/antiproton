-- A person's own API keys, listed and revoked from the console (/ui/api-keys): read by tenant and owner.
-- Read by cf/src/control-plane.ts d1ApiKeys list and revokeOwned.
CREATE INDEX IF NOT EXISTS api_keys_by_owner ON api_keys (tenant_id, owner_agent_id, created_at);
