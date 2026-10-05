-- Which of the deployment's USER_MODELS options (src/model/user-models.ts) an agent's owner picked for it. Kept apart
-- from model_overrides because it is a different authority: an admin's agent or tenant row outranks it, and it outranks
-- the admin's deployment row (cf/src/model-request.ts resolveModel). It names an option's id, not a provider and model,
-- so what the id stands for stays the operator's to change, and an id the deployment no longer offers is passed over
-- rather than bound. No row is the owner's "default".
CREATE TABLE IF NOT EXISTS model_choices (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  choice_id TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
);
