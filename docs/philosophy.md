# What We Believe When We Build Agents: The Philosophy of Antiproton

> "Those with explanatory capability are more prone to explaining away inconsistencies rather than reporting them."

Most AI agent frameworks are demonstrations of optimism. They show a model executing tools in a single happy-path turn on a laptop, and treat the rest of the problem—concurrency, credential safety, memory retention across eviction, tenant boundaries, and long-running cost—as deployment details to be solved later.

When you put an agent into production on real systems, however, the physics of software engineering take over.

This article lays out the core design philosophy of **Antiproton**: why we rejected the standard stateless function and persistent container patterns, why we isolate tenants structurally rather than logically, why credentials must never enter context prompts, and how our methodology for engineering reliable agents forced us to adopt a radical epistemological rule: **never trust an observer who has the power to explain away failures.**

---

## 1. The Scaling Paradox: Replacing the Linux Process with Durable Identity

Throughout the cloud computing era, monumental engineering effort was poured into elastic scaling: horizontal auto-scaling, online elasticity, and instantaneous resource provisioning. 

Yet, when applied to autonomous, stateful AI agents, the fundamental abstraction beneath cloud computing—**the POSIX / Linux kernel process interface**—encounters a hard ceiling.

On traditional Linux abstractions:
- **State is tied to machines and processes:** To preserve working memory, an agent must reside in-process within a persistent VM or container. Moving or scaling that process online requires distributed coordinators, socket migration, and disk remounting.
- **Cold starts fight statefulness:** If an idle container is killed to save money, waking it incurs hundreds of milliseconds to seconds of runtime initialization, image pulls, and state deserialization.
- **The Waiting Dilemma:** Empirical profiling reveals that **model inference latency accounts for ~94% of an agent's total wall-clock time** (a completion is ~94% waiting, `docs/pi-upstream.md:75`). In a multi-turn task, the CPU executes logic for mere seconds; the rest is pure network idle time. Keeping a Linux process resident burns compute for waiting; killing it destroys execution continuity.

The answer is not to fight the Linux scheduler to make process migration seamless. The answer is to **change the level of abstraction: the agent's identity does not live on a Linux process interface.**

Antiproton separates identity, storage, and waiting:

1. **Identity as a Durable Object:** The unit of execution is not a container or VM, but a lightweight actor—a **Cloudflare Durable Object** with its own in-process SQLite database. There is no OS kernel boot, no container daemon, and no machine affinity.
2. **Waiting Leaves the Object:** Durable Objects bill for active wall-clock duration; Workers and Queues bill for CPU execution, where time spent waiting on network I/O is free. The moment an agent initiates model inference, the task commits durably to an outbound queue, and the object stands down. The wait happens in a queue consumer outside the object.
3. **True Scale-to-Zero Without State Loss:** An idle agent runs nothing:
   - No active processes.
   - No polling background workers (work is delivered via queue acknowledgments).
   - No armed timers (an idle object unarms its alarm, waking only on incoming events).
   - No resident containers.

The economic and operational contrast is directly measurable on production infrastructure:

| Condition | Measured Duration & Cost | Source |
|---|---|---|
| A model call awaited inside the object | **128.2s** of billed object duration | Production deployment baseline (`README.md:255`) |
| The same call awaited outside via queue | **0.7s** billed object duration | Asynchronous wait offloading (`README.md:256`) |
| Full agent execution across 79 model calls | **40.8s** billed inside vs. **709.2s** waited outside (582.5s provider RTT) | Deployed agent audit (`README.md:257`) |
| Benchmark run on τ²-bench retail (8 tasks × 3 trials) | **19.3s** billed inside object across **1,026s** wall clock (<2%) | Deployed DO `bench-v5`, build `c493981` (duration: `tau2-v5-mtz6ecej.log:48`; build: `tau2-v5-mtz6ecej.json:4`) |
| Idle agent state | **0 invocations, 0 armed alarms, 0 containers** (pure storage pricing) | Measured idle state (`README.md:258`) |

---

## 2. Structural Isolation vs. Application Filters

