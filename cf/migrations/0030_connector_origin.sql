-- The Raft origin a connector belongs to (cf/src/provision/handlers.ts `ownConnector`). The tenant is not enough: a
-- platform token derives it from the Raft server's id alone, so two Raft deployments naming one server id share it,
-- and a connector, which carries a GitHub credential, must be seen, bound, reconnected, renewed and removed only by
-- the origin that made it. NULL: no origin could be told (below); such a connector is seen by no token, and no
-- agent renews through it (`d1ConnectorGrants.grant`).
ALTER TABLE connectors ADD COLUMN raft_origin TEXT;

-- The origin of the agent it was made for: a connector is made by a confirm for one agent (its 'create' event),
-- through that agent's origin's own connect flow, so that is whose it is, whatever is bound to it since. With no such
-- event, or no row for that agent, it is left NULL: the agents bound to it say only who holds it, not who made it,
-- and taking their origin could hand the credential to one that did not.
UPDATE connectors SET raft_origin = (
  SELECT p.raft_origin FROM connector_events e
    JOIN provisioned_agents p ON p.tenant_id = e.tenant_id AND p.raft_agent_id = e.raft_agent_id
   WHERE e.tenant_id = connectors.tenant_id AND e.connector_id = connectors.id AND e.action = 'create'
   ORDER BY e.at LIMIT 1);

-- A binding of another origin's agent to a connector (one made before this migration, when nothing stopped it) is
-- cut: that agent is never handed the connector's credential again. The only step here that disconnects anyone, so
-- each is recorded first, as a connector event: which agent, and both origins. The copy already on that agent's mount
-- is not reachable from here; it stops renewing (`grant`), and a token that does not expire lives until revoked on
-- GitHub, which a person decides.
INSERT INTO connector_events (tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason)
SELECT pc.tenant_id, pc.connector_id, pc.raft_agent_id, 'origin_mismatch_removed', 'antiproton', 'system',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       json_object('agentOrigin', p.raft_origin, 'connectorOrigin', c.raft_origin, 'provider', pc.provider)
  FROM provisioned_connections pc
  JOIN connectors c ON c.tenant_id = pc.tenant_id AND c.id = pc.connector_id
  JOIN provisioned_agents p ON p.tenant_id = pc.tenant_id AND p.raft_agent_id = pc.raft_agent_id
 WHERE c.raft_origin IS NOT NULL AND p.raft_origin != c.raft_origin;

DELETE FROM provisioned_connections
 WHERE EXISTS (SELECT 1 FROM connectors c JOIN provisioned_agents p ON p.tenant_id = c.tenant_id
                WHERE c.tenant_id = provisioned_connections.tenant_id AND c.id = provisioned_connections.connector_id
                  AND p.raft_agent_id = provisioned_connections.raft_agent_id
                  AND c.raft_origin IS NOT NULL AND p.raft_origin != c.raft_origin);
