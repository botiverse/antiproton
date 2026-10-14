-- A provisioned agent remembers whether its creating POST asked it to wait for its workspace import (`awaitImport`),
-- so a replay is compared with the request it repeats: the same value answers the same, another is 409 like any other
-- field. 0 on every older row: none of them asked.
ALTER TABLE provisioned_agents ADD COLUMN await_import INTEGER NOT NULL DEFAULT 0;
