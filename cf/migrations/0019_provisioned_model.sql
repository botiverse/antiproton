-- A provisioned agent remembers the `model` its creating POST asked for, so a replay is compared with the request it
-- repeats: the same model (or none, both times) answers the same, another is 409 like any other field. The request's,
-- not what runs now: a PUT …/model later changes the pick (model_choices), never this. NULL: no model was asked for,
-- which is also every row made before this column existed — their creates never sent one.
ALTER TABLE provisioned_agents ADD COLUMN model TEXT;
-- 1 while the create's pick is not stored yet (a create that named a model and died before storing it). Its replay
-- may then still change `model`, and stores the pick; once it is 0, a replay never writes the pick again, so a later
-- PUT …/model (null included) is not undone. 0 on every older row: none of them named a model.
ALTER TABLE provisioned_agents ADD COLUMN model_pending INTEGER NOT NULL DEFAULT 0;
