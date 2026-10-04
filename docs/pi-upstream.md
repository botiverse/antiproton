# Staying in sync with pi

pi is pre-1.0 and moves. We depend on it in three ways that fail *differently*
on an upgrade, and only the first one fails loudly. This file exists so the
other two are not discovered in production.

Upstream: [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi),
MIT, © 2025 Mario Zechner. The MCP client, `@earendil-works/pi-mcp`, comes from
the same repository and is held to the same rules; its contracts are in their
own section below.

`@earendil-works/pi-durable` 1.0.0 is installed beside it, for the move of the
agent loop onto pi's durable harness. On it is the second engine, `pd`
(`src/runtime/durable-agent.ts`): its SQLite storage behind
`src/store/pi-durable-sqlite.ts`, the offloaded provider on pi-ai 1.0
(`src/model/durable-offloaded.ts`) and the park decision
(`src/runtime/durable-drive.ts`). `cf/src/runtime.ts` opens it for an object
whose `ap_meta` records `pd` (`recordedEngine`): one the operator migrated
(`AgentRuntime.migrateEngine` in `cf/src/runtime.ts`, which runs `src/runtime/pd-migrate.ts`
and records the move with `ApStore.migrateEngine`) or a pd bench object
(`cf/src/bench.ts`). No creation path records it, so every production agent
still runs on `pi-agent-core` (`pi085`).

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
`InboxDoc`, `ToolTask` and the task and document types,
in `src/runtime/durable-drive.ts`; `AgentDoc`, `GenerationTask` and `ROOT_CONVERSATION_ID`
in `src/runtime/durable-agent.ts`, whose `createRegistry` is the vendored one; `defineExtension`, `hook`, `GenerationTask` and the tool
types in `src/runtime/durable-tools.ts`), `testing` (`createStorageConformance`,
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
| reading a pi 0.85 session without opening it (the tip in `pi.branch.tip`, a run or queued input in `pi.lane.state`, the branch walk, a compaction's context as its summary, retained tail and what follows), and writing it as pi-durable's context (the newest head marker starts it, an entry's `head` may point at an earlier entry) | pi-agent-core `harness/session/values.js`, `harness/session/context.js` (`buildContextEntries`), `harness/messages.js`; pi-durable `harness/context.js` (`deriveContext`) | `src/runtime/pd-migrate.ts` (`planMigration`, `importDrafts`); `test/pd-migrate.ts` and `npm run pd-migrate:do` compare pd's next requests after a migration, and pi085's after the rollback, with pi085 never migrated |

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

On pi-durable, the tools (`src/runtime/durable-tools.ts`, the pi085 tool objects
wrapped) rest on these, each read in 1.0.0's `dist` and covered by
`test/pd-tools.ts` and `npm run pd-tools:do`:

- `ToolRegistration.replay` is decided at recovery: an `unsafe` call whose
  intent was recorded is not run again and gets an error result
  (`harness/tool.js`, the `execute` phase); a `safe` one is run again.
- `close()` aborts a running tool's context **and waits for `execute()` to
  return**; the wrapper stops waiting on abort so a close is not as long as a
  gateway call.
- One `executionMode: "sequential"` tool makes its whole round sequential
  (`harness/generation.js`, `startToolRound`). pi-agent-core 0.85's harness
  does not read the field at all.
- A conversation's stored `extensions` array selects exactly the installed
  extensions it names and silently skips a missing one; an unset selection is
  every installed extension (`harness/agent.js`, `selectExtensions`).
- A round's tool results are stored in completion order and sent to the model
  in call order.

Cancel and the API caller's functions (`DurableAgent.cancel`, `clientTool`;
`test/pd-cancel.ts` and `npm run pd-cancel:do`) rest on these:

- `Conversation.abort()` marks every live task of the conversation, starts the
  scheduler, and resolves once it is idle. A generation aborted in its `poll`
  phase calls `cancelDeferred` (`harness/generation.js`, `abort`), which is how
  the job row is marked cancelled; nothing is appended for the abort itself, so the
  marker entry is ours: a note entry of the runtime's kind, its model message
  the runtime's note, written with the conversation's client calls forgotten in
  one commit.
- Once the abort mark is down a tool's late result is not committed; its
  result is pi-durable's `Tool <name> was aborted` block, and that is what the
  model and the transcript's readers see (pi085's abort instead waits for the
  tool and records its real result).
- Nothing holds pi-durable's commits off while a gateway call runs, so the
  abort mark commits with the call still in flight, and the call's late result
  is not committed (above).
- A tool may wait in `execute()` as long as it likes; `close()` aborts it. A
  `safe` one is run again on reopen, which is what lets a harness whose only
  pending work is the caller's function close with no alarm
  (`externalWaits` in `parkVerdict`).
- A tool can commit (`api.commit`) and watch a conversation document
  (`api.watchDoc`, a `DocumentObserver`): the caller's function records its
  call in the `ap.clientCalls` document and waits on it, and
  `Conversation.commit` writes the caller's answer there, so the answer is a
  pi-durable commit that wakes the watch and `settle`'s re-read alike.
- Input submitted while a run waits on the caller is queued (`whenBusy:
  "steer"`) and placed at the run's next boundary, after the caller's results;
  `Conversation.abort()` withdraws it with the rest of the run.

#### On pi-durable: parking replaces `drive()` returning `waiting`

pi-durable has no `drive()` and nothing returns `waiting`. A generation that
gets `deferred` commits a `poll` checkpoint (`pollAt`, from the handle's
`pollAfterMs`) and then **sleeps in-process until `pollAt`**; a retryable error
commits `retry` with `until` and sleeps the same way, and so does a compaction
(the vendored `harness/compaction.js`): its summary is deferred too, and its
`poll` and `retry` sleep alike. An object that kept the harness open for that would be billed for the
sleep. What replaces `waiting` is `settle()` in `src/runtime/durable-drive.ts`:
it reads the harness after every commit and every sleep notice, and when the
harness is doing nothing but sleeping until T it closes the harness and returns
`{ state: "parked", parkedUntil: T }` for the caller to set an alarm; the alarm
opens a harness on the same storage and calls `resume()`. The contracts it
rests on:

- `Harness.close()` at any moment aborts task invocations and **writes no task
  outcome**; a reopened harness resumes each task from its last checkpoint. A
  fetch cut off by close is simply made again.
- A not-ready `fetchDeferred` commits a fresh `poll` checkpoint with a new
  `pollAt` and **no transcript entry**.
- Who says a task is sleeping is the scheduler: 1.0.0 reports a sleeping task as
  plain `running`, so we run a vendored scheduler (see *Changing upstream
  files*; upstream issue pi#10325) whose `inspect()` adds `sleepingUntil` while
  the task's invocation is inside `runtime.sleep`. It also calls
  `HarnessOptions.onSleep` when a sleep starts, for a task that works without
  committing and then sleeps — no commit brings the read that would see it.
  `PdHost` passes that notice to `settle` (its `subscribe`), so such a sleep is
  read at once rather than at settle's 1 s recheck; pi-durable's own poll and
  retry sleeps start right after their checkpoint's commit and are seen either
  way. `test/spec/durable-agent-spec.ts` fails if a park waits for the recheck,
  for a poll and for a task that sleeps after uncommitted work. This replaced
  reading `poll`/`retry` checkpoints and a table of every phase pi-durable
  writes, which a new upstream sleep or an extension's own would have turned
  into a billed wait. The sleep reads the harness clock (`HarnessOptions.now`),
  which is the clock the park decision must read.
- Input submitted while a run holds the conversation waits in `pi.inbox` for
  the run's next boundary, and does not wake the sleeper.
- What wakes a poll sleeper early is the delivered answer. 1.0.0 has no way to
  end a sleep before its time, so the vendored scheduler adds
  `Harness.wake(taskIds)`: a task inside `runtime.sleep` returns from it at
  once, and a live task with no invocation yet keeps the wake for its first
  sleep. A task running but not sleeping is not woken: a kept wake would end
  whatever sleep came next, such as a retry's backoff after an error answer.
  `PdHost` calls it for every task whose `poll` checkpoint names a job that has
  its answer (`#wakeAnswered`, read from `ap_model_jobs`, not remembered): in
  `deliver` when the harness is open, in every `drive` before `resume()`, so
  the step the delivery asks of a parked object (cf/src/index.ts
  `deliverAnswer`, as on pi085) reads the answer at once, and from the harness's
  `onSleep` when a poll starts sleeping, for an answer that landed while the
  poll was fetching. A wake that comes too early costs one fetch, which commits
  a new `pollAt` (the contract above). The handle's `pollAfterMs` is then only
  the backstop for a lost wake: `POLL_BACKSTOP_MS`, 5 min, the same for every
  poll. While a job is out, a park comes back by its redelivery time
  (`REDELIVERY_MS`, 2 min) anyway, for the sweep that resends a lost dispatch.

The park predicate, `parkVerdict`, says "park" only when all of these hold:
every live task is a sleeper or `waiting` on other tasks; every sleeper is
reported `sleepingUntil` T by the scheduler, not abort-marked, and its T is **strictly after now** (by at least
`minParkMs`, default 1000 — a shorter park saves almost nothing and risks closing mid-fetch); no conversation involved has a committed streaming
partial or a tool slot that is not done; and queued input exists only where a
run already holds its conversation. T is the earliest sleeper's. The strict
comparison is the one that matters: a task whose T has passed is fetching or
about to (its timer may fire late, so the report can still stand), and parking it
sets an alarm in the past that reopens, fetches, parks again — a spike measured
108 fetches for one answer that way. `test/durable-drive.ts` and
`npm run durable-drive:do` cover submit-then-park, the wake that completes with
one fetch, the wake that parks again with one fetch, the wake whose `pollAt` has
passed, input while parked, and the retry backoff, and judge one parked
snapshot at T−1, T and T+1.

#### On pi-durable: one synchronous commit, and plain writes beside it

A pi-durable commit is one host `transactionSync` (the vendored `storage.js`, see
*Changing upstream files*): every statement in it synchronous, so no other code
of the object runs between its first statement and its commit or rollback.
Nothing of ours can land inside one except what its commit hook writes on purpose
(below), and a failed commit rolls back only its own writes and the hook's. That is the whole of the coordination between pi-durable and the
rest of the object: the facade (`src/store/pi-durable-sqlite.ts`) runs each
statement when it is called, with no queue; the runtime, the store, the
gateway, the plugins and `AgentDO` write the object's SQL with plain
statements, before, after and alongside pi-durable's commits; a tool call runs
alongside its round's commits. Where several writes of ours must land together
they run in their own `transactionSync` (`ApStore.unit`, the store's methods
that had one). It rests on:

- **No pi-durable transaction spans an await.** The vendored `storage.js` and
  `migrations.js` ask only for `transactionSync`, `storage.js` refuses a
  database without it, and the facade has no async `transaction`. `test/pi-vendor.ts` counts what the
  vendored storage asks for (no async transaction) against upstream's (three).
- A raw `sql.exec` scheduled from inside a commit — a microtask or a timer —
  runs after it, sees it whole, and survives its rollback. `test/pi-durable.ts`
  and `npm run pi-durable:do` probe both; `test/spec/pd-commits.ts` starts work
  as each commit ends, which is how `test/pd-writes.ts`, `test/pd-cancel.ts` and
  `test/durable-agent.ts` drive the runtime's writes against commits.

#### On pi-durable: our bookkeeping is written inside pi-durable's commit

pi 0.85 lets us write the usage and trace outboxes inside `Storage.commit`; on
pi-durable the vendored storage calls a commit hook inside the transaction that
applies each batch (see *Changing upstream files*), and `bookCommit` in
`src/runtime/pd-outbox.ts` writes there: `model.call` trace rows and the
`ap_model_jobs` rows, committing or rolling back with the batch. Usage is not
written there: a pd model call is metered when its answer is delivered
(`PdHost.deliver`), as [`metering.md`](metering.md) sets out, and pi-durable's
`pi.usage` is the independent source that metering is reconciled against. It
rests on:

- **`pi.usage` records every answer the harness consumed**: a response
  (`appendAssistant` in `harness/generation.js`, a failed attempt that is
  retried included) and compaction's model call (the vendored
  `harness/compaction.js`, which appends no entry for it) each add to the
  conversation's `pi.usage` `models` bucket, keyed `provider/model` as the
  answer names them, in the commit that records the response. A tool result
  that carries usage (`appendToolResult` in `harness/tool.js`) adds to the
  `tools` bucket, which is not money we pay. The drift check
  (`pdUsageDrift`) reads these documents and nothing else of pi-durable's.
- **A generation records a deferred handle in a `poll` checkpoint**, in the
  commit after the provider returned it (`classify` in `harness/generation.js`),
  and so does a compaction's summary (`respond` in the vendored
  `harness/compaction.js`): same phase name, same `handle` field.
  The provider only stages the job; that commit inserts the row, and the job is
  dispatched after it. A task that dies before it leaves no row.
