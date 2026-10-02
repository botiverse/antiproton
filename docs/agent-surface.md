# Agent usage and workspace

Three read-only endpoints show one agent's usage and the files it works with. They exist on two
surfaces that answer the same bodies from the same code (`cf/src/agent-surface/`):

- **The public API** (`/v1/agents/:agentId/...`), authenticated with an API key. This is the primary
  contract.
- **The Raft provider binding** (`/provision/agents/:agentId/...`), authenticated with a provider token.
  This is the same contract addressed the way a Raft server addresses its agents.

Nothing here writes, starts a container, or shows a secret.

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
parameter is `400`, `code: "invalid_value"`, with the parameter named in `param`.

### `GET .../usage`

| Parameter | |
|---|---|
| `from` | Required. ISO 8601 time with a zone (`2026-10-01T00:00:00Z`, `2026-10-01T08:00:00+08:00`). An unencoded `+` that arrives as a space before the offset is read as the `+`. |
| `to` | Required, the same form, later than `from`. `to - from` is at most 31 days. |
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
    { "at": "2026-10-01T00:00:00.000Z", "resource": "model.tokens", "dimensions": { "model": "deepseek-chat", "kind": "output" }, "unit": "tokens", "quantity": 30 },
    { "at": "2026-10-01T00:00:00.000Z", "resource": "tool.call", "dimensions": { "tool": "gh.issue_list", "outcome": "failed" }, "unit": "calls", "quantity": 2 }
  ]
}
```

- `at` is the bucket's start. Rows are ordered by `at`, then resource, dimensions and unit. A row whose
  quantity would be zero is left out; no quantity is negative.
- `asOf` is how far the ledger speaks for this agent: the time of the read, or, when the agent holds
  usage it has not yet sent to the ledger, the time of the oldest such usage.
- `partial` is `true` when the window ends after `asOf` (a bucket in it is not finished, or holds usage
  not yet counted), when the agent's unsent usage could not be read, or when the ledger marks part of
  the window as unreadable. A `partial` answer is a lower bound.

**Every row can be summed with every other row of its resource and unit: no kind contains another.**

| `resource` | `dimensions` | `unit` | |
|---|---|---|---|
| `model.tokens` | `{ model, kind }` | `tokens` | `kind` is one of `input`, `output`, `reasoning`, `cache_read`, `cache_write_5m`, `cache_write_1h`. `output` **excludes** reasoning tokens (`output` as the provider counts it less `reasoning`); `cache_write_5m` is the cache write less its 1-hour part. A model's own name may contain `:`. |
| `tool.call` | `{ tool, outcome }` | `calls` | `outcome` is `succeeded` or `failed`; `succeeded` is all calls less the failed ones. |
| `tool.call` | `{ tool }` | `ms` | Time spent in the tool. |
| anything else | `{ key }` | as recorded | Passed through as the ledger holds it (for example `js.run` / `{ key: "run_js" }` / `runs`). |

The subtraction is made per bucket and per model or tool. A difference that would come out negative
(the ledger disagreeing with itself) is left out and logged on the server.

### `GET .../workspace/files`

| Parameter | |
|---|---|
| `dirPath` | The directory to list, e.g. `state/notes/`. Empty or `/` is the top level. A trailing `/` is optional. |
| `includeHidden` | `true` or `false` (default). Hidden entries are those whose name starts with `.`. |

Answers one directory level, directories first, then by name, at most 1000 entries:

```json
{ "files": [
  { "name": "notes", "path": "state/notes/", "isDirectory": true, "size": 0, "modifiedAt": "2026-10-01T01:00:00.000Z" },
  { "name": "memory", "path": "state/memory", "isDirectory": false, "size": 31, "modifiedAt": "2026-10-01T01:00:00.000Z" },
  { "name": ".draft", "path": "state/.draft", "isDirectory": false, "size": 8, "modifiedAt": "2026-10-01T01:00:00.000Z", "isHidden": true }
] }
```

`path` is what to pass back as `dirPath` (a directory, ending in `/`) or as `path` to the read (a
file). `modifiedAt` is ISO 8601; where a store does not keep a time it is the epoch.

The top level is always three directories:

| Root | What it holds |
|---|---|
| `state/` | What the agent keeps with its state tools, one file per key; a `/` in a key makes directories. A text value is its text; any other value is JSON. In a listing, a state file's `size` is its stored (JSON-encoded) size; the read reports the size of the content it returns. The agent's sealed secrets are never listed and never readable, under any spelling of their name; mount credentials and hook secrets are not part of the workspace at all. |
| `artifacts/` | The agent's objects in object storage: tool results too large to return inline, files saved out of its container, and state values too large for a row. |
| `sandbox/` | The working directory (`/work` by default) of the agent's container, **only while that container is already running**. A look never starts one: a container is billed while it runs. When none is running, `sandbox/` holds a single file, `NOT_RUNNING.txt`, saying so, and any other path under it is `404`. |

Listing a directory that does not exist is `404`.

### `GET .../workspace/files/read`

| Parameter | |
|---|---|
| `path` | Required. A file under one of the three roots, e.g. `state/memory`. |

```json
{ "content": "the user prefers short answers", "binary": false, "size": 31, "mimeType": "text/plain", "encoding": "utf-8" }
```

- Text (valid UTF-8 with no NUL byte) comes back as `content` with `encoding: "utf-8"`.
- Anything else comes back base64-encoded: `binary: true`, `encoding: "base64"`.
- A file over **1 MB** (1,048,576 bytes) is not returned: `content: null`, `binary: true`,
  `encoding: "base64"`, and `size` still says how large it is.
- `mimeType` is taken from the name's extension, else what the store recorded, else `text/plain` or
  `application/octet-stream`.
- A path to a directory is `400`; a path that does not exist is `404`.

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
  `code: "not_found"`.
