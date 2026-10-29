-- The Raft origin a connector belongs to (cf/src/provision/handlers.ts `ownConnector`). The tenant is not enough: a
-- platform token derives it from the Raft server's id alone, so two Raft deployments naming one server id share it,
-- and a connector, which carries a GitHub credential, must be seen, bound, reconnected and removed only by the origin
-- that made it. NULL: no origin could be told (below); such a connector is seen by no token.
ALTER TABLE connectors ADD COLUMN raft_origin TEXT;

-- First, the origin of the agent it was made for: a connector is made by a confirm for one agent (its 'create'
-- event), through that agent's origin's own connect flow, so that is whose it is, whatever is bound to it since.
UPDATE connectors SET raft_origin = (
  SELECT p.raft_origin FROM connector_events e
    JOIN provisioned_agents p ON p.tenant_id = e.tenant_id AND p.raft_agent_id = e.raft_agent_id
   WHERE e.tenant_id = connectors.tenant_id AND e.connector_id = connectors.id AND e.action = 'create'
   ORDER BY e.at LIMIT 1);

-- Else, with no such event or agent row, the one origin every agent bound to it has. Bound agents of more than one
-- origin, or none bound: left NULL, since any choice could hand the credential to an origin that did not make it.
UPDATE connectors SET raft_origin = (
  SELECT MIN(p.raft_origin) FROM provisioned_connections pc
    JOIN provisioned_agents p ON p.tenant_id = pc.tenant_id AND p.raft_agent_id = pc.raft_agent_id
   WHERE pc.tenant_id = connectors.tenant_id AND pc.connector_id = connectors.id
  HAVING COUNT(DISTINCT p.raft_origin) = 1)
 WHERE raft_origin IS NULL;