- A summary's answer is never an entry, so its job is marked consumed by the
  batch that moves the compaction task off the `poll` of an answered job; it
  gets no `model.call` trace row, which the status would read as the turn's.
- An offloaded answer keeps the fields the worker wrote (`jobId`) when
  pi-durable stores it as the entry's message; the batch that appends it marks
  the job consumed.
- `cancelDeferred` is called only for a generation or a compaction whose
  committed checkpoint is `poll` (`abort` in `harness/generation.js` and the
  vendored `harness/compaction.js`), so a cancelled job's answer
  is never appended. The `consumed` and `cancelled` marks are what `takeJob`
  and the sweep read; neither moves money.

`test/pd-outbox.ts` and `npm run pd-outbox:do` compare the rows with PiAgent's
for the same conversation, and cover the jobs' crash, cancel and rollback cases.

#### What `caller.contextId` rests on

`PluginContext.caller.contextId` (`src/runtime/context-id.ts`) promises a
plugin that the id changes when the model's context is rebuilt. It does not
read the context to find out. It reads the entry each engine rebuilds the
context from, so it rests on how each engine does that. Each point below is
pinned in `test/caller-context.ts`:

- **pi-agent-core 0.85 starts a session's context at its newest `compaction`
  entry on the path** (`buildContextEntries`, `dist/harness/session/context.js`).
  An entry before it contributes nothing, and an entry after it is not a
  boundary. The id hashes the newest `compaction`, `branch_summary` or
  `pi.reset` entry, which it finds through the partial index `<entries>_boundary`.
