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
(`Authorization: Bearer <provider token>`), addressed the way every other provider route is:

| Method | Path |
|---|---|
| `GET` | `/provision/agents/{agentId}/usage?from=&to=&bucket=` |
| `GET` | `/provision/agents/{agentId}/workspace-files?dirPath=&includeHidden=` |
| `GET` | `/provision/agents/{agentId}/workspace-files/read?path=` |

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

## Evaluation setup (preview only)

Routes for an evaluator to give an agent its workspace before the agent first runs, start it on a
fresh conversation, and read back what its model was sent. They are served only where the deployment
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

### Seeded files

A seeded file has two copies, written together in one transaction: a **snapshot** nothing the agent
can call reads or changes, and a **working copy**, the agent's ordinary state key `path` (its
`get` reads it; `state/{path}` in the workspace reads above). `mode` is `writable` (default) or
`readonly`. The state plugin refuses every tool of its own that writes a key — `put`, `remember`,
`forget` — on a `readonly` path, with a reason naming the path; a `writable` one is an ordinary key
the agent may change or remove. Its `get` and `list` mark a seeded path with `seed: "writable"` or
`seed: "readonly"`, and its first mount puts a "Workspace files provided at setup" paragraph in the
system prompt ahead of the working set: `MEMORY.md`'s working copy (its first 4,000 characters), then
every other seeded path, printed exactly as stored, with its working copy's size now and its mode. With
nothing seeded the paragraph is absent and the prompt is as it was. Rules for `PUT …/seed`:

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
  "manifestSha256": "…", "sealedAt": "2026-10-09T09:00:00.000Z", "how": "explicit" }
```

`manifest` is sorted by `path`; `manifestSha256` is the SHA-256 of its canonical JSON (keys sorted, no
spaces: `src/core/canon-json.ts`), so it is the same however it was read. `how` is `explicit`,
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

### Audit

Every seed write, explicit seal, fresh context and restart logs one line, `evt: "eval.seed"`, with
`tenant`, `agent`, `op` (`write`, `seal`, `fresh-context`, `restart`), the `path` and `sha256` where
there is one, and `credentialId`: the provider token's
hash, the name the operator's token listing gives it. Never the token and never a file's text. A seal
made by the first push or turn logs the same line, `credentialId: null`, when files were seeded.
