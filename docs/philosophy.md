# What We Believe When We Build Agents: The Philosophy of Antiproton

> "AI agents are the new citizens of a new digital world. When building infrastructure for them, we must use addition, not subtraction."

Most AI agent frameworks are demonstrations of optimism. They show a model executing a tool in a single happy-path turn on a developer's laptop, treating the real engineering challenges—durability across evictions, multi-tenant isolation, long-running cost, and execution safety—as downstream deployment details to be patched on later.

When developers attempt to take these prototypes into production, they almost universally resort to **subtraction**:
- They take a legacy, monolithic Linux OS, and strip down permissions until it barely boots.
- They take an interactive terminal shell (bash), strip away human interactivity, and wrap brittle timeouts around unbuffered streams.
- They grant full ambient network capacity, and then struggle to patch leaks with egress firewalls and IP blacklists.
- They take a human security protocol, and answer uncertainty with runtime bans and abrupt task cancellations.

Subtraction treats the agent as a liability—a clumsy, dangerous pseudo-human that must be chained inside systems designed decades ago for physical keyboards and desktop monitors.

**Antiproton is built on addition.** 

We do not force agents to masquerade as crippled Linux processes. We treat them as first-class digital citizens, providing purpose-built distributed infrastructure where safety is not an exhausting list of runtime bans, but a structural foundation upon which capability, autonomy, and open ecosystems can be constructed without compromise.

This is the philosophy that governs Antiproton.

---

## 1. Identity Beyond the Process: The Scaling Paradox

Throughout the cloud computing era, monumental engineering effort was poured into elastic scaling: container orchestration, predictive auto-scaling, and rapid cold starts. 

Yet, when applied to autonomous, stateful AI agents, the fundamental abstraction beneath modern cloud computing—**the POSIX / Linux kernel process interface**—encounters a hard ceiling.

On traditional operating system abstractions:
- **State is bound to a machine and a process:** To maintain working context, an agent must reside in-memory within a running VM or container. Migrating an active execution thread across machines online introduces distributed coordinators, socket migration, and split-brain hazards.
- **Cold starts fight statefulness:** If you terminate idle containers to save money, waking them incurs hundreds of milliseconds to tens of seconds of runtime initialization, container engine overhead, and disk remounting.
- **The Waiting Dilemma:** Profiling reveals that **model inference latency accounts for ~94% of an agent's total wall-clock time** (a completion is ~94% waiting, `docs/pi-upstream.md:75`). In a typical 10-minute task, the CPU executes logic for barely 20 to 30 seconds; the rest is pure network idle time. Keeping a Linux process resident burns continuous compute for waiting; killing it destroys state continuity.

The answer is not to fight the Linux scheduler to make process migration seamless. The answer is to **change the level of abstraction: the agent's identity does not live on a Linux process interface.**

Antiproton replaces the OS process with an edge-native actor model that decouples identity, storage, and waiting:

1. **Identity as a Durable Object:** The unit of execution is not a container, but a lightweight actor—a **Cloudflare Durable Object** with a collocated, in-process SQLite database. There is no OS kernel boot, no container daemon, and no machine affinity.
2. **Waiting Leaves the Object:** Durable Objects bill for active wall-clock duration; Workers and Queues bill for CPU execution, where time spent waiting on network I/O is free. When an agent initiates model inference, the task commits durably to an outbound queue, and the object completely stands down. The wait happens in a queue consumer outside the object.
3. **True Scale-to-Zero Without State Loss:** An idle agent runs nothing: no active processes, no background polling loops, no armed timers, and no active containers. It incurs cost strictly for stored SQLite bytes. The next token or webhook automatically resumes the object at the edge nearest the user.

The economic reality of this architecture is measured directly on production infrastructure:

| Execution Condition | Measured Billed Duration | Source |
|---|---|---|
| A model call awaited inside the object | **128.2s** of billed object duration | Production deployment baseline (`README.md:255`) |
| The same call awaited outside via queue | **0.7s** of billed object duration | Asynchronous wait offloading (`README.md:256`) |
| Full agent execution across 79 model calls | **40.8s** billed inside vs. **709.2s** waited outside (582.5s provider RTT) | Deployed agent audit (`README.md:257`) |
| Full benchmark run on τ²-bench retail (8 tasks × 3 trials) | **19.3s** billed inside object across **1,026s** wall clock (<2%) | Deployed DO `bench-v5`, build `c493981` (duration: `report/runs/2026-09-13/tau2-v5-mtz6ecej.log:48`; build metadata: `report/runs/2026-09-13/tau2-v5-mtz6ecej.json:4`) |
| Idle agent state | **0 invocations, 0 armed alarms, 0 containers** | Pure storage pricing (`README.md:258`) |

