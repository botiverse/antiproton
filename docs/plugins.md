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

**Say which identity a call was made with.** `ctx.credential` being null has
several causes, and different people fix them: the mount names no credential,
so its owner attaches an account; it names `agent:<name>` and that row is gone,
so whoever holds that credential writes it again; it names `operator:` or
`env:` and this deployment does not hold it, so whoever deploys configures it.
They arrive as the same null, so a plugin that writes "this mount has no
account" into a failure states a guess as a fact, and the advice that follows
the guess sends the wrong person. Read `credentialState(ctx)`, which is
`credential` together with `credentialRefKind`, and put `identityNote(ctx)` in
the message: one wording per state, each ending in the action it implies, and
`unreported` (a caller that did not say) names the possibilities rather than
picking one. The kind is *whose* credential, never which one and never its
value — a reference has structure, and `src/store/refs.ts` exists because raw
references named the bucket, the tenant and the agent in every result that
carried one.

Put it on the error as a field as well, with `markIdentity(error, ctx)`
(`ToolErrorFields`). The sentence is for a person; the console renders stored
events and badges them, and a badge matched out of prose breaks silently the
next time the prose changes. Data beside the message, wording in it.

Say it when a credential *did* arrive, too. A failure that does not record the
identity behind it can only be attributed later by reading the source of the
build that produced the message — which in the reading that prompted this meant
three builds, because the sentence a conclusion rested on did not exist yet on
the day of the call.

**Keep per-mount state in `ctx.connection`.** It belongs to one mount, survives
across calls and runs, and is never shown to the model. Two mounts of the same
plugin never share it.

**The version is a pin.** Mounts record the registry's `version`, and the
gateway refuses a call when a mount's pin and the registry disagree. Only raise
the version, never lower it. Removing a plugin id makes every existing mount of
it refuse every call (`test/mount-pin.ts`).

**Declare `holds` if the plugin reserves something billed** — a container, a
session, a seat, a lease. It is one group, because the four parts are one
decision:

```ts
holds: {
  tools: { release: "release", postpone: "quiet" },
  activity(ctx),        // what is alive right now
  usage?(ctx),          // what it has cost, as far as this mount can say
  release(ctx),         // let go of it
}
```

`activity` must not need the credential and must not call anything remote: it
is asked on a timer, and often when the credential has been removed. Read
`ctx.connection` and answer. `release` must be safe to call twice, it releases
everything the mount holds *for the agent* rather than what one conversation
used, and it throws when it could not let go of something still being billed.

`tools` names the plugin's own tools for the two things the framework has to be
able to tell an agent to do. `release` is required; `postpone` is for a
resource with a lease. **Give the key, not a sentence.** The framework resolves
each name against what the model was actually offered, because qualification
sanitises the alias and breaks ties at the length cap — a name rebuilt as
`<alias>__release` resolves, and on a collision it is another mount's tool.

**The framework does the reminding, and the plugin does not.** From `holds`
alone it writes three sentences: what the agent is already holding when a
session opens, a line after each of that mount's results, and a warning shortly
before an idle resource is taken. So do not put any of that in a tool result.
What *is* the plugin's — how to release it, what survives a release, the lease's
own terms — belongs in its tool descriptions, where the model reads it every
turn instead of on one result (`src/runtime/held.ts`, `test/held.ts`).

**Serialisation follows from `holds`; there is no separate flag.** A plugin
that holds something has its calls serialised for the whole turn, not only its
own mount's. This used to be a member named `exclusive` that a plugin set
itself, and it could disagree with `holds` — one of the two was then wrong with
nothing saying which. `isExclusive` derives it, so the two cannot part.

**Whether new agents get the plugin is not the plugin's to say.** There is no
field for it. The deployment catalogue, `AgentRuntime.DEFAULT_MOUNTS` in
`cf/src/runtime.ts`, is the only source: a plugin listed there is seeded for
every agent, and one that is not has to be switched on and mounted. To change
the default, change the catalogue — an agent's own answer still overrides it
either way (`pluginEnabled`).

**Declare `provides` for what the plugin can give a session.** Today the one
value is `"container"`. The agents API picks a plugin to seed by asking what
each one offers rather than by looking for the id `sandbox`, so a second
plugin that can run a container is chosen without the kernel learning its
name.

**Reading a plugin's name is not always wrong; here is the test.** Naming a
plugin is exactly what the deployment catalogue and a test fixture do, and they
are right to: they are saying *which one to mount*. It becomes a defect when the
code is *picking* one out of a set a third party can join. The question that
separates them: **if someone adds a second plugin that does this same thing
tomorrow, does this line pick the wrong one?**

