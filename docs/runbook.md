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