---

## 2. Structural Safety: Architecture Over Application Checks

When building for autonomous agents, security cannot depend on developer vigilance. A safety property that requires an engineer to remember a rule on every code path is a vulnerability waiting to happen.

Across Antiproton, every constraint is enforced by **physical architecture rather than runtime checks** (a principle appearing 32 times throughout our specifications as *"rather than"*):

### Multi-Tenancy by Physical Absence
In traditional multi-tenant architectures, tenants share a database, and isolation relies on application developers remembering to append `WHERE tenant_id = ?` to every query. The moment an engineer forgets, cross-tenant data leaks.

In Antiproton, **two tenants are two discrete Durable Objects with two physically separate SQLite databases.** Tenant A's data is physically absent from Tenant B's storage engine. A query executed in Tenant B cannot leak Tenant A's records even under catastrophic logic failures, because the data simply does not exist in that database.

Similarly, file storage is scoped by the caller's identity, not by the reference: a model or user only ever sees `artifact://<path>`, with no bucket, tenant, or agent in it. The server resolves it by prepending the caller's own `t/<tenant>/<agent>/` (`src/store/refs.ts`, `keyForRef`). A reference cannot name another agent's object at all, and paths with `.`, `..`, or empty segments resolve to nothing (`test/agent-refs.ts`). Programmatic routes (`/agent/*`, `/bench/*`) strictly require an automation token or a verified signed-in owner (`cf/src/auth.ts`, `programmaticAccess`, `test/auth.ts`).

### Zero Ambient Network Capability
Consider the standard approach to sandbox networking: an environment is granted full ambient network access, and developers attempt to restrict it with firewalls, iptables rules, and DNS blacklists. It is an unending cat-and-mouse game.

Antiproton starts from **absolute zero and builds through addition**:
- The execution sandbox (QuickJS or Cloudflare Dynamic Workers) initializes with `globalOutbound: null`—no sockets, no DNS resolver, no HTTP stack, and no access to the open Internet. There are no firewall filters to bypass because network capability does not exist in the isolate.
- Capability is added explicitly via mounts: to reach external endpoints, the developer mounts an audited plugin (such as `http` with an explicit `allowedHosts` whitelist). Egress is not "permitted despite a block"; it is an explicit, typed, and auditable tool bridge synthesized from scratch.

### The Zero-Trust Credential Gate
Most agent systems inject API keys, database passwords, and OAuth tokens directly into prompt strings or tool result payloads. This turns every prompt injection attack into an exfiltration vector. If a model can read a token, a malicious instruction can trick the model into leaking it.

Antiproton enforces a **Zero-Trust Credential Gate**:
- **Models address abstract tool aliases (`alias__tool`), never endpoints or keys.**
- Credentials reside in sealed, encrypted server-side stores and resolve dynamically via `secret_ref`. They never enter model context prompts, execution sandboxes, or audit logs.
- By construction, the model never receives the token. In our AppWorld benchmark setup (9 applications, 457 APIs, 362 of them [79%] requiring access tokens), the agent operates through gateway-resolved aliases rather than handling bearer credentials; the refusal paths and secret isolation are asserted in `test/gateway-refusals.ts` and `test/secrets.ts`.

---

## 3. Extensibility & Programmable Tools: Why Agents Don't Like Bash

In conventional frameworks, tools are exposed as loose callback scripts or arbitrary shell access. Antiproton rethinks how agents interact with the world through two complementary primitives: **Audited Mounts** and **Programmable Structured Tools**.

