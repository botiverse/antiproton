-- Every removal of an agent's connection is recorded (cf/src/provision/handlers.ts, DELETE …/connections/{provider}),
-- including one whose connection has no connector (made before connectors, 0012): connector_id becomes nullable, and
-- `provider` names the connection such an event is about. SQLite cannot drop a NOT NULL in place, so the table is
-- rebuilt with every row kept as it was, every original column copied by name. `provider` stays NULL on the rows
-- copied: those events did not record one, and filling it in would be a guess. One audit table rather than a second
-- one beside it: the events of one agent's connection stay in one place, read in one order.
CREATE TABLE connector_events_0032 (
  tenant_id TEXT NOT NULL,
  connector_id TEXT,
  raft_agent_id TEXT,
  action TEXT NOT NULL,
  acting_raft_user_id TEXT NOT NULL,
  acting_role TEXT NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT,
  provider TEXT
);
INSERT INTO connector_events_0032 (tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason)
  SELECT tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason FROM connector_events;
DROP TABLE connector_events;
ALTER TABLE connector_events_0032 RENAME TO connector_events;