Security in multi-tenant systems is usually an afterthought implemented as a database filter: developers promise to remember `WHERE tenant_id = ?` on every query. The moment someone forgets, cross-tenant data leaks.

In Antiproton, **multi-tenancy is structural, not an application check**:
- **Two tenants are two separate Durable Objects with two completely separate SQLite database files.**
- Tenant A's data is physically absent from Tenant B's storage engine. A query in Tenant B cannot leak Tenant A's data even under catastrophic application-level logic errors, because the data does not exist in that database.
- File storage is scoped by the caller's identity, not by the reference: a model or person only ever sees `artifact://<path>`, with no bucket, tenant or agent in it, and the server resolves it by prepending the caller's own `t/<tenant>/<agent>/` (`src/store/refs.ts`, `keyForRef`). A reference therefore cannot name another agent's object at all, and paths with `.`, `..` or empty segments resolve to nothing (`test/agent-refs.ts`). The programmatic routes (`/agent/*`, `/bench/*`) strictly require the automation token or a signed-in owner (`cf/src/auth.ts`, `programmaticAccess`, `test/auth.ts`).

---

## 3. The Zero-Trust Credential Gate

The standard way modern agents access tools is reckless: API keys, database passwords, and OAuth tokens are injected directly into system prompts or returned inside tool result strings.

This turns every prompt injection attack into a credential exfiltration vector. If a model can read a token, a malicious prompt can coerce the model into leaking that token to an external endpoint.

Antiproton enforces a **Zero-Trust Credential Gate**:
- **Models address abstract tool aliases (`alias__tool`), never endpoints or keys.**
- Credentials reside in sealed, encrypted server-side stores and resolve dynamically via `secret_ref`. They never enter model context prompts, execution sandboxes, or audit logs.
- For outbound HTTP capabilities, credentials must be bound to an explicit whitelist of allowed hosts (`allowedHosts`). The model decides *what* to fetch, but the gateway enforces *where* the credential is authenticated.
- By construction, the model never receives the token. In our AppWorld benchmark setup (9 applications, 457 APIs, 362 of them [79%] requiring access tokens), the agent operates through gateway-resolved aliases rather than handling bearer credentials; the refusal paths and secret isolation are asserted in `test/gateway-refusals.ts` and `test/secrets.ts`.

---

## 4. Extensibility, Marketplaces, & Programmable Structured Tools

In conventional agent frameworks, plugins are treated as unconstrained callback scripts or arbitrary Python functions. Installing a tool requires absolute trust in the third-party author: a rogue tool can inspect process memory, exfiltrate environment variables, or scan local network sockets.

Antiproton inverts this dynamic. We designed plugins under `src/plugins/` to be open for community contribution—and structurally architected for an eventual third-party marketplace—because the runtime structure renders them **safe by default**.

### A Mount Is an Authority Boundary, Not a Callback
A plugin declares schemas and implementations, but it never grants ambient authority. Authority belongs strictly to the **mount**:
- **Independent Policies:** A mount carries an explicit policy (`allow`, `deny`, or `approval` across read, write, and individual tools). Mounting the same plugin twice under two distinct aliases creates two distinct authorities (e.g., a read-only production database mount beside a read-write staging mount).
- **The Danger of Ungated Neighbors:** As formulated in our invariants (`README.md:108-112`), an ungated mount of a plugin sitting beside a gated mount is a door beside the gate. Security requires evaluating an agent's entire mount set, not inspecting one mount in isolation.
- **Human-in-the-Loop Parking:** When an operation requires `approval`, execution does not abort. The task *parks* cleanly, awaiting human authorization. In production testing, answering a held call with an error caused the agent to abort after 75s; pausing execution with an explicit parking status converted the exact same task into a **17.2s success** (`README.md:118-122`).

### The Marketplace Foundation: Decoupling Provider from Consumer
The underlying storage schema was built from day one to support an open ecosystem marketplace (`src/store/durable-object.ts:80`):
- The `mounts` schema physically isolates `installation_id`, `tool_version` pins, `secret_ref`, and `policy` per `(tenant, agent, alias)`.
- Capabilities are decoupled: capability providers publish plugins, while operators configure separate policies and credentials per alias.
- What remains unbuilt is dynamic runtime installation: plugins are currently registered at build time in `cf/src/runtime.ts` (`README.md:622-626`). We state this limitation explicitly rather than pretending dynamic runtime loading exists.

