# Staying in sync with pi

pi is pre-1.0 and moves. We depend on it in three ways that fail *differently*
on an upgrade, and only the first one fails loudly. This file exists so the
other two are not discovered in production.

Upstream: [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi),
MIT, © 2025 Mario Zechner. The MCP client, `@earendil-works/pi-mcp`, comes from
the same repository and is held to the same rules; its contracts are in their
own section below.

`@earendil-works/pi-durable` 1.0.0 is installed beside it, for the move of the
agent loop onto pi's durable harness. What exists on it so far is its SQLite
storage core behind `src/store/pi-durable-sqlite.ts`, the offloaded provider
on pi-ai 1.0 (`src/model/durable-offloaded.ts`) and the park decision
(`src/runtime/durable-drive.ts`). Nothing in `cf/src` or the live runtime
reaches any of them yet (only the never-deployed conformance worker does); the
runtime still runs on `pi-agent-core`.

## The pin is exact, on purpose

`package.json` pins `0.85.1`, not `^0.85.1`. A caret on a `0.x` package still
allows every patch release, and a patch can change any of the behavioural
contracts below — none of which TypeScript would catch, because none of them is
expressed in a type.

Check for movement with `npm view @earendil-works/pi-agent-core version`.

`@earendil-works/pi-mcp` is pinned the same way, at `1.0.0`; check it with
`npm view @earendil-works/pi-mcp version`.

pi-durable is pinned the same way, and so is what it needs: `chord` 1.0.0 as a
direct dependency, and `pi-ai` 1.0.0 through `overrides`, scoped to pi-durable.
The override is not a style choice. Our own code imports `@earendil-works/pi-ai`
by its bare name and gets whatever is installed at the top level, which has to
stay pi-agent-core's 0.85.1 until the runtime moves; a top-level 1.0.0 would
swap the provider contract under the running loop. Scoped, it installs under
`node_modules/@earendil-works/pi-durable/`. Nothing of ours imports `chord`
outside the pi-durable side (`src/runtime/durable-drive.ts`,
`src/runtime/durable-agent.ts` and their tests), and pi-agent-core gets its own 0.85.1 copy, so
`chord` can sit at the top level. `npm ls @earendil-works/pi-ai
@earendil-works/chord pi-ai-1` shows the layout.

Our own code that is on the 1.0 side imports pi-ai 1.0 as **`pi-ai-1`**, a
package alias (`"pi-ai-1": "npm:@earendil-works/pi-ai@1.0.0"`). The bare name
has to keep meaning 0.85.1, for the reason above, and the copy under
pi-durable cannot be named from our code at all: its exports are pi-durable's,
and node refuses a `node_modules` segment in an `imports` mapping. The alias is
the one name that says at the import site which world a file is in. Its costs,
stated so they are not rediscovered:

