# Agent usage and workspace

Three read-only endpoints show one agent's usage and the files it works with. They exist on two
surfaces that answer the same bodies from the same code (`cf/src/agent-surface/`):

- **The public API** (`/v1/agents/:agentId/...`), authenticated with an API key. This is the primary
  contract.
- **The Raft provider binding** (`/provision/agents/:agentId/...`), authenticated with a provider token.
  This is the same contract addressed the way a Raft server addresses its agents.

Nothing here writes, starts a container, or shows a secret — except the
[evaluation setup](#evaluation-setup-preview-only) routes at the end, which exist only on the preview
deployment.

## The public API

Every request sends `Authorization: Bearer ap-...` (see [`agents-api.md`](agents-api.md) §2). The
agent must be one the key's owner made through the API (the agents `GET /v1/agents` lists). Any other
id — another owner's agent, another tenant's, a deleted one — is `404` with `code: "not_found"`, the same
answer as an id that never existed.

| Method | Path | Answers |
|---|---|---|
| `GET` | `/v1/agents/{agentId}/usage?from=&to=&bucket=` | the agent's usage, bucketed |
| `GET` | `/v1/agents/{agentId}/workspace/files?dirPath=&includeHidden=` | one directory level of its workspace |
| `GET` | `/v1/agents/{agentId}/workspace/files/read?path=` | one file of its workspace |

Errors use the API's usual envelope: `{ "error": { "message", "type", "param", "code" } }`. A bad
parameter is `400`, `code: "invalid_value"`, with the parameter named in `param`; a failure underneath
is `502`, `code: "upstream_unavailable"`.

### `GET .../usage`

| Parameter | |
|---|---|
| `from` | Required. ISO 8601 time with a zone (`2026-10-01T00:00:00Z`, `2026-10-01T08:00:00+08:00`). An unencoded `+` that arrives as a space before the offset is read as the `+`. |
| `to` | Required, the same form, later than `from`. The window asked for, `to − from`, is at most 31 days; widening to whole buckets (below) can make the answer cover one bucket more. |
| `bucket` | `1h` (default) or `1d`. Days are cut at 00:00 UTC. `1h` is refused for a `from` more than 35 days ago (hourly rows past that may have been folded into days); use `1d`. |

The window is widened to whole buckets — `from` down and `to` up to a bucket boundary — and the answer
names the window it covers:

```json
{
  "agentId": "agent_1",
  "bucket": "1h",
  "from": "2026-10-01T00:00:00.000Z",
  "to": "2026-10-01T02:00:00.000Z",
  "asOf": "2026-10-02T12:00:00.000Z",
  "partial": false,
  "rows": [
    { "at": "2026-10-01T00:00:00.000Z", "resource": "model.tokens", "dimensions": { "model": "deepseek-flash", "kind": "output" }, "unit": "tokens", "quantity": 30, "cost": 0.000036 },
    { "at": "2026-10-01T00:00:00.000Z", "resource": "tool.call", "dimensions": { "tool": "gh.issue_list", "outcome": "failed" }, "unit": "calls", "quantity": 2, "cost": null }
  ]
}
```

- `at` is the bucket's start. Rows are ordered by `at`, then resource, dimensions and unit. A row whose
  quantity would be zero is left out; no quantity is negative.
- `asOf` is how far the ledger speaks for this agent: the time of the read, or, when the agent holds
  usage it has not yet sent to the ledger, the time of the oldest such usage.
- `cost` is the row's estimated cost in US dollars (one credit is one dollar), from rough prices
  (docs/metering.md, "Prices"); `null` when nothing prices that row — which is not the same as free. Usage
  paid with the agent's own credential (a tool `own:<plugin>.<tool>`, a container `own:sandbox`) is `0`.
  The costs of a bucket's rows can be summed even where the quantities cannot (`input`, below).
- `partial` is `true` when the window ends after `asOf` (a bucket in it is not finished, or holds usage
  not yet counted), when the agent's unsent usage could not be read, or when the ledger marks part of
  the window as unreadable. A `partial` answer is a lower bound.

**One rule: rows of the same resource share a unit and can be summed directly — no kind contains
another, except `input`.** `input` is the whole prompt as the provider counts it, so `cache_read` is the
part of it served from cache; its `cost` is for the uncached part only. The ledger's own `tool.call` time rows (unit `ms`) are therefore emitted as their own
resource, `tool.duration`. The one exception is a resource passed through as the ledger holds it (last
row below), which keeps the ledger's units: sum those per `unit`.

| `resource` | `dimensions` | `unit` | |
|---|---|---|---|
| `model.tokens` | `{ model, kind }` | `tokens` | `kind` is one of `input`, `output`, `reasoning`, `cache_read`, `cache_write_5m`, `cache_write_1h`. `output` **excludes** reasoning tokens (`output` as the provider counts it less `reasoning`); `cache_write_5m` is the cache write less its 1-hour part. A model's own name may contain `:`. |
| `tool.call` | `{ tool, outcome }` | `calls` | `outcome` is `succeeded` or `failed`; `succeeded` is all calls less the failed ones. |
| `tool.duration` | `{ tool }` | `ms` | Time spent in the tool (the ledger's `tool.call` rows in `ms`). |
| anything else | `{ key }` | as recorded | Passed through as the ledger holds it (for example `js.run` / `{ key: "run_js" }` / `runs`). |

The subtraction is made per bucket and per model or tool. A difference that would come out negative
(the ledger disagreeing with itself) is left out and logged on the server.

### `GET .../workspace/files`

| Parameter | |
|---|---|
| `dirPath` | The directory to list, e.g. `state/notes/`. Empty or `/` is the top level. A trailing `/` is optional. |
| `includeHidden` | `true` or `false` (default). Hidden entries are those whose name starts with `.`. |

Answers one directory level, directories first, then by name, at most 1000 entries. A listing that
left entries out says so: `truncated: true`, and `omitted` with how many when that is known (a
container whose output was cut short may not say). A whole listing has neither field.

```json
{ "files": [
  { "name": "notes", "path": "state/notes/", "isDirectory": true, "size": 0, "modifiedAt": "2026-10-01T01:00:00.000Z" },
  { "name": "memory", "path": "state/memory", "isDirectory": false, "size": 31, "modifiedAt": "2026-10-01T01:00:00.000Z" },
  { "name": ".draft", "path": "state/.draft", "isDirectory": false, "size": 8, "modifiedAt": "2026-10-01T01:00:00.000Z", "isHidden": true }
] }
```

```json
{ "files": [ ... ], "truncated": true, "omitted": 41 }
```

`path` is what to pass back as `dirPath` (a directory, ending in `/`) or as `path` to the read (a
file). `modifiedAt` is ISO 8601; where a store does not keep a time it is the epoch.

The top level is always three directories:

| Root | What it holds |
|---|---|
| `state/` | What the agent keeps with its state tools, one file per key; a `/` in a key makes directories. A text value is its text; any other value is JSON. In a listing, a state file's `size` is its stored (JSON-encoded) size; the read reports the size of the content it returns. The agent's sealed secrets are never listed and never readable, under any spelling of their name; mount credentials and hook secrets are not part of the workspace at all. |
| `artifacts/` | The agent's objects in object storage: tool results too large to return inline, files saved out of its container, and state values too large for a row. |
| `sandbox/` | The working directory (`/work` by default) of the agent's container, **only while that container is already running**. A look never starts one: a container is billed while it runs. When none is running, `sandbox/` holds a single file, `NOT_RUNNING.txt`, saying so, and any other path under it is `404`. "Running" means both that antiproton has not switched the container off and that its provider lists it as awake (run9's `idle` or `running`, not `ready`). One race remains: the provider may put an idle container to sleep in the moment between that check and the look's first command, which then wakes it (see `AWAKE_STATES` in `src/plugins/sandbox.ts`). |

Listing a directory that does not exist is `404`; listing a file in `sandbox/` is `400` with
`param: "dirPath"`.

In `sandbox/`, symbolic links are listed as files and never followed. A path whose real location —
every link in it resolved inside the container — is outside the working directory is `404`, so a link
to `/` or to a file elsewhere in the container shows nothing of what it points at. Only a regular file
is read; a device, FIFO or socket is `400`. A look takes at most 10 seconds (a listing) or 20 (a read),
and never holds up the agent's own use of its container for longer than it takes to check the container
is awake and start the look.

### `GET .../workspace/files/read`

| Parameter | |
|---|---|
| `path` | Required. A file under one of the three roots, e.g. `state/memory`. |

```json
{ "content": "the user prefers short answers", "binary": false, "size": 31, "mimeType": "text/plain", "encoding": "utf-8", "sha256": "…" }
```

- Text (valid UTF-8 with no NUL byte) comes back as `content` with `encoding: "utf-8"`.
- Anything else comes back base64-encoded: `binary: true`, `encoding: "base64"`.
- A file over **1 MB** (1,048,576 bytes) is not returned: `content: null`, `binary: true`,
  `encoding: "base64"`, and `size` still says how large it is.
- `sha256` is the hex SHA-256 of the bytes `content` stands for (its text as UTF-8, or the base64
  decoded), and `null` when `content` is. A seeded file's working copy
  ([evaluation setup](#evaluation-setup-preview-only)) hashes to its manifest entry until it changes.
- `mimeType` is taken from the name's extension, else what the store recorded, else `text/plain` or
  `application/octet-stream`.
- A path to a directory is `400`; a path that does not exist is `404`.
- When something underneath fails (the ledger, the agent, object storage, the container's provider),
  the answer is `502` with a sentence that names none of it; the detail is logged on the server only.

### Paths

Both `dirPath` and `path` are normalised before anything is read: empty and `.` segments drop out
(`state//a/./b` is `state/a/b`). A path is refused with `400` and the parameter named when it has a
`..` segment (also percent-encoded, `%2e%2e`), a segment that decodes to one containing `/`, a backslash,
or a control character, or when it is not under `state/`, `artifacts/` or `sandbox/`. A path is never
resolved against anything outside the agent's own three roots.

## The Raft provider binding

The same three reads for an agent a Raft server provisioned, with the provider token
(`Authorization: Bearer <provider token>`), addressed the way every other provider route is, and one
read of the tenant as a whole:

| Method | Path |
|---|---|
| `GET` | `/provision/agents/{agentId}/usage?from=&to=&bucket=` |
| `GET` | `/provision/agents/{agentId}/workspace-files?dirPath=&includeHidden=` |
| `GET` | `/provision/agents/{agentId}/workspace-files/read?path=` |
| `GET` | `/provision/usage?from=&to=&bucket=day\|month` — the tenant's spend and daily limit ([below](#the-tenants-spend)) |
| `PUT` | `/provision/servers/{raftServerId}/plan` — the server's plan, which picks its daily limit ([below](#the-servers-plan-plan)) |
| `PUT` | `/provision/servers/{raftServerId}/model-picker` — whether the server's agents may pick another model than the default ([below](#the-servers-model-picker-model-picker)) |
| `POST` | `/provision/agents/{agentId}/import` — the agent's workspace, once ([below](#workspace-import)) |
| `GET` | `/provision/import-limits` — the bounds an import is held to ([below](#workspace-import)) |
| `POST` | `/provision/agents/{agentId}/stop` — end the agent's running turn without deleting it ([below](#stopping-a-turn-stop)) |

`{agentId}` is the `providerAgentId` the provisioning call returned. As on every provider route,
`/provision/agents/by-raft-agent/{raftAgentId}/...` reaches the same agent by the Raft agent's id.

- **Tenant.** A tenant-scoped token is its tenant. A platform-scoped token needs `?raftServerId=` on
  every one of these requests, beside the read's own parameters; without it the answer is `422` with
  `param: "raftServerId"`. The agent is looked up in the tenant that server names, so an agent of
  another server is `404`.
- **Which agents.** Only a provisioned agent of the token's tenant that has not been deleted. Another
  tenant's agent, a deleted agent, and an id that never existed are all `404`, `code: "not_found"`.
- **Bodies.** Identical to the public API's, except that the usage answer names the agent as
  `raftAgentId` and `providerAgentId` instead of `agentId`.
- **Errors.** The provider envelope: `{ "error": { "code", "message", "param"? } }`. A bad parameter is
  `400`, `code: "invalid"`, `param` naming it; a missing agent, file or directory is `404`,
  `code: "not_found"`; a failure underneath is `502`, `code: "unavailable"`.

**An agent's `instructions`** (`POST /provision/agents` and `PATCH /provision/agents/{agentId}`) are
at most 8000 characters, counted as `String.length` counts them (`INSTRUCTIONS_MAX`,
`cf/src/provision/handlers.ts`). Over it is `422`, `code: "invalid"`, `param: "instructions"`, with
the limit and the value's size in the message, and nothing is made or changed; a value is never cut.
A deployment serving the evaluation routes counts them differently ([below](#instructions)).
A `PATCH` of `name` or `instructions` reaches the agent's next turn, including when its harness is
already open: the harness is rebuilt when its persona or its model binding differs from what it was
built from (`harnessKey`, `cf/src/runtime.ts`), never under a turn that is running. On a `pd` agent the
changed section reaches the model as a newer system message after the conversation's first one, as
pi-durable sends any prompt change; on `pi085` the prompt is rebuilt whole.

**An agent's `model`** (`POST /provision/agents`, optional) creates it on a chosen model in the same call: an
offered option's id ([below](#the-agents-model)), or `null` or absent for the default, which is the create as it
was. A value neither a string nor `null` is `422 invalid`. On a first create, before anything is made, an id not
offered is `422 unknown_model`; where the deployment enforces the server's model picker (`MODEL_PICKER_ENFORCE`)
and it is off ([below](#the-servers-model-picker-model-picker)), any model but the default is
`403 model_picker_disabled`, and the default is taken without storing a pick; otherwise a model while an administrator's agent or tenant row applies is
`409 model_locked` (all with `param: "model"`) — the agent is not made and its Raft id is not taken, so the same
POST without `model` is then a first create (`201`). A deployment that offers no options takes only `null`. The
answer's body is the same as without it; `GET …/model` reads the pick as `source: "chosen"`.

`model` is part of the request a replay is compared with, `null` and absent being one value: the same `model`
answers the same, and another (or one where the create had none, or none where it had one) is
`409 idempotency_conflict` naming `model`. A replay is compared, not checked again: an option withdrawn, or a lock
set, since the create does not refuse the identical replay of an agent that exists. It is compared with what the
create asked, not with what runs: a delayed replay after a `PUT …/model` (`null` included) answers as the create
did and leaves the newer pick alone. One exception: a create that named a model and failed before storing its pick
(still `provisioning`) has not chosen yet, so its replay may name another model or none, checked as a first create
— the way out when the option was withdrawn or a lock set in between — and answers `201`, the create completing.
A `PUT …/model` in between is a choice made, so after it that replay is an ordinary one and leaves the PUT's pick.

### The agent's model

Raft's Agent Panel lets a person pick the model of an agent Raft hosts. Production routes, not part of
the evaluation set; authentication and tenant as above (`?raftServerId=` for a platform token, on
`/provision/models` too), and `404` for an agent that is not a live provisioned agent of the tenant.

| Method | Path | Does |
|---|---|---|
| `GET` | `/provision/models` | the models this deployment offers, and the default |
| `GET` | `/provision/agents/{agentId}/model` | what the agent's next turn runs on, and why |
| `PUT` | `/provision/agents/{agentId}/model` | `{ "model": "<id>" }` picks an option; `{ "model": null }` follows the default |

```json
GET /provision/models
{ "models": [{ "id": "deepseek-flash", "label": "DeepSeek Flash", "provider": "deepseek" }],
  "default": "deepseek-flash", "defaultLabel": "DeepSeek Flash", "locked": false, "pickerEnabled": false }

GET or PUT /provision/agents/{agentId}/model
{ "model": "deepseek-flash", "label": "DeepSeek Flash", "source": "default", "locked": false }
```

- **The options** are the deployment's `USER_MODELS` (README.md, "Model providers"), the list the
  console's model picker and `/admin/models` read: each option's `id`, `label` and provider id, never a
  model's address, a gateway or a secret. An option whose provider's secret is unset is not listed.
  Without `USER_MODELS` the list is empty, and only `null` is accepted.
- **`model`** (and `default`) is the offered option's id when one names what runs, else
  `<provider>/<model>` — the Agents API's name for it — which is how a model an administrator set and no
  option names reads.
- **`source`**: `"default"` (nothing chosen), `"chosen"` (a pick made here, in the console's picker or
  through the Agents API's `model` — one stored value, so the three surfaces agree), or `"admin"` (an
  administrator's row decides it).
- **Precedence** is the console's (`resolveModel`, `cf/src/model-request.ts`): an administrator's row for
  this agent, then one for its tenant, then the pick, then the administrator's deployment row, then
  `HARNESS_MODEL`. While an agent or tenant row applies, `locked` is `true` and a `PUT` — `null` included
  — is `409`, `code: "model_locked"`, `param: "model"`: kept but never run, a pick would be a setting
  accepted and ignored. The pick stays stored under the lock, and runs again once the row is removed. A
  deployment row does not lock: it reads as `"admin"` until something is picked.
- **A `PUT`** stores the pick (`model_choices`, `set_by` `provider:<the token's hash>`, the hash the
  operator's token listing names it by) and binds it at once, so the agent's next model request goes to
  the new model even while its harness is open (see the `PATCH` note above). An id not offered now
  (`"default"` and `<provider>/<model>` included) is `422`, `code: "unknown_model"`, `param: "model"`; a
  `model` that is neither a string nor `null` is `422 invalid`; any other field is `400 unknown_field`.
  The same body twice answers the same. Each accepted `PUT` leaves one `provision.model` log line naming
  the token by its hash.
- **At creation**, `model` on `POST /provision/agents` ([above](#the-raft-provider-binding)) is a pick made
  the same way — the same offered ids, the same `409` under a lock, the same row, `set_by` and log line —
  stored before the agent's model is first bound, so its first model request already goes to it. The row
  and the pick are two writes: a create that fails between them fails, and its replay stores the pick and
  finishes. The row records whether the create's pick is settled yet (`model_pending`; a `PUT` settles it
  too), so once it is, no replay writes it again. Settling makes the stored pick the create's, `null`
  included: a reopened create without `model` removes one an earlier attempt stored.
- **Off by default, where enforced.** On a deployment that enforces the switch (`MODEL_PICKER_ENFORCE` `"1"`), a
  server may pick a model other than the deployment's default only once Raft has turned its model picker on
  ([below](#the-servers-model-picker-model-picker)); until then a `PUT` of another model is `403`. Where it is not
  enforced (production and preview today) every offered pick is taken as above. `GET /provision/models` reports
  the stored switch as `pickerEnabled`.
- **An agent never given a pick** is unchanged by these routes: reading them stores nothing and rebuilds
  nothing, and it runs on the default as before (`test/provision-model.ts`).

#### The server's model picker (`model-picker`)

Which model a Raft server's agents run is the deployment's to decide unless Raft has allowed the server to choose
(Raft's `antiproton_model_picker` flag). Raft says so per server, as it says the plan:

```
PUT /provision/servers/{raftServerId}/model-picker
{ "enabled": true }
→ 200 { "raftServerId": "srv-1", "modelPicker": true, "updatedAt": "2026-10-14T09:12:00.000Z" }
```

- **Enforced only where `MODEL_PICKER_ENFORCE` is `"1"`.** A deployment variable, read in `cf/src/index.ts`
  (`modelPickerEnforced`): exactly `"1"` applies the switch as this section describes; anything else, or unset,
  stores and reports it (this route, `pickerEnabled`) but refuses and rewrites no pick, so model choice is what it
  was before the switch existed — every offered id taken and stored as a pick, the default by name included, and
  `409 model_locked` under an operator's agent or tenant row as before. No wrangler config sets it
  (`test/provision-model.ts` fails if `cf/wrangler.jsonc` or `cf/wrangler.preview.jsonc` does), because a server
  with no row reads as off: enforced before Raft has sent the switch for every server, it would refuse picks Raft
  allows. To turn it on, once Raft has backfilled every server and syncs the switch before each create: add
  `"MODEL_PICKER_ENFORCE": "1"` to the `vars` of `cf/wrangler.jsonc` (and `cf/wrangler.preview.jsonc` for
  preview), drop the wrangler check in `test/provision-model.ts` for that file, and deploy. Everything below
  "Default: off" describes the enforced behaviour.
- **Default: off.** A server Raft has never sent this for is off. Raft sends it whenever its flag for the server
  changes; the latest write wins.
- **Rollout order.** When enforcement is first turned on, **every server is off**, including servers whose Raft flag
  is already on, until Raft sends `{ "enabled": true }` for each of them. So Raft must have backfilled the switch
  for every server, and its sync of the switch before each create must be live, **before** `MODEL_PICKER_ENFORCE`
  is turned on; until then the stored switch has no effect. A server not yet synced when enforcement starts has its
  picks of another model refused with `403 model_picker_disabled`. Agents that already picked keep their model
  (grandfathered, below).
- **Tenant and auth.** Exactly as the plan's ([above](#the-servers-plan-plan)): a platform token's tenant is the one
  `{raftServerId}` names; a tenant-scoped token may only name a server its tenant's agents were provisioned for, else
  `403 server_mismatch` (`param: "raftServerId"`) and nothing is written; a malformed `{raftServerId}` is `422`.
- **Body.** Exactly `{ "enabled": true | false }`: missing is `422 missing`, a non-boolean `422 invalid` (both
  `param: "enabled"`), any other field `422` naming it. Nothing is written when it is refused. It is not accepted on
  `POST /provision/agents`: `modelPicker` there is `422 invalid`, `param: "modelPicker"`, and nothing is made — a
  create retried late must not turn back a switch flipped since, and a field silently ignored would read as allowed.
- **While off** (and enforced), for the provider routes only:
  - **The accepted ids** are a default's: the option naming `HARNESS_MODEL` (`deepseek-flash`), and the id these
    routes report as the default for the agent now — `default` of `GET /provision/models`, `model` of `GET …/model`
    before a pick. An operator's deployment, tenant or agent row may make that second id another model (e.g.
    `gpt-5.6-luna`), so a client echoing back what it was told is not refused. Either id is taken as **no pick**: the
    agent follows the default and any operator row, exactly as one created without `model`.
  - `POST /provision/agents` with `model` absent, `null` or an accepted id is made, and so is never `409
    model_locked`. Any other model is `403`, `code: "model_picker_disabled"`, `param: "model"`, with the accepted ids
    in the message, and nothing is made.
  - `PUT …/model` with `null` or an accepted id is taken as "follow the default" (the pick is removed), so an agent
    can always return to the default. Any other model is `403 model_picker_disabled` and stores nothing. An
    administrator's agent or tenant row still answers `409 model_locked` first, as with the picker on.
  - An id that is neither offered nor accepted is still `422 unknown_model`.
- **Grandfathered.** Turning the picker off migrates nothing: an agent that picked a model while it was on keeps
  that pick and keeps running on it.
  - It may `PUT` the same pick again. That is a repeat, checked before the accepted-ids rule, so a stored pick of
    `deepseek-flash` stays a pick and keeps outranking an operator's deployment row.
  - Its create's replay answers as before. A create interrupted before its pick was stored (still `provisioning`)
    finishes on its replay with the model it asked for.
  - It may return to the default (`null`), but may not pick another model, nor its old one once it has left it.
- **Operators are not gated.** The administrator's rows (`/admin/models`, deployment, tenant or agent scope) decide
  as before, above any pick, whatever the switch: the way the operator sets which model a server or an agent runs.
- `GET /provision/models` answers `pickerEnabled` (`false` while off) and still lists every offered option, so a
  reader written before the switch keeps working. `pickerEnabled` is the stored switch, not whether it is
  enforced: it reads `false` for a server Raft has not synced yet even though, while enforcement is off, that
  server's picks are accepted. So Raft drives its picker UI from its own flag, not from this field.

### The tenant's spend

`GET /provision/usage?from=&to=&bucket=day|month` is what Raft's panel shows as "today $x of $5" and
a daily cost history: the token's tenant's estimated spend, its daily limit, and whether its next model
call would be refused. A production route, not part of the evaluation set. Read-only; any other method
is `404`. `cf/src/provision/usage.ts`; tests in `test/provision-usage.ts`.

- **Tenant.** As above: a tenant-scoped token is its tenant, a platform-scoped token the tenant
  `?raftServerId=` names (`422`, `param: "raftServerId"`, without it). Every read is scoped to that
  tenant in its own query. A missing, unknown or revoked token is the `401` every provider route gives.
- **Window.** `from`, `to` and `bucket` are read as `/admin/usage-costs` reads them (`parseCostsQuery`,
  `cf/src/admin-usage-costs.ts`): ISO 8601 dates or times with a zone, a bare date its 00:00 UTC;
  `bucket` `day` (default) or `month` (UTC); no `from` is 30 days before `to`, no `to` is now; at most
  400 days; widened to whole periods. Anything else is `400`, `code: "invalid"`, with the problem in
  `message`.
- **`today`** is always today (UTC), whatever the window. It is the daily limit's own reading and rule
  (`readDaySpend` and `standing` in `cf/src/spend-limit.ts`, the `judge` the queue consumer applies),
  read afresh for each answer (kept 15 s, below): `spentUsd` is the priced usage today of the tenant's own
  agents (every agent but its onboarding ones, [below](#which-budget-pays-budget)), `model.tokens.unaccepted` left out;
  `limitUsd` the admin's override if there is one, else the plan's default (`$3` free, `FREE_DAILY_LIMIT_USD`;
  `$10` pro, `PRO_DAILY_LIMIT_USD`; `$5`, `DAILY_LIMIT_USD`, while Raft has sent no plan), `null` when there is no
  per-tenant limit or the tenant is exempt (`exempt: true`, `DAILY_LIMIT_EXEMPT_TENANTS`);
  `plan` the plan Raft last sent (`null` when it never did); `onboardingUsd` the tenant's onboarding agents'
  spend today, which the platform pays and which is in neither `spentUsd` nor `limitUsd` (so today's period in
  `periods`, which counts every agent, can be larger than `spentUsd` by it); `onboardingLimitUsd` the tenant's share
  of the onboarding pool (`$1` unless an admin set another; `null` for none or an exempt tenant), and
  `onboardingRefusing` whether its onboarding agents' next call would be refused, by that share or by the pool as a
  whole being spent (the pool's own figures are not given);
  `platformLimitReached` whether the platform's limit is reached; `refusing` whether a model call would
  be refused now (platform first, then the tenant's limit; never for an exempt tenant). The consumer
  may act on a reading up to 30 s old (docs/metering.md, "How fresh the reading is"). The platform's own total and limit are not given: they are every tenant's
  spend summed.
- **`periods`** are the window's periods that have usage, oldest first, priced as everywhere else
  (docs/metering.md, "Prices"), `model.tokens.unaccepted` left out. `resources` gives each resource's
  cost; `unpriced` lists `resource key unit` for usage nothing prices, which counts nothing in a total
  (not the same as free). `totalUsd` at the top is the window's sum.
- **`agents`** is each agent's total over the window, highest first, named by `providerAgentId` as the
  provider's agent view names it (the ledger's agent id, which for a provisioned agent is that).
- **`agentDays`**, only with `?byAgent=1` (absent otherwise): each agent provisioned in the tenant
  (`provisioned_agents`, deleted ones included) that has usage in the window, ordered by `raftAgentId`, as
  `{ "raftAgentId": string, "budget": "onboarding" | null, "days": [{ "day": "YYYY-MM-DD", "usd": number }] }`.
  `budget` is the one it was created with ([below](#which-budget-pays-budget)); `days` are UTC days with
  usage, oldest first (a day with none is absent, not `0`), priced as `agents` is and with
  `model.tokens.unaccepted` left out, so an agent's `usd` add up to its `totalUsd` in `agents`. An agent
  Raft did not provision (the console's, the Agents API's) is in `agents` only. Read in the same query
  scoped to the tenant, the agents' rows too. `byAgent` is `1` or `0` (or absent); anything else, or
  `byAgent=1` with `bucket=month`, is `400`. Windows, limits and the 15 s cache are as without it (the
  cache keeps the two answers apart).
- **Tenant from the token only.** A tenant-scoped token sending `?raftServerId=` or `?tenantId=` still
  gets its own tenant; those parameters do not choose one.
- **Kept 15 s.** Each isolate keeps the whole answer for 15 s (`USAGE_CACHE_MS`), per tenant and
  window as widened (so no query and `?bucket=day` share one), never past the UTC day it was made in.
  Only a window of at most 62 days is kept (a longer one is read afresh every time), and at most 256
  answers per isolate, the oldest dropped first.
  So a figure can be 15 s old, and with the consumer's own 30 s reading `refusing` can differ from what
  the consumer does for under a minute.

```json
GET /provision/usage?from=2026-10-10&bucket=day
{
  "currency": "USD", "estimated": true, "tenantId": "raft_srv-1",
  "today": { "day": "2026-10-12", "spentUsd": 1.84, "limitUsd": 10, "plan": "pro", "onboardingUsd": 0.42,
             "onboardingLimitUsd": 1, "onboardingRefusing": false, "exempt": false,
             "platformLimitReached": false, "refusing": false, "resetsAt": "2026-10-13T00:00:00.000Z" },
  "from": "2026-10-10T00:00:00.000Z", "to": "2026-10-13T00:00:00.000Z", "bucket": "day",
  "totalUsd": 4.31,
  "periods": [
    { "start": "2026-10-10T00:00:00.000Z", "totalUsd": 2.47,
      "resources": [{ "resource": "model.tokens", "costUsd": 2.4 }, { "resource": "sandbox.container", "costUsd": 0.07 }],
      "unpriced": [] },
    { "start": "2026-10-12T00:00:00.000Z", "totalUsd": 1.84,
      "resources": [{ "resource": "model.tokens", "costUsd": 1.84 }, { "resource": "tool.call", "costUsd": 0 }],
      "unpriced": ["tool.call js.run calls"] }
  ],
  "agents": [{ "providerAgentId": "raft_01JAGENT", "totalUsd": 3.9 }, { "providerAgentId": "raft_01JOTHER", "totalUsd": 0.41 }]
}
```

With `&byAgent=1` the same answer also carries:

```json
  "agentDays": [
    { "raftAgentId": "01JAGENT", "budget": null,
      "days": [{ "day": "2026-10-10", "usd": 2.47 }, { "day": "2026-10-12", "usd": 1.43 }] },
    { "raftAgentId": "01JOTHER", "budget": "onboarding", "days": [{ "day": "2026-10-12", "usd": 0.41 }] }
  ]
```

#### The onboarding pool (`/provision/budgets/onboarding`)

`GET /provision/budgets/onboarding?date=YYYY-MM-DD` is the shared onboarding pool on one UTC day (`date`
defaults to today): every tenant's onboarding agents together. `onboardingPool` in
`cf/src/provision/usage.ts`; tests in `test/provision-usage.ts`.

```json
GET /provision/budgets/onboarding?date=2026-10-13
{ "date": "2026-10-13", "limitUsd": 30, "spentUsd": 12.84, "capped": false }
```

- **Platform tokens only.** It is a figure over every tenant, so a tenant-scoped token is `403`,
  `code: "platform_only"`, whatever it names. A platform token needs no `raftServerId` (one sent is
  ignored). No token, or an unknown or revoked one, is the usual `401`; any method but GET is `404`.
- **The enforcer's reading.** `spentUsd` is `readDaySpend`'s `onboardingUsd` (`cf/src/spend-limit.ts`):
  every agent created with `budget: "onboarding"`, in any tenant, `model.tokens.unaccepted` included,
  as the pool is judged. `limitUsd` is the pool's limit (an admin's override, else
  `ONBOARDING_DAILY_LIMIT_USD`, `$30`; `null` when there is none). `capped` is `judge`'s verdict:
  `true` exactly when an onboarding agent's next call is refused by the pool (`spentUsd >= limitUsd`). A
  tenant's own share of the pool is not judged here (a share of `$0` does not make `capped` true);
  `today.onboardingRefusing` in `/provision/usage` says it. `capped` describes the pool, not any one
  call: an exempt tenant (`DAILY_LIMIT_EXEMPT_TENANTS`, default `bench`) is admitted before anything is
  judged, so its onboarding agents still work while `capped` is `true`. Read afresh each time; the
  consumer may act on a reading up to 30 s old.
- **A past day** is read from the ledger, a day already folded into whole days included. Its `limitUsd`
  is the limit as it stands now: an admin's override is kept as its current value, not per day.
- **`date`** is exactly `YYYY-MM-DD`, a calendar day, today or earlier, or absent for today; anything else
  (an empty `date=` included), a later day, or any other parameter is `400`, `code: "invalid"`.

#### The server's plan (`plan`)

A Raft server is on a plan, which only Raft knows; its tenant's default daily limit follows it (`free`: $3, `pro`:
$10; a server Raft has sent no plan for keeps $5, the limit before plans; docs/metering.md, "Daily limits"). Raft
says it, and antiproton never asks:

```
PUT /provision/servers/{raftServerId}/plan
{ "plan": "pro" }
→ 200 { "raftServerId": "srv-1", "plan": "pro", "updatedAt": "2026-10-14T09:12:00.000Z" }
```

- **When.** On every change of the server's plan (upgrade, downgrade, a lapsed subscription), and once for each
  server that exists before this route does. The latest write wins; a repeat of the same plan changes nothing.
- **Tenant.** As every provider route: a platform-scoped token's tenant is the one `{raftServerId}` names. A
  tenant-scoped token names no server, so `{raftServerId}` must be one its tenant's agents were provisioned for
  (`raftServerId` on their create); any other, or any before the tenant has an agent, is `403`,
  `code: "server_mismatch"`, `param: "raftServerId"`, and nothing is written — never a plan written to the token's
  tenant under another server's id. `{raftServerId}` must match the Raft id pattern (`422`, `param: "raftServerId"`).
  The answer's `raftServerId` is therefore always the server whose plan was written.
- **Body.** Exactly `{ "plan": "free" | "pro" }`: a missing or other `plan` is `422` (`code` `missing` or `invalid`,
  `param: "plan"`); any other field is `422` naming it. Nothing is written when it is refused.
- **On a create too.** `POST /provision/agents` takes the same `plan` (optional; absent or `null` says nothing),
  validated the same way (`422`, `param: "plan"`, nothing made). A create that makes the agent writes it, before the
  agent's row. It is the server's, not the agent's, so it is **not** part of what a replay is compared with (a replay
  with another plan, or none, is still the same create), and **a replay never writes it**: a create retried late
  carries the plan of its first send and must not undo a `PUT` that landed since. So the PUT is the route that keeps
  the plan current; the create's field saves a call when a server's first agent is made.
- **Takes effect** within the consumer's reading (30 s at most, docs/metering.md, "How fresh the reading is"); the
  next `GET /provision/usage` shows it as `today.plan` and `today.limitUsd` (kept 15 s).
- **No plan said** keeps the $5 every tenant had before plans, until Raft sends one. An admin's per-tenant override
  beats any of the three.

### Workspace import

A Raft agent that moves from a local computer to hosting here keeps its identity (the same Raft agent)
and brings its workspace with it: Raft creates the agent (`POST /provision/agents`, with
`awaitImport: true`, [below](#waiting-for-the-import-awaitimport)), imports its files, then cuts over.
The same route gives a newly provisioned agent its first files (a playbook, a memory file). A
production route: served on every deployment, not behind `EVAL_SEED_ROUTES`. `cf/src/provision/handlers.ts`
(`workspaceImport`), `src/store/workspace-import.ts`; tests in `test/workspace-import.ts`.

```
POST /provision/agents/{agentId}/import
POST /provision/agents/by-raft-agent/{raftAgentId}/import?raftServerId=…
{ "migrationId": "mig_01JX…", "instructions": "…",
  "files": [{ "path": "notes/plan.md", "contentBase64": "cGxhbiAuLi4K", "sha256": "…" }],
  "totalBytes": 9 }
```

Authentication, tenant and which agents are as for the reads above: another tenant's agent, a deleted
agent and an unknown id are `404 not_found`.

- **`migrationId`** — required; the idempotency key, 1–128 of `A–Z a–z 0–9 . _ : -`.
- **`files`** — required, at most **2,000**. Each is exactly `{ path, contentBase64, sha256 }`; any other
  field (a utf-8 `content` included) is `400 unknown_field` naming it. `contentBase64` is the file's
  bytes in standard padded base64, at most **2 MiB** (2,097,152 bytes) decoded; `sha256` the hex SHA-256
  of those bytes, checked (`422 sha256_mismatch`, `param: "files[i].sha256"`).
- **`totalBytes`** — required: the sum of the files' decoded sizes, at most **10 MiB** (10,485,760 bytes).
  Over it is `413` before anything is decoded; a value that is not the sum is `422 total_mismatch`.
- **`instructions`** — optional; the agent's persona, under the same rule as `PATCH`'s (8000
  characters; [above](#the-raft-provider-binding)). Applied as a `PATCH` applies them, after the files land.
- The request as sent is at most 16 MiB (`413`, `param: "body"`).

`GET /provision/import-limits` answers `{ "maxTotalBytes": 10485760, "maxFiles": 2000, "maxFileBytes": 2097152 }`
(`IMPORT_LIMITS`), for Raft's exporter to refuse a workspace over them before sending it.

**Where the files go.** Each file is the agent's state key `path` — what its state tools `get` and `put`,
and `state/{path}` in the workspace reads above — so it reads back through
`GET …/workspace-files/read?path=state/{path}` with the same bytes and `sha256` as imported (a value over
32 KiB as JSON is kept in object storage, as the state plugin keeps one, and reads back the same). An
imported file is the agent's own: it may change or remove it.

**What the agent is shown.** From its first turn the agent's system prompt carries a block headed "Files
that were in your workspace when you were created": `MEMORY.md`'s current text (what its `get` answers now, not the copy
imported) fenced, up to 4,000 characters with a line saying where the rest is, or a note that it is kept in
object storage or was removed; then up to 40 of the other imported paths by name, with the count of the rest;
and the state mount's `get` to open them (`importedFilesParts`, `src/plugins/state.ts`).

**What a file may be.** UTF-8 text with no NUL byte: a state value is text, and a file that is not could not
read back as the bytes it was (`422 not_text`). Nothing shaped like a credential (`422 credential_in_text`,
the kind named and none of the text). Paths are normalised, then checked: empty and `.` segments drop out
(`./notes//a.md` is `notes/a.md`); refused with `422`, `param: "files[i].path"`: a leading `/`, a `..`
segment, a trailing `/`, a backslash, a control character, anything the state key rule
(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`) refuses once normalised, and a path two files share
(`duplicate_path`). Names the runtime owns are `422 reserved`: `kept:…` (the agent's sealed secrets) and the
working-set documents `memory`, `todo` and `journal`, which the runtime puts in the system prompt as the
agent's own running notes; and, on a deployment serving the evaluation routes, a path already seeded.
Over a bound is `413` (`too_many_files` with `param: "files"`, `file_too_large` with
`param: "files[i].contentBase64"`, `too_large` with `param: "files"` or `"totalBytes"`).

**Once per agent.** The first import that lands is the agent's import for good. The same `migrationId`
with the same `instructions` and the same files (by path and `sha256`, in any order) answers what the
first answered, `200` instead of `201`, and writes nothing. Anything else afterwards — another
`migrationId`, or the same one with any difference — is `409 already_imported`.

**Only before the agent runs.** An agent that has taken a turn (a message in its main conversation, a
fresh context, or a turn started by any route) is `409 agent_active`, and nothing is written: an import
never overwrites a live agent's workspace. A push accepted and still queued is not a turn.

**All or nothing.** Every rule above is checked for the whole request before anything is written. Then,
in the agent's own object: a file too large for its row is put in object storage under a name of this
attempt alone (`t/{tenant}/{agent}/import/{attempt}/{sha256}.json`), which nothing names yet; then every
file's row and the import's own record are written in **one SQLite transaction**, which also decides
whether this is a retry, a second import or an agent that has started. A failure before or inside it
writes no row (the transaction rolls back), and the attempt's objects are deleted; the retry is a first
import. A file is its row, so no imported path is readable unless all of them are. (Between upload and
commit the attempt's objects are listed under `artifacts/import/` like any spilled value, and if their
deletion itself fails they stay there, logged as `provision.import.orphans`; no row ever names them.)
`instructions` are the one part outside that transaction, since they live in the registry too: they are
applied after the files land, and the import records whether they were, so an identical retry of an
import whose instructions did not apply applies them, and one after they did never applies them over a
later `PATCH`.

```json
201
{ "migrationId": "mig_01JX…", "providerAgentId": "raft_01JAGENT", "raftAgentId": "01JAGENT",
  "importedAt": "2026-10-13T09:00:00.000Z", "fileCount": 1, "totalBytes": 9, "instructions": true,
  "files": [{ "path": "notes/plan.md", "bytes": 9, "sha256": "…" }] }
```

`files` is sorted by path. Errors use the provider envelope, `param` naming the field: `400`
(`invalid_json`, `unknown_field`), `401`, `404 not_found`, `409` (`already_imported`, `agent_active`),
`413`, `422` (`invalid`, `reserved`, `duplicate_path`, `sha256_mismatch`, `total_mismatch`, `not_text`,
`credential_in_text`); a failure underneath is `500`, after which the same request is safe to retry.

**Audit.** One `provision.import` log line per request that names a live agent: the token's hash
(`credentialId`), the tenant and agent, the outcome (`imported`, `replayed`, `refused` with its `code`,
`failed`), the file count and bytes, and the `migrationId`. Never a path's content or the token.

#### Waiting for the import (`awaitImport`)

`POST /provision/agents` takes `awaitImport: true` (optional; `false` or absent is today's create) for an
agent that must not run before its import:

- **Held.** From the create on, pushes to the agent are accepted (`202`) and queued as usual, but no turn
  starts and no model call is made. A queued push is not given up for its age while held, and gets its
  full 30 minutes from the hold's end. The queue's own bound still applies: past 30 pushes waiting, a
  push is `429`, as when posting is failing. A message by any other route (the console) has no queue to
  wait in and is refused while held, with the time the hold ends (the console's message route: `409`).
- **Lifted by the import.** The import that lands lifts the hold — in its own transaction, or, when it
  carries `instructions`, once they are applied, so the first turn runs on the imported persona — and
  wakes the agent: the queued pushes are posted and the first turn starts. A trace row `import.hold`,
  `status: "import"`, records it.
- **Ready.** A provisioned agent tells Raft it is `online` once it is ready and before any turn: when
  `enable_push` succeeds, or, for an agent made with `awaitImport`, when the import lifts the hold. One
  trace row `agent.ready`, once per agent, sent as a status-only activity event while push is on
  (`src/runtime/ready.ts`). The provider's own `enable_push`/`disable_push` calls are not the agent's
  activity and are not reported as it working.
- **The valve.** With no import within **24 hours** of the create (`IMPORT_HOLD_MAX_MS`), the hold lifts
  on its own the next time input is to be delivered (the alarm comes back at that time while pushes are
  waiting), with a trace row `import.hold`, `status: "valve"`, `verdict: "failed"`, saying why. The agent
  then runs without an import, and a later import is `409 agent_active`.
- **Replay.** `awaitImport` is part of the request a replay is compared with (`false` and absent being one
  value): the same answers the same, another is `409 idempotency_conflict` naming `awaitImport`. A hold is
  placed once per agent: a replay after the import (or the valve) never holds it again.

#### The prompt-cache prewarm

Once an import is whole (in its own transaction, or once its `instructions` are applied), the agent makes one
cheap model call that carries exactly the system prompt and tools its first turn will send, so the provider has
that prefix cached when the first message comes (`src/runtime/prewarm.ts`). Nothing for Raft to send or do:

- **Not a turn.** No transcript entry, message or model job is written; the agent and its owner see nothing.
- **Metered** like any model call (usage, `model.tokens`), with a trace row `model.prewarm`: `status` `warmed`,
  `skipped` or `failed`, `attrs` the outcome, the model and its tokens (`inputTokens`, `cacheReadTokens`,
  `outputTokens`).
- **At most once per agent** (an agent is imported once), sent through the model queue, never retried, and never a
  reason for the import to fail. Admitted against the daily spend limits like any call.
- **Skipped** when the agent has already started a turn (a push held for the import runs as the import lands),
  runs on its own model credential or the `pd` engine, or its model is neither DeepSeek's nor OpenAI's GPT-5.6 or
  later (the models that take `prompt_cache_options.prewarm`).
- **Same reasoning as the first turn**: both providers key their cache on it (a prewarm with thinking off did not
  warm a turn with thinking on, measured 2026-10-14), so an agent made with `firstTurn` (below) is warmed with
  reasoning off. Through the Responses API (GPT-5.6 Luna) it is a `prompt_cache_options.prewarm` request, which
  generates nothing (capped at `max_output_tokens: 16`, the least the API takes); through chat/completions a
  one-token call. OpenAI keeps that cache 30 minutes, DeepSeek hours.

#### The first turn without reasoning (`firstTurn`)

`POST /provision/agents` takes `firstTurn: { "reasoning": "off" }` (optional; absent or `null` is today's
create) for an agent whose first reply someone is waiting on, such as an onboarding agent the owner talks to
right after signing up:

- **What it does.** Every model call of the agent's first turn — from its first input until a reply that ends
  without a tool call — runs with reasoning off (DeepSeek `thinking: { type: "disabled" }`, OpenAI effort
  `none`). Every later turn runs as any agent's does.
- **Once per agent.** The first turn ends for good at the first of: an answer that ends a turn (a reply, a failure,
  a cut-off), a cancel (recorded in the agent's object, so a first turn cancelled mid tool loop does not carry into
  the next), or the end of the agent's first main conversation (a fresh context, or a rebuild, before or after
  it). A new conversation after any of these runs with reasoning on.
- **Models.** Applied only where the model has a known off field: DeepSeek's models, and OpenAI's (their catalog's
  off level; one without reasoning is unchanged). Any other model's first turn runs with its default, and is sent
  no field it might refuse. Not refused at the create, since the model can change after it (`PUT …/model`, an
  admin's choice).
- **The cost.** The cache is keyed on the reasoning setting, so the second turn reads nothing of the first's
  prefix from cache and writes it anew; from the third turn on the cache is shared as usual.
- **Values.** Exactly `{ "reasoning": "off" }`; anything else is `422`, `code: "invalid"`, `param: "firstTurn"`.
- **Fixed at creation.** Recorded on the agent's record; a replay must repeat it (absent and `null` being one
  value), another is `409 idempotency_conflict`. A `PATCH` and an import never change it.
- **Nothing else changes**: the import contract is as it was, and an agent made without the field runs every
  turn with the provider's default reasoning.

#### Which budget pays (`budget`)

`POST /provision/agents` takes `budget: "onboarding"` (optional; absent or `null` is the tenant's own budget, today's
create) for a hosted onboarding agent, whose spend the platform pays:

- **What it does.** The agent's priced usage goes to the onboarding pool (docs/metering.md, "Daily limits"): in
  neither its tenant's daily figure (`today.spentUsd`) nor the platform total, so it never uses up the server's
  daily limit. Its model calls are refused only when every onboarding agent's spend today, in any tenant, reaches the
  onboarding limit ($30 a day unless an admin sets another), or its own tenant's onboarding agents' spend reaches the
  tenant's share of it ($1 a day unless an admin sets another for that tenant), so one server's users cannot spend
  the pool for every other server. The refusal is any limit's (a failed turn, `usage limit reached (out of budget)`,
  `BridgeFatal` `usage_limit_reached` with the sentence, `Onboarding daily usage limit reached; resets at 00:00 UTC.`
  for the pool and `This server's onboarding daily usage limit reached ($X of $Y); resets at 00:00 UTC.` for the
  share). Its tenant being over its own limit, or the platform over its, does not refuse it.
- **An identity, not a behaviour.** It says who pays and nothing else: the model (`model`) and the first turn
  (`firstTurn`) are their own fields, and an onboarding agent without either runs as any agent does.
- **Values.** Exactly `"onboarding"`; anything else (another string, a different case, a non-string) is `422`,
  `code: "invalid"`, `param: "budget"`, and nothing is made.
- **Fixed at creation.** Stored on the agent's row (`provisioned_agents.budget`) and given back as `budget` in the
  agent's view (absent for an agent on its tenant's budget). A replay must repeat it (absent and `null` being one
  value): another, or none where the create had it, is `409 idempotency_conflict` naming `budget`. No route changes it
  later; an agent that should stop being platform-paid is a new agent.
- **Seen by the operator** as its own line: `onboarding` in `/admin/usage-costs` and on the admin host's usage-costs
  and spend-limits pages. The tenant's own history (`GET /provision/usage` `periods`, `agents`) still lists the
  agent's spend, and `today.onboardingUsd` says how much of today's is the platform's.

**What Raft sends for a hosted onboarding agent:**

```json
POST /provision/agents
{ "raftAgentId": "…", "raftServerId": "…", "raftOrigin": "…", "name": "Cindy", "instructions": "…", "credential": "sk_agent_…",
  "model": "deepseek-flash", "firstTurn": { "reasoning": "off" }, "budget": "onboarding", "plan": "free" }
```

— `budget` on the onboarding agent only (every other agent leaves it out), and `plan` whenever Raft knows the
server's plan ([above](#the-servers-plan-plan)); a retry repeats the same body, as for every field.

### Stopping a turn (`stop`)

```
POST /provision/agents/{agentId}/stop
POST /provision/agents/by-raft-agent/{raftAgentId}/stop?raftServerId=…
```

Ends the agent's running turn the way the Agents API's cancel does: the turn is aborted, a model call it had out is
dropped (its answer, if one still comes, starts nothing), and the background work it started is stopped. The agent is
not deleted; its next message starts a new turn. No body. Same token, tenant and `raftServerId` rules as every route
above, with one difference: **a deleted agent can still be stopped**, since a turn that outlived its delete is the one
that most needs it.

| Answer | When |
|---|---|
| `200 {"result":"interrupted","cancelledTurn":"<turn id>"}` | a turn was running and is now ended |
| `200 {"result":"not_running"}` | nothing was running — including a repeat of a stop that already ended it |
| `503 {"error":{"code":"stop_failed","message":…}}` | the turn could not be ended; retry |
| `404 {"error":{"code":"not_found",…}}` | no agent by that id in the tenant |

The ended turn reports itself to Raft: a "Bridge fatal" activity event with `errorClass` `stopped: by owner`, and
status `error` with that detail. Every attempt is a `turn.stop` line in the Workers logs, whatever came of it, written
by the Worker that answered it (`side` = `worker`; [`runbook.md`](runbook.md#logs-and-what-an-object-did)).

**A delete ends the turn too.** `DELETE /provision/agents/{agentId}` first stops the running turn (`errorClass`
`stopped: agent deleted`), and from then on the agent's object takes no step for it, whatever arrives; a repeated
delete stops again. A stop that fails does not fail the delete: it is logged as a `turn.stop` line with `result`
`failed` ([`runbook.md`](runbook.md)).

### Tool calls in Raft's activity log

While push is on, each tool call the agent makes is reported to Raft (`raft-agent-activity-ingest.v1`) as two
events, built from the call's `tool.call` trace row when it ends (`src/runtime/activity.ts`): `PreToolUse`, dated
when the call was asked for, and `PostToolUse` (it succeeded) or `PostToolUseFailure` (anything else, with the
operation's status as `errorClass`), dated when it ended. Calls the provider makes on the agent's behalf are not
reported.

| Field | On | Value |
|---|---|---|
| `toolName` | both | the tool as the model names it, `<mount>__<tool>` |
| `toolUseId` | both | the call's operation id: the same on the two events of a call, different for every call (two calls to one tool, the host calls of one `run_js` program, the step that continues a tool's question, a call run after approval) |
| `ok` | the end | `true` succeeded (including a command that exited non-zero), `false` failed or refused (by the mount's policy, or by a person denying the approval), `null` the outcome is not known (lost, or cancelled) |
| `durationMs` | the end | how long the tool ran; a call held for approval counts from when it began after the approval, not from the request |
| `exitCode` | the end | only for a command (sandbox `shell` / `run`, backgrounded or not): its exit status |

An operation has exactly one `tool.call` row, at its first end; completing it again (an approved call, a result
too large to inline) updates the record and writes no second row, so a call is never reported twice.

## Evaluation setup (preview only)

Routes for an evaluator to give an agent its workspace before the agent first runs, start it on a
fresh conversation, read back what its model was sent, read the tools its next turn is offered, and export
its conversation and its trace afterwards. They are served only where the deployment
sets `EVAL_SEED_ROUTES` to `"1"` — `cf/wrangler.preview.jsonc`, never `cf/wrangler.jsonc`
(`test/eval-seed.ts` fails if production sets it). Anywhere else every one of them is `404`, as an
unknown route is. Authentication, tenant and which agents are as for the reads above: the provider
token, `?raftServerId=` for a platform token, `{agentId}` or `by-raft-agent/{raftAgentId}`, and `404`
for an agent that is not a live provisioned agent of the tenant.

| Method | Path | Does |
|---|---|---|
| `PUT` | `/provision/agents/{agentId}/seed?path=&mode=` | seed one file; the body is the file |
| `POST` | `/provision/agents/{agentId}/seed/seal` | close the window now |
| `GET` | `/provision/agents/{agentId}/seed/manifest` | what is seeded, and whether it is sealed |
| `POST` | `/provision/agents/{agentId}/fresh-context` | start a new main conversation |
| `POST` | `/provision/agents/{agentId}/restart` | restart the agent, keeping its conversation |
| `GET` | `/provision/agents/{agentId}/model-input?session=&call=` | what one model call was sent |
| `GET` | `/provision/agents/{agentId}/tools` | the tools the next turn offers the model |
| `GET` | `/provision/agents/{agentId}/transcript?session=&limit=&cursor=` | a main conversation, every event of it; `limit` 1–2000, default 500; a page also stops before 4 MiB ([below](#transcript)) |
| `GET` | `/provision/agents/{agentId}/trace?from=&to=&limit=&cursor=` | the agent's trace rows in a window of at most 24 hours; `limit` 1–1000, default 200 ([below](#trace)) |

The same flag lets `POST /provision/agents` choose the agent's tools ([below](#choosing-the-agents-tools)),
and gives `instructions` a larger bound ([below](#instructions)).

### Instructions

Where `EVAL_SEED_ROUTES` is `"1"`, an agent's `instructions` on `POST /provision/agents` and
`PATCH /provision/agents/{agentId}` are at most 65,536 bytes of UTF-8 (`EVAL_INSTRUCTIONS_MAX_UTF8`,
`cf/src/provision/handlers.ts`) instead of 8000 characters, so a persona in CJK or emoji meets the
same bound as one in ASCII. One byte over is `422`, `code: "invalid"`, `param: "instructions"`,
message `instructions is at most 65536 UTF-8 bytes; this one is <n>`, and nothing is made or
changed: never cut, since an evaluation of an agent given part of its instructions measures the
wrong agent. Nothing after the check bounds them: the registry row, the agent's record and the
system prompt carry the value as sent (`test/eval-seed-object.ts` sends a 35 KB CJK-and-emoji
persona, then PATCHes one of exactly 65,536 bytes, and finds each one's bytes in the model request). The prompt drops surrounding whitespace, as it
does for every persona (`personaSection`, `src/runtime/pi-prompt.ts`). A `PATCH` reaches the next
turn, as on every deployment ([above](#the-raft-provider-binding)).

### Choosing the agent's tools

`POST /provision/agents` takes two optional fields, served only where `EVAL_SEED_ROUTES` is `"1"`. On
any other deployment either field is refused with `400`, `code: "eval_only"`, `param` naming it, and
nothing is made: an evaluation that asked for a minimal agent is never given the default one in
silence. Sending neither is today's agent exactly — every default mount, reconciled as the catalogue
grows, and run_js, resume and jobs (`test/eval-seed-object.ts` checks such an agent's export against
a real turn's request, and measured its request identical to the base commit's, 2026-10-09).

- **`mounts: string[]`** — the default mounts to give the agent, named by the alias the catalogue
  gives them for an agent Raft hosts (`tools`, `artifacts`, `web`, `search`, `gh`, `sandbox`,
  `state`; `AgentRuntime.DEFAULT_MOUNTS`, `cf/src/runtime.ts`). `raft` is always added and must not
  be named. The agent gets exactly those plus `raft`, and is marked as having chosen its mounts
  (`chosen`, `src/store/seed-record.ts`), so no catalogue reconcile — at a turn's start, a console
  open or a later provision — ever adds one. `[]` is `raft` alone. An unknown name, a name given
  twice, `raft`, a non-string entry or a non-array is `400` naming the entry; so is a mount whose
  plugin cannot run on this deployment (asked of the agent's object before anything is written).
- **`harness: "minimal"`** — the harness offers none of its own tools: no `run_js`, no `resume`, no
  `jobs`. The one accepted value; anything else is `400`. It holds on every turn — a prompt, a steer,
  a pushed event — under both engines, and in `GET …/tools`, which is built by the same step. The
  system prompt's run_js paragraph goes with the tool. Without `mounts`, the agent keeps the default
  mounts (still reconciled) and only the harness's tools go.

**Questions under `minimal`.** A tool that asks the model a question before acting needs `resume` to
be answered. With none offered, the harness's existing no-resume path applies: the question is
dropped, nothing is done, and the model is shown the question with a note to call the tool again if
it still applies (`toolQuestion`, `src/runtime/pi-tools.ts`). `raft`'s only question is a held send or
task write when newer messages arrived, or, on a mount with conversation cards on, when the context has
not seen the conversation's card; the model's own call records what the question showed as seen before
asking, so calling again goes ahead (`heldCall`, `src/plugins/raft.ts`; `test/raft-plugin.ts`, "the
same send again … goes through"). Any other mount whose plugin asks questions is refused under
`minimal` with `400`, rather than given that changed flow; a default mount that comes to ask questions
later is not added to a `minimal` agent by the catalogue reconcile either (recorded as `refused`, with
the reason). No default mount asks questions today.

**Recorded, and fixed.** The choice is kept on the agent's record as `toolConfig: { mounts, harness }`
(`mounts` `null` when not sent, otherwise sorted, since the list is a set and its order means nothing;
`harness` `"default"` when not sent; no `toolConfig` at all when neither was). A later `POST` for the same agent must ask for the same tools (in any order): one asking for others —
including one sending neither field, for an agent made with them, or either field for an agent made
without — is `409`, `code: "tool_config_conflict"`, and changes nothing. A `PATCH` says nothing about
tools and keeps them. A different set of tools needs a new agent. `GET …/tools` answers the record's
`toolConfig` beside the list, and the seed manifest carries it ([the seal](#seeded-files)).

### Seeded files

A seeded file has two copies, written together in one transaction: a **snapshot** nothing the agent
can call reads or changes, and a **working copy**, the agent's ordinary state key `path` (its
`get` reads it; `state/{path}` in the workspace reads above). `mode` is `writable` (default) or
`readonly`. The state plugin refuses every tool of its own that writes a key — `put`, `remember`,
`forget` — on a `readonly` path, with a reason naming the path; a `writable` one is an ordinary key
the agent may change or remove. Its `get` and `list` mark a seeded path with `seed: "writable"` or
`seed: "readonly"`, and its first mount puts a "Workspace files provided at setup" paragraph in the
system prompt ahead of the working set: `MEMORY.md`'s working copy (its first 4,000 characters, in a
code fence longer than any run of backticks in it), then every other seeded path, printed exactly as
stored, with its working copy's size now in UTF-8 bytes (an unedited copy reads its manifest `bytes`;
one kept in object storage is given its size at setup, said to be that) and its mode. A seeded path
that is also a working-set document (`memory`, `todo`, `journal`) is left out of the working set. With
nothing seeded the paragraph is absent and the prompt is as it was. On the pi085 engine the paragraph
is the one taken when the conversation began (a fresh context takes it again); a working copy changed
since is given to the model in a harness notice at the head of its next message, not by re-rendering
the system prompt (`src/runtime/prompt-context.ts`). Rules for `PUT …/seed`:

- `path` follows the state plugin's key rule (`^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`), with no empty,
  `.` or `..` segment and never under `kept:`; else `422`, `param: "path"`. The working set's own
  keys (`memory`, `todo`, `journal`), which the agent is shown as written by itself, are refused with
  `400`, `code: "reserved"`.
- The body is the file as sent, not JSON: UTF-8 text with no NUL byte (`422` otherwise), at most
  262,144 bytes (`413`), and nothing shaped like a credential (`422`, `code: "credential_in_text"`, the
  kind named and none of the text). All of an agent's files together are at most 2,097,152 bytes
  (`413`). A file larger than 32 KiB as a state value is kept in object storage, both copies, as the
  state plugin keeps a large value; it reads back the same.
- The answer is `{ path, mode, bytes, sha256, changed }`: `bytes` the body's length and `sha256` the
  hex SHA-256 of the body, both as sent. The same bytes and mode again change nothing (`200`,
  `changed: false`); different bytes or mode before the seal replace both copies.
- `409`, `code: "sealed"`, once the window is closed.

**The seal.** The window closes at the first of: `POST …/seed/seal`; the agent's first accepted
inbound push (in the same step that queues it, before its turn starts); the agent's first turn by any
other route. A write that arrives after that is refused, even while the turn is still queued or
running. An agent that already ran before seals existed (a message in its main conversation, a fresh
context, or an accepted push) is sealed by the first write that finds it, as `prior-activity`, and
that write is refused. `POST …/seed/seal` is idempotent and answers the seal it finds:

```json
{ "manifest": [{ "path": "MEMORY.md", "mode": "writable", "bytes": 120, "sha256": "…" }],
  "toolConfig": { "mounts": ["state"], "harness": "minimal" },
  "manifestSha256": "…", "sealedAt": "2026-10-09T09:00:00.000Z", "how": "explicit" }
```

`manifest` is sorted by `path`. `toolConfig` is the agent's [tool choice](#choosing-the-agents-tools),
`null` for an agent made without one; once sealed it is the seal's own copy, the one its hash was computed
over, whatever later happens to the agent's record. `manifestSha256` is the SHA-256 of canonical JSON (keys sorted,
no spaces: `src/core/canon-json.ts`), so it is the same however it was read: of `manifest` alone when
`toolConfig` is `null` — every hash recorded before `toolConfig` existed — and of
`{ "manifest": …, "toolConfig": … }` otherwise, so the hash also pins which tools the agent was given. `how` is `explicit`,
`first-inbound`, `first-turn` or `prior-activity`. `GET …/seed/manifest` answers the same body plus `sealed: true`, or,
before the seal, `sealed: false` with the files as they stand and `sealedAt` and `how` null.

### Fresh context

`POST …/fresh-context` answers `{ oldSessionId, newSessionId }`. The agent's main conversation — the
one inbound pushes and the console post to — starts empty: the next model call is sent none of the
old conversation's messages and no summary of them. The old transcript is kept, readable under
`oldSessionId`. The agent's state, its working copies and its seeded files are not touched. The first
main conversation's id is `main`; each fresh one is `main.<n>`. Refused with `409`, `code: "busy"`,
while anything is in flight (a run, a queued input, an unanswered model call, background work, a push
queued or being delivered, a function call waiting for the Agents API caller), and for an agent on the
`pd` engine. The `409`'s message says which.

### Restart

`POST …/restart` answers `{ sessionId, restartedAt }`. It is the ordinary restart, **not** a fresh
context: the agent's object drops everything it holds in memory — the harness built for each
conversation, cached tool lists, programs held for `resume` — as an eviction would, and the next turn
rebuilds from storage on the **same** main conversation (`sessionId`), so its model is sent the whole
earlier conversation again. Refused with `409`, `code: "busy"`, on the same conditions as a fresh
context.

### Model input

`GET …/model-input?session={id}&call={n}` (`call` from 1, default 1) answers what call `n` of that
conversation was sent, recorded when the call was handed to the model queue. Hashes, ids and roles
only, never text:

```json
{ "sessionId": "main.1", "call": 1, "jobId": "mj_…", "at": 1791536400000,
  "systemPromptSha256": "…",
  "messages": [{ "role": "user", "sha256": "…", "length": 42, "sourceSessionId": "main.1", "messageId": "…" }],
  "summaryBlock": false, "workingSetKeys": ["memory"], "seedPathsInSystemPrompt": ["MEMORY.md"] }
```

Each message's `sha256` is of its canonical JSON as sent; `sourceSessionId` and `messageId` name the
main conversation whose transcript holds exactly that message, current or ended, and are `null` for
one no transcript holds. `summaryBlock` says whether a compaction or branch summary is in the input.
`workingSetKeys` are the working-set documents (`todo`, `memory`, `journal`) the system prompt carries;
`seedPathsInSystemPrompt` are the seeded paths it lists as seeded files (a heading or list line of the "Workspace files
provided at setup" block; a mere mention does not count). Without `session`, the answer lists the main
conversations: `{ current, sessions: [{ sessionId, generation, current, startedAt, endedAt, calls }] }`.
Only calls of the `pi085` engine are recorded; `404` when there is no such record.

A call's answer also carries `images`: what the queue consumer did with the image references of its
conversation, one record per queue delivery attempt, first first. A retry adds a record and never changes
an earlier one. Hashes and sizes only, never bytes, a URL or a storage key:

```json
"images": [{ "modelCallId": "mj_…", "sessionId": "main.1", "call": 3, "attempt": 1,
  "policy": "image-window/v1", "budget": { "maxImages": 8, "maxBytes": 12582912, "step": 4 },
  "windowStart": 0, "model": "deepseek-flash", "vision": true, "preparedAt": "2026-10-12T09:00:00.000Z",
  "items": [{ "index": 0, "sha256": "…", "declaredBytes": 3172, "readBytes": 3172, "result": "included_in_request" }],
  "provider": { "outcome": "http", "status": 200, "at": "2026-10-12T09:00:04.210Z" } }]
```

`modelCallId` is the call's `jobId`; `attempt` counts from 1 in the order the agent's object first heard of
each attempt. `budget` is the image window the consumer applied (`MODEL_IMAGES_MAX`, `MODEL_IMAGES_MAX_BYTES`,
and the step its start moves by) and `windowStart` the index of the first image it sent; for a model that
cannot see images (`vision: false`) it is the number of references, since none is sent. `preparedAt` is when
the provider request was built, before it was sent: it says the request was prepared, not that the provider
received it.

`items` has one entry per image reference in the conversation, oldest first, `index` its place among them.
`declaredBytes` is the size the reference declares (`null` when it declares none) and `readBytes` the size of
the bytes read (`null` when none were). `result` is one of:

- `included_in_request`: the bytes are in the request;
- `omitted`, sent as a line naming it and never read, with `reason` `over_budget` (the newer images already
  fill the budget), `before_window` (it would fit, but the window's start, which moves a step at a time, is
  past it) or `non_vision_model`;
- `load_failed`, sent as a line saying it could not be loaded, with `reason` `missing` (nothing is stored
  under its hash), `read_error` (the read failed, or the bytes no longer hash to the reference) or
  `size_mismatch` (the bytes are not the size the reference declares; they are refused even when the hash
  matches).

At most 200 items are kept, the newest; `truncated`, present only then, counts the older ones dropped.

`provider` is written once the provider call has ended: `{ "outcome": "http", "status", "at" }` for an
answer (a success, a refusal, or a 5xx or 429 its retries did not get past), `{ "outcome": "timeout", "at" }`
when the call's deadline passed, `{ "outcome": "transport_error", "errorClass", "at" }` otherwise
(`errorClass` the JavaScript error's class, e.g. `TypeError` for a failed connection). An attempt that never
ended, such as one whose invocation was stopped mid-call, has no `provider` key at all.

The consumer runs in its own invocation, so it writes each attempt back to the agent's object, addressed by
the queue message as its take of the job is (`cf/src/image-evidence.ts`): once when the request is built,
beside the provider call, and once when the call has ended, waited on for at most 2 s. A write that fails
or is slow is logged (`model_job.image_evidence_failed`) and the call goes on, so `images` can be missing an
attempt, or an attempt's `provider`; it is empty for a call whose conversation held no image reference.

### Tools

`GET …/tools` answers the tools the agent's next turn offers its model, in the order its model request
lists them, read without changing anything: no snapshot is re-taken, no turn starts, nothing is sealed
and no row is written. It is built by the step that builds a turn's harness (`#turnTools` and
`harnessTools`, `cf/src/runtime.ts` and `src/runtime/pi-tools.ts`), so it is that list rather than a
second derivation of it; `test/eval-seed-object.ts` compares it with what a real turn's model request
carries.

```json
{ "agentId": "raft_…", "asOf": "2026-10-09T09:00:00.000Z", "engine": "pi085", "retakePending": false,
  "toolConfig": null,
  "tools": [{ "name": "raft__inbox_list", "description": "…", "parameters": { "type": "object" },
              "source": "mount", "alias": "raft", "plugin": "raft", "tool": "inbox_list",
              "sideEffects": "read", "idempotency": "native", "replay": "never" }],
  "mounts": [{ "alias": "raft", "plugin": "raft", "toolVersion": "1.0.0", "offered": true,
               "tools": ["raft__inbox_list"], "withheld": [],
               "snapshot": { "takenAt": "…", "hash": "…", "basis": "raft-tools:…", "tools": ["inbox_list"],
                             "skipped": [{ "name": "messages_read", "reason": "…" }] },
               "basis": "raft-tools:…", "retake": null, "snapshotError": null }] }
```

Each tool's `name`, `description` and `parameters` are exactly what the model is sent: the name as
offered (`<alias>__<tool>`, as the harness names it, `offeredToolName`), the description with
whatever the harness appends. `source` is `mount` for a mount's tool, `harness` for the harness's own
(`run_js`, `resume`, `jobs`) and `caller` for an Agents API caller's function; a mount's tool also
carries `alias`, `plugin`, `tool` (its name in the plugin), `sideEffects`, `idempotency`, `replay`
(whether the harness may run it again after an interruption: `safe` or `never`), and `modelOnly`,
`reads` and `exclusive` where they are set.

`mounts` lists every mount the agent has, offered or not: `offered: false` with `notOffered`
(`switched_off`, or `plugin_unavailable`) for one whose tools the model is not offered; `withheld`,
the tools this deployment withholds; `snapshot`, the tool list the mount was last listed with (`null`
for a plugin that does not list its tools, or a mount never listed), with what its plugin left out and
why in `skipped`; `basis`, the plugin's current basis. A turn's start re-takes a snapshot whose basis
is not its plugin's: until then `retake` is `due` and `retakePending` is true, and the next turn may
offer a different list if the re-take finds different tools. `backed_off` is a re-take that failed
recently and is not asked again yet (`snapshotError` says why); the list above is then the one
offered. A mount's config and credential are never included.

### Transcript

`GET …/transcript` answers one conversation of the agent as the operator's `/admin/transcript` reads it:
the same reader (`readTranscript`, `cf/src/transcript-read.ts`), the same events in the same shapes, and
the same approvals — every user or pushed message, each model reply with its reasoning and its tool calls
and their arguments, each tool result with its status and its whole body, and runs that failed. It is
read from the agent's storage with SELECTs only: nothing is written, no table is made, no turn starts and
nothing is sealed (`test/eval-seed-object.ts` compares every table and row before and after, and the
answer with `/admin/transcript`'s for the same agent).

- `session` — the conversation: `main` for the agent's first main conversation, `main.<n>` for the n-th
  [fresh one](#fresh-context), current or ended (an ended one is read from where the fresh context kept
  it). Without it, the current main conversation. Only main conversations: anything else, a task id
  of the agent included, is `422` (`param: "session"`) before the agent is asked; `main.<n>` the agent
  never had is `404`.
- `limit` — events per page, 1 to 2000, default 500. `cursor` — where the page starts, from the
  previous page's `nextCursor` (`0` or absent for the first). Events are in sequence order and a
  conversation only grows at its end, so the pages of a finished conversation are the whole of it.
- A page also stops early, with a `nextCursor`, before its events and `byOp` would pass 4 MiB
  serialized after [redaction](#redaction); it always holds at least one event while any are left, so
  one event larger than that is a page of its own. The reader has no range of its own, so each page
  reads the whole conversation from storage; only the page's events are masked and walked.

```json
{ "agentId": "raft_…", "sessionId": "main.1", "current": true, "total": 4, "shown": 4,
  "cursor": "0", "nextCursor": null,
  "events": [{ "sequence": 1, "kind": "message", "payload": { "text": "…", "at": 1791536400000 }, "createdAt": 1791536400000 },
             { "sequence": 2, "kind": "model.response", "payload": { "text": "…", "toolCalls": [{ "id": "…", "name": "p__noop", "arguments": {} }], "finishReason": "toolUse", "at": 0 }, "createdAt": 0 },
             { "sequence": 3, "kind": "tool.result", "payload": { "tool": "p__noop", "callId": "…", "isError": false, "status": "succeeded", "result": {}, "at": 0 }, "createdAt": 0 }],
  "byOp": {}, "redactions": 0 }
```

### Trace

`GET …/trace` answers the agent's trace rows — the spans of its work, one row each when it ended
(`model.call`, `tool.call`, `approval.wait`, `container.lease`, `inbound`, `mount.seeded`,
`rebuild.decision`, `rebuild.outcome`, `rebuild.behaviour`, `turn.timing`, `import.hold`, `model.prewarm`, `agent.ready`,
`mount.settings` (an operator's in-place change of a mount's settings, [docs/plugins.md](plugins.md)), and the rows a plugin writes of its own, `raft.held`, `raft.held_answer` and `raft.state_save_failed`
([docs/plugins.md](plugins.md)); `src/trace/outbox.ts`) — with `from <= at < to`, in `seq` order.

- `from`, `to` — ISO 8601 or milliseconds since the epoch; the window is at most 24 hours. One alone
  puts the other 24 hours away; neither is the 24 hours up to now. `to` before or at `from`, a wider
  window, and a window reaching past ±8.64e15 ms (the last time a date holds) are `422`, before the
  agent is asked.
- `limit` — rows per page, 1 to 1000, default 200. `cursor` — a `seq`: only rows after it, from the
  previous page's `nextCursor`. A page may hold fewer rows than `limit`, none even, and still have a
  `nextCursor`: one request reads at most 5,000 rows from the agent and 20 exported batches, and says
  where it stopped. Only a `null` `nextCursor` means nothing is left.

**Source and lag.** A row is written to the agent's own outbox (`trace_outbox`) in the step that ends its
span, and the agent's next alarm pass exports it in batches of up to 500 to object storage
(`trace/<tenant>/<agent>/<fromSeq>-<toSeq>.ndjson`, `cf/src/trace-r2.ts`), then forgets it. The route
reads the outbox first and the exported batches second, so a row is found whether or not it was
exported, and one exported between the two reads is found in its batch: no lag past the span's end.
What is never there: a span still open (a model call awaiting its answer, a tool still running), and
anything the trace does not record (`src/trace/outbox.ts` names the documented silences). Each row is
as exported: `{ seq, at, tenantId, agentId, kind, spanId, parentId?, status, verdict, ms?, attrs }`.
A `model.call` row's `attrs` carry `model` and the answer's `input`, `cacheRead` and `cacheWrite` tokens;
on the pi085 engine also `prefix` (`src/runtime/request-prefix.ts`): the sha256 of the system prompt
and of the tool list, the request's message count and characters, how many leading messages (and their
characters) are the previous request's byte for byte, and `broken` — `system`, `tools`, `message`, or
null when the previous request is all a prefix of this one. No content is recorded.
A `rebuild.decision` row is a context rebuild decided (`src/runtime/rebuild.ts`), recorded and, unless it says
`shadow: false`, not acted on:
`trigger` `cold-wake` (each inbound wake of a pi085 agent's main conversation: whether the deployment's rules,
`REBUILD_POLICY`, predict the cache cold, `predictedCold`, and would rebuild, `wouldRebuild` — cold and over the
size threshold — with `reason` and the facts: gap, context tokens, model, the previous wake's first-call hit rate;
`expectedCold` for a first call or one after a reset), `window` (a pi085 context at 80% of its window, an answer
that is a context overflow, or a pd compaction that ran) or `operator` (a manual pd compaction), with `strategy`.
Its `rebuild.outcome` row (`parentId` the decision's `spanId`, `spanId` the model job) is the next call measured:
`input`, `cacheRead`, `hitRate`, and `status` `agree`, `false-cold`, `false-warm` (`predictedCold` against the
measurement), `expected-cold` (cold by construction, out of the rate) or `unmeasured` (an error, or no input).
One cold-wake rule is acted on: a wake more than `idleMinutes` (50; 25 for `gpt-5.6-luna`, whose cached prefix OpenAI keeps 30 minutes after its last use, less a
5-minute margin because this idle clock is not the provider's) after the conversation's
last answered call, when that call's input C is at least `2 × (fixed + 8,000)` — `fixed` the agent's own system prompt
and tools in that call's request, estimated at 4 characters a token, and 8,000 the briefing's budget, so the rebuilt
request is at most half of C — is rebuilt before it is answered — a new transcript of
the same conversation whose first message is a briefing, the wake after it (a wake whose push is never delivered
leaves the briefing for the next post: it is never sent alone). The rule is per model, in
`REBUILD_POLICY`'s `idle` section: `{ "default": {…}, "byModel": { "<model id, or a part of it>": {…} } }` (an exact
id first, else the longest key the id contains; the defaults name `deepseek`, 50 minutes, and `gpt-5.6-luna`, 25, which
a moved `default` leaves at 25); `"minContextTokens"` sets an extra floor C must exceed (none by default);
`"idleMinutes": null` turns one model's off, `"idle": false` all of them. A partial policy is laid
over the default (`{"idle": false}` alone is the kill switch), and a policy that is refused leaves the default shadow
rules with idle rebuilds off. Its decision is that wake's
only cold-wake row: `status` `ran`, `shadow: false`, `rule` `idle`, `idleEntry` (the entry applied: `default` or
`byModel:<key>`), with the gap, the context before, `fixedTokens` and `idleThresholdTokens` (the C it needed), the briefing's tokens, blocks and budget, `conversation` and `to`
(the transcripts ended and started) and `logicalConversation`, and the prediction it can no longer be measured against
(`predictedCold`, `shadowReason`, and the previous measured wake's `prevWakeHitRate` and `prevWakeGapMs`); a wake the
rule passes by keeps its shadow row, whose `idleRebuild` and `idleEntry` say why (`gap-under-idle`,
`savings-below-half`, `fixed-unknown`, `context-below-floor`, `needs-reset`, `idle-off`, …), with `fixedTokens` and
`idleThresholdTokens`. The rebuilt transcript's first run, once it has ended, writes one `rebuild.behaviour` row
(`parentId` the decision), and so does, for comparison, the run of every wake past the idle time that was not rebuilt
and of a tenth of the others (`rebuilt`, `group`: `rebuilt`, `idle-not-rebuilt`, `sample`; `idleReason`), with
`inboxReads` counted apart from the rest: `firstSendMs` (the wake to the first message sent), `toolCallsBeforeSend`,
`recapCallsBeforeSend` (memory, state and message-history reads), `firstAction` (`recap`, `send`, `act`),
`repeatedCalls` and `repeatedBeforeSend` (calls with the same tool and arguments as one that succeeded among the
replaced conversation's last 12), `toolCalls`, `modelCalls`, `runMs` and `endedWith`. Numbers and flags only.
A `turn.timing` row is one turn of a pi085 conversation (`src/runtime/turn-timing.ts`), written when it ends: from a
message accepted by the agent to the reply it can read, across every pause for the caller's functions. `spanId` is
`tt_<session>@<inboundAt>`, `ms` the turn's wall time, `status` pi's last run outcome (`completed`, `failed`, `aborted`),
`cancelled` (a cancel that aborted a run or dropped waiting calls; one with neither writes no row), or `abandoned`
(verdict `failed`: the caller's new input through the Agents API arrived while the turn waited on a call the caller
never answered; the turn ends at that input, `replyAt`, and the input opens a new turn — a background completion, a
push or a lease warning arriving then joins the turn instead). Its `attrs` hold the points — `inboundAt` (the message entered the agent), `saidAt` (durable in the
transcript), `turnStartAt` (the first step that drove it), `firstJobAt` (the first model job written), `lastAnswerAt`
(the last answer delivered), `replyAt` (the step that saw the turn end returned) — and the split, whose first five
add up to `ms` when every job was answered: `inboundToStartMs`, `startToFirstJobMs`, `modelMs` (each job, written to
answered, as `model.call` measures it), `betweenJobsMs` (each answer to the next job), `lastAnswerToReplyMs`; then,
inside `betweenJobsMs`, `toolMs` (tools run by the agent, summed per call) and `clientWaitMs` (each pause, from the
step that paused to the results that completed it), and `prepMs` (`inboundAt` to `saidAt`), with the counts
`modelJobs`, `tools`, `clientPauses` and `messages` (a steer joins the turn in flight), and the turn's first model
call's `firstCallPromptTokens` and `firstCallCachedTokens` (how much of its prompt the provider read from cache:
DeepSeek's `prompt_cache_hit_tokens`, OpenAI's `cached_tokens`; null while that call has no answer), which tell a
first reply slowed by a cold cache from one slowed by the model. pd agents write none.
The answer adds `from`, `to` (ISO), `cursor`, `nextCursor` and `scanned: { local, objects }`. Nothing
is written.

### Redaction

**Treat every export as sensitive.** It is an agent's whole conversation and trace, written by a model
that saw tool results, files and messages from people; redaction narrows what a credential in it can
reach and does not make the export safe to publish. What is caught is exactly the list below; anything
else, a credential in a shape not listed or split across two strings, is not guaranteed to be caught.

Both exports are walked whole — every string at any depth, and every key — first inside the agent's
own object, which alone can open its sealed values and never returns them, and once more by the route
(`cf/src/eval-read.ts` `redactCredentials`). Each replacement is `<redacted:KIND>` and is counted in
`redactions` at the top level. Caught:

- **By tool.** A call to or result of a kept-secret tool — any tool named `secret_*` under any alias
  (`<alias>__secret_put`, `<alias>__secret_get`, …; `state.secret_get` in a trace row or approval) —
  loses every string in its arguments, result and approval request but the secret's `name`
  (`<redacted:kept-secret>`), whatever the shape: an object, JSON in a string, or text.
- **By exact value.** Every value the agent's object holds sealed — the secrets it kept, its mounts'
  sealed credentials, its owner's and its hooks' secrets — the Worker environment value any of its
  mounts names (`env:NAME`), and the operator's credential any of its mounts names (`operator:exa`,
  `operator:run9`, resolved as the plugin's call resolves it; each string of a JSON one too), of 8
  characters or more: each appearance, anywhere in a value or a key (`<redacted:agent-secret>`, one
  per appearance), spelled as it is or JSON-escaped (once or twice), `\uXXXX`-escaped, HTML-escaped,
  URL-encoded (`encodeURIComponent`, strict with `!'()*` escaped, form-encoded with `+` for a space,
  `encodeURI`, and the first three encoded again), base64 or base64url (whole, or inside a longer run
  at any alignment) or hex; a value of 16 characters or more, and its hex, in any letter case. And a
  run that decodes to text holding one is replaced whole: a `%xx`-encoded run (up to three rounds of
  decoding, `+` read both ways; only its `&`/`?`/`=`-separated parts that hold one, when some do) and
  a base64 or base64url run of 24 to 65,536 characters, decoded from each of its first four characters.
  If a sealed value or an operator credential a mount names cannot be read, the export is `503`
  (`unavailable`), not sent without this.
- **By key.** The string values under a key named like a credential — containing `token`, `secret`,
  `password`/`passwd`, `passphrase`, `authorization`, `api_key`/`api-key`/`apikey`, `credential`,
  `private_key` or `cookie`, any case — replaced whole, and every string under such a key when its
  value is an object or array.
- **By shape**, whole strings: what the console refuses to send (`cf/src/secret-shape.ts`: API keys,
  Raft agent credentials, GitHub tokens, AWS access keys, private keys, Slack tokens, URLs with a
  password, labelled keys, our own service and provider tokens).
- **By shape**, the credential part only: JWTs (three base64url segments, the first a JSON object);
  `Authorization:`/`Proxy-Authorization:` values; `Bearer <token>` with a digit in it; `Basic <base64
  of user:pass>`; `Set-Cookie:`/`Cookie:` values; the values of `X-Amz-Signature`, `X-Amz-Credential`,
  `X-Amz-Security-Token`, `X-Goog-Signature`, `X-Goog-Credential`, `Signature`, `sig`, `token`,
  `access_token`, `refresh_token`, `id_token`, `client_secret`, `password`, `passwd`, `api_key` and
  `apikey` parameters; env lines `*_TOKEN=`, `*_KEY=`, `*_SECRET=`, `*_PASSWORD=`, `*_PAT=`,
  `*_CREDENTIAL(S)=`, `PASSWORD=` (no spaces round `=`, not a `$REFERENCE`); Google `AIza…` keys;
  Stripe `sk_`/`rk_` `live_`/`test_` keys; `<prefix>_live_…` keys; `ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`
  tokens of 20 characters or more and `github_pat_…`; `sk_agent_…` of 8 or more; `sk-…` of 20 or more.
- **Inside an encoding**: JSON in a string is parsed and walked (and written back when anything in it
  was replaced); `%xx`-encoded text holding any of the shapes, decoded up to three times, is kept
  decoded; a base64 run of 24 to 65,536 characters whose decoded text holds any of the shapes is
  replaced whole.

A subtree nested more than 100 deep is replaced whole (`<redacted:too-deep>`). A credential sealed
on a mount, and a mount's config, are not in a transcript or a trace row to begin with; the exact-value
scrub is for when the agent repeated one.

**Not caught.** The exact-value scrub knows only what the agent holds when the export is read: a
secret the agent deleted, or overwrote with `secret_put`, is no longer known, and neither is a mount's
credential since replaced or a mount since removed. A value shorter than 8 characters is not
scrubbed at all, and one shorter than 16 only in its own letter case. A value split across two strings
or two events, reversed, spaced out, compressed (gzip or deflate under base64), or in any spelling not
listed above, is not found by value. In a kept-secret tool's call, the fields that name it and say
where and when it ran (`id`, `name`, `tool`, `toolName`, `callId`, `toolCallId`, `task`, `taskId`,
`status`, times, sequence numbers, `mount`, `approver`…, `cf/src/eval-read.ts` `SECRET_TOOL_KEEP`)
are walked as ordinary text, so a secret the tool put in one of them is caught only by value or shape.
The shapes are heuristics: a credential with none of the shapes or keys above — a bare opaque token
outside `Authorization`, `Bearer` without a digit, a `key: value` or `KEY = value` line, an
upper-cased key prefix (`SK-PROJ-…`), a JWT whose header is not JSON, a header given as a
`[name, value]` pair or `{name, value}` object, or JSON embedded in prose (`result: {"token":"…"}`: a
string is parsed as JSON only when it starts as JSON, so a credential key inside such text is not
read as one) — is not caught unless it is one of the agent's values.

### Audit

Every transcript or trace read logs one line, `evt: "eval.read"`, with `tenant`, `agent`, `route`
(`transcript` or `trace`), `session` (transcript) or `from` and `to` (trace), `cursor`, `count` (events
or rows answered), `redactions`, and `credentialId`; never any content.

Every seed write, explicit seal, fresh context and restart logs one line, `evt: "eval.seed"`, with
`tenant`, `agent`, `op` (`write`, `seal`, `fresh-context`, `restart`), the `path` and `sha256` where
there is one, and `credentialId`: the provider token's
hash, the name the operator's token listing gives it. Never the token and never a file's text. A seal
made by the first push or turn logs the same line, `credentialId: null`, when files were seeded.
