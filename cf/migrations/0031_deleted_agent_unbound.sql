-- A deleted agent's bindings to connectors, left by deletes from before a delete unbound them (cf/src/provision/
-- handlers.ts, the agent's DELETE): removed, each first recorded as a connector event, 'deleted_agent_unbound', with
-- `mountCleared: false`, as the delete's own events say it, since this clears no mount. The credential copy on the
-- deleted agent's mount is not reachable from here. Its object is kept (a delete destroys no data), but it is never
-- handed a renewed pair nor finds a connector to renew through (`d1ConnectorGrants`), so the copy is not renewed; a
-- repeated DELETE of the agent clears its mount.
INSERT INTO connector_events (tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason)
SELECT pc.tenant_id, pc.connector_id, pc.raft_agent_id, 'deleted_agent_unbound', 'antiproton', 'system',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000, json_object('provider', pc.provider, 'mountCleared', json('false'), 'deletedAt', p.deleted_at)
  FROM provisioned_connections pc
  JOIN provisioned_agents p ON p.tenant_id = pc.tenant_id AND p.raft_agent_id = pc.raft_agent_id
 WHERE p.status = 'deleted' AND pc.connector_id IS NOT NULL;

DELETE FROM provisioned_connections
 WHERE EXISTS (SELECT 1 FROM provisioned_agents p
                WHERE p.tenant_id = provisioned_connections.tenant_id AND p.raft_agent_id = provisioned_connections.raft_agent_id
                  AND p.status = 'deleted');
