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
curl -s -H "x-harness-token: $AUTOMATION_TOKEN" -H "X-Read-Reason: <why>" "$HOST/admin/transcript?tenantId=<tenantId>&agentId=<agentId>"
```

Every read of a conversation is audited in D1 (`admin_read_audit`, migration 0026, `cf/src/read-audit.ts`):
`/admin/transcript`, the `/agent/*` reads (`/agent/state`, `/agent/events`, `/agent/activity`), the console's
`/ui/transcript`, and the provisioning eval `transcript` and `model-input`. Each row says when, which route, which agent
and conversation, what kind of credential read it and its label, and the reason given, never the content. Say why with
`reason=` in the query or the `X-Read-Reason` header. For a personal assistant (an agent whose Raft account has an
owner, `src/plugins/raft-assistant.ts`) the reason is required (400 `read_reason_required` without one), a read whose
row cannot be written is refused (503 `read_audit_failed`), and its eval `transcript` and `model-input` are not
exported at all (403 `assistant_private`). For any other agent the reason is recorded when given, and a row that
cannot be written is logged and the read goes ahead.

```
SELECT datetime(at / 1000, 'unixepoch'), route, agent_id, session, token_kind, token_label, reason, outcome
  FROM admin_read_audit WHERE tenant_id = '<tenantId>' ORDER BY at DESC LIMIT 50;
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

An override can only lower a limit, never raise it, so `0` stops the tenant whatever daily budget Raft has sent for
its server; for the same reason an override cannot be used to lift a tenant above Raft's budget.

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

## A GitHub connection that needs reconnecting

Connect GitHub hands out expiring user tokens (8 hours, renewed with a single-use refresh token that lasts about 6
months). The deployment renews them (cf/src/github-refresh.ts). Only GitHub refusing a renewal marks the connection
as needing reconnecting: a JSON answer from the token endpoint whose OAuth `error` code is one that means the grant is
gone: `bad_refresh_token` (spent, expired, or the App revoked), `invalid_grant` or `unauthorized` (`RECONNECT_ERRORS`
in cf/src/github-token.ts; GitHub documents no refresh error codes). Nothing else marks it:
- a `401` from the API. Before a `401` renews anything, `GET /user` is asked with the same token: only a `401` there
  says the token is dead. A live token refused by an endpoint that refuses every user token (`/app`) rotates nothing,
  and the call reports its `401`. Even a renewed token's `401` marks nothing, and a `401` within a minute of a renewal
  does not renew again;
- any other OAuth error code (`temporarily_unavailable`, the deployment's own `incorrect_client_credentials`, a code
  GitHub adds later), or an answer without one (an HTML page, a 5xx, a timeout): logged as `unavailable`, and the next
  call tries again;
- a refusal that lost its lease while GitHub answered: it marks the connector only while the connector still holds the
  refresh token it spent. If another renewal stored a good pair meanwhile, that pair is taken instead.

A mount whose connector was deleted stops renewing and says to reconnect: it never renews with its own copy of a pair
its owner removed.

**Where it shows.** Raft's `GET …/connections/github` answers `connected: false, oauthStatus: "error"` and
`lastCheckError`
([`agent-surface.md`](agent-surface.md#the-agents-github-connection-connectionsgithub)), and the agent's GitHub tools say
the user must reconnect GitHub. In D1 (`antiproton-control`):

```sql
-- Connectors that need reconnecting, and what GitHub said.
SELECT tenant_id, id, account, broken_at, broken_reason, refreshed_at, last_checked_at, expires_at FROM connectors WHERE broken_at IS NOT NULL;
-- The agents pointed at one of them.
SELECT raft_agent_id FROM provisioned_connections WHERE tenant_id = '<tenantId>' AND connector_id = '<connectorId>';
-- When it was marked (`acting_role` system), beside who made and pointed it.
SELECT action, raft_agent_id, acting_raft_user_id, acting_role, at, reason FROM connector_events WHERE connector_id = '<connectorId>' ORDER BY at;
-- An agent's connection made before connectors carries the state on its own row.
SELECT tenant_id, raft_agent_id, broken_at, broken_reason FROM provisioned_connections WHERE broken_at IS NOT NULL;
```

`refreshing_until` on a connector is a renewal in progress (a 30-second lease, held by `refreshing_by`; only its holder
releases it); one in the past is a renewal that did not finish, and the next one takes over. The token endpoint is
given 25 seconds, inside the lease.

**A renewal cut off half-way can cost a reconnect.** GitHub spends the old pair the moment it hands out a new one. The
new pair is written to the connector immediately, before anything else is done with it. A write that fails is tried
three times (`store-failed` lines with `attempt`). If D1 still refuses, the mount that asked keeps the pair
(`kept-unstored`) and its own calls keep working. The connector, though, holds a spent refresh token, and once the
lease runs out another agent's renewal is refused and marks the connection as needing reconnecting. A deploy, an
eviction or a timeout between GitHub's answer and the write loses the pair outright. A `rotated` line with
`stored: false`, `kept-unstored`, or an `interrupted-before` line followed by `broken`, is this case.

**Other agents on the connector** are told of a new pair after the renewing call has answered, not during it
(`waitUntil`). One that is not reached (`propagate-failed`) takes the pair on its own next GitHub tool call's `401`,
but its sandbox's `git` and `gh` have no `401` path: they keep the spent token until that mount's own recorded expiry
comes within five minutes, when it is renewed (adopted from the connector) before use.

**In the logs.** Every renewal is a `github.refresh` line: `outcome` `rotated` (a new pair), `adopted` (an agent took
the pair another agent's renewal stored), `broken`, `unavailable` (GitHub did not answer: not a verdict, nothing is
marked), `interrupted-before` (a renewal in this object stopped part-way; the next one goes ahead) or
`propagate-failed` (an agent on the connector was not told, below), `store-failed` and `kept-unstored` (above), with
`tenantId`, `agentId`, `connectorId`, `why` (`expiring`, `rejected`, `adopt`) and GitHub's error as `reason`. Never a
token. Each connect also writes `connect.exchange` with the **names** of the keys GitHub's answer carried: one with
`expires_in` and `refresh_token` is an expiring token (`expiring: true`).

**In the trace.** The renewal runs in the agent's object, whose lines Workers Logs can drop (above, "Logs and what an
object did"): on 2026-10-18 a connector rotated at 18:38:04Z with no `github.refresh` line, while the R2 trace export
held that same alarm pass's `model.call` row, whose log line was missing too. So every outcome is also a
`github.refresh` row in the agent's trace (`GET …/trace`, and the export under `trace/<tenantId>/<agentId>/`): `status`
the outcome, `verdict` `ok` for `rotated` and `adopted`, `attrs.scope` `connector` (the connector's own renewal) or
`mount` (what this agent's mount took), `connectorId`, `mount`, `why`, `attempt`, `stored`, and `reasonCode`: the
OAuth error code (`oauth:bad_refresh_token`; `oauth:other` for a code not known to be GitHub's), `http-<status>`,
`no-answer`, `no-refresh-token`, `d1-write-failed`, `propagate-error`, `no-app`, `lease-timeout`, `connector-gone`,
`nothing-to-renew`, `refused` or `other` (`reasonCode` in cf/src/github-refresh.ts). The reason's own text stays in
the log line only.

**Mending it** is the person's: reconnect from the agent's page. Raft sends the broken connector's id with the
connect (`connectorId`, [`agent-surface.md`](agent-surface.md#reconnecting-a-connector-in-place)), so the connector
is mended in place, keeps its id, and every agent on it gets the new pair in the same call. A connect without the id
still makes a new connector for that one agent, and the other agents stay on the broken one until they are pointed
at the new one. Nothing an operator writes to D1 brings a refused refresh token back.

The reconnect has to be the connector's own GitHub account. `connectors.account_id` (migration 0024) is GitHub's
numeric user id. It is null for a connector made before 0024, and then the login is compared until the id is stored.
A reconnect stores it, and so does the connector's first successful renewal, best effort: a `github.account_id` log
line says `filled`, `unknown` (`GET /user` did not answer; the renewal stands), `login-mismatch` (GitHub named another
login, so the id is left null) or `failed`. Any other account is `409 account_mismatch` and changes nothing. A reconnect in place shows as:

```sql
-- Who reconnected it, and in what role (`creator`, or `admin` on Raft's word).
SELECT action, raft_agent_id, acting_raft_user_id, acting_role, at FROM connector_events WHERE connector_id = '<connectorId>' AND action IN ('reconnect', 'bind') ORDER BY at;
```

The log has a `connect.reconnect` line with `connectorId`, `actingRole` and how many agents were `updated` or
`failed`. A failed agent takes the pair from the connector on its next GitHub call.

## Forwarding trace rows

Some trace rows can be forwarded to Raft's trace-upload worker, which writes them as OTLP logs to `otel.logs`;
antiproton only posts to it (cf/src/trace-forward.ts). There are two lanes, each with its own route, queue, cursor,
backoff and counts:

- **`github.refresh`**: the `github.refresh` rows (above, "In the trace"), so a renewal's outcome can be alerted on from
  the trace instead of from Workers Logs, which drops an object's lines (#980). Route `/api/external/github-refresh`.
- **`agent.trace`**: `model.call`, `model.attempt`, `tool.call`, `tool.refused`, `turn.timing`, `turn.stop`,
  `turn.end_unrecorded`, `rebuild.outcome`, `raft.assistant_wake`, `raft.assistant_check`, `raft.assistant_notify`,
  `raft.assistant_chat_told`, `raft.assistant_rules`, `raft.assistant_send_as_owner` and `raft.turn_ended`, so a turn's
  timing, its model attempts and an assistant's wakes, checks and sends can be read next to Raft's own telemetry. Route `/api/external/antiproton-trace`
  (botiverse/slock#10530); the rows land as `antiproton.<kind>`.

**It is off** unless both of these are set on the deployment; with either missing nothing is sent, nothing is staged and
no table is made:

- the Worker **var** `TRACE_INGEST_URL`: the worker's base URL, without a path (the code appends each lane's route).
  It must be `https://`: the token goes on every request, so an `http://` URL (a bare load-balancer address, say), one
  that does not parse, or one with a user or password in it is refused: nothing is staged or sent, and diagnose's
  `traceForwardConfig` says `misconfigured` with the `problem` (`url_not_https`, `url_invalid`, `url_has_credentials`;
  also `url_missing`, `token_missing`, `deployment_env_invalid` when only some of the settings are there) and which
  setting names it read, never their values. A wrong `TRACE_INGEST_URL` does not fall back to the old name.
- the Worker **secret** `TRACE_INGEST_TOKEN`: the dedicated write-only bearer token, one for both routes, never in a
  wrangler config or the repository. It is not a ScopeDB key: antiproton never talks to ScopeDB.

`GITHUB_REFRESH_INGEST_URL` and `GITHUB_REFRESH_INGEST_TOKEN`, their earlier names, are still read when the new ones
are unset (an empty value counts as unset), so a deployment set up with them keeps working; set the new names and then
delete the old. Both lanes run on the same settings: there is no switch for one lane alone. A receiver that does not
have a lane's route yet answers 404, which pauses that lane only (below).

`DEPLOYMENT_ENV` (`production` in cf/wrangler.jsonc, `preview` in cf/wrangler.preview.jsonc) is what each row says in
`env`; a deployment without it forwards nothing.

**What is sent, `github.refresh`.** Rows of kind `github.refresh` only, every outcome (`rotated`, `adopted`, `broken`,
`unavailable`, `store-failed`, `kept-unstored`, `interrupted-before`, `propagate-failed`), as
`POST <base>/api/external/github-refresh`. Each row has exactly these fields and no other: `at` (ISO 8601), `tenant_id`,
`agent_id`, `seq`, `env`, `outcome`, `scope`, `connector_id`, `mount` (the mount's plugin type, never its alias),
`why`, `attempt`, `stored`, `reason_code`; an
attr the row does not have is `null`, and so is one that is not its shape, the same shapes as `agent.trace`'s:
`outcome`, `scope`, `why` and `reason_code` must be codes and `connector_id` an id, and a row whose `outcome` is not a
code is not sent but counted (`unsendable`). No span id, no verdict, no other attr, no token and no reason text. A row's
identity is (`tenant_id`, `agent_id`, `seq`), the same on every resend, and the receiver dedupes on it.

**What is sent, `agent.trace`.** Rows of the fifteen kinds above only, as `POST <base>/api/external/antiproton-trace`.
Each row has an envelope (`seq`, `at`, `kind`, `tenant_id`, `agent_id`, `env`, and when there are ones that fit,
`span_id`, `status`, `verdict`, `ms`) and then its kind's fields, each named and typed as the receiver's
(`ANTIPROTON_TRACE_KINDS` there, `AGENT_TRACE_FIELDS` here) and built from one attr (a notify's `dropped_other` sums
the drops by a reason without a field of its own); a field the receiver does not keep yet is dropped by it, the row
kept, until it does (test/trace-forward.ts `PROPOSED` lists them: none at present, as the receiver at botiverse/slock 240303c6 takes every field sent); an attr that is not a field here is never sent, and a value that is not its field's shape (an id, a code, a listed value, a non-negative integer, a
boolean) is left out rather than rewritten. So no message text, prompt, tool argument, error sentence, rule or
conversation name leaves: a `tool.call` row's `error` (the tool's own sentence), a `model.call`'s `limit`, a wake's
`error` are never fields. Nor is a name a person or a conversation has: the receiver's id shape takes `alice` as
readily as an id, so an id field here carries only an opaque id this side mints (a session, turn or task in the shapes
`main`, `sub_…`, `sess_…`, `iso_…`; a span as a job, operation, provider call id, else no `span_id`)
or a name from code or configuration (a tool, a model, a mount's type); a mount's alias is a name someone typed, so it
is never sent: `mount` is the mount's plugin type (`raft`, `github`, …), `mount_index` its ordinal in the agent's mount
list, and a plugin row's span `mount:<alias>` goes as `mount`, `wake:<alias>:<ms>` as `wake:<ms>`. Where the vocabulary is known (`by`, `trigger`,
`outcome`, `stop_reason`, a wake's `reason`, a rules row's `action`, …) it is that list; a check's `check_id` is sent only
in the shape Raft mints it. `model.call`'s `first_tool` and `tool.refused`'s `tool` are never filled:
they are whatever the model wrote. Some id and code fields carry a value chosen outside this code, by Raft or by an MCP
server the agent mounts (a tool's name, a `tool.call`'s `error_code`, a `check_id`, a notify's or rules row's `code`):
those are only shape-checked, not checked against a list, so they are only as free of names as their source keeps them. A row's identity at the receiver is (`tenant_id`, `agent_id`, `seq`), the same on every resend;
a span id is not unique per row (a wake's and a turn end's are the mount's). A row whose tenant or agent is not an id
is not sent but counted (`unsendable`).

The receiver takes a batch row by row: a 2xx answers `{"accepted": n, "rejected": [{"index", "reason"}]}`. The rejected
rows are dropped, never retried (the same row gets the same answer), and counted as `rejected` with the receiver's
reason (diagnose `agentTraceForward.rejected`, by reason, seven days); the rest are sent, and the batch is a success.

**Both lanes.** At most 500 rows and 256 KiB a request (the receiver takes 500 rows, and 256 KiB on github-refresh,
512 KiB on antiproton-trace), `Authorization: Bearer <token>`, the body `{"rows":[…]}`.

**What an answer does.** 2xx: sent. 413: the batch is halved until it fits; one row still too large is dropped
(`too-large`). 400 or 422: the batch is dropped (`schema`). 401, 403 or 404 (the receiver answers 404 while it is
switched off, or has no such route): the lane pauses with the rows kept (`auth_or_off`). 408, 429, 5xx or no answer:
kept (`unavailable`). No answer includes none within 10 s: every request, each half of a 413 split included, is aborted
then, because the send runs inside the agent's alarm pass, and the lane sends no further batch in that pass. Any other
4xx: dropped (`rejected`). The send runs at the end of the pass, after the agent's next alarm is armed, and within a
budget per pass: 2 s of wall time for both lanes together (a request still waiting then is aborted, as one with no
answer is) and 8 requests per lane, each half of a 413 split counted. What the budget leaves stays queued for the next
pass, with no backoff; a pass's send never delays the agent's next step by more than the budget. A kept batch is tried again on the first alarm pass after a backoff of a minute, doubling to
an hour, and a success clears it; each lane has its own. A failure never fails the pass, never delays the R2 export,
and asks for no extra pass: an idle agent's waiting rows go on its next pass.

The rows wait in the lane's own queue in the object (`ghr_forward_queue`, `atr_forward_queue`), copied from the outbox
before the export runs, so a paused lane never holds the outbox or the export. Each queue keeps at most 5,000 rows;
past that the oldest are dropped (`lost`).

**Turning it on, preview first.**

1. Deploy the worker side first (botiverse/slock#10530 for `agent.trace`), with its token. Then
   `wrangler secret put TRACE_INGEST_TOKEN --config cf/wrangler.preview.jsonc` (the preview token), add
   `"TRACE_INGEST_URL": "<staging worker's base URL>"` to `vars` in `cf/wrangler.preview.jsonc` and deploy the preview.
   It is a var in the config rather than one set in the dashboard, because a deploy replaces the dashboard's vars with
   the config's.
2. Let a preview agent take a turn (and, for `github.refresh`, make a renewal happen or wait for one).
3. Check it: `GET $HOST/admin/diagnose?tenantId=<tenantId>&agentId=<agentId>` has `traceForwardConfig.state` `on`, and
   `githubRefreshForward` and
   `agentTraceForward`, each with `stagedThrough` moving, `queued` 0, `backoff` null and nothing in `recent` (or the
   reasons it was not sent: `auth_or_off` with 401 is the token, with 404 the receiver switched off or without the
   route; `unsendable` a row whose tenant or agent is not an id; `rejected` rows the receiver refused, with its reason
   in `detail` and the totals in `agentTraceForward.rejected`). Workers Logs has `github.refresh.forward` and
   `trace.forward` lines (`result` `sent`, `kept`, `dropped` or `retry`, with `reason` and `status`; never the URL or
   the token), though the object's lines can be dropped (above). On the receiving side, the rows are in `otel.logs`
   with `env` `preview`.
4. Then the same for production: the secret with `--config cf/wrangler.jsonc`, the var in `cf/wrangler.jsonc`.

**Turning it off.** `wrangler secret delete TRACE_INGEST_TOKEN --config <that deployment's config>` (and the old
`GITHUB_REFRESH_INGEST_TOKEN` if it is still set; immediate), or remove the URL var and deploy. From the next pass
nothing is staged or sent; whatever an object had queued stays in its queues, untouched, and goes out if it is turned
back on. Nothing else changes: the R2 export carries every row either way.

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

## Raft managed MCP on an agent

What the agent is offered from its Raft Server's connectors (docs/plugins.md, "Raft's managed MCP"). Nothing here
needs a Raft message or a model call.

1. **Its credential holds `mcp`.** The raft mount's listing asks for the catalogue only then. List the mount again and
   read what it offers; the answer carries no credential:

   ```
   curl -s -X POST -H "x-harness-token: $AUTOMATION_TOKEN" -H "content-type: application/json" \
     "$HOST/admin/mounts" -d '{"tenantId":"<tenantId>","agentId":"<agentId>","refreshTools":"raft"}' | jq '{tools: [.tools[] | select(startswith("mcp_"))], skipped}'
   ```

   One `mcp_…` name per catalogue entry is the expected answer for a Server with a connected connector. None, with
   `mcp_` entries absent from `skipped` too, means the credential lacks `mcp` or the Server has no connector for the
   agent. A `skipped` entry named `(managed MCP catalogue)` means Raft did not answer the catalogue request (its reason
   says how); one per tool means the kernel left that tool out (a description over 2,048 characters, a schema over
   16,384, or more than 128 tools on the mount).
2. **The request reached Raft.** The listing and each call write a `raft.call` line to the Workers logs:
   `node cf/scripts/logs.mjs --agent <agentId> --since 30m`, and look for `route` `/internal/agent-api/mcp/tools`
   (the listing) and `/internal/agent-api/mcp/call` (a call), each with its `status`. A call's line with `status`
   `null` and an `error` is a connection that failed mid-call: the operation is recorded `unknown`, the model was told
   to check before calling again, and nothing retried it.
3. **A connector that needs reconnecting** is one line in the raft mount's paragraph of the agent's instructions, in the
   SDK's words ("… is set up on this server but disconnected right now; …"); a connector tool the agent is not offered
   (step 1's `skipped`) is a line `"<server>": "<tool>" is not available here (…).` beside it, the names cleaned and quoted. Either reaches a
   conversation already under way as a notice. The catalogue only carries these once Raft's Server sends `unavailable` (Raft #10091).
4. **Freshness.** The catalogue is listed again at the agent's first turn five minutes after the last listing, and at
   once after a call was told it is stale; step 1 lists it now.

## Subagents

Every hosted agent can delegate work to subagents (docs/agent-surface.md, "Subagents"), its Agents API sessions
included. Subagents can read and research but cannot change anything or act as this agent: no writes, no messages, no
shell. Give them reading tasks and do the changes yourself. The bench tenant's agents and evaluation agents provisioned
with an explicit tool choice have them only where their setting turns them on (`harness: "minimal"` never), so a deploy
changes no measurement.

**Kill switches.** For one agent, turn its setting off:

```
curl -s -X PATCH -H "x-harness-token: $AUTOMATION_TOKEN" -H "content-type: application/json" \
  "$HOST/admin/agent-settings" -d '{"tenantId":"<tenantId>","agentId":"<agentId>","settings":{"subagents":false}}'
```

For every agent of the deployment at once, set the Worker var `SUBAGENTS_DISABLED` to `1` (a var, not a code change:
`wrangler deploy --var SUBAGENTS_DISABLED:1`, or the dashboard's variables); unset it to undo. The var beats any agent's
setting. The answer is the settings in force, what moved, and what each setting does: `{"settings":{"subagents":false},
"changed":["subagents"],"disabledEverywhere":false,"about":{"subagents":"…"}}`; the GET also says `stored` and
`defaults`. Either switch stops **new** children at once: a turn already running is refused at its next `send_to_agent`
call (a start or a follow-up), and a finished child's background completion no longer starts a turn of it. It also stops
the children **already running**: each is marked stopped and its run cancelled, and its parent gets one notice for all of
them ("subagents were switched off for this agent; N running children were stopped: …"). The parent's own turn goes on.
The setting does this when it is written (the answer then says `stoppedSubagents`); the var, at each agent's next pass,
which comes at least every 5 minutes while a child runs. A report already owed when the switch is set is still
delivered. On again is the same call with `true`.

An Agents API caller that declares its own function named `send_to_agent` keeps it: the agent is then not offered its
own `send_to_agent` (a `subagent.tool_shadowed` log line says so). **Turning it off does not stop subagents already running**: they finish and report. To stop
them, stop the agent's turn with `/admin/cancel-turn` ([Stopping a runaway agent](#stopping-a-runaway-agent)), which
stops every subagent with it. An unknown setting or a value that is not a
boolean is `400` and nothing is written; an agent that is not there is `404`. Each change is an `agent.settings` line in
the Workers logs.

**Measuring a trial.** `cf/scripts/subagent-trial.mjs` reads an agent's trace export from R2 and prints, per UTC day and
in total, the model calls and tokens of its own conversations and of its subagents, the main conversation's input
tokens per call (median and p90: its context's growth), rebuilds that ran, delegations (spawns, follow-ups, wakes),
child turns by outcome, and report sizes. Read-only; needs `CF_API_TOKEN` (R2 read) and `R2_ACCOUNT_ID`, as
`~/.secrets/antiproton.env` has them:

```
node cf/scripts/subagent-trial.mjs [--preview] --tenant <tenantId> --agent <agentId> --from 2026-10-20 --to 2026-10-27 [--json]
```

Rows still in the agent's outbox (the last pass's) are not exported yet. `--file rows.ndjson` reads rows saved
elsewhere (the preview trace route's page works too). Compare a window before the agent had subagents with one after.

**Raft activity.** A subagent's work reaches Raft's activity log only where the Worker var `SUBAGENT_ACTIVITY` is `1`
(docs/agent-surface.md, "Subagents", Raft). Leave it unset until Raft's ingest accepts the subagent fields: it strips
fields it does not know, and a child's step would then read as the agent's own.

To see an agent's subagents and the setting:

```
curl -s -H "x-harness-token: $AUTOMATION_TOKEN" "$HOST/admin/agent-settings?tenantId=<tenantId>&agentId=<agentId>"
```

`subagents` lists them, newest first: `id` (the child's session, `sub_…`), `parentSession`, `state` (`running` while a
turn is in flight, else `idle`), `turns`, `outcome` of the last turn (`done`, `failed`, `cancelled` at the 30-minute
ceiling, `stopped` with its parent), and `modelOption`. A child's work is in the agent's trace, its rows naming its
session (`model.call` `attrs.session`, `tool.call` `attrs.task`) and one `subagent.turn` row per turn (`done`, `failed`,
`cancelled`, `stopped`, or `report_failed` for a post that will be retried). A child's transcript is read like the
agent's: `/admin/transcript?tenantId=<tenantId>&agentId=<agentId>&taskId=sub_…`.

A delete — the provider's (`DELETE /provision/agents/…`) or an Agents API agent's (`DELETE /v1/agents/{id}`, which
until now only removed the owner's index row) — stops the agent's turn and every subagent in the agent's own object and
marks it deleted, so nothing it began calls the model again. After it, `/admin/agent-settings` answers `404` for read
and change. `/admin/transcript` still reads the deleted agent's conversations and its subagents', for what happened:
a delete keeps the object's data.

**Stopping.** A stop of the agent stops its subagents with it: `/admin/cancel-turn`, the provider's stop and a delete
([Stopping a runaway agent](#stopping-a-runaway-agent)) mark every running subagent `stopped` and cancel its turn, on
both engines, and no report is sent (a report would wake the turn the stop ended). `/admin/cancel-turn` answers
`interrupted` when only subagents were running, too. There is no route that stops one subagent alone. While any
subagent runs, a fresh context and a reset refuse, as they do for a running turn. An Agents API session's cancel stops
the subagents that session started, and deleting the session stops them first and drops their owed reports.

Each pass also cancels any subagent session that has work while nothing tracks it — no row, or a row a stop ended (a
run that landed as the stop did) — logged as `subagent.stray`. A finished subagent's own background job is not that:
it runs to its end, and its completion wakes the subagent under its limits. A subagent lives at most 2 hours from its creation and takes at most 10 turns;
each turn is cancelled after 30 minutes. A finished subagent is archived after 7 days idle (its transcript deleted, its
row kept with state `archived`; a `subagent.archived` log line each), at most 5 a pass. A bench task's end
(`benchSweFinish`) stops its subagents as a stop does. A report whose post fails stays owed and is retried with backoff (5 s doubling
to 10 minutes), each failure a `subagent.turn` row with status `report_failed`; after 8 attempts it is dropped
(`report_dropped`) and the subagent is idle with outcome `report_failed`. A subagent whose model option a pin or the
picker switch overrides after its spawn writes a `subagent.model_changed` row, and its next report says so.

## Where agents get stuck

A daily friction scan reads yesterday's (UTC) conversations of the hosted agents in scope and writes a report of where
they got stuck to the private artifacts bucket (`antiproton-artifacts`, never the public runs bucket):
`friction/<YYYY-MM-DD>.json` and `friction/<YYYY-MM-DD>.md`. It runs in the daily Cron Trigger (`17 3 * * *`), after
the usage retention (`dailyCron`, `cf/src/friction-scan.ts`); the classifier is `cf/src/friction.ts`, and its rules
were calibrated on the hosted traffic of 2026-10-17 and 2026-10-18.

**Scope, and what was decided.** `FRICTION_SCAN_TENANTS` decides whose conversations are read: comma-separated tenant
ids, or `*` for every hosted (`raft_…`) tenant. Unset or empty, nothing is read and no report is written. The `bench`
tenant (and any agent named `bench…`) is never read, whatever the var says. No wrangler config sets it; set it as a
Worker var (`wrangler deploy --var FRICTION_SCAN_TENANTS:'*'`, or the dashboard's variables). Scanning every hosted
agent was approved on these terms, and the var is not to be widened, nor the terms changed, without a new decision:

- purpose: finding product friction, and nothing else;
- the private report carries tenant, agent and conversation ids, seq numbers, templated errors and short redacted
  excerpts of the agent's own words and commands (at most 140 characters, credential shapes removed); never a user
  message and never raw tool output. User messages do not leave the agent's object at all (`cf/src/friction-read.ts`);
- reports are kept 30 days (each run deletes older ones);
- reports are read by the antiproton team only;
- public GitHub issues carry counts and id-free templates only (below).

**Reading the report.** The `.md` is for people, the `.json` for tools. Its header says what was read: agents found
(from the day index, or a listing when the day has none), agents read, conversations, events, and whether anything was
cut (`maxAgents`, the time budget, conversations or events capped per agent). Section 1 is the headline: **stuck
episodes**, grouped by root cause. An episode is one conversation with 3 or more friction classes less than 10 minutes
apart that ends in the agent saying it cannot do something or in 3 or more hard failures; its root is the first hard
failure (a tool error, an auth failure, a binary read as text, a guessed endpoint's 404, a model failure), which is
what a fix targets. Section 2 ranks every signal group by class weight × distinct agents × log2(1 + count). Each root
and group has a fingerprint (`fr_…`), a hash of its class and id-free key: the same problem has the same fingerprint
on every day and every agent. To see an episode in full, follow its ids:

```
curl -s -H "x-harness-token: $AUTOMATION_TOKEN" "$HOST/admin/transcript?tenantId=<tenant>&agentId=<agent>&taskId=<conversation>"
```

and look at the `sequence` numbers the report lists. Inability text still matches some explanations (it counts only
as a turn's last words or within 10 minutes after a failure), so treat a group of `inability_text` alone as a lead,
not a finding.

**On demand.** `POST /admin/friction-scan?day=YYYY-MM-DD` runs the same scan for any day, under the same tenant list
and kill switch, and answers the report. It writes the report unless `write=0`, and never files issues.

```
curl -s -X POST -H "x-harness-token: $AUTOMATION_TOKEN" "$HOST/admin/friction-scan?day=2026-10-18&write=0" | jq '.report.roots'
```

It answers `409` when no tenant is in scope and `503` when the scan is switched off.

**Kill switch.** Set the Worker var `FRICTION_SCAN_DISABLED` to `1`: the cron step and the route stop before reading
anything. The usage retention in the same cron is not affected. Each cron run logs one `friction.scan` line saying what
it did or why it failed; a failing or slow scan cannot fail the cron (it is cut off after its budget plus a minute).

**Issues** are off. They are filed only when the Worker var `FRICTION_ISSUES` is `1` **and** two Worker secrets are
set; with either missing nothing is filed, and each cron run logs a `friction.issues` line naming what is missing:

- `FRICTION_GITHUB_TOKEN`: a token used for nothing else, allowed to create issues and comments in
  `FRICTION_ISSUES_REPO` (default `botiverse/antiproton`);
- `FRICTION_HASH_KEY`: a random key (e.g. `openssl rand -hex 32`) that agent ids are HMAC'd under in an issue, so
  knowing an agent's id does not let anyone check whether it is in one. Never in the repository or a wrangler config;
  changing it renames every agent in later issues.

Set both with `wrangler secret put`, then the var. Then the cron (never the route) opens one issue labelled
`agent-friction` for each new fingerprint among the hard classes that is an episode's root, an auth failure, or seen
on 2 or more agents, at most 5 a day, and comments on a known one only when its counts changed. The repository is
public, so an issue holds the fingerprint, the class, counts, the hashed agent ids, the build and the window. An error
text appears only when the key matches one of our own fixed product messages (`KNOWN_TEMPLATES` in
`cf/src/friction-scan.ts`: the attachments_view size refusals, the background-job limit, the gh mount's refused
credential, web__get's refused scheme, the two fixed managed-MCP texts from `@botiverse/raft-sdk`
(`MCP_OUTCOME_UNKNOWN_TEXT`, `MCP_CALL_INTERNAL_ERROR_TEXT`), binary read as text, our own API hosts' 401/403/404), and then it is that
list's text, never the key. Anything else reads "withheld (see private report, fingerprint fr_…)". Never an excerpt,
a command, a raw id or a conversation id. Adding a message to the list needs its source and a test. Which issue a
fingerprint has is kept in `friction-state/issues.json` in the private bucket. Create the label in the repository
before turning issues on.

**The day index.** Each agent's trace flush writes an empty object `trace-index/<day>/<tenant>/<agent>` the first
time it exports rows for a UTC day (`noteTraceDays`, `cf/src/trace-r2.ts`), so the scan never lists the whole
`trace/` prefix. Its failure is only warned about (`trace day index for …`) and retried on the next flush. Index days
older than 14 days are deleted by the scan, one day per run. A day with no index at all (one before the index was
deployed) falls back to listing the in-scope tenants' `trace/<tenant>/` prefixes, bounded by `maxAgents`.

## Checking that a string is stored nowhere for an agent

`POST /admin/storage-scan` (operator token) reads every table and row of one agent's object and every R2 object under
its prefixes (`t/<tenant>/<agent>/`, `trace/<tenant>/<agent>/`), and says where a string is found: table names and a
count of objects, with how much was read. It is the check for a data contract such as RaftBench's (no copy of the
source text outlives a run). A match is case-insensitive and also looks inside JSON-escaped strings. The needle is not
returned and not logged (`admin.storage_scan` carries the ids and `found`). Past its caps the answer says `truncated`,
and a `found: false` then covers only what was read. Each call reads a few MB of an agent's tables at most, skips R2
objects over 16 MB (`skipped`), and stops its R2 walk at 256 MB read. Cloudflare's and SQLite's own tables (`_cf_…`,
`sqlite_…`), which an object may not read and which hold none of the agent's data, are counted in `systemSkipped`. A
table that fails to read is named in `unreadable`, and the answer is then `truncated` and not `complete`.

**A scan passes only with `found: false`, `truncated: false` and an empty `unreadable`** (`complete: true`). Anything
else is not a pass: a `found: false` beside `truncated` or `unreadable` says only that the part that was read held none.
A failure is answered `500` with a fixed text and a `reason`: `object_scan` (the agent's object threw) or `r2_scan`
(the R2 walk threw). The `admin.storage_scan` log line carries the same reason and the error's class (`errorName`),
never its message. Right after a deploy, an agent's object can still run the previous build until it restarts (its
`harness.open` line says `cause=deploy` when it does): a scan that fails `object_scan` then is that object, so wait for
the restart and ask again. It is operator-only for a reason: any substring of four characters or more can
be asked about, so it answers whether a text is stored, and is an oracle for what an agent holds.

```
curl -s -X POST -H "x-harness-token: $AUTOMATION_TOKEN" -H "content-type: application/json" \
  -d '{"tenantId":"<tenant>","agentId":"<agent>","needle":"<a marker placed in the material>"}' "$HOST/admin/storage-scan"
```

## Listing which agents' mounts hold a connection credential

`GET /admin/credential-inventory` (operator token, plus an `x-claimed-caller` header naming who is asking) lists the
provisioned agents, deleted ones included, and for each its GitHub connection reconciled two ways: what the agent's
object says its `github` mounts hold, and what D1 says (the `provisioned_connections` binding). The `state` is `both`,
`mount_only` (a key on the mount with no binding: what a disconnect that did not clear the mount leaves), `binding_only`,
`neither`, or `unknown` (the object did not answer: `object: "failed"`). A mount-only key also says whether a binding
removal was recorded in `connector_events` (`removalRecorded`, `lastRemoval`). Each agent's recent events and its open
`egress_residue` rows (`box_id`, `secret_id`, `title`, `reason_code`, …) come with it. Residue whose agent the registry
does not list comes once, on the last page, as `residueOfUnlistedAgents`.

A key is reported by its presence, the connector its renewal names, and `fingerprint`: the first 16 hex characters of
its SHA-256, which tells two copies apart without recovering either. Reading changes nothing in the object.

One page per call: `limit` agents (default 10, at most 25), each one's object asked. Pass `tenantId` for one tenant, or
none to walk every tenant. A page with more after it carries `cursor`; pass it back to continue. Every call, refused ones
included, is an `admin_audit` row (`route = '/admin/credential-inventory'`) with the page's counts.

It cannot see run9's egress registrations themselves, only the residue already recorded in `egress_residue`. It does
not list agents that were not provisioned (console agents). Its counts are a stock at the time read: they say what is
there now, not when or by which build it got there.

## Moving a Raft server's agents to a new tenant

A platform token acts in the tenant its request's server id derives (`derivedTenant`, cf/src/provision/handlers.ts).
A server id that is not a legal tenant id as it stands derives `raft_<readable>_<12 hex>`, not the substituted or cut
`raft_<id>` it used to. That means ids with a character outside letters, digits, `.`, `_` and `-`, ids longer than 59
characters, and ids ending in `_` plus twelve hex digits. A server like that that provisioned agents before the change
finds none of them afterwards: its requests now address a tenant that holds nothing. On 2026-10-17 neither the
production nor the preview `provisioned_agents` had such a server; every derived tenant there is `raft_<UUID>`. To
check again, read `raft_server_id` and `tenant_id` from `provisioned_agents` and look for an id that fails
`/^[A-Za-z0-9._-]{1,59}$/` or matches `/_[0-9a-f]{12}$/`.

Rewriting `tenant_id` in D1 does not move them. The tenant is part of where the agent lives, not only a column:

- **The agent's Durable Object.** Its name is `a/<tenantId>/<agentId>` (`agentObjectName`, cf/src/object-name.ts), and
  an object's id comes from its name, so the new tenant's name addresses a new, empty object. The old object's SQLite
  (tasks, transcript, mounts and their credentials, seed files) also keys its rows on `tenant_id`
  (src/store/ap-store.ts, src/store/plugin-db.ts, src/store/seed-files.ts, src/store/seed-record.ts).
- **D1.** `tenant_id` is a column of `provisioned_agents`, `tenant_plans`, `tenant_model_picker`, `spend_limits`,
  `spend_limit_events`, `spend_pool_limits`, `spend_pool_limit_events`, `usage_daily`, `usage_hourly`,
  `usage_cursor`, `model_choices`, `model_overrides`, `connectors`, `provisioned_connections`, `inbound_hooks`,
  `connector_events`, `provider_tokens`, `api_keys`, `identities` and `service_tokens`.

So a migration is one of these two:

1. **Move the objects.** For each agent, create the object under the new name, copy the old object's rows into it
   with `tenant_id` rewritten, then update the D1 rows above in one batch. Retire the old object only after the new
   one has answered for the agent. Usage rows can stay under the old tenant as history, or be re-keyed so a spend
   limit counts them.
2. **Fall back to the old tenant.** Keep the objects where they are, and let the provisioning routes look an agent
   up under the server's old derivation when the new tenant has no row for it. This needs code: the old spelling
   (`raft_` + the id with every character outside `[A-Za-z0-9._-]` replaced by `_`, cut to 64) is no longer computed
   anywhere. It also brings back the shared namespace the derivation exists to prevent, for any server that still
   derives that old name.

### Which issuance paths accept a `raft_` tenant

`raft_` is the prefix of every tenant a Raft server id derives. A credential that brings a new principal into a tenant
under it would act in whichever server's tenant that is. The check is `reservedTenantProblem`
(cf/src/admin-provider-tokens.ts), and it refuses at issuance only, so a row issued earlier still resolves and can
still be listed and revoked.

| Path | Under `raft_` | Why |
|---|---|---|
| `POST /admin/provider-tokens`, `scope: "tenant"` | `400` | The token is a whole tenant, and its agents, quota and billing are that tenant's. |
| `POST /admin/provider-tokens`, `scope: "platform"` | n/a | It names no tenant; each request derives `raft_<raftServerId>`, the one source of these names. |
| `POST /admin/api-keys` | `400` | The key's owner agent, and every agent it makes, are created in the named tenant and spend its limit. |
| `/ui/api-keys/new` | n/a | The tenant is the signed-in person's own, never a value from the request. |
| `POST /admin/service-tokens` | only for an existing provisioned agent: an explicit `agentId` with a live `provisioned_agents` row in that tenant, otherwise `400` | An operator may need a token that reaches a provisioned agent in a Raft server's tenant. Without `agentId` the route would make a new agent named after the label, which is a new principal there. |
| `POST /admin/hooks`, `POST`/`PATCH /admin/mounts` | accepted | They act on the object of the agent named by `(tenantId, agentId)` and issue no credential for the tenant. Neither checks that the agent exists. |

All of these are operator-only. Preview has one tenant-scoped provider token under `raft_`, `raft_pu-verify-1013`. The
admin route issued it before the refusal existed, and it is revoked.
