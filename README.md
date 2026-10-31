# antiproton

[![Built with Raft](https://raw.githubusercontent.com/raft-builders/awesome-raft-build/main/badge/built-with-raft.svg)](https://raft.build)

> A durable, multi-tenant serverless runtime for autonomous AI agents that interact with real-world systems.
> 
> Built on a three-tier architecture that decouples state from model waiting and execution environments: agents sleep for free, wake to think without container overhead, and mount real-world sandboxes strictly on demand.

The agent loop itself is commodity — bring your own, or use the reference harness. Antiproton provides the durable execution substrate underneath it, designed around four core architectural guarantees:

- **Structural multi-tenancy:** Distinct tenants execute in discrete Durable Objects backed by dedicated SQLite databases. Cross-tenant data is physically absent from the querying database rather than filtered by application `WHERE` clauses.
- **Serverless durability:** Runs in the cloud without long-lived background daemons, local laptop requirements, or state directories. Agents survive crashes, process evictions, and code deployments, resuming execution transparently.
- **True scale-to-zero:** Idle agents consume zero compute: no active processes, no background polling, no armed timers, and no active containers. Inactive state costs storage only; incoming requests reconstruct the agent from its event log.
- **Zero-trust credential isolation:** Agents act on external APIs and systems without credentials ever entering model context prompts, tool outputs, or execution logs.

---

## Table of Contents

- [OpenAI Agents API Guide](docs/agents-api.md)
- [Agent Usage & Workspace API](docs/agent-surface.md)
- [Plugin Authoring Guide](docs/plugins.md)
- [Philosophy & Design Principles](docs/philosophy.md)
- [Architecture](#architecture)
  - [The Problem: Why Not 'One Sandbox per Agent'?](#the-problem-why-not-one-sandbox-per-agent)
  - [The Three-Tier Runtime Model](#the-three-tier-runtime-model)
- [Getting Started](#getting-started)
- [Core Invariants](#core-invariants)
  - [Zero Cost While Idle](#zero-cost-while-idle)
  - [Context Window Bounding & Compaction](#context-window-bounding--compaction)
  - [Persistent Memory](#persistent-memory)
  - [Storage Substrate](#storage-substrate)
- [Verification & Benchmarks](#verification--benchmarks)
- [Contributing](#contributing)
- [What Was Taken From Elsewhere](#what-was-taken-from-elsewhere)
- [What Is Not Done](#what-is-not-done)

---

## Architecture

### The Problem: Why Not 'One Sandbox per Agent'?

When deploying agents to the cloud, the reflexive reaction is: *"Just spin up a dedicated container for every agent."* While familiar, that model collides with four practical engineering realities:

1. **Heterogeneous Demands:** Different tasks need radically different environments. Some need a headless browser, some need GPUs, some need heavy RAM and compilers, while others only need basic CPU. A single generic container cannot fit all of them.
2. **Wake, Think, Sleep:** Autonomous agents wake up frequently to inspect ambient events (webhooks, alerts, reminders), think for two seconds, and return to sleep. Booting and provisioning a heavy container just for two seconds of cognitive triage is structurally inefficient.
3. **The Scaling Dilemma:** Fixed, always-on containers sit idle most of the day, burning memory and compute; dynamically autoscaling pools suffer from slow cold starts, state-restoration delays, and fragile maintenance.
4. **Auto-Sleep Disruption:** If a container is automatically put to sleep whenever an agent goes idle, background tasks initiated by the agent get killed.

### The Three-Tier Runtime Model

Antiproton resolves this dilemma by separating cognitive state from execution environments across three distinct tiers:

```
┌────────────────────────────────────────────────────────┐
│  Tier 3: Real-World Sandboxes (On-Demand / Run9)       │
│  - Heavy compilation, tests, browsers, GPUs           │
│  - 30-min idle lease with 5-min warning; auto-reclaim  │
└───────────────────────────▲────────────────────────────┘
                            │ On-demand mount
┌───────────────────────────┴────────────────────────────┐
│  Tier 2: Sandbox-less Code Mode (V8 Dynamic Worker)    │
│  - Ephemeral V8 isolate with globalOutbound: null      │
│  - Orchestrates tools without container boot overhead  │
└───────────────────────────▲────────────────────────────┘
                            │ Tool calling
┌───────────────────────────┴────────────────────────────┐
│  Tier 1: Harness & Zero-Wait Durable Objects (DO)      │
│  - Instant millisecond wake; private SQLite databases  │
│  - Synchronous suspension during async model waits     │
└────────────────────────────────────────────────────────┘
```

1. **Tier 1 (Harness & Zero-Wait DOs):** Every agent is backed by a serverless Durable Object with a transactional SQLite database. It wakes in milliseconds, restores state, enqueues model calls onto background queues, and suspends synchronously (`stopReason: "deferred"`). On a real 17.4s turn, the Durable Object is active for only 3.71s (21%), consuming zero compute while awaiting model responses across the network.
2. **Tier 2 (Sandbox-less Code Mode):** For data processing, formatting, and tool orchestration, the model executes JavaScript inside an ephemeral V8 isolate (Cloudflare Dynamic Workers). It has zero direct internet access (`globalOutbound: null`), strict deterministic CPU/sub-request limits, and supports `await pause(...)` to await model feedback. It orchestrates tools without container boot overhead.
3. **Tier 3 (Real-World Sandboxes):** When a task genuinely requires `cargo build`, a Linux shell, or a browser, the agent mounts an on-demand container powered by **Run9** (PingCAP's project). Sandboxes operate on a 30-minute idle lease with a 5-minute pre-release warning, allowing agents to postpone or release immediately. A container is an on-demand tool, not an architectural cage.

---

### Implementation Details

```mermaid
flowchart TB
    client([Client]):::ext

    subgraph edge["Outside the object — where waiting is free"]
        router["Router<br/><i>addresses by (tenant, agent)</i>"]
        queue["Model queue<br/><i>owns the call while it is out:<br/>redelivers until acked, then DLQ</i>"]
        consumer["Queue consumer<br/><i>waits on the provider so<br/>the object does not</i>"]
    end

    subgraph object["Durable Object — one per (tenant, agent)"]
        direction TB
        lane["<b>Lane</b> <i>(pi's harness)</i><br/>accept = a durable write<br/>drive = one I/O pass"]
        harness["<b>Tools</b><br/>mounts + the sandbox,<br/>as functions the lane calls"]
        cmd["<b>Model jobs</b><br/><i>written before dispatched</i>"]
        store[("<b>Session</b><br/>entries · values · usage<br/>operations · quotas")]
        memory[("<b>Agent state</b><br/>memory · todo · journal<br/><i>outlives the task</i>")]
    end

    subgraph trust["Credential boundary — nothing past here reaches the model"]
        gateway["<b>Tool gateway</b><br/>mount → installation · connection<br/>secret_ref · version pin · idempotency"]
        secrets[("Secrets")]
        conn[("Per-mount<br/>session state")]
    end

    sandbox["<b>Sandbox</b><br/><i>QuickJS · Dynamic Worker</i><br/>no network, no filesystem"]
    box["<b>Container</b> <i>(a mount, not the sandbox)</i><br/>a real machine when one is needed<br/>destroyed when the agent goes idle"]
    saas([SaaS APIs]):::ext
    provider([Model provider]):::ext

    client -->|"message · steer · interrupt"| router
    router --> lane
    lane <--> store
    lane --> harness
    harness -->|commands| cmd
    cmd -->|model.request| queue
    queue --> consumer
    consumer -->|"response event"| store
    consumer --> provider
    cmd -->|tool.call| gateway
    cmd -->|js.execute| sandbox
    sandbox -->|"the only way out"| gateway
    gateway --> secrets
    gateway --> conn
    gateway --> saas
    gateway --> box
    gateway -->|"state.remember"| memory

    classDef ext fill:#eee,stroke:#999,color:#333;
    style trust fill:#fff6e5,stroke:#e0a030
    style object fill:#eef5ff,stroke:#5588cc
```

Four things the picture is meant to make obvious:

1. **The sandbox has exactly one exit.** It has no network and no filesystem;
   the only thing it can do is call the gateway, which decides what that means.
2. **Credentials sit on the far side of the gateway.** The model produces a
   mount alias and arguments. It never produces, sees, or stores a credential.
3. **The object is the tenant boundary.** Two tenants are two Durable Objects
   with two SQLite databases, so cross-tenant data is not in the database being
   queried — and the object refuses an identity that is not its own.
4. **A container is a mount, not a loophole.** Work that genuinely needs a real
   machine gets one, but it is reached the same way a SaaS API is — through the
   gateway, under the mount's policy — rather than by loosening the sandbox. It
   holds no credential of the agent's, and it is destroyed when the agent has
   nothing open, on the same agent-wide scope as above.

### Policy, and the gate

A mount carries a policy — `{read, write, tools}`, each `allow`, `deny` or
`approval`. A denied tool never reaches the plugin. A call marked `approval`
is not performed: the operation is recorded as a hold, the model is told it
is held, and its turn goes on. A person sees the request verbatim and signs
it, on the console or, for an agent Raft hosts, on a Raft action card
([`docs/raft-approvals.md`](docs/raft-approvals.md)). An approved call is then
performed exactly once, under the mount's policy as it is then: a `deny` set
since the hold wins. A hold nobody decides within the TTL (`APPROVAL_TTL_HOURS`,
24 hours by default) expires and is not performed. Whichever way it ends, the
agent is told at its next step.

**A gate binds the mount it is set on, so two mounts of one plugin are two
authorities.** That is worth stating because the default runs the other way: a
mount with no policy at all allows every tool it exposes, so an ungated mount of
the same plugin sitting beside a gated one is a door beside the gate rather than
a second opinion. Nothing stops a second alias being added — that is what mounts
are for — so the property to check is the agent's whole mount set, not the policy
on the mount you are looking at.

A plugin can name tools a person signs even then (`Plugin.defaultPolicy`):
`stamp` holds `pr_approve`, `pr_merge` and `api` for approval on a mount whose
policy does not name them, because approving or merging cannot be undone by
trying again. Only the mount's own per-tool entry lifts one; a mount-wide
`write: "allow"` does not.

`stamp`'s `api` tool (any write under `/v1/` or `/api/v3/`) is decided by the
same route table as a run_js program's `sdk:stamp` requests. A write the table
names is also decided under the tool of the same effect, the stricter of the
two: `api: "allow"` with `pr_comment: "deny"` refuses a comment through `api`.
A write it does not name, requesting changes, and cancelling auto-merge or
leaving the queue are decided under `stamp.write`, held for a person unless the
mount allows it. So `api: "allow"` alone runs only listed writes whose tools the
mount allows. What the table refuses (approving, merging, GraphQL, the
`/repositories/<id>` alias, a review write with a query, a review body with no
single string `event`, and a path with `;`, a space or control character, a character outside ASCII, or
escapes that do not decode as UTF-8) `api`
refuses too, even after a person approves the call and even with
`stamp.write: "allow"`.

The parking matters more than it sounds. Answering a held call with an error
made the agent announce it could not proceed and stop; told instead that it is
paused and a decision is coming, the same task went from a 75s failure to a
17.2s success. Two mounts of one plugin can carry different policies, which is
how two accounts of the same SaaS get different authority.

### The step

Admission and work are separate calls, and that separation is the design:

```
accept()   a pure write — the message is durable before anything is answered
drive()    one I/O pass — returns `waiting` rather than blocking
resume     the next alarm picks up whatever was left open
```

`accept` returns at once, so a person's message survives a crash that happens
before the model is even asked. `drive` never waits for a model: the provider
here answers `deferred` with a handle, the operation suspends durably, and the
object stops being active while the queue does the waiting. Nothing needs a
lease or a fencing token, because a Durable Object is single-threaded and pi's
mutation line serialises the writes — there was never a second writer for them
to protect against.

A running turn can be ended from outside: the provider's
`POST /provision/agents/{id}/stop`, the operator's `/admin/cancel-turn`, and a
delete, after which the agent's object takes no further step. The ended turn
reaches Raft as a "Bridge fatal" activity event saying who ended it
(`stopped: by owner`, `stopped: by operator`, `stopped: agent deleted`). How to
find and stop a runaway agent is [`docs/runbook.md`](docs/runbook.md).

Effects the object cannot re-run safely are marked. A tool declares
`sideEffects` and `idempotency`, which becomes pi's `replay: "never" | "safe"`:
a read repeats freely, a write repeats only if the plugin can make it
idempotent, and everything else is answered `unknown` rather than performed
twice.

### Tools are called the provider's way

The harness offers the mounted tools through the provider's own tool-calling
channel and reads `tool_calls` back. That sounds like a detail and is not.

The alternative — asking the model, in prose, to reply in a convention invented
here — was the default until a model change broke it in public. A model under
any pressure falls back to the format it was trained on, and every provider
trains a different one. Four turned up in two days: `<tool_call>`, `<invoke>`,
an invented `<system name="...">`, and DeepSeek's DSML written with full-width
bars. Each arrived as another branch in a regex, and each time the harness had
read the markup as a finished answer and ended the task mid-job.

Measured on the same model, prompt and task: through the invented convention,
16s, one model call and no tool calls at all — it emitted markup, the harness
took it for an answer, and it replied from memory against an explicit
instruction not to. Through the provider's channel: 91s, twelve model calls,
thirty tool results, and an answer that had read the repository.

The invented convention is gone with the harness that used it: pi's loop calls
tools through the provider's channel and nothing else, so there is no regex left
to teach.

---

## Getting Started

### Prerequisites

- **Node.js**: >= 24 (Node 24+ native TypeScript support with `--experimental-strip-types` / strip-only TS is used; no build step required for Node scripts).
- **Package manager**: `npm`.
- **Cloudflare account** (optional, for edge deployment): Wrangler CLI and a Cloudflare account with Workers and Durable Objects enabled.
- **Model API key**: e.g. OpenRouter, Anthropic, or OpenAI key.

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/botiverse/antiproton.git
cd antiproton
npm install
```

### Running Tests

The test suite covers in-process storage conformance, agent loop semantics, tool isolation, compaction, and sandbox contracts:

```bash
# Run individual unit or conformance test suites (Node 24+ native TS strip)
node test/pi-storage.ts
node test/pi-agent.ts
node test/state.ts

# Or run predefined npm scripts for key suites
npm run pi-storage
npm run pi-agent
npm run pi-tools

# Run type checks (Node scripts and Cloudflare Worker checked independently)
npm run typecheck
```

Three integration tests require live external credentials and are skipped in standard unit runs:
- `test/live-e2e.ts`: Live end-to-end multi-turn agent test (`RUN_LIVE_TESTS=1`).
- `test/live-github.ts`: Real GitHub tool operations against a test repository (`GITHUB_TOKEN=...`).
- `test/appworld.ts`: AppWorld benchmark evaluation against an active AppWorld environment.

### Local Development & Edge Deployment

Antiproton is designed to run as a Cloudflare Worker backed by Durable Objects:

1. **Configure credentials:**
   Copy the example environment or configure credentials in `cf/wrangler.jsonc` (or via Cloudflare Secrets):
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   # or OPENROUTER_API_KEY, etc.
   ```

   **Model providers.** The operator's model account reaches the providers the `MODEL_PROVIDERS` var
   declares: a JSON array of `{ id, baseUrl, auth: { secret, header }, modelFormat?, passKeys? }`, where
   `baseUrl` is an https OpenAI-compatible endpoint and `auth.secret` is the *name* of the Worker secret
   holding the credential, never its value (`src/model/providers.ts` validates it). Unset, the deployment
   has one provider, `deepseek`, at `DEEPSEEK_BASE_URL` with `DEEPSEEK_API_KEY`. A model choice is a
   provider and a model under it; one stored with no provider is `deepseek`'s, which is also where
   `HARNESS_MODEL` is served. `cf/wrangler.preview.jsonc` declares Cloudflare AI Gateway as a second
   provider (`vendor/model` names, its token in `cf-aig-authorization`, DeepSeek's key passed through only
   for `deepseek/` models). Admins choose per deployment, tenant or agent through `/admin/models`, whose
   `GET` also lists the owner options below with the provider and model each stands for.
   Owners pick for their own agents from the `USER_MODELS` var — a JSON array of
   `{ id, label, provider, model }` under those providers (`src/model/user-models.ts` validates it; unset,
   nothing is offered, and an option whose provider's secret is unset is not offered) — through
   `GET`/`POST /ui/agent/model`, or the Agents API's `model` field (`cf/src/agents-api/model.ts`; an option's
   id, its `<provider>/<model>`, or `default`, anything else a 400). Most specific wins: an admin's agent row, then their tenant row (either
   locks the owner's pick), then the owner's pick, then the admin's deployment row, then `HARNESS_MODEL`.
   A pick whose option is no longer offered is passed over. For an agent Raft hosts, Raft's
   `PUT /provision/agents/{id}/model`, or `model` on the `POST /provision/agents` that creates it, makes the same
   pick (docs/agent-surface.md, "The agent's model"). Raft also sets, per server, whether its agents may pick
   another model than the default (`PUT /provision/servers/{id}/model-picker`); that switch refuses a pick only
   where the `MODEL_PICKER_ENFORCE` var is `"1"`, which no wrangler config sets yet: unset, it is stored and
   reported and refuses nothing (docs/agent-surface.md, "The server's model picker").
   An owner's pick is bound when it is made (the
   console's POST, Raft's PUT, or the Agents API's create or update of an agent already bound), so the agent's next model
   call runs on it, on a harness rebuilt for it if one was open. An admin's change is bound when something next checks the agent's binding: its console
   page opening, a console message, an Agents API input, an owner's pick, or, for an agent Raft made, a hook
   push; a turn started any other way runs on the binding it has.
   An `openai/…` reasoning model (gpt-5.6-luna among them; pi-ai's OpenAI catalog decides) is called
   through the Responses API at the same provider (`<baseUrl>/responses`, the same model name, token and
   billing), with its reasoning on at `medium` (every agent's call: the queue consumer forwards no job option
   that could ask another level; only a direct caller of the client can), its tools beside it, and
   its encrypted reasoning items carried back on the turn's next call (`store: false`; stored in the
   transcript as the thinking block's `thinkingSignature`; `src/model/openai-responses.ts`). Through
   chat/completions such a model accepts function tools only with its reasoning off, so it reasoned on no
   call. Any other `openai/…` model is sent the fields pi-ai's OpenAI-compatible provider would send it
   (`max_completion_tokens`; `src/model/chat-request-shape.ts`); every other model's request, DeepSeek's
   included, is unchanged (`test/model-request-snapshot.ts` pins it). A provider's refusal of the request itself
   (HTTP 400, 401, 403, 404, 422) is not retried: the turn fails at once with the provider's status and
   message. That message travels beside the harness's error text rather than in it, since pi's retry
   check scans the error text for words like `timeout` that a provider's message can contain. 408, 409,
   429, 5xx and network errors are retried, and then dead-lettered, as before.

   **Daily spend limits.** Model calls on the operator's accounts stop for the day once a tenant's priced
   usage reaches its limit — the `dailyBudgetCents` Raft sends for its server, and only while Raft has sent none the
   plan's fallback, `FREE_DAILY_LIMIT_USD` ($3 when unset) for `free` and `PRO_DAILY_LIMIT_USD` ($10) for `pro`,
   `DAILY_LIMIT_USD` ($5) while Raft has said no plan; an admin's per-tenant override through `/admin/spend-limits`
   (audited) can only lower it — or once every tenant's together reaches
   `PLATFORM_DAILY_LIMIT_USD`, $2000 when unset. Agents Raft creates with `budget: "onboarding"` are a pool of
   their own, in neither figure, refused only at `ONBOARDING_DAILY_LIMIT_USD` ($30) for all of them (an admin's
   override replaces it), or one tenant's share: Raft's `onboardingDailyBudgetCents`, else
   `ONBOARDING_TENANT_DAILY_LIMIT_USD` ($1), which an admin's override can only lower.
   Tenants in `DAILY_LIMIT_EXEMPT_TENANTS` (`bench` when unset) are never refused but count toward the
   platform total. Usage paid with the tenant's own
   credential counts nothing. The check is made in the queue consumer before each provider call, on a
   reading of the ledger at most 30 s old (5 s near a limit); a refused call fails its turn once with
   `Daily usage limit reached ($X of $Y); resets at 00:00 UTC.` (or the platform's sentence), which Raft
   is told too (`BridgeFatal` `usage_limit_reached`, and the sentence as the error status's detail), is not
   retried, and is not read as an overflow. A key with no price counts nothing and is logged. A spend read that fails lets the call through, with a log
   line. Running containers are not stopped. What is counted, how far a tenant can overshoot and why:
   docs/metering.md, "Daily limits".

   **Images.** A tool result can ask for an image to be seen with a `view` field naming an artifact
   (docs/plugins.md). DeepSeek Flash and GPT-5.6 Luna see it (`VISION_MODELS`,
   `src/model/context-windows.ts`); any other model is told in its place that it cannot, and that an owner
   can switch the agent to one of those two. The bytes are stored once in the artifacts bucket under the
   agent's prefix (`model-images/<sha256>`), and the transcript, the job rows and the prefix and input
   readings hold only that reference; the queue consumer reads the bytes back right before the call. At
   DeepSeek a tool result's image is sent in a user message after the tool results, the only place it takes
   one; through the Responses API it goes inside the tool result's output, or, with the
   `RESPONSES_TOOL_IMAGES` var set to `user`, in a user message after the results as well. An image stays in
   the conversation until compaction, whose summary is text, but one request carries only the newest 8, and at
   most 12 MiB of them (`MODEL_IMAGES_MAX`, `MODEL_IMAGES_MAX_BYTES`); each older one is sent as a line naming
   it, and until the next compaction (which renumbers what is left) an image outside that window stays
   outside. The window's start moves four images at a time (one at a time when `MODEL_IMAGES_MAX` is under
   four, and never past the newest image), so the provider's cached prefix breaks once per four new images
   rather than at every one. An image in the window whose stored bytes cannot be read, no longer hash to
   its reference, or are not the size its reference declares is not sent: the model is told it could not be
   loaded. Where model-input evidence is on (the evaluation routes), each call's `model-input` record says
   what became of every image reference, per queue delivery attempt (docs/agent-surface.md, "Model input").

2. **Run locally with Wrangler:**
   ```bash
   cd cf
   npx wrangler dev
   ```

3. **Deploy to Cloudflare Workers:**
   ```bash
   cf/scripts/deploy-pinned.sh             # production: the full gate (cf/scripts/verify-and-deploy.sh), then the deploy
   cf/scripts/deploy-pinned.sh --preview   # the preview Worker (cf/wrangler.preview.jsonc)
   ```
   It deploys origin/master from a fresh worktree of its own and then reads the live build. That is the way to deploy
   from a machine where others share the checkout: a checkout moved or modified while the gate runs in it would ship
   a tree the suites never ran on, so the gate refuses to deploy from one that moved or holds untracked files.

---

## Core Invariants

### Zero Cost While Idle

Scale-to-zero is easy to claim and easy to lose one careless `await` at a time,
so the numbers below are measured on the deployment rather than reasoned about.

Durable Objects bill **wall-clock duration while the object is active**; Workers
bill **CPU**, and time spent waiting on I/O is free. A model call is five to
sixty seconds of pure waiting. Awaiting it inside the object means paying for
the wait; that one distinction drives most of the design.

| | Measured |
|---|---|
| Model call awaited inside the object | 128.2s of billed object time |
| The same work, awaited off it | **0.7s** |
| One agent, 79 model calls | 40.8s billed inside vs **709.2s waited outside** (582.5s of it the provider) |
| Idle agent | no invocations, no armed alarm, no container |

Three things had to be true for the last row, and each was a bug first:

- **The alarm stands down.** It used to re-arm every 30 seconds for the life of
  the object. An idle object now deletes its alarm and wakes only when something
  arrives.
- **Nothing polls.** Work in flight belongs to a queue, which redelivers until
  acked and gives up into a dead-letter queue. The object does not stay awake to
  supervise it. (It used to: the sweeper, the give-up timer and the re-dispatch
  loop were a hand-rolled reimplementation of one line of a queue's contract.)
- **The sandbox is handed back.** A container is destroyed when the agent has
  nothing open, not stopped — `stop` returns 200, leaves the box and its storage
  in place, and keeps billing. Thirteen boxes were live before that was noticed.
  The release is scoped to the agent and covers every mount it holds, so it fires
  when the *agent* has nothing open rather than when a particular task ends. The
  condition is per pass, not per conversation: a wake that settles a turn and
  opens no new one releases, so a container is handed back between turns of the
  same conversation rather than only at its end. A mount whose plugin keeps
  something across calls should therefore expect to be released and re-entered
  rather than held — `run9` preserves the environments named in `envs` for that
  reason, and anything a container accumulates that is not named there is gone.

The other half of cost is tokens, and the number that decides it is prompt-cache
hit rate. Measured here: editing the system message drops it from **84.9% to
0.0%** — 6.6x the uncached tokens — while editing the tool block costs 1.1x. So
the agent's memory is injected once when the harness opens rather than before
every turn, which is where a local harness would put it. The injection is built
from tenant and agent rather than from anything per conversation, so the harness
opening decides how often it is paid. The console draws the cache
hit per call, so losing it is visible rather than merely expensive.

The cache is not the whole story, though: on a long investigation it sits above
99% and the bill still climbs, because each fetched page is re-sent on every
subsequent turn. That is what compaction is for, below.

### Context Window Bounding & Compaction

A long investigation outgrows any context window, and what it has learned is
the part worth keeping. Dropping old turns keeps the task alive and throws the
findings away.

So, following [pi][pi] — see [what was taken from elsewhere](#what-was-taken-from-elsewhere) —
walk back from the newest message to a budget and keep
that tail verbatim; summarise everything before it into a handover with fixed
sections — goal, constraints, progress, decisions, next steps; truncate tool
output hard, or the summariser summarises a fetched page instead of the work;
and on a second pass feed the previous handover back with an update prompt that
says to merge rather than append.

Four triggers, two of them estimates and two facts. A share of the model's
context window, and a share of the checkpoint budget — both estimates, and both
expressed as fractions, because the same token count is most of a small window
and a rounding error in a large one. Then the two certain ones: the provider
refusing the call because the prompt does not fit, which forces a compaction
rather than a retry that cannot succeed; and a person pressing **compact now**.

It fits here better than it fits pi, because the harness holds no I/O:
compaction is a command like any other. The request declares its purpose, so
the reply is a record in the log of where a compaction happened and what was
folded up.

Nothing is destroyed. `state = fold(events)`, the log is untouched, and only
what the model is shown gets shorter — the console says so where it happened.

Demonstrated end to end: compaction fired on its own, produced a handover with
the goal and per-page progress intact, and the agent then answered two questions
whose answers had been fetched *before* the compaction, without going back to
re-read anything.

### Persistent Memory

An agent that cannot write anything down re-derives everything on every task,
and it knows it: asked to keep a note, this one used to answer that it had
nowhere to keep one. It now has its own store, per `(tenant, agent)`, outliving
any single task — small values in the object's SQLite, large ones spilled to
object storage behind an `r2://` reference the existing reader can page.

The shape follows what [pi-memory][pim] and Codex arrived at independently:
plain text documents a person can read and correct, separate documents for
separate lifetimes (`memory` for durable facts, `todo` for what is open,
`journal` for what happened), and appending in one call — a journal you have to
read, edit and rewrite to add a line is a journal that stops being written.

The load-bearing part is theirs too: the working set is **pushed into the
prompt**, not left to be pulled, because an agent that has to remember to go and
look will not look. What does not carry over is doing it before every turn. That
is affordable in a local CLI and not here — see the cache numbers above — so it
is injected once when a conversation begins, where the prefix stays stable and
cached. The system prompt then stays byte for byte the same for the
conversation's life, however often its harness is opened again; a document that
changes later reaches the model as a short harness notice at the head of the
next message, with only the lines added where the document only grew
(`src/runtime/prompt-context.ts`). A fresh context begins from the documents as
they are then.

Demonstrated across two tasks: told a deploy window, a formatting preference and
an unhandled certificate expiry in one, then asked in a *new* task when to ship,
it answered with the next Tuesday's date at 02:00 UTC, raised the certificate
unprompted, and formatted the reply the way it had been asked to.

[pim]: https://github.com/jayzeng/pi-memory

### Storage Substrate

One contract, two implementations, no third:

| Backend | Where | pi storage conformance |
|---|---|---|
| `PiSqliteStorage` on node:sqlite | in-process (Node) | 21/21 |
| `PiSqliteStorage` on DO SQLite | Cloudflare | 21/21 |

A db9/Postgres backend also passed, and was removed: 61,219 ms against sqlite's
162 ms, no `SERIALIZABLE`, and `40001` on plain concurrent inserts. A backend
that passes but is never run is a liability, not an asset — it has to be updated
on every seam change while nobody exercises it.


---

## What is verified

Contracts, not assertions in prose. The storage contract runs unchanged against
both backends, and it is not ours — it ships with pi, which is the point of
implementing pi's interface rather than copying its design.

**The measurement standard: a figure counts as measured only when it was taken
on the real serverless environment** — the Durable Object, not a Node process
and not in-memory SQLite. A number from anywhere else is reported only if it is
labelled as in-process, and never in place of an on-object one. This is why the
SWE-bench rows below say which environment produced them.

| Suite | Cases | Covers |
|---|---|---|
| `pi-storage` | 21 | pi's own storage conformance, unchanged, on node:sqlite (`npm run pi-storage`) and on Durable Object storage (`npm run pi-storage:do`, a worker that is never deployed): mixed-write atomicity, rollback across every store, value and list ordering within a transaction, branch stops before filters and cursors before limits, admission order under concurrent commits, close that seals admission but drains what it admitted |
| `pi-agent` | 15 | the object-side loop: a message is a pure write, a pass suspends rather than waits, a tool turn goes model → gateway → model, a duplicated pass does not grow the transcript, a run is not dispatched twice, the alarm does not poll, a run interrupted by eviction is reported open and finished, turn cancellation discards model jobs and records a marker, and projected cancellation markers prevent models from continuing aborted tasks |
| `pi-offload` | 3 | the object never waits for the model: drive suspends, the answer resumes the same operation, and a suspension survives eviction |
| `pi-tools` | 24 | mounts as tools: the gateway is still the only way out, a refusal reaches the model as a refusal, replay policy, and names the provider will accept. The `run_js` half runs against the real executors: a script reaches a tool by the name the model was offered, a mistyped name is answered with the nearest names rather than "not a tool name", an empty tool list says so, a switched-off mount says why, and a name is attributed to the longest alias it starts with — because an alias may itself contain `__` |
| `pi-loop` | 3 | pi's harness on our storage, and a rebuilt harness finding the transcript again |
| `pi-bridge` | 11 | pi's request shape against our provider client, both ways |
| `executor` · `http-plugin` | 46 | sandbox contract in-process (`executor` 11 runs the `spec/executor-spec` rows including script syntax errors), fetch and HTML extraction (`http-plugin` 10) |
| `state` | 65 | memory that survives a task, byte budgets, `memory` capped at its 8,000-character prompt budget and one over it from before shown by its first and latest lines with a marker naming `get`, growing writes to it refused and shrinking ones taken, per-agent isolation, a full document dropping whole oldest lines and `remember` quoting them back, CRLF documents kept CRLF, `remember` refusing a value that is not text, `revise` replacing exactly the one occurrence of its `old` text (within a line or across lines) and refusing zero or several matches with their lines, the old `match`/`replace` names, and only growth past the cap, `insert` at a line number refusing a line out of range and a full document with its listing, a put over an inline todo past 32 KiB told to shrink it with `revise` or `forget`, every row's `bytes` the JSON's length (with a once-per-store backfill) and `maxTotalBytes` holding for every write, parallel `remember`, `revise` and `insert` on one key losing no write on either store, both stores answering the same, `remember` and `put` sharing one namespace, every row `list` returns carrying the `ref` it is read back by, parked notes pointing to read calls, path segment traversal refusal, and stale unreadable rows offering `forget` |
| `markdown` | 11 | the console renders the agent's markdown and never its HTML |
| `model-binding` | 6 | whose key an agent spends |

Benchmarks are not tests and are reported separately, because they measure a
model as much as a harness. Each row says which environment produced it: only
the on-object ones meet the standard above, and the in-process ones are marked
as such. SWE-bench Verified, the same three astropy
instances each time. **Every row in this table was measured with the
container's network open**, which SWE-bench's own runs never are: in the
archived transcripts of the `bench-swe1` row the agent fetched the upstream fix
for one of its three instances, and the in-process rows kept no transcripts to
check. Read them as loop comparisons under one condition, not as solve rates. The
ten-instance run below is the one measured under SWE-bench's own condition.

| | model | resolved | wall clock | prompt tokens | measured in |
|---|---|---|---|---|---|
| pi's loop | deepseek-flash | 3/3 | 690 s | 550 k (94% cached) | Node process, in-memory SQLite |
| pi's loop | **deepseek-flash** *(deployed model)* | **3/3** | 692 s | 446 k (93% cached) | **Durable Object** `bench-swe1`, 2026-09-10, `swe-on-object` |

Ten instances, the container without network (every command runs in an empty
network namespace, so nothing the agent does can reach GitHub, where the answer
to each instance is a public commit):

| | model | resolved | wall clock | prompt tokens | measured in |
|---|---|---|---|---|---|
| pi's loop | **deepseek-flash** *(deployed model)* | **7/10** | 6,059 s | 7.56 M (97% cached) | **Durable Object** `bench-swe3`, 2026-09-11, Worker `60580fd`, network none |

Record: [`swebench-swe3-mtwgij3r.json`](https://pub-212e604eb60944c6854033a8ee1b3cef.r2.dev/runs/2026-09-11/swebench-swe3-mtwgij3r.json). All ten
transcripts were read: seven commands tried to reach GitHub, none received
anything. The three misses ran out of the fifteen-minute budget; every solve
landed in one file. The object was billed for 4,419 s of the 6,059 s wall clock
(73 %), 527 s of it the runner grading.

The table compares the loop in-process against the deployed environment for the deployed model (`deepseek-flash`). Only the on-object row meets
the full measurement standard: it was driven through the deployed Worker (`bench/swebench/cf.ts`),
the agent ran inside the object with the instance's image mounted as its
machine, the model calls went through the production queue, and the grader ran
in the same container before the runner released it. Same score and wall clock
as the in-process row, about a fifth fewer tokens, and one number the Node
process could not produce at all: **the object was billed for 516 s of the 692 s wall clock
(75 %)**, 28 s of it the runner grading. τ² bills the object for 3 % of wall
clock; SWE-bench bills it for 75 %. The difference is where the waiting
happens: a model call leaves the object through the queue, but a tool call runs
inside it, and this task is 49 shell commands in a container, the first of them
a 75-second image pull. That is a property of what ships, measured rather than
argued, and not something this change fixes.

Prompt tokens alone overstate the bill by more than ten times: of the 446 k in
the last row, about 30 k were actually re-read. An append-only transcript earns
that — each turn adds to the tail and leaves the prefix untouched, which is the
shape a provider cache rewards.

Across all three instances, in the in-process run (53 tool calls) and the
on-object one (49), `run_js` was used **zero** times. The same is true of τ²:
on the object it went unused across 24 trials. The one run that reached for it
— twice — was an in-process matrix, which is not on-object evidence. This task
is shell work inside a container, and the sandbox earns its place by replacing
several calls with one; neither benchmark is the shape that tests it, and the
sandbox is not yet shown to pay on this substrate.

Two runs of the same commit on the same model scored 3/3 both times and differed
by a third in cost — 1,071 s / 813 k against 690 s / 550 k. That is the size of
the noise, and it is worth knowing before reading any single figure as a trend.

A single instance is a coin flip: `astropy-12907` passed alone, failed in a
slice, and passed again on another model, all with the same code. Three
instances measure that the loop runs, not how good it is.

---

## Contributing

We welcome contributions from the community. To keep antiproton reliable and maintainable:

- **Plugins (`src/plugins/`):** Open for direct pull requests! Read the [Plugin Authoring Guide](docs/plugins.md) for conventions, lifecycle hooks, and testing guidelines. If you want to add integrations, tool bindings, or data connectors, feel free to submit a PR with tests in `test/`. The one line that registers a new plugin in `cf/src/runtime.ts` is exempt from the "issue first" requirement.
- **Core Runtime & Durable Objects (`src/runtime/`, `src/core/`, `src/store/`, `cf/`):** Please **open an issue first** to discuss architecture, invariants, and design before writing code.
- **Evidence-based verification:** Every PR must include tests that verify the exact mechanism or boundary introduced. We verify mechanism by callable entry points, not by assertions of absence.
- **Documentation:** Documentation must be kept in sync with code reality. All documentation is in English.

---

## What was taken from elsewhere

The harness is the commodity part of this, and the parts of it that are good
were mostly worked out by other people. Naming what came from where, because a
reader deserves to know which decisions were reasoned from first principles and
which were copied from someone who had already made the mistake.

**[pi][pi]** (MIT, © Mario Zechner) is the main source, and the debt is
specific rather than atmospheric:

- **Compaction.** Walk back from the newest message to a budget and keep that
  tail verbatim; summarise everything before it into a handover with fixed
  sections; truncate tool output hard so the summariser summarises the work
  rather than a page it fetched; and on a second pass feed the previous
  handover back with an *update* prompt that says to merge rather than append.
  The prompts here are written fresh but the structure is theirs.
- **Push the working set in rather than trusting recall.** Both pi-memory and
  compaction rest on it: an agent that has to remember to go and look will not
  look. What did not carry over is doing it before every turn, which the cache
  economics here forbid.
- **Separate documents for separate lifetimes** — durable facts, open items,
  a running log — so the working set can be trimmed by priority.
- **Steering as distinct from aborting.** A message sent while the agent works
  reaches the model before its next call and stops nothing in flight; a
  follow-up waits until it has finished. Two gestures, not one, and the default
  is the first. I had these confused until pi's definition corrected me.
- **Per-model configuration rather than one deployment-wide number.** pi keeps
  context windows and provider quirks in `models.json`. The same shape is used
  here, and adopting it immediately found a live misconfiguration: compaction
  was calibrated for a 131k window on a model that holds a million.

**[Codex][codex]** for the distinction between static instruction and learned
memory — `AGENTS.md` is configuration and does not learn — and for redacting
secrets before anything is written down.

- **The durable storage contract.** `src/store/pi-storage.ts` implements pi's
  `Storage` interface on SQLite, and `test/pi-storage.ts` runs pi's own
  `createStorageConformance` suite against it — 21 cases, unchanged, on both
  node:sqlite and Durable Object storage. Implementing someone else's interface
  buys an executable specification for the part of a session store that is
  hardest to test honestly: mixed-write atomicity, rollback across four tables,
  cursor-before-limit ordering, admission order under concurrent commits. Our
  own tests encode our own assumptions, which is exactly why they would not have
  caught these. The suite runs in a worker that is never deployed: bundling it
  into the real one grew the production binary by 58 KB, of which the storage
  implementation itself is 500 bytes. A multi-tenant Worker should not pay for a
  test suite on every cold start. The usage arithmetic in that file is derived
  from pi's `harness/utils/usage.js`, which its export map does not publish.

That last item revises what this section used to say. It claimed the shape of
the agent loop was deliberately not borrowed, because pi was a local,
single-tenant tool where a shell is a reasonable thing to hand a model. As of
0.85 that is no longer true: `pi-agent-core` splits durable admission
(`accept`) from an I/O pass (`drive`), and describes its unit of change as "one
effect-free decision made on a lane's serialized mutation line" — the same split
this project's own kernel arrived at independently, before that kernel was
deleted in favour of pi's loop. The storage layer came first; the loop above it
followed, and both are pi's now.

[pi]: https://github.com/badlogic/pi-mono
[codex]: https://developers.openai.com/codex

---

## What is not done

Stated plainly, because a runtime that hides its gaps is worse than one that has
them:

- **Event retention.** Snapshots are written and pruned, so rebuild stays
  bounded — but the event log itself is never trimmed. This is the one hole in
  the idle-cost claim above: compute really does go to zero, and storage really
  does not, so a genuinely long-running agent's floor rises for ever and will
  eventually exhaust one object's 10 GB.
- **Usage retention.** Each agent's object prunes its own usage outbox on every
  send, bounded by the cursor, so the object side cannot grow. The table those
  rows land in, `usage_hourly` in the control-plane database, keeps 35 days of
  hours: a daily Cron Trigger folds older whole days into `usage_daily` and
  deletes the hours it folded (docs/metering.md, "Retention"). `usage_daily`
  itself is never trimmed, and grows with tenants × agents × days × (resource,
  key, unit).
- **A container's last seconds can go uncounted.** All five resources the usage
  view names are recorded now. Container time is asked of the mounts themselves
  once per pass, so a box alive across ten turns is counted in the hours it was
  alive — but the final stretch, between the last pass and the moment the box
  went away, is only counted if the agent wakes again while that session is still
  in the mount's bounded window. An agent that holds a container, is released by
  the idle reaper and never wakes again leaves that tail out of the ledger. The
  same is true of the object's own last span, and for the same reason: both are
  written down by the pass after them.
- **A resource that starts being counted mid-window.** The read reports the first
  hour it holds anything for each resource, and a tile whose first hour falls
  inside the window says so instead of showing a part as a whole. What it cannot
  say is *why* the earlier hours are empty: an agent that was idle and a
  resource that was not being counted yet look identical in the ledger. The line
  is named; which side of it is which is not recoverable from the rows.
- **Plugin lifecycle.** A mount's config and policy are reconciled on every
  visit, so drift self-heals, and a seed mount is validated on the first agent
  it reaches. Mounts can be switched on, switched off, or set to inherit via the
  console (with switched-off mounts keeping their row marked closed rather than
  vanishing), and mounts can be renamed. Full revocation and dynamic installation
  of arbitrary plugins at runtime are not supported: plugins are registered at
  build time in `cf/src/runtime.ts`. Revoking or removing a mount must preserve
  prompt resolution integrity: the system prompt names the mount and tool
  (e.g. "kept by the `state` mount, … its `revise` tool replaces a piece of text") rather
  than the underlying dispatch address, and drops the instruction when the mount
  is absent.
- **OAuth mounts.** An operator configures a credential by pasting it — a token,
  a username and password, an access key and a secret key. Those are two of the
  three shapes a credential can have: a bare token, an object with named fields,
  or a sign-in completed at the provider. Only the third is a flow, needing a
  callback route and a refresh when the reference is resolved, and neither is
  built *for a mount* — the console has a callback for signing in, which
  establishes who the person is rather than what an agent may use. Until they
  exist, a plugin can declare that its credential is a sign-in (`mount-config`
  pins the rule), so the page greys the control instead of offering a box that
  produces a mount which dies when the token expires. No plugin declares one yet,
  so the declaration is a capability the contract has rather than behaviour to
  observe.
- **One object per (tenant, agent).** That is what makes isolation structural,
  and it is also the ceiling: an individual agent's durable state does not shard
  horizontally across multiple objects. Workload scaling is achieved via
  subagent delegation rather than distributed object clustering.
- **Subagent depth boundaries.** Hierarchical agent delegation supports single-layer
  nesting (parent to subagents) with strict concurrency (up to 3 concurrent
  subagents) and turn limits; arbitrary recursive sub-delegation is intentionally
  restricted to bound execution spend and cyclic dependencies.
- **The context window is configuration.** Compaction is a share of it, so a
  model change that forgets to bring `HARNESS_CONTEXT_WINDOW` with it calibrates
  against the wrong number. Unset assumes a small window, which compacts early
  rather than discovering the limit from a refused call — but nothing reads the
  real value dynamically from the provider.
- **Benchmarks are operational evaluations.** τ²-bench scoring tracks end-to-end
  task completion and reward basis across production cycles (manifested in
  `report/runs/manifest.tsv`), while SWE-bench Verified runs serve as regression gates.
  They measure direction and system stability across releases rather than a static
  leaderboard claim.