The console's container panel filtered mounts by `m.plugin === "sandbox"`, over
the agent's whole mount list — which anyone's plugin can enter — so the second
container-providing plugin would have silently vanished from the panel. It asks
`provides` now (#501). `AgentRuntime.DEFAULT_MOUNTS` names `sandbox` and is
right to, because a catalogue's whole job is to say which one. A bench harness
that mounts a plugin and then meters that same alias is naming its own fixture:
nothing can enter a set of one it built itself a few lines earlier in the same
harness (`benchSweStart` mounts it, `benchSweStats` meters it).

Note what the test is *not*: "is this in the kernel". `cf/src/` is production
code too, and the bench line is fine there for a reason that has nothing to do
with where it lives.

**Declare `reads: "parked-result"` on a tool that can read a parked result
back.** A result too large for the conversation is stored and replaced with a
reference, and the runtime finds the tool that opens one by this declaration —
not by the plugin id plus a tool name. Without it, a large result is truncated
instead of parked, and nothing says why.

**Work that outlives one call is backgrounded.** Return
`backgrounded(handle, note)` from `invoke`, and declare `background: { poll,
cancel }`. The handle is stored as given, so it must never carry a credential.
`poll` runs with the same context as the call. When `cancel` returns, the work
must actually have stopped; if the plugin cannot confirm that, it throws.
Swallowing that failure reports a cancellation that did not happen.

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
the paragraph stable — and in particular **write instants, not durations**. "in
use since 12:03" does not move when the reader does; "idle for 7 minutes" is
different on every rebuild, and the prompt is rebuilt on every `open`. Anything
that has to count is a message, not a paragraph
(`test/prompt-contributions.ts`).

**The operator in the console** sees three things:

- `holds.activity(ctx)` returns a `MountActivity`: what the mount is keeping alive
  right now (`live`), how it is billed (`billing`, as a sentence) and how many
  entries of its own record it could not read (`unreadable`). The console
  panel, the idle sweep and mount renaming all read it. It must not need the
  credential and must not call anything remote: it is asked on a timer, and
  often when the credential has been removed. Read `ctx.connection` and answer.
  `unreadable` means "I could not read this", not "there is nothing". A record
  read leniently must still count what it skipped, or a broken record looks
  like an idle mount.
- `holds.usage(ctx)` returns the finished stretches (`MountUsage`), newest first,
  for the console's history. It may keep a rolling window. Anything that must
  be complete has to be recorded where it happens, not here.
- `checkCredential(ctx)` returns `account`, a name a person recognises (a
  login, a project), so the console shows which account is attached rather
  than the last characters of a key.

A plugin that keeps nothing alive declares no `holds` at all, and is never
asked: not holding anything is the whole of what it has to say. A plugin that
holds things but has nothing alive at this moment answers `{ live: null }`.

**The audit record** is written by the gateway, not the plugin. A call that
resolves to a mount and tool is recorded as an operation (agent, mount, tool,
version) before the policy is applied; a call held for approval is recorded
as waiting, and a call that runs has its outcome written when it ends. The
plugin writes nothing there, so work done by any route other than the
plugin's own hooks (`invoke`, `background.poll`/`background.cancel`,
`holds.release`) is work the record cannot show.

## Events a service pushes

A plugin can let an outside service wake the agent, so the agent never has to
poll. Everything else in the plugin contract starts with the agent: a tool
call, or work a tool call started. A pushed event is the one way in from
outside, so the plugin acts as a gate, not a pipe.

### What a plugin implements

Two parts, both in the plugin:

1. **Tools that record what the agent wants to hear about**, kept in
   `ctx.connection`. They are writes, so a mount's policy can hold them.
2. **`receive(event, secret, ctx)`**, which the runtime calls for each request
   the service sends. It gets the raw body bytes, lowercase header names and
   the hook's secret, and answers either `{ deliver: true, text }` or
   `{ deliver: false, reason }`.

A service that reports status changes and signs its requests with an HMAC is
enough to show both:

```ts
import type { Json } from "../core/types.ts";
import type { Plugin } from "./types.ts";

async function signedBy(body: Uint8Array, header: string | undefined, secret: string) {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "")?.[1];
  if (!hex || !secret) return false;
  const sig = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, body); // constant-time
}

export const statusPlugin: Plugin = {
  id: "status",
  version: "1.0.0",
  tools: [{
    name: "watch",
    summary: "Be told when a component's status changes. Changes arrive as messages.",
    parameters: {
      type: "object",
      properties: { component: { type: "string" } },
      required: ["component"],
    },
    sideEffects: "write",
    idempotency: "native",
  }],

  async invoke(tool, args, ctx): Promise<Json> {
    if (tool !== "watch") throw new Error(`unknown tool: ${tool}`);
    const component = String((args as { component?: unknown })?.component ?? "");
    if (!component) throw new Error("component is required");
    const watched = ((await ctx.connection.get()) as string[] | null) ?? [];
    if (!watched.includes(component)) await ctx.connection.set([...watched, component]);
    return { watching: component };
  },

  async receive(event, secret, ctx) {
    if (!(await signedBy(event.body, event.headers["x-signature"], secret))) {
      return { deliver: false, rejected: true, reason: "missing or wrong signature" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(event.body));
    } catch {
      parsed = undefined;
    }
    // `null`, `5` and `[]` are valid JSON too; reading a field of them would
    // throw, and a throw is recorded as the runtime failing (503), not as a
    // bad request (401).
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { deliver: false, rejected: true, reason: "the body is not a JSON object" };
    }
    const p = parsed as { id?: string; component?: string; status?: string };
    const watched = ((await ctx.connection.get()) as string[] | null) ?? [];
    if (!p.component || !watched.includes(p.component)) {
      return { deliver: false, reason: `${p.component}: not watched` };
    }
    const status = String(p.status ?? "unknown").replace(/\s+/g, " ").slice(0, 40);
    return {
      deliver: true,
      text: `Status page: ${p.component} is now ${status}`,
      ...(p.id ? { dedupeKey: p.id } : {}),
    };
  },
};
```

This plugin is not in the deployment catalogue, so it has to be switched on
and mounted before it does anything; until it is, every event is ignored at the
mount check below, with the reason "switched off".

Nothing the agent does can change a component's status, so this plugin needs
no check for events the agent caused itself. A service the agent can write to
does need one; see the GitHub example below.

### How an event travels

1. **A hook is made for the mount.** An operator can do it: until the console
   has a page for this, that is `POST /admin/hooks` with the automation token.
   The plugin can also do it itself, with `ctx.inbound` (below). Either way the
   answer is a URL (`/hooks/<id>`, a random id) and a secret. The secret is
   shown once and kept sealed in the agent's own store.
2. **Both are given to the service**, in whatever place the service takes a
   webhook URL and signing secret. An operator pastes them in; a plugin sends
   them to the service's own API with the mount's credential.
3. **The service posts to the URL.** The runtime looks up the agent, and an
   unknown or revoked hook gets the same 404. The body may be at most 1 MB.
4. **The mount is checked the way a tool call is.** It must exist, its plugin
   must implement `receive`, the plugin must be switched on for this agent,
   and the mount's version must match. If any check fails, the event is
   ignored and `receive` is not called. The mount's policy does not apply:
   the switch is the control for pushed events.
5. **The runtime calls `receive`.**
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

### Hooks the plugin makes itself

Where a service has an API for registering a webhook, the plugin can set the
whole thing up with the mount's own credential, and nobody has to paste a URL
anywhere. `ctx.inbound` is that door. It is there only for a plugin that
implements `receive`, on a deployment that publishes a hook origin, so a plugin
checks for it rather than assuming it. Its being there is not a promise that
`create()` will work: a deployment that publishes an origin but keeps no key
for sealing secrets refuses every `create()`, and so does the mount check
below. Report what the call said rather than deciding in advance:

- `create()` returns `{ hookId, url, secret }`. The secret is generated by the
  runtime, sealed in the agent's store, and handed back this once. It is
  refused while the mount cannot take events — the same checks as step 4
  above — and past `INBOUND_HOOKS_PER_MOUNT` live hooks on one mount. That
  count is read and then acted on, so two calls at once can both pass it: it
  bounds a leak at a few addresses rather than being an exact limit.
- `revoke(hookId)` takes one of *this mount's* hooks away, secret included,
  and answers whether it was live. Another mount's hook is never touched.

The rules that go with them:

- **The secret and the URL never go into a tool result or an error.** What
  `invoke` returns is written into the conversation. The secret goes to the
  service and nowhere else, `ctx.connection` included.