### Programmable Structured Tools: Why Agents Don't Like Bash

Most agent architectures default to handing the model an unconstrained bash terminal over a POSIX filesystem. The industry rationalizes this by arguing that bash is universal. But the truth is simpler: **agents don't like bash, just like human developers don't like writing complex bash.**

Bash's primary historic virtue was physical keyboard ergonomics for human typists: spaces are easier to strike than parentheses, and single-line commands chain piping primitives with minimal typing. But non-trivial, multi-line bash scripts are notoriously difficult to write, reason about, and debug. While post-training and RL fine-tuning often inject synthetic multi-line bash scripts to force CLI competence, this fights the model's natural strengths. LLMs are trained on vastly richer, cleaner, and more expressive corpora in modern structured languages—overwhelmingly **JavaScript and TypeScript**.

This explains why Antiproton explicitly rejected architectures based on "just a bash shell over a POSIX filesystem on top of shared storage":

1. **Structured Types Over Brittle Text Streams:** When an agent composes tools, paginates endpoints, transforms nested objects, or catches errors, it writes structured JavaScript. It manipulates real data structures (arrays, objects, maps, JSON) and benefits from standard control flow and typed exception handling, rather than brittle string munging with `grep`, `awk`, `sed`, subshells, and escaping-heavy shell interpolations.
2. **Preserving the Sandboxing Invariant:** A shared POSIX filesystem with bash requires granting the sandbox ambient filesystem and network access—the exact two capabilities Antiproton strictly eliminates (`README.md:89`). Antiproton's architectural stance is uncompromising: *"A container is a mount, not a loophole. Work that genuinely needs a real machine gets one... rather than by loosening the sandbox"* (`README.md:98`).
3. **Hermetic Execution with a Single Exit:** `run_js` evaluates JavaScript inside an isolated sandbox (QuickJS or Cloudflare Dynamic Workers) with zero ambient network access (`globalOutbound: null`), no filesystem, and no ambient `process` or `fetch`. Code in the sandbox interacts with external systems exclusively through an injected host tool bridge. Those calls re-enter the `ToolGateway`, where they are subjected to the exact same mount policies, authorization gates, and audit trails as direct model tool calls.
4. **Code-as-Orchestrator:** Rather than consuming 10 separate conversational round trips across the network—or struggling with fragile shell scripts—the model writes a concise, idiomatic JavaScript snippet that orchestrates tools locally in the sandbox, returning only the compact, structured answer.

### The Measure of Honesty: When a Feature Does Not Yet Pay
Most technical manifestos present their capabilities as unmitigated triumphs. Antiproton's documentation takes the opposite stance: **we measure whether a feature actually earns its place, and state plainly when it does not.**

On paper, `run_js` is an elegant capability. In our production benchmark measurements, however:
- Across all three SWE-bench Verified instances (53 tool calls in-process, 49 on-object), `run_js` was used **zero times** (`README.md:516-522`).
- On τ²-bench retail, it went unused across **24 trials**.
- As recorded in `README.md:519`: *"This task is shell work inside a container, and the sandbox earns its place by replacing several calls with one; neither benchmark is the shape that tests it, and the sandbox is not yet shown to pay on this substrate."*

An architectural capability that does not yet pay under real benchmarks is reported as unproven, not celebrated as a breakthrough. That discipline is the difference between marketing and engineering.

---

## 5. Context Compaction as a Lossless Function

Long-running investigations inevitably exceed context windows. Naive architectures truncate old messages, throwing away hard-earned discoveries and forcing the agent to repeat work.

Antiproton treats state as a fold over an append-only event log: `state = fold(events)`.
When context budgets approach thresholds:
- The historical transcript is summarized into a deterministic **Handover Document** structured into explicit semantic sections: *Goal, Constraints, Progress, Decisions, Next Steps*.
- Tool outputs are aggressively truncated in the summary to prevent transient HTML or large API payloads from crowding out reasoning.
- When compaction runs a second time, it updates the previous handover rather than blindly appending, bounding token growth while preserving factual continuity.
- In tests, an agent resumed a multi-step investigation post-compaction and answered questions about facts fetched dozens of turns earlier without needing to re-fetch the data.

