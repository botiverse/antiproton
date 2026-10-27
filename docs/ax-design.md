# Agent Experience (AX): how an official app talks to an agent

Every official app an agent uses — Raft is the most complex one, not the only one — should
expose itself in two layers, and the layer an agent is taught is designed for a reader who
thinks in turns, can be wrong about the world, and costs a model call every time it stops.
This document states the design so each app does not rediscover it.

## 1. Two clients, one foundation

| | Low level (programs, bots) | AX level (agents) |
|---|---|---|
| Premise | None declared; the service never checks freshness | Declares what the model has seen; a changed world interrupts |
| Returns | Typed data; an error is an error | Model-readable text, plus interruptions (§2); expected conditions never throw |
| State | Stateless; the caller manages anything it needs | Requires a state store (cursor, premise, continuations), because two steps of one agent may run in two processes |
| Acknowledgement | The caller decides | Only after the model has seen what is acknowledged |

- **The low level stays.** A bot posting a feed item every hour has no premise to protect, and
  must not be interrupted for one. It is a thin, typed, stable wrapper over the service's
  routes, with one calling convention (a named object per route).
- **The AX level is built only on the low level.** No private paths: anything a bot can do an
  agent can do, and the difference is only experience.
- **One surface for all agents.** An app's own agents and external agents learn the same text
  and the same interruption shape. For Raft that means the AX client and the CLI print the
  same lines; parity is then true by construction, not by alignment.
- **Agents are taught only the AX level.** A model should learn how to choose after an
  interruption, not how a route orders its parameters.

## 2. Interruptions

An interruption says: the operation did not happen, here is why, here is what changed, and
here is how to continue or give up. It protects **the premise of a decision**, not the
operation — so whether it can happen depends on whether the caller declared a premise.

```
{ state: "interrupted",
  reason: "stale_premise" | "needs_approval" | "needs_permission",
  context: "<for the model: what happened, what arrived>",
  resume: { token, expiresAt },   // continue the stored call, with the new premise
  cancel: { token } | null,       // give up, and release what was taken
  choices: "<one line: resume, cancel, or do something else>" }
```

The shape is the same whichever system raised it — the app (new messages arrived, a
permission is missing) or the agent runtime (a mount policy wants a person to approve). The
model learns it once.

The operating-system analogy holds and is worth keeping in mind:

- A **stale premise** is `futex_wait(addr, expected)` / compare-and-swap: the caller passes what
  it saw, the service compares atomically, and a change returns "try again". A caller that
  does not care passes nothing and is never refused.
- **Needs approval** is a system call interrupted by a signal: the caller declares its restart
  policy (`SA_RESTART` for programs, the interruption handed back for agents), the service
  keeps the continuation (`restart_block`), and the interruption is delivered only where
  control returns to whoever decides — for an agent, a tool result.
- Where it breaks: handling `EINTR` is nearly free; handling an interruption costs a model turn.
  So interruptions must be rare and complete — carrying enough context (like `siginfo`) to
  decide in one turn — and cancelling must release what was taken, not only drop a token.

## 3. Who does what

- **The service** decides the condition: only it knows the newest message, who may do what,
  and what a policy requires.
- **The SDK** lets the caller choose whether to declare a premise, and hands interruptions back
  **as data**: continuations are serialisable, it never retries on the model's behalf, and it
  holds no closures a later process would need.
- **The agent runtime** (antiproton) is where thinking is forced:
  - **One place.** Every tool call passes the gateway, whether the model made it or code the
    agent wrote. A plugin only reports that a call was interrupted; the gateway handles it,
    its own policy holds included.
  - **The premise is recorded with the result.** When an interruption is shown to the model,
    what the model has now seen and the continuation are recorded in the same transaction as
    the tool result, so a resume can only carry what the model actually saw.
  - **Code cannot skip it.** Inside agent-written code the interruption is neither a return
    value (it could be ignored) nor an exception (it could be caught): the executor ends the
    run, and the model receives the whole account — which calls completed (they happened and
    are not undone), which was interrupted, and that the rest did not run.
  - **Resume and cancel are the model's.** They take a token, never a restated call, and are not
    callable from code, so a decision cannot be taken programmatically.
  - **Resolution is a wake.** A person approving or clicking a card arrives as an inbound event
    carrying the token.

## 4. Where antiproton stands

Recorded so the design is not read as a description of today:

- Inside run_js, a call that comes back held (`pending`) ends the program as paused: the model
  gets the outputs so far, the call count and the held operation, and the rest does not run.
  There is no resume or cancel token for a hold yet: approval runs the held call alone, and the
  model continues with a new program.
- A plugin can put its SDK in the box (`Plugin.bridge`, #1092): a program imports it as
  `await import("sdk:<alias>")` (or `sdk:<plugin>` where that names one mount), and the SDK's
  `fetch` makes each request **one host call** of `<alias>.request` through the gateway — the same
  policy, approval, operation and trace row, host-call budget and pause on a hold as any tool call.
  No credential or network is in the box, which is the defence: only `content-type` and `accept`
  cross from it, no header that carries a credential comes back, and the mount's credential (each
  field of a stored session) and the tokens `send` names are replaced in the answer, or in the
  message of a `send` that throws, where they appear literally (values of 8 or more characters).
  - The core first refuses a path that names a host, carries a backslash, whitespace or a control
    character, or whose path part carries `;`, a percent-escape or anything outside printable
    ASCII, or has an empty, `.` or `..` segment, and
    a path past 2048 characters, a body past 1 MiB or a header value with CR or LF; it drops a
    GET's or HEAD's body.
  - The plugin's route table then classifies the request, on the path its `normalize` answers
    (without the query or a trailing slash, case-insensitively) and the body as sent. A body a row
    checks that is not a JSON object is an unlisted write.
  - A listed route is decided under its policy key and the bridge tool's own entry, the stricter
    of the two (a key only tightens, `Plugin.policyKey`); an unlisted read follows the mount's read
    policy; an unlisted write is decided under the plugin's `unlistedWriteKey`, at least `approval`
    unless the mount itself allows it; a `refuse` row ends the call rejected, approved or not.
    `confirm` adds a person and never lifts a refusal.
  - A held request ends the program as above, even when the SDK's caller catches the throw, and
    the model sends a new program after the approval; there is no resume, which waits on #596.
    Only the dynamic worker executor loads these modules; QuickJS refuses the import
    (`bridge_unavailable`).
- A program can stop itself and ask: `const answer = await pause(question, data, expected?)`.
  That pause is resumable — the result is `yielded`, with a token, and the model answers with the
  one static `resume` tool (or cancels); the program continues from that line. `expected`
  (choices, yes/no, text, or a small JSON-schema subset) is checked on the server, and an answer
  that does not fit is refused with the token still valid. The continuation lives only in the agent object's memory,
  for at most `RUN_JS_RESUME_MS` (a minute by default; the object keeps itself awake meanwhile),
  so it is not yet the serialisable continuation §3 asks for: once it expires or the object
  restarts, `resume` says so and the model sends a new program, as it did before.
- A Raft freshness hold returns the newer messages and asks the model to send again with the
  same key and content; the model restates the call instead of resuming it.
- A plugin's database writes and the recorded tool result are two transactions (#596); the
  "recorded with the result" rule depends on fixing that first.
- Raft's SDK client mixes both layers today (it tracks a premise for every caller).
