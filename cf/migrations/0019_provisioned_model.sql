-- A provisioned agent remembers the `model` its creating POST asked for, so a replay is compared with the request it
-- repeats: the same model (or none, both times) answers the same, another is 409 like any other field. The request's,
-- not what runs now: a PUT …/model later changes the pick (model_choices), never this. NULL: no model was asked for,
-- which is also every row made before this column existed — their creates never sent one.
ALTER TABLE provisioned_agents ADD COLUMN model TEXT;
