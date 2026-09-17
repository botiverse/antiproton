# Writing a plugin

A plugin is the only way an agent reaches anything outside its own object. It
declares tools; an operator mounts it for an agent under an alias, with
settings, a credential reference and a policy; every call then goes through the
tool gateway (`src/runtime/gateway.ts`), which applies the policy, resolves the
credential server-side, pins the plugin version and records the operation.
The plugin never decides whether it may run, and the model never sees a
credential.

This page is the how-to. The contract itself is `src/plugins/types.ts`, and
each member's explanation lives in the JSDoc above it. This page does not
repeat those explanations, because a copy of an interface drifts from it. To
read the whole contract as one page, generate it from the source:

    node scripts/plugin-map.ts > plugin-contract.html

## Contributing a plugin

Plugins are part of this repository and are built into the deployment. There
is no way yet to install a plugin into a running deployment, so a plugin for a
service is contributed as a pull request that adds:

- the plugin, as a file under `src/plugins/`;
- its tests, under `test/`;
- one line registering it in `cf/src/runtime.ts` (see below).

Pull requests adding plugins are open to anyone (see `AGENTS.md`). A plugin
for a well-known service (an issue tracker, a calendar, a store) is the
expected kind of contribution. Other changes under `cf/` need an issue first;
the one line that registers a new plugin is exempt.

## The smallest plugin

```ts
import type { Json } from "../core/types.ts";
import type { Plugin } from "./types.ts";

export const notesPlugin: Plugin = {
  id: "notes",
  version: "1.0.0",
  tools: [
    {
      name: "read_note",
      summary: "Read the note saved on this mount, or null if there is none.",
      parameters: { type: "object", properties: {} },
      sideEffects: "read",
      idempotency: "native",
    },
    {
      name: "write_note",
      summary: "Replace the note saved on this mount.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      sideEffects: "write",
      idempotency: "native",
    },
  ],
  config: [
    { name: "maxChars", type: "number", default: 2000,
      summary: "Longest note this mount will keep." },
  ],

  async invoke(tool, args, ctx): Promise<Json> {
    const max = (ctx.publicConfig.maxChars as number | undefined) ?? 2000;
    if (tool === "read_note") return { note: await ctx.connection.get() };
    if (tool === "write_note") {
      const text = String((args as { text?: unknown })?.text ?? "");
      if (text.length > max) {
        throw new Error(`note has ${text.length} characters; the limit is ${max}`);
      }
      await ctx.connection.set(text);
      return { saved: text.length };
    }
    throw new Error(`unknown tool: ${tool}`);
  },
};
```

`src/plugins/demo.ts` is the same size and is what production runs.
Once a plugin talks to a real service, copy from `http.ts` (network access,
settings, no credential) and `github.ts` (an optional token, a credential
check, retryable errors).

To ship it, add it to the list in `AgentRuntime`'s constructor
(`cf/src/runtime.ts`) **after the last plugin already there** and before
`builtinToolsPlugin`. The order is not cosmetic: prompt contributions are
appended in registry order, and the provider caches the prompt prefix, so a
plugin inserted in the middle changes every byte after it for every agent.

Then mount it for an agent from the console's Plugins page.

## Conventions

Each of these exists because breaking it has already cost something. The
reason is in the JSDoc of the member it concerns.

**Tool names are permanent.** The model sees `<alias>__<tool>`
(`qualifyMountedTools` in `src/runtime/pi-tools.ts`), and a session remembers
the names it was opened with. Renaming a tool, or changing how names are
formed, makes every session opened before the change fail at admission. A
rename is a migration, not a relabel.

**Do not write the alias into text.** The operator picks the alias. When an
error or a prompt paragraph has to name one of the plugin's tools, build the
name from `ctx.alias`, not from the plugin id.

**Declare side effects truthfully.** `sideEffects` decides which half of the
mount's policy (`read` or `write`) applies to a tool that has no policy of its
own. A write declared as a read escapes an operator's "writes need approval".
It also decides replay: a read may be repeated after an interruption, and a
write is repeated only when its `idempotency` is `native` (`replayPolicy` in
`src/runtime/pi-tools.ts`). Declare `native` only when calling the tool twice
really leaves the same result as calling it once.

**Errors are for the model.** Throw an `Error` whose message says what went
wrong and what to do instead; the gateway returns it as a `tool_error`. When a
request may have reached the service before failing (a timeout, a 5xx), set
`retryable = true` on the error, so the operation is recorded as `unknown`
rather than `failed`. `github.ts` shows the pattern.

**Declare every setting.** A mount whose settings contain a key the plugin does
not declare is refused when the mount is written (`validateMount` in
`src/runtime/mount-config.ts`). This catches a typo such as `timeout_ms` for
`timeoutMs` while a person is there to read the message. Settings are flat:
`string`, `number`, `boolean` or `string[]`. Settings are public (they appear
in the console and in `tools.mounts`), so a credential never goes in one. A
setting whose name sounds like a credential must carry
`references: "credential"`; the check for that runs over the `everyPlugin`
list in `test/mount-config.ts`, so it only covers a plugin that list names.

