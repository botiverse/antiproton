-- A provisioned agent remembers the agent profile its creating POST asked for (`profile`, src/runtime/agent-profile.ts),
-- so a replay is compared with the request it repeats: the same value answers the same, another is 409 like any other
-- field. NULL on every older row: none of them asked for one.
ALTER TABLE provisioned_agents ADD COLUMN profile TEXT;