### Mounts as Authority Boundaries
A plugin declares schemas and implementations, but it never grants ambient authority. Authority belongs strictly to the **mount**:
- **Independent Policies:** A mount carries an explicit policy (`allow`, `deny`, or `approval` across read, write, and individual tools). Mounting the same plugin twice under two distinct aliases creates two distinct authorities (e.g., a read-only production database mount beside a read-write scratchpad).
- **The Decoupled Marketplace:** The underlying storage schema was designed from day one to support an open ecosystem marketplace (`src/store/durable-object.ts:80`). The `mounts` schema physically isolates `installation_id`, `tool_version` pins, `secret_ref`, and `policy` per `(tenant, agent, alias)`. Capability providers publish plugins; operators configure separate policies and credentials per alias. (We state our current gap plainly: dynamic runtime plugin installation is unbuilt; plugins are currently registered at build time in `cf/src/runtime.ts`).
- **Human Approval Parking:** When an operation requires `approval`, execution does not fail or abort. The task *parks* cleanly (`src/runtime/gateway.ts:507-527`), returning `status: "pending"` with `heldBy: "policy"`. In production testing, answering a held call with an error caused the agent to abort after 75s; pausing execution with an explicit parking status converted the exact same task into a **17.2s success** (`README.md:118-122`).

### Why Agents Don't Like Bash
Most agent architectures default to handing the model an unconstrained bash terminal over a POSIX filesystem on top of shared storage. The industry rationalizes this by arguing that bash is universal. 

The truth is simpler: **agents don't like bash, just like human developers don't like writing complex bash.**

Bash's primary historic virtue was physical keyboard ergonomics for human typists: spaces are easier to strike than parentheses, and single-line commands chain piping primitives with minimal typing. But non-trivial, multi-line bash scripts are notoriously difficult to write, reason about, and debug. While post-training and RL fine-tuning often inject synthetic multi-line bash scripts to force CLI competence, this fights the model's natural strengths. LLMs are trained on vastly richer, cleaner, and higher-quality datasets in modern structured languages—overwhelmingly **JavaScript and TypeScript**.

Antiproton replaces the bash-over-shared-storage paradigm with **Programmable Structured Tools** via **`run_js`**:
- **Structured Types Over Brittle Text Streams:** When an agent composes tools, paginates endpoints, transforms nested objects, or catches errors, it writes structured JavaScript. It manipulates real data structures (arrays, objects, maps, JSON) and benefits from standard control flow and typed exception handling, rather than brittle string munging with `grep`, `awk`, `sed`, subshells, and escaping-heavy shell interpolations.
- **Preserving the Sandboxing Invariant:** A shared POSIX filesystem with bash requires granting the sandbox ambient filesystem and network access—the exact two capabilities Antiproton strictly eliminates (`README.md:89`). Antiproton's architectural stance is uncompromising: *"A container is a mount, not a loophole. Work that genuinely needs a real machine gets one... rather than by loosening the sandbox"* (`README.md:98`).
- **Code-as-Orchestrator:** Rather than consuming 10 separate conversational round trips across the network—or struggling with fragile shell scripts—the model writes a concise, idiomatic JavaScript snippet that orchestrates tools locally in the sandbox, returning only the compact, structured answer.

### The Measure of Honesty: When a Feature Does Not Yet Pay
Most technical manifestos present their capabilities as unmitigated triumphs. Antiproton's documentation takes the opposite stance: **we measure whether a feature actually earns its place, and state plainly when it does not.**

On paper, `run_js` is an elegant capability. In our production benchmark measurements, however:
- Across all three SWE-bench Verified instances (53 tool calls in-process, 49 on-object), `run_js` was used **zero times** (`README.md:516-522`).
- On τ²-bench retail, it went unused across **24 trials**.
- As recorded in `README.md:519`: *"This task is shell work inside a container, and the sandbox earns its place by replacing several calls with one; neither benchmark is the shape that tests it, and the sandbox is not yet shown to pay on this substrate."*

An architectural capability that does not yet pay under real benchmarks is reported as unproven, not celebrated as a breakthrough. That discipline is the difference between marketing and engineering.

---

## 4. Context as State: Lossless Compaction & Long-Term Memory

Long-running investigations inevitably exceed context windows. Naive architectures truncate old messages, throwing away hard-earned discoveries and forcing the agent to repeat work.