- **Keep the live `hookId` in `ctx.connection`.** Every `create()` is another
  address that stays valid until something revokes it, and the plugin is the
  only thing that knows the id. An id that is not written down is an address
  nobody can ever take away — so never drop one to keep a list short.
- **Rotate new-then-old, and clear out failed attempts first.** Replacing a
  hook goes: `create()`, register the new one with the service, write the new
  id down, then revoke the old one. Two hooks are live in the middle of that,
  which is what the room under `INBOUND_HOOKS_PER_MOUNT` is for — revoking
  the live hook before creating its replacement would instead open a window
  where events go nowhere. What must be cleaned up before creating anything
  is what *failed* attempts left behind: a tool that only ever adds one
  reaches the limit after a few failures, and then cannot enable push at all,
  which is exactly when someone is retrying it.
- **If registering with the service definitely fails, revoke the new hook.**
  If it may have landed, keep the new id and revoke the old one later: the
  service may already be posting to it.
- **A tool that calls `create()` is not natively idempotent.** A replay makes
  another hook, so declare it `idempotency: "none"` or key it yourself.
- **Turning push off must not depend on the service.** Revoking the mount's
  own hooks is what stops the wakes: a later event finds no hook and gets a
  404. So revoke them and record push as off even when the service's
  deregistration call fails, and say in the result whether the far end
  confirmed.

The `raft` plugin's `enable_push` is this, and it is the one to read in
full. In outline, with its helpers left out:

```ts
async function enablePush(ctx: PluginContext): Promise<Json> {
  if (!ctx.inbound) throw new Error("this deployment cannot take pushed events");
  const state = await pushState(ctx);

  // What earlier failures left behind goes first; the live hook is replaced
  // new-then-old, further down.
  const superseded = await revokeAll(ctx, state.superseded);
  if (superseded.length > 0) {
    await ctx.connection.set({ ...state, superseded });
    throw new Error("an earlier endpoint could not be revoked; try enable_push again");
  }

  const hook = await ctx.inbound.create();
  try {
    await registerWithService(ctx, hook.url, hook.secret);
  } catch (e) {
    if (!mayHaveLanded(e)) {
      await revokeAll(ctx, [hook.hookId]);   // it definitely failed: leave no address behind
      throw e;
    }
    // It may have landed, so the service may already be posting to the new
    // hook. Keep it, and keep the old id to revoke on the next attempt.
    await ctx.connection.set({ hookId: hook.hookId, superseded: ids(state) });
    throw e;
  }
  // Written down before the old ones are revoked; then whatever would not
  // revoke stays on the list for the next call.
  await ctx.connection.set({ hookId: hook.hookId, superseded: ids(state) });
  await ctx.connection.set({ hookId: hook.hookId, superseded: await revokeAll(ctx, ids(state)) });
  return { push: "enabled" };  // never the URL, and never the secret
}
```

One thing to know before you rely on this: **a hook belongs to the alias, and
renaming the mount does not move it.** What that leaves behind is quiet in the
direction that keeps traffic flowing:

- the old hook still answers every push with 202, because a failed mount check
  is an `ignored`, so the service sees success and carries on sending. Only the
  agent's own event record says the events went nowhere;
- the plugin cannot clear it up: `revoke` compares the alias and refuses one
  that no longer matches, so it takes an operator and `POST /admin/hooks`;
- it is dormant rather than dead. The secret is kept under the hook's id, not
  the alias, so renaming the mount back makes the old hook deliver again.

### Outcomes

Every event leaves a row in the agent's event record (kept 7 days) with its
outcome and reason. The service only sees the status code:

| Outcome | Status | When |
|---|---|---|
| delivered | 202 | posted to the agent |
| ignored | 202 | `deliver: false` without `rejected`, or the mount check failed |
| duplicate | 202 | same `dedupeKey` delivered in the last 24 hours |
| rejected | 401 | `deliver: false, rejected: true` |
| too_large | 413 | body over 1 MB |
| rate_limited | 429 | over 30 deliveries a minute for this hook |
| failed | 503 | `receive` threw, or the hook has no secret |

When an expected event never arrived, read the record with
`GET /admin/hooks?tenantId=…&agentId=…`, which lists the agent's hooks and
its recent events. `POST /admin/hooks` with `{ "revoke": "<hookId>" }`
revokes a hook.

### What `receive` must do

