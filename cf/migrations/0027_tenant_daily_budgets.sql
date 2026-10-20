-- The Raft server's daily budgets, beside its plan (cf/src/spend-limit.ts; docs/metering.md, "Daily limits"): Raft is the
-- source of a tenant's daily limit and of its share of the onboarding pool, and the plan's mapping and the env's figures
-- are what is used only while Raft has sent none. Whole US cents, never dollars as a float.
--
-- NULL: Raft has not sent it (every row before this migration, and every write that left the field out), so the
-- fallback applies. A write that leaves a field out keeps what is stored; only an explicit `null` clears it
-- (`PUT /provision/servers/:id/plan`, docs/agent-surface.md), so an older Raft that sends `{ plan }` alone cannot wipe it.
ALTER TABLE tenant_plans ADD COLUMN daily_budget_cents INTEGER;
ALTER TABLE tenant_plans ADD COLUMN onboarding_daily_budget_cents INTEGER;
