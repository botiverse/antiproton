# Runbook

Operating the deployment. Every route here takes the operator's token as `x-harness-token: $AUTOMATION_TOKEN`;
`$HOST` is the deployment (`https://antiproton.ai`, or the preview Worker's host).

## Logs and what an object did

A Durable Object's console lines can be dropped from Workers Logs when its invocations overlap: the whole
invocation's logs go missing, not one line. So an event an alert depends on is logged from the Worker request that
answers the call, and the object's own line is kept as a supplement (`side` = `worker` or `do`). A missing `do` line
says nothing about what the object did; to confirm that, read its trace export in R2, in the deployment's artifacts
bucket (`antiproton-artifacts`, or `antiproton-preview-artifacts` on preview) under `trace/<tenantId>/<agentId>/`
(cf/src/trace-r2.ts).

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
`provider_stop`, `delete`), `result` (`aborted`, `nothing_running`, `failed`), `turn` when one was aborted, `error` when
it failed, and `side`. The Worker that answered the stop writes one (`side` = `worker`) for every attempt; the agent's
object writes another (`side` = `do`) when it was reached, and that one can be missing ([above](#logs-and-what-an-object-did)).
Filter on `evt` = `turn.stop` and `side` = `worker` in the Workers Observability query builder.

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

## Trying conversation cards on an agent

Conversation cards are the `raft` mount's `conversationCards` setting, off unless `true` (docs/plugins.md). Turn them on
for one agent in place; the mount's credential, push registration and saved state are kept, and the agent's next Raft
call uses them:

```
curl -s -X PATCH -H "x-harness-token: $AUTOMATION_TOKEN" -H "content-type: application/json" \
  "$HOST/admin/mounts" -d '{"tenantId":"<tenantId>","agentId":"<agentId>","alias":"raft","settings":{"conversationCards":true}}'
```

For an agent Raft made, `agentId` is `raft_<raftAgentId>` and `tenantId` is its provider token's tenant (both on its
`provisioned_agents` row). The answer is the mount's settings after the change and the keys that moved:
`{"alias":"raft","plugin":"raft","config":{"serverUrl":"…","conversationCards":true},"changed":["conversationCards"]}`.
Off again is the same call with `"conversationCards":false`. A name or instructions PATCH from Raft keeps the setting.

Only settings the plugin marks `changeable` are accepted (`conversationCards` and `timeoutMs` for raft); `serverUrl` or
an undeclared key is `400`, a value of the wrong type is `400`, and an agent or alias that is not there is `404`. Each
change writes a `mount.settings` line to the Workers logs (filter on `evt` = `mount.settings`) and a `mount.settings`
row to the agent's trace.

## Subagents

An agent can delegate work to subagents (docs/agent-surface.md, "Subagents") only where its `subagents` setting is on.
It is off for every agent unless set. Turn it on for one agent:

```
curl -s -X PATCH -H "x-harness-token: $AUTOMATION_TOKEN" -H "content-type: application/json" \
  "$HOST/admin/agent-settings" -d '{"tenantId":"<tenantId>","agentId":"<agentId>","settings":{"subagents":true}}'
```

The answer is the settings in force and what moved: `{"settings":{"subagents":true},"changed":["subagents"]}`. The
agent's next turn is offered `send_to_agent`; a turn already running keeps the tools it started with. Off again is the
same call with `false`; subagents already running finish and report. An unknown setting or a value that is not a
boolean is `400` and nothing is written; an agent that is not there is `404`. Each change is an `agent.settings` line in
the Workers logs.

To see an agent's subagents and the setting:

```
curl -s -H "x-harness-token: $AUTOMATION_TOKEN" "$HOST/admin/agent-settings?tenantId=<tenantId>&agentId=<agentId>"
```

`subagents` lists them, newest first: `id` (the child's session, `sub_…`), `parentSession`, `state` (`running` while a
turn is in flight, else `idle`), `turns`, `outcome` of the last turn (`done`, `failed`, `cancelled` at the 30-minute
ceiling, `stopped` with its parent), and `modelOption`. A child's work is in the agent's trace, its rows naming its
session (`model.call` `attrs.session`, `tool.call` `attrs.task`) and one `subagent.turn` row per turn.

**Stopping.** A stop of the agent stops its subagents with it: `/admin/cancel-turn`, the provider's stop and a delete
([Stopping a runaway agent](#stopping-a-runaway-agent)) mark every running subagent `stopped` and cancel its turn, on
both engines, and no report is sent (a report would wake the turn the stop ended). `/admin/cancel-turn` answers
`interrupted` when only subagents were running, too. There is no route that stops one subagent alone. While any
subagent runs, a fresh context and a reset refuse, as they do for a running turn.