- **Check the signature before anything else**, with the `secret` argument
  (not `ctx.credential`), and refuse anything unsigned. Answer a bad request
  with `rejected: true`, so the service's own delivery log shows the failure
  to the person setting it up. Services sign differently, which is why this is
  the plugin's job. Every other answer comes after that check, a ping or an
  event the plugin does not handle included: anything but `rejected` tells
  the service its request was accepted.
- **Write nothing before refusing.** A request that ends in `rejected` must
  leave `ctx.connection` as it was: a stranger's request must not change what
  the mount remembers.
- **Deliver only what the mount subscribed to**, as the plugin's own tools
  recorded it in `ctx.connection`.
- **Drop what the mount's own account caused**, whenever the agent can act on
  the service. Otherwise the agent is woken by its own reply and answers it.
- **Write the text itself:** one line saying what happened, kept on one line
  whatever the service put in its fields, then at most a short quote with
  every line marked as quoted. Never pass the payload through: whoever
  triggered the event wrote it.
- **Return a `dedupeKey`** when the service marks redeliveries.
- **Make no network calls.** Services wait only a few seconds for an answer
  (ten for GitHub).

The runtime side is held by `test/inbound.ts` and `test/inbound-gateway.ts`.

### Example: GitHub

The `github` plugin is the one that ships. `issue_subscribe(repo, number?)`
subscribes to one issue or pull request (they share numbers), or to a whole
repository; `issue_unsubscribe` and `issue_subscriptions` go with it. Its
`receive` delivers:

| GitHub event | Actions |
|---|---|
| `issues` | opened, edited, closed, reopened, deleted, transferred |
| `issue_comment` | created, edited, deleted (this includes comments on a pull request's conversation) |
| `pull_request` | opened, edited, closed or merged, reopened, ready for review, new commits |
| `pull_request_review` | submitted, dismissed |
| `pull_request_review_comment` | created, edited, deleted |

What is specific to GitHub:

- **Setup:** in the repository's Settings, then Webhooks, paste the hook's
  URL and secret, choose content type `application/json`, and pick the five
  events above. Creating a webhook needs admin rights on the repository.
- **Signature:** `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body. A
  webhook saved without a secret sends no signature, and every delivery is
  refused.
- **Duplicates:** `X-GitHub-Delivery` is the `dedupeKey`; a redelivery keeps
  it.
- **The agent's own activity:** subscribing records the login of the mount's
  account, and events sent by that login are dropped. If a credential is
  attached after subscribing, nothing is delivered until the agent subscribes
  again.

`test/github-inbound.ts` holds these rules.

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
- `holds.activity` on a missing record, on a well-formed one, and on a corrupt
  one.

Before trusting a new case, break the code it guards and watch the suite report
one failure; then restore it. A case that cannot go red guards nothing.

**And never name a fixture after the thing under test.** A case for "the panel
picks the container mount by what it provides" is green before *and* after the
fix if its fixture mounts the `sandbox` plugin — because only the sandbox
declares `provides` today, so asking the name and asking the capability return
the same answer. The case that can go red mounts a container-providing plugin
called something else, next to a plugin called `sandbox` that declares nothing.
The same trap makes a guard over the real registry useless whenever every value
it distinguishes comes from a single plugin (`test/mount-config.ts`). Run
`npm run typecheck` too: it must print `0 new` and exit 0.

## Where things are

| What | Where |
|---|---|
| The contract | `src/plugins/types.ts` |
| The contract as one page | `node scripts/plugin-map.ts` |
| Registration | `cf/src/runtime.ts`, `AgentRuntime` constructor |
| Which plugins new agents get | `cf/src/runtime.ts`, `AgentRuntime.DEFAULT_MOUNTS` |
| Settings validation | `src/runtime/mount-config.ts` |
| Policy, credentials, pins, operations | `src/runtime/gateway.ts` |
| Model-facing tool names | `src/runtime/pi-tools.ts` (`offeredToolName`) |
| What an agent is holding, and the three sentences saying so | `src/runtime/held.ts`, `test/held.ts` |
| When an idle resource is taken, and the warning | `src/runtime/idle-lease.ts`, `test/idle-lease.ts` |
| Examples | `src/plugins/demo.ts`, `http.ts`, `github.ts` |
| Settings and activity tests | `test/mount-config.ts` |
| Version and plugin-id refusals | `test/mount-pin.ts` |
| Pushed events: limits and statuses | `src/runtime/inbound.ts` |
| Pushed events: route and admin calls | `cf/src/index.ts` |
| Pushed events: mount check, delivery, record | `cf/src/runtime.ts` (`receiveHook`), `src/runtime/gateway.ts` |
