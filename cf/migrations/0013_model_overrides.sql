-- Which model an agent's operator binding uses, when not the deployment's default (HARNESS_MODEL).
-- One row per scope: the deployment (tenant_id = '' and agent_id = ''), a tenant (agent_id = ''), or an
-- agent. The most specific row wins. An agent with its own model credential is not affected: this
-- chooses among the models the operator's account reaches (through its AI Gateway).
CREATE TABLE IF NOT EXISTS model_overrides (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
);
