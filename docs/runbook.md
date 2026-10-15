# Runbook

Operating the deployment. Every route here takes the operator's token as `x-harness-token: $AUTOMATION_TOKEN`;
`$HOST` is the deployment (`https://antiproton.ai`, or the preview Worker's host).

## Stopping a runaway agent

A runaway agent is one whose turn keeps calling its model: the same failing tool call again and again, or a turn
that never ends. On preview (2026-10-15) one agent resent a run_js program that did not parse every ~2.5 s, 300+ times,
and two agents kept calling their model for five minutes after they were deleted. A delete now ends the running turn,
and the routes below end one without deleting.

### 1. Find it

Which tenant is spending, and on what, is the usage ledger: today's priced spend per tenant and resource from
`usage_hourly` (`GET /admin/usage-costs?from=&to=&bucket=day`, docs/metering.md), which the agent's object sends on
every alarm pass, so it keeps counting after Raft stops taking a deleted agent's activity.

```
curl -s -H "x-harness-token: $AUTOMATION_TOKEN" "$HOST/admin/usage-costs?from=<today>&to=<today>&bucket=day"
```

To see what one agent is doing, read its conversation; a loop shows as the same tool call and the same error, again
and again, at the end:

```
curl -s -H "x-harness-token: $AUTOMATION_TOKEN" "$HOST/admin/transcript?tenantId=<tenantId>&agentId=<agentId>"
```

Every stop, cancel or delete of a turn writes a `turn.stop` line to the Workers logs: `trigger` (`admin_cancel`,
`provider_stop`, `delete`), `result` (`aborted`, `nothing_running`, `failed`) and `error` when it failed; filter on
`evt` = `turn.stop` in the Workers Observability query builder.

For one agent's lines: `node cf/scripts/logs.mjs [--preview] --agent <agentId> --since 30m`.

### 2. Stop its turn

```
curl -s -X POST -H "x-harness-token: $AUTOMATION_TOKEN" "$HOST/admin/cancel-turn?tenantId=<tenantId>&agentId=<agentId>"
```

Aborts the running turn (and the model call it has out) without deleting anything: `{"result":"interrupted",
"cancelledTurn":"<turn id>"}`, or `{"result":"not_running"}`; `503` with `"result":"failed"` and an `error` when the turn
could not be ended — retry. Raft is shown the stop as a "Bridge fatal" with `stopped: by operator`. The agent's next
message starts a new turn.

The provider has the same stop for its own agents, `POST /provision/agents/by-raft-agent/{raftAgentId}/stop`
(docs/agent-surface.md, "Stopping a turn").

`/admin/reset-session` is **not** a stop. It clears the overflow backstop's `needs_reset` mark (`rebuild=0`), or clears
it and rebuilds the conversation — a rebuild that refuses while a turn runs. Neither touches a running turn, which is
why `{"ok":true,"cleared":null,"rebuilt":null}` on preview left both loops running.

### 3. Last resort: a $0 spend limit

When the stop route cannot reach the agent (it answers `failed`, or the deployment predates it), cut the agent's
tenant off from the model: its next model call is refused for the day's limit and the turn ends there, reported to
Raft as `usage_limit_reached`. This stops **every** agent of the tenant, so it is the last resort.

```
curl -s -X PUT -H "x-harness-token: $AUTOMATION_TOKEN" -H "content-type: application/json" \
  "$HOST/admin/spend-limits" -d '{"tenantId":"<tenantId>","limitUsd":0}'
```

An agent created on the onboarding budget (`provisioned_agents.budget = 'onboarding'`) is judged by the onboarding
pool, not its tenant's limit, so it needs its tenant's share of the pool set as well:

```
curl -s -X PUT -H "x-harness-token: $AUTOMATION_TOKEN" -H "content-type: application/json" \
  "$HOST/admin/spend-limits" -d '{"pool":"onboarding","tenantId":"<tenantId>","limitUsd":0}'
```

These are rows in `spend_limits` and `spend_pool_limits` (pool `onboarding`); every set and clear is audited in
`spend_limit_events` / `spend_pool_limit_events`. **Remove them afterwards**, or the tenant stays cut off: the same
requests with `DELETE` and no `limitUsd`.

```
curl -s -X DELETE -H "x-harness-token: $AUTOMATION_TOKEN" -H "content-type: application/json" \
  "$HOST/admin/spend-limits" -d '{"tenantId":"<tenantId>"}'
curl -s -X DELETE -H "x-harness-token: $AUTOMATION_TOKEN" -H "content-type: application/json" \
  "$HOST/admin/spend-limits" -d '{"pool":"onboarding","tenantId":"<tenantId>"}'
```

`GET /admin/spend-limits` lists what is set.