- **pi-durable 1.0.0 starts a conversation's context at its newest head marker**
  (`captureContextBounds` → `findLatestHeadMarker`, `dist/harness/context.js`),
  and both a compaction and a reset write one (`head` set). The id hashes
  `MAX(id)` of entries with `head IS NOT NULL`.
- **pi-durable applies context edits with no head marker.** An entry's
  `edits` (`omit` / `replace`, `deriveContext`) can take an earlier read out
  of the model's context while the newest head marker stays where it was, so
  the id would not change. Nothing in `src/` or `cf/src/` writes an edit, and a
  test fails if anything starts to. Whoever starts writing edits has to make
  the id change with them: one way is to add the editing entry to what the id
  hashes.
- **pi085's `navigateTree`** moves the tip back without writing a boundary.
  Its one caller, `resumeClientCalls` (`src/runtime/client-calls.ts`), carries
  every result of the paused message onto the new branch, so no read leaves
  the context. A new caller that rewinds past a read has to write a boundary.

#### What the unknown-tool explanation rests on

A call to a tool the model was not offered is answered by pi itself, before any
hook of ours, with a fixed line. The runtime replaces that line with why
(`explainUnavailableTool`, `src/runtime/unavailable-tool.ts`: a name the plugin
retired, a name the mount's tool list left out, no such tool) in each request as
it goes out; the transcript keeps pi's result as pi wrote it. Recognising pi's
result means keying on its text, which no type carries. Each point is pinned in
`test/unavailable-tool.ts`, which drives the real engine with an unknown name
and fails if the recogniser no longer matches what pi wrote:

- **pi-agent-core 0.85.1** answers with an error result whose only content is
  `Tool "<name>" is unavailable` (`JSON.stringify` of the call's name), no
  `details` (`prepareToolCall`, `dist/harness/execution/tools.js`). It is
  recognised by that exact text for the result's own `toolName`, `isError`, no
  `details`, and a name that is not among the harness's tools: pi takes that
  path only for a name it does not have, and a tool that does not exist cannot
  have answered. One case the shape cannot tell apart: a tool that existed when
  called, answered with exactly that text, and has since left the catalogue;
  its old result is explained as a missing tool, which is then true. The
  rewrite is the `transform_context` hook (`PiAgent.open`), whose result is
  used for that request only.
- **pi-durable 1.0.0** answers with `harnessError("tool_unavailable", "Tool
  <name> is not available")`, rendered into the content as
  `<harness>\n[error] Tool <name> is not available\n</harness>`, from two
  places: the round (`startToolRound`, `dist/harness/generation.js`) for a call
  the request did not offer, and the tool task (`dist/harness/tool.js`, the
  `call` phase) for a tool that is gone when the task runs. Besides the text,
  the entry must carry exactly that one `tool_unavailable` diagnostic
  (`isPdUnavailableEntry`, read from the entries table by
  `PdHost.#unavailableResults`): our tools record no diagnostic, so a real
  tool's identical text is never taken for it, even once the tool is gone. The
  rewrite is the generation's `beforeRequest` hook, on the session's tools
  extension (`toolsExtension`, `src/runtime/durable-tools.ts`); pi-durable uses
  its result for that request only.

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
| `src/vendor/pi/pi-durable/dist/harness/scheduler.js` | `@earendil-works/pi-durable/dist/harness/scheduler.js` | pi-durable 1.0.0 (npm) | `#sleep` records its wake time and calls a new `onSleep` option; `inspect()` reports a sleeping task as `{ kind: "running", sleepingUntil }`. Without it a host cannot tell "only sleeping" from "working", and `settle` (src/runtime/durable-drive.ts) inferred it from checkpoint phases. A new `wake(taskIds)` ends the tasks' sleeps now (or their next one), through a resolver `delay` hands out beside its abort: without it a delivered answer waited for the checkpoint's `pollAt` | [pi#10325](https://github.com/earendil-works/pi/issues/10325) |
| `src/vendor/pi/pi-durable/dist/harness/harness.js` | `@earendil-works/pi-durable/dist/harness/harness.js` | pi-durable 1.0.0 (npm) | passes `HarnessOptions.onSleep` to the scheduler, adds `Harness.wake` (the scheduler's), and imports the vendored scheduler: the package's harness imports its own. Imports the vendored compaction and registry too, and `open` refuses a registry whose built-in task of a name is not the vendored one (the package's `createRegistry` makes one) | [pi#10325](https://github.com/earendil-works/pi/issues/10325); compaction: none yet |
| `src/vendor/pi/pi-durable/dist/harness/compaction.js` | `@earendil-works/pi-durable/dist/harness/compaction.js` | pi-durable 1.0.0 (npm) | the summary request keeps `deferred`, and a new `poll` phase sleeps until `pollAt`, fetches the deferred response and classifies it as `summarize` did (place, retry, fail, or poll again); an abort in `poll` cancels it. Upstream strips `deferred`, so on a provider that answers only deferred its summary is "no text" and its job is never read | none yet: a draft PR asks for a deferred-capable summary with a `poll` phase |
| `src/vendor/pi/pi-durable/dist/harness/registry.js` | `@earendil-works/pi-durable/dist/harness/registry.js` | pi-durable 1.0.0 (npm) | `BUILTIN_TASKS` holds the vendored `CompactionTask`: the scheduler runs a task with the definition its registry holds by kind, and the package's registry imports its own compaction | as above |
| `src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js` | `@earendil-works/pi-durable/dist/storage/sqlite/storage.js` | pi-durable 1.0.0 (npm) | `commit` (and `document`'s read) run in the facade's `transactionSync` with every statement synchronous, instead of an async `transaction` that awaits between statements: on a Durable Object that one is a savepoint any `sql.exec` issued meanwhile joins, and rolls back with. Same statements, order and errors. `open` also takes `{ onCommit }`, which `commit` calls inside that transaction before applying the batch, so our usage, trace and job rows commit or roll back with pi-durable's state (`src/runtime/pd-outbox.ts`) | none yet: a draft asks for an optional synchronous transaction on `SqliteDatabase` |
| `src/vendor/pi/pi-durable/dist/storage/sqlite/migrations.js` | `@earendil-works/pi-durable/dist/storage/sqlite/migrations.js` | pi-durable 1.0.0 (npm) | `applySqliteMigrations` runs in `transactionSync` too, so no pi-durable transaction spans an await; the schema is the package's (`test/pi-vendor.ts` compares them) | as above |

How the vendored files are used: they are `dist` files, copied, and their
relative imports of unchanged modules point into the installed package
(`../../../../../../node_modules/@earendil-works/pi-durable/dist/…`), so they
share every other module — and its identity — with the package. The vendored
`compaction.js` imports pi-ai's utilities from pi-durable's own nested copy
(`node_modules/@earendil-works/pi-durable/node_modules/@earendil-works/pi-ai/dist/utils/`),
the copy the package's files import: the bare name would resolve the top-level
0.85.1. Our code
imports `Harness` from the vendored `harness.js` (types in its `harness.d.ts`),
`createRegistry` from the vendored `registry.js` (types in its `registry.d.ts`)
and `SqliteStorage` from the vendored `storage.js` (types, and the
`SqliteSyncDatabase` it needs, in its `storage.d.ts`);
nothing is redirected and `node_modules` is untouched, so node, the
conformance worker and the deployed bundle run the same files with no loader
or alias to forget. `test/pi-vendor.ts` fails when the installed package
version or an upstream file's sha256 moves from the base in a vendored file's
header, when a vendored file imports the package's copy of another vendored
file, and when anything outside `src/vendor` imports the package's own
`Harness`, `createRegistry`, `CompactionTask`, `SqliteStorage` or
`applySqliteMigrations`, which would run without the patch. `test/pd-compaction.ts`
and `npm run pd-compaction:do` cover the compaction patch on the `pd` engine:
a manual and a threshold compaction, a cancel and two crashes.

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
   contract above; bump `pi-ai-1` together with pi-durable's pi-ai. Then
   `npm run pd-tools` and `npm run pd-tools:do`: the tool contracts above, and
   the same model against both engines.
4. `npm run pi-loop`, `pi-offload`, `pi-tools`, `pi-agent`, `pi-bridge` — the
   behavioural contracts and every divergence above.
5. Re-diff the copied source in the table in §2, and re-take each vendored file
   in *Changing upstream files* from the new version and re-apply its marked
   change (`test/pi-vendor.ts` fails until its header's base sha256 matches).
6. The remaining suites.
7. **SWE-bench before deploying.** Every contract above can hold while the agent
   simply gets worse, and nothing in §1–3 would notice.

## Credit

`NOTICE` records copied source; the README's *What was taken from elsewhere*
records design borrowings. Keep them apart and keep them true — a wrong credit
is as bad as a missing one.