**Declare the credential; never pass it on.** If the plugin uses a credential,
declare it in `credential` (`CredentialSpec`). The console builds its form from
that declaration, and a mount that needs an account but has none is refused
when it is written. Implement `checkCredential` if the service can say whose
key it is, and keep its two failures distinct: `rejected` (the service said no)
and `unreachable` (no answer). The credential arrives as `ctx.credential`. It
must not appear in a result, an error message, a background handle, a prompt
contribution or a log line. If the credential can be sent to a host the agent
chooses, the plugin must bound that host with a setting. `http` declares no
credential today, but its `allowedHosts` setting is already marked
`requiredWithCredential` for the day it does.

**Keep per-mount state in `ctx.connection`.** It belongs to one mount, survives
across calls and runs, and is never shown to the model. Two mounts of the same
plugin never share it.

**Use `exclusive` only when overlapping calls break something.** It stops
every tool call in the turn from running in parallel, not only this mount's.

**`defaultForAllAgents` stays off** unless every new agent should have the
plugin. A plugin nobody asked for costs context on every turn.

**The version is a pin.** Mounts record the registry's `version`, and the
gateway refuses a call when a mount's pin and the registry disagree. Only raise
the version, never lower it. Removing a plugin id makes every existing mount of
it refuse every call (`test/mount-pin.ts`).

**Work that outlives one call is backgrounded.** Return
`backgrounded(handle, note)` from `invoke`, and implement `pollBackground` and
`cancelBackground`. The handle is stored as given, so it must never carry a
credential. `pollBackground` runs with the same context as the call. When
`cancelBackground` returns, the work must actually have stopped; if the plugin
cannot confirm that, it throws. Swallowing that failure reports a cancellation
that did not happen.

**Hand back what you hold.** A plugin that reserves something billed (a
container, a session, a lease) implements `release`. It must be safe to call
twice. It releases everything the mount holds for the agent, not only what one
conversation used, because it runs only when nothing of the agent's is open.
It throws when it could not let go of something that is still being billed.

**Node runs the source as strip-only TypeScript.** Parameter properties
(`constructor(readonly x)`) and `enum` are syntax errors there.

## Showing the caller what a plugin is doing

Three readers look at a plugin's work, and each has its own hook.

**The model** sees the tool result, the error message, the background `note`
and `progress`, and `promptContribution`. A prompt contribution is a paragraph
added to the system prompt; it is asked for once per mount each time the
harness opens. Use it for something the
agent should know before its first call (the `state` plugin lists the agent's
saved notes). Return `null` when there is nothing to say. Something that
changes often costs a re-read of everything after it on the next turn, so keep
the paragraph stable.

**The operator in the console** sees three things:

- `activity(ctx)` returns a `MountActivity`: what the mount is keeping alive
  right now (`live`), how it is billed (`billing`, as a sentence) and how many
  entries of its own record it could not read (`unreadable`). The console
  panel, the idle sweep and mount renaming all read it. It must not need the
  credential and must not call anything remote: it is asked on a timer, and
  often when the credential has been removed. Read `ctx.connection` and answer.
  `unreadable` means "I could not read this", not "there is nothing". A record
  read leniently must still count what it skipped, or a broken record looks
  like an idle mount.
- `usage(ctx)` returns the finished stretches (`MountUsage`), newest first,
  for the console's history. It may keep a rolling window. Anything that must
  be complete has to be recorded where it happens, not here.
- `checkCredential(ctx)` returns `account`, a name a person recognises (a
  login, a project), so the console shows which account is attached rather
  than the last characters of a key.

A plugin that keeps nothing alive does not implement `activity`; that reads the
same as `{ live: null }`.

**The audit record** is written by the gateway, not the plugin. A call that
resolves to a mount and tool is recorded as an operation (agent, mount, tool,
version) before the policy is applied; a call held for approval is recorded
as waiting, and a call that runs has its outcome written when it ends. The
plugin writes nothing there, so work done by any route other than the
plugin's own hooks (`invoke`, the background hooks, `release`) is work the
record cannot show.

## Events a service pushes

A plugin can let a service wake the agent, without the agent polling, by
implementing `receive`. Everything else in the plugin contract starts with the
agent; this is the one way in from outside, so the plugin acts as a gate, not a
pipe.

`github` is the example. `issue_subscribe(repo, number?)` records what the
agent wants to hear about (one issue or pull request, or a whole repository),
and `receive` turns a webhook delivery into a short message. It delivers:

