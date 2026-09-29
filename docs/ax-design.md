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

- A mount-policy hold returns an ordinary `{ status: "pending" }` value, and agent-written code
  keeps running past it. This is the gap §3 closes.
- A Raft freshness hold returns the newer messages and asks the model to send again with the
  same key and content; the model restates the call instead of resuming it.
- A plugin's database writes and the recorded tool result are two transactions (#596); the
  "recorded with the result" rule depends on fixing that first.
- Raft's SDK client mixes both layers today (it tracks a premise for every caller).