Antiproton treats state as a fold over an append-only event log: `state = fold(events)`.
When context budgets approach thresholds:
- The historical transcript is summarized into a deterministic **Handover Document** structured into explicit semantic sections: *Goal, Constraints, Progress, Decisions, Next Steps*.
- Tool outputs are aggressively truncated in the summary to prevent transient HTML or large API payloads from crowding out reasoning.
- When compaction runs a second time, it updates the previous handover rather than blindly appending, bounding token growth while preserving factual continuity.
- In tests, an agent resumed a multi-step investigation post-compaction and answered questions about facts fetched dozens of turns earlier without needing to re-fetch the data.

Simultaneously, an agent maintains persistent working documents across tasks (`memory` for durable facts, `todo` for open items, `journal` for event logs) stored in its private SQLite namespace. Rather than relying on the agent to remember to query memory, the active working set is pushed directly into the initial system prompt upon harness opening, preserving cached token economics.

---

## 5. Our Engineering Methodology: Four Hard-Earned Invariants

The architectural principles above were not conceived in a vacuum. They were forged through intensive debugging and empirical measurement. Over successive development milestones, our team converged on four non-negotiable verification invariants:

### ① A number must carry its condition
*The Defect:* `AGENTS.md` claimed "only the full fifteen test suites answer 'is this branch sound'". Over time, new tests were added and old ones split. The suite count climbed to 39, while the document remained frozen on 15. The irony: three lines below that sentence was the rule: *"count rather than trust a number in a document, including this one."*
*The Rule:* Numbers in documentation must either be immediately recomputable via an automated script, or point to an immutable invariant. Hardcoded counts are liabilities that rot silently.
*The Artifact:* We introduced `npm run suite-table` which reconciles claims directly against executable suites. Where counts exist, they link to the runnable verification command.

### ② A conclusion must carry its origin
*The Defect:* During rapid debugging, claims about code behavior frequently cited line numbers or function behaviors that were true on someone's local branch, but false on `master`. Four separate bugs arose from verifying a *value* without verifying the *ref and premise* that made it true.
*The Rule:* Every citation of code or behavior must name its authoritative machine surface: `git show origin/master:<path>`, the commit SHA, the environment (Node vs. Durable Object), and the author. If a condition cannot be checked against an authoritative surface, it is a rumor, not evidence.

### ③ A guard must be proven by destructive verification
*The Defect:* We repeatedly observed tests and lint checks that appeared "green" simply because the assertion wasn't executing: a grep for `"not ok"` when the test runner printed `FAIL`, or a syntax error that exited cleanly before assertions were reached.
*The Rule:* A test or guard is only verified when you prove it can catch real failure through a three-step sequence:
- **ⓐ** The destructive change visibly alters the runtime behavior.
- **ⓒ** The viewing surface or report actually displays the change.
- **ⓑ** The guard turns red, specifically naming the intended failure.
If you cannot make a guard fail on demand, you do not have a guard; you have a placebo.

### ④ The Danger of Explanatory Power
*The Defect:* When an experienced engineer observes an unexpected discrepancy between two test runs, their first instinct is to rationalize: *"Oh, the version probably changed,"* or *"That's just network latency."* They explain the contradiction away rather than investigating it.
In contrast, when we deployed an automated, naive agent with **no prior timeline context** to test our tool surface, it observed two conflicting responses across builds. Having no timeline to construct an excuse with, it simply laid the two conflicting observations side by side and reported: *"I observed shape A, and then I observed shape B; these contradict."* That cold observation immediately exposed a deeply nested serialization regression.
*The Rule:* **Those with explanatory capability are more prone to explaining away inconsistencies rather than reporting them.**
*The Artifact:* Our evaluation pipeline explicitly preserves timeline-free observer agents without build credentials. Naivety is not a weakness; it is a high-precision measurement instrument.

---

## Conclusion: Building for Reality

AI agents will not achieve enterprise reliability through ever-longer prompts, naive subtraction, or hand-waving abstractions. They require the same engineering discipline that distributed database systems and secure operating systems demand:
- **Addition over subtraction:** Treating agents as first-class digital citizens with purpose-built infrastructure rather than crippled legacy processes.
- **Physics over promises:** Structural isolation, true scale-to-zero compute, and zero-trust credential barriers.
- **Evidence over assertion:** Verifiable numbers, destructive testing, and epistemological humility in evaluation.

Antiproton is built for developers who believe that if an agent is going to act on real systems, every single guarantee underneath it must be verifiable.