| GitHub event | Actions |
|---|---|
| `issues` | opened, edited, closed, reopened, deleted, transferred |
| `issue_comment` | created, edited, deleted (this includes comments on a pull request's conversation) |
| `pull_request` | opened, edited, closed or merged, reopened, ready for review, new commits |
| `pull_request_review` | submitted, dismissed |
| `pull_request_review_comment` | created, edited, deleted |

### How an event travels

1. **An operator creates a hook for a mount.** Until the console has a page
   for this, that is `POST /admin/hooks` with the automation token. The answer
   is a URL (`/hooks/<id>`, a random id) and a secret. The secret is shown once
   and kept sealed in the agent's own store.
2. **The operator gives both to the service.** For GitHub: the repository's
   Settings, then Webhooks, content type `application/json`, and the five
   events above. Creating a webhook needs admin rights on the repository.
3. **The service posts to the URL.** The runtime looks up the agent, and an
   unknown or revoked hook gets the same 404. The body may be at most 1 MB.
4. **The mount is checked the way a tool call is.** It must exist, its plugin
   must be able to receive, the plugin must be switched on for this agent, and
   the mount's version must match. If any check fails, the event is ignored
   and `receive` is not called. The mount's policy does not apply: the switch
   is the control for pushed events.
5. **The runtime calls `receive`** with the raw body bytes, lowercase header
   names and the hook's secret.
6. **The runtime acts on the answer:**
   - it drops a delivery whose `dedupeKey` it has delivered in the last
     24 hours;
   - it drops deliveries past 30 a minute per hook;
   - otherwise it posts `text` (cut at 4,000 characters) into the agent's
     conversation, labelled as written outside the conversation and not by
     the user.

   It answers the service as soon as the message is posted. The model runs
   afterwards: an idle agent starts a turn, and a busy one takes the message
   into the turn it is already running.

Every event leaves a row in the agent's event record (kept 7 days) with its
outcome and reason. The service only sees the status code. When an expected
event never arrived, read the record with
`GET /admin/hooks?tenantId=…&agentId=…`, which lists the agent's hooks and
its recent events. `POST /admin/hooks` with `{ "revoke": "<hookId>" }`
revokes a hook.


| Outcome | Status | When |
|---|---|---|
| delivered | 202 | posted to the agent |
| ignored | 202 | `deliver: false` without `rejected`, or the mount check failed |
| duplicate | 202 | same `dedupeKey` delivered in the last 24 hours |
| rejected | 401 | `deliver: false, rejected: true` |
| too_large | 413 | body over 1 MB |
| rate_limited | 429 | over 30 deliveries a minute for this hook |
| failed | 503 | `receive` threw, or the hook has no secret |

### What `receive` must do

- **Check the signature first**, with the `secret` argument (not
  `ctx.credential`), and refuse anything unsigned. Set `rejected: true` for a
  bad request, so the service's own delivery log shows the failure to the
  person setting it up.
- **Deliver only what the mount subscribed to**, as the plugin's own tools
  recorded it in `ctx.connection`.
- **Drop what the mount's own account caused.** An agent that replies on an
  issue it is subscribed to would otherwise be woken by its own reply. `github`
  records the account's login when the agent subscribes, and delivers nothing
  if a credential was attached after that.
- **Write the text itself:** one line saying what happened, on one line
  whatever the title holds, then a short quote with every line marked as
  quoted. Never pass the payload through, since anyone can comment on a public
  issue.
- **Return a `dedupeKey`** when the service marks redeliveries
  (`X-GitHub-Delivery` for GitHub).
- **Make no network calls.** The service waits only a few seconds (ten for
  GitHub).

These rules are held by `test/github-inbound.ts` for the plugin side, and by
`test/inbound.ts` and `test/inbound-gateway.ts` for the runtime.

## Tests

Every `test/*.ts` runs in the deploy gate (`cf/scripts/verify-and-deploy.sh`).
A suite is a plain Node script that prints its results and exits non-zero on a
failure; copy the `check` helper from an existing suite such as
`test/mount-config.ts`. Suites must not need the network.

A new plugin comes with cases for at least:

- an entry in `everyPlugin` in `test/mount-config.ts`. That list is written by
  hand; a plugin missing from it is skipped by the checks that run over every
  plugin, and nothing reports the omission;
- its settings, through `validateMount`: a misspelt key is refused, and a
  complete mount is accepted;
- each tool's result and each error the model can receive;
- for a structured setting, a legal value that the plugin's own code can
  actually use. Checking the declaration against the validator only compares
  the schema with itself.
- `activity` on a missing record, on a well-formed one, and on a corrupt one.

Before trusting a new case, break the code it guards and watch the suite report
one failure; then restore it. A case that cannot go red guards nothing. Run
`npm run typecheck` too: it must print `0 new` and exit 0.

## Where things are

| What | Where |
|---|---|
| The contract | `src/plugins/types.ts` |
| The contract as one page | `node scripts/plugin-map.ts` |
| Registration | `cf/src/runtime.ts`, `AgentRuntime` constructor |
| Settings validation | `src/runtime/mount-config.ts` |
| Policy, credentials, pins, operations | `src/runtime/gateway.ts` |
| Model-facing tool names | `src/runtime/pi-tools.ts` |
| Examples | `src/plugins/demo.ts`, `http.ts`, `github.ts` |
| Settings and activity tests | `test/mount-config.ts` |
| Version and plugin-id refusals | `test/mount-pin.ts` |
| Pushed events: limits and statuses | `src/runtime/inbound.ts` |
| Pushed events: route and admin calls | `cf/src/index.ts` |
| Pushed events: mount check, delivery, record | `cf/src/runtime.ts` (`receiveHook`), `src/runtime/gateway.ts` |