---

## 6. Our Engineering Methodology: Four Hard-Earned Invariants

The technical architecture is only half the story. The way Antiproton was built and verified reflects a disciplined philosophy regarding evidence, truth, and software verification. Over intensive engineering cycles, we established four non-negotiable principles:

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

## 7. Addition, Not Subtraction: Agents as Citizens of the New World

Underlying every line of Antiproton's design is a foundational worldview: **AI agents are the new citizens of a new digital world. In building infrastructure for them, we must use addition (加法), not subtraction (减法).**

When legacy software engineering attempts to accommodate autonomous agents, it almost universally resorts to **subtraction**:
- Take a monolithic Linux OS, and strip down capabilities until it barely runs.
- Take an interactive human shell (bash), strip away terminals, and hack fragile timeouts around text streams.
- Take a standard human security policy, and respond with runtime bans, errors, and task cancellations whenever an action looks uncertain.

Subtraction treats the agent as a liability—a clumsy, dangerous pseudo-human that must be restricted and contained within legacy environments designed decades ago for human fingers and physical keyboards.

Antiproton designs infrastructure through **addition**:

### Structure Instead of Bans (32 Instances of "Rather Than")
Across Antiproton's codebase and architecture, this principle is reflected not as an abstract slogan, but as a recurring structural discipline (appearing 32 times in our foundational specifications):
- **Physical Absence Over Runtime Filtering:** Multi-tenancy is not an instruction to "remember the `WHERE` clause"; data is physically absent from the querying database *rather than* filtered.
- **Dedicated Egress Over Network Bans:** The sandbox does not play a game of whack-a-mole with blocked ports; it gives the agent a single, auditable tool bridge *rather than* loosening the isolate.
- **Asynchronous Waiting Over Blocking:** The runtime issues an I/O pass that returns `waiting` *rather than* blocking or polling.

### The Power of Addition: Human-in-the-Loop Parking
The clearest operational proof of "addition over subtraction" is **approval parking** (`src/runtime/gateway.ts:507-527`):
- **The Subtraction Approach:** When a tool call requires human authorization, fail the call with an error or security exception. In our benchmark evaluations, answering a held call with an error caused the agent to conclude it was blocked and terminate the task in failure after 75s.
- **The Addition Approach:** Do not reject the call. Preserve the agent's intent by returning `status: "pending"` with `heldBy: "policy"`. The task *parks* cleanly, the human inspects and signs the exact request, and execution resumes seamlessly.

Told that it was paused rather than refused, the exact same task transformed from a **75s failure into a 17.2s success** (`README.md:118-122`). That is the measurable dividend of addition: safety is achieved by providing structure to preserve capability, not by stripping capability away.

## Conclusion: Building for Reality

AI agents will not achieve enterprise reliability through ever-longer prompts, naive subtraction, or hand-waving abstractions. They require the same rigor that distributed database systems and secure operating systems demand:
- **Addition over subtraction:** Treating agents as first-class citizens with purpose-built infrastructure rather than crippled legacy processes.
- **Physics over promises:** Structural isolation, true scale-to-zero compute, and zero-trust credential barriers.
- **Evidence over assertion:** Verifiable numbers, destructive testing, and epistemological humility in evaluation.

Antiproton is built for developers who believe that if an agent is going to act on real systems, every single guarantee underneath it must be verifiable.

AI agents will not achieve enterprise reliability through ever-longer prompts or hand-waving abstractions. They require the same rigor that distributed database systems and secure operating systems demand:
- **Physics over promises:** Structural isolation, true scale-to-zero compute, and zero-trust credential barriers.
- **Evidence over assertion:** Verifiable numbers, destructive testing, and epistemological humility in evaluation.

Antiproton is built for developers who believe that if an agent is going to act on real systems, every single guarantee underneath it must be verifiable.
