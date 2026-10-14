-- Whether a Raft server's agents may be given a model other than the deployment's default through the provider routes
-- (`model` on POST /provision/agents, PUT /provision/agents/:id/model), as Raft last said it (PUT
-- /provision/servers/:id/model-picker). No row: off — the deployment decides the model, and an operator's rows
-- (model_overrides) still decide it per tenant or agent. Turning it off migrates nothing: a pick made while it was on
-- stays stored and keeps running. One row per tenant, the latest write wins.
CREATE TABLE IF NOT EXISTS tenant_model_picker (
  tenant_id TEXT PRIMARY KEY,
  enabled   INTEGER NOT NULL,  -- 1 on, 0 off
  set_by    TEXT NOT NULL,     -- the provider token's hash, as the provider routes' audit lines name it
  set_at    INTEGER NOT NULL   -- ms since the epoch
);