- **It is a second install of the same 1.0.0**, not the one pi-durable loads.
  Our provider, `Models` and streams come from `pi-ai-1`; pi-durable reads them
  through its own copy. That is safe only because pi-durable takes nothing from
  pi-ai but pure functions (`utils/transcript`, `retry`, `estimate`, `overflow`,
  `validation`) and makes no `instanceof` or identity check on a pi-ai value
  (read in 1.0.0's `dist`). Both are things to re-read on an upgrade, and
  `test/durable-drive.ts` fails when the two installs' versions differ. TypeScript
  sees one package, because it merges same-name same-version copies.
- **No pi-ai value crosses between 0.85 and 1.0.** The two share the job wire
  format as JSON only: a job row is a string written by one provider and read
  by `toRequest`; an answer is a string written by `fromResponse` and read back
  by `readAnswer`. The 0.85 provider writes version 1 (0.85's `Context`,
  untagged); the 1.0 one writes version 2 (`version: 2`), which keeps each
  system message where it stands in the transcript, rendered to text by the
  writer. `JobContextV2` in `src/model/pi-bridge.ts` defines it.
- The production bundle carries pi-durable, `chord`, `pi-ai-1` and the
  `typebox` they validate with, because `cf/src/runtime.ts` imports the `pd`
  engine (`src/runtime/durable-agent.ts`) to open an agent whose object
  records it. Measured on a dry-run build: 2,689,794 bytes at master 3a1ee8e,
  3,609,643 with the engine (gzip 595.57 KiB to 763.43 KiB). A dynamic
  `import()` does not help — esbuild inlines it, and the build grew to
  3,819,591 bytes.

The override yields two physical pi-ai copies: the top-level 0.85.1 for the live
runtime, and 1.0.0 nested under pi-durable. That is safe only while no pi-ai
value crosses between the two: they may share types, never runtime objects
(messages, streams, errors), or `instanceof` and identity checks break.

## What we depend on

### 1. Imported symbols — these break loudly

The authoritative list is a command, not a table, because a table rots:

```bash
grep -rhoE 'from "(@earendil-works/|pi-ai-1)[^"]*"' src cf/src test bench --include='*.ts' | sort -u
```

At the time of writing that is six entry points: four from
`@earendil-works/pi-agent-core` — the package root (`AgentHarness`,
`LaneBusy`), `harness/session` (`StorageBackedSession`), `harness/context`
(`BACKGROUND_CONTEXT`), `harness/session/testing` (`createStorageConformance`,
tests only) — plus `@earendil-works/pi-ai` for the provider contract
(`createProvider`, `createAssistantMessageEventStream`) and the faux provider
in tests, plus the root of `@earendil-works/pi-mcp` for the MCP client
(`McpClient`, `StreamableHttpTransport`, `toLlmContent`; see §4).
pi-durable adds `storage/sqlite` (the `SqliteDatabase` types, and
`SqliteStorage` in `src/runtime/durable-agent.ts`; its migrations in tests), its root (`Harness`, `LiveDoc`,
`InboxDoc`, `GenerationTask`, `CompactionTask` and the task and document types,
in `src/runtime/durable-drive.ts`; `createRegistry` and `ROOT_CONVERSATION_ID`
in `src/runtime/durable-agent.ts`), `testing` (`createStorageConformance`,
tests only) and `@earendil-works/chord` (types, and `chord/context` in
`src/runtime/durable-agent.ts` and tests).
`pi-ai-1` adds `models` (`createProvider`, `createModels`),
`utils/event-stream`, `utils/transcript` (`getCurrentTools`), `utils/text`
(`getSystemMessageText`, `renderSystemMessageUpdate`) and the root's types, in
`src/model/durable-offloaded.ts` (and `createModels` in
`src/runtime/durable-agent.ts`).

### 2. Copied source — this breaks silently

| what | from | where it lives here |
|---|---|---|
| `emptyUsage`, `addUsage` | `harness/utils/usage.js` | `src/store/pi-storage.ts` |
| scan, cursor and stop-order semantics | `harness/session/in-memory-storage-state.js` | `src/store/pi-storage.ts` |
| the facade's serial operation queue (re-implemented, smaller: a transaction always queues) | pi-durable `storage/sqlite/node.js` (`SerialOperationQueue`) | `src/store/pi-durable-sqlite.ts` |

The usage arithmetic is copied because pi's export map does not publish it. The
scan semantics are re-implemented against a reference we can read; pi's own
conformance suite is what keeps them honest, which is the whole reason we run
upstream's suite rather than ours.

**Re-diff each on every upgrade.** They will not fail to compile.

### 3. Behavioural contracts — these break silently and worst

Nothing imports these. Nothing types them. Everything rests on them:

- `drive()` returns `waiting` rather than blocking when a response carries
  `stopReason: "deferred"` (pi-agent-core; on pi-durable, parking replaces it —
  see below). If it ever awaited instead, the object would be
  billed for the provider's latency and the cost model would be gone.
- A `fetchDeferred` that is not ready answers by returning **the same handle**.
- The inbox (`steer` / `followUp` / `nextRun`) drains at `accept()`, not on a
  timer and not on `drive()`.
- `AgentHarness.create` starts no provider, tool, hook or timer work, and
  reports operations left open by the previous process in `open[]`. This is our
  entire crash-recovery mechanism; there is no sweeper any more.
- `Storage.commit` is all-or-nothing across entries, values, lists and usage.
- `AssistantMessage["stopReason"]` is exactly the set the trace seams decide
  over: which reasons end a model call's span and which are the placeholder's
  and a poll's. The set is pinned in `src/trace/seams.ts` by a record keyed on
  that union, so an added or removed reason fails the typecheck there rather
  than reading silently as "not an end".

Each has a test. That is deliberate: an upgrade that quietly changes one of
these should fail here, not on a tenant.

#### On pi-durable: parking replaces `drive()` returning `waiting`

pi-durable has no `drive()` and nothing returns `waiting`. A generation that
gets `deferred` commits a `poll` checkpoint (`pollAt`, from the handle's
`pollAfterMs`) and then **sleeps in-process until `pollAt`**; a retryable error
commits `retry` with `until` and sleeps the same way, and so does a compaction
retry. An object that kept the harness open for that would be billed for the
sleep. What replaces `waiting` is `settle()` in `src/runtime/durable-drive.ts`:
it reads the committed state after every commit, and when the harness is doing
nothing but sleeping until T it closes the harness and returns
`{ state: "parked", parkedUntil: T }` for the caller to set an alarm; the alarm
opens a harness on the same storage and calls `resume()`. The contracts it
rests on:

- `Harness.close()` at any moment aborts task invocations and **writes no task
  outcome**; a reopened harness resumes each task from its last checkpoint. A
  fetch cut off by close is simply made again.
- A not-ready `fetchDeferred` commits a fresh `poll` checkpoint with a new
  `pollAt` and **no transcript entry**.
- A sleeping task is `running` with its checkpoint in `poll` or `retry`, and the
  sleep reads the harness clock (`HarnessOptions.now`), which is the clock the
  park decision must read.
- Input submitted while a run holds the conversation waits in `pi.inbox` for
  the run's next boundary, and does not wake the sleeper.

The park predicate, `parkVerdict`, says "park" only when all of these hold:
every live task is a sleeper or `waiting` on other tasks; every sleeper is
`running`, not abort-marked, and its T is **strictly after now** (by at least
`minParkMs`, default 1000 — a shorter park saves almost nothing and risks closing mid-fetch); no conversation involved has a committed streaming
partial or a tool slot that is not done; and queued input exists only where a
run already holds its conversation. T is the earliest sleeper's. The strict
comparison is the one that matters: a task whose `pollAt` has passed is
fetching or about to, with its checkpoint still saying `poll`, and parking it
sets an alarm in the past that reopens, fetches, parks again — a spike measured
108 fetches for one answer that way. `test/durable-drive.ts` and
`npm run durable-drive:do` cover submit-then-park, the wake that completes with
one fetch, the wake that parks again with one fetch, the wake whose `pollAt` has
passed, input while parked, and the retry backoff, and judge one parked
snapshot at T−1, T and T+1.

#### On pi-durable: usage and trace are derived after the commit

pi 0.85 lets us write the usage and trace outboxes inside `Storage.commit`;
pi-durable's commits are its own, so `src/runtime/pd-outbox.ts` derives the
same rows afterwards from committed entries, past a watermark on
`entries.commit_seq`, and checks its totals against pi-durable's `pi.usage`
documents. It reads pi-durable's tables directly, and rests on:

- **Every response is an assistant entry**, a failed attempt that is retried
  included, and its usage is added to `pi.usage` in the same commit
  (`appendAssistant` in `harness/generation.js`). Derived totals therefore
  equal `pi.usage`; compaction (off on pd) is the one writer that counts usage
  with no entry.
- `durable_metadata.next_seq` is one past the last committed sequence, and is
  written in the commit it counts.
- An entry row's `record` is the `EntryRecord` as JSON, with `kind` and `model`.
- `pi.usage` checkpoints on every change, so its newest revision is a `base`;
  a `delta` there is reported as unreadable rather than read.
- An offloaded answer keeps the fields the worker wrote (`jobId`) when
  pi-durable stores it as the entry's message.

`test/pd-outbox.ts` and `npm run pd-outbox:do` compare the rows with PiAgent's
for the same conversation, and fail when any of these moves.

### 4. pi-mcp — what `src/plugins/mcp.ts` rests on

The plugin imports exactly `McpClient`, `StreamableHttpTransport` and
`toLlmContent`. Three things about them are not in any type:

- **The package root re-exports `StdioTransport`, which reaches
  `child_process` through `cross-spawn`.** It stays out of the Worker only
  because the package declares `sideEffects: false` and the bundler drops what
  is not imported. So the stdio transport is never imported, under any name,
  and an upgrade that drops `sideEffects: false` or makes the root import
  `child_process` itself would put it back. `test/mcp-plugin.ts` checks the
  import list and bundles the plugin with esbuild, looking for
  `child_process` — with a control bundle that imports `StdioTransport` to show
  the check can see it.
- **There is no way to resume a session.** `StreamableHttpTransport` takes no
  session id; it captures the one the server assigns during `initialize` and
  uses it for that connection only, and `connect` always initializes. So every
  call is a fresh connection that initializes again — a server keeping state
  per session sees a new session per call. `test/mcp-plugin.ts` counts one
  `initialize` per connection, none of them carrying an earlier session id.
- **`openGetStream: false` means no GET request at all.** The default opens a
  server-to-client stream after `initialize`; nothing here listens between
  calls, so the plugin turns it off, and the same test asserts no GET is sent.

Also unexpressed, and read rather than tested: `listTools` silently drops a
listed tool whose `name` is not a string or whose `inputSchema` is not an
object, so such a tool never reaches the snapshot's `skipped` list.

## Where we deliberately differ from pi

These are not bugs and must survive an upgrade:

| divergence | why | pinned by |
|---|---|---|
| the provider has **no non-deferred path** | Cloudflare bills Durable Objects for wall clock with no exemption for network I/O; a completion is ~94% waiting | `test/pi-offload.ts` |
| `step()` polls only when an answer already exists | pi records what the provider says, and "not ready" is something it said — correct for a batch API, but our provider is a table in the same object, so asking costs a transcript row for nothing | `test/pi-agent.ts` |
| a `steer` on an idle lane **starts a run** | pi keeps the three gestures separate because its front end is a TUI that knows the lane's state; an HTTP request does not, and the page sends every message as a steer | `test/pi-agent.ts` |
| pi-durable's SQLite tables and indexes are **placed in a namespace** by our facade (`src/store/sql-namespace.ts`), from a fixed list — `pd_tasks` on a Durable Object; any other CREATE throws | its schema creates `tasks` with no `IF NOT EXISTS`, and `AgentDO` already has a `tasks` table in the same object (`src/store/durable-object.ts`) — un-namespaced, pi-durable's migration fails on an object that has ours, and on one that had pi-durable's first, our `CREATE TABLE IF NOT EXISTS` would silently adopt a table of another shape. The namespace is an interface rather than a prefix so a store with real schemas can address them as `pd.tasks` without the facade changing | `test/pi-durable.ts`, `npm run pi-durable:do` |

If an upgrade makes one of these unnecessary, delete it deliberately and strike
the row — do not leave it as a divergence nobody can explain.

## Changing upstream files

Prefer not to. If it is necessary, it is allowed, but:

- **Never edit `node_modules` in place.** It is not tracked; the change vanishes
  on the next install and takes the reason with it.
- Vendor the patched file under `src/vendor/pi/`, mirroring its upstream path,
  with a header naming the upstream path, the version it was taken from, and
  what was changed and why.
- Record it in the table below and in `NOTICE` — MIT requires the notice, and a
  modified file has to say it was modified.
- Open the issue or PR upstream and link it here, so the patch has an end rather
  than becoming a fork by accident.

| vendored file | upstream path | taken from | why | upstream link |
|---|---|---|---|---|
| *(none yet)* | | | | |

## Upgrading

In order. Each step gates the next; the point is that the cheap checks run
before the expensive one.

1. Read what changed: the export maps, and the `.d.ts` of the five entry points
   we import.
2. Bump the pin to an exact version.
3. `npm run pi-storage` and `npm run pi-storage:do` — pi's own 21 conformance
   cases, on node:sqlite and on real Durable Object storage. This is the canary
   for the `Storage` contract, and it is upstream's suite rather than ours.
   For pi-durable, `npm run pi-durable` and `npm run pi-durable:do` do the same
   with its suite, plus the facade's own cases; a new migration fails them
   until the list of names in `src/store/pi-durable-sqlite.ts` is updated.
   Then `npm run durable-drive` and `npm run durable-drive:do`, the park
   contract above; bump `pi-ai-1` together with pi-durable's pi-ai.
4. `npm run pi-loop`, `pi-offload`, `pi-tools`, `pi-agent`, `pi-bridge` — the
   behavioural contracts and every divergence above.
5. Re-diff the copied source in the table in §2.
6. The remaining suites.
7. **SWE-bench before deploying.** Every contract above can hold while the agent
   simply gets worse, and nothing in §1–3 would notice.

## Credit

`NOTICE` records copied source; the README's *What was taken from elsewhere*
records design borrowings. Keep them apart and keep them true — a wrong credit
is as bad as a missing one.
