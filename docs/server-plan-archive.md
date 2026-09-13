# Server-Side Antiproton: Architecture & Implementation Plan v1.1

> **Archive Note (2026-09-10, recorded at repository ingestion)**
>
> This document was written prior to initial code implementation as an architectural baseline,
> and is preserved as an archival design reference.
>
> **Current reality is governed by [`README.md`](../README.md).** Wherever this document conflicts
> with `README.md`, `README.md` takes precedence.
> In particular: Section 13 (Roadmap) and Section 14 (Acceptance Matrix) originally planned custom
> kernel leases, fencing tokens, generations, and transactional outboxes. These mechanisms were
> superseded when the agent loop converged on pi's loop model (see `README.md` and [`pi-upstream.md`](pi-upstream.md)).
> Furthermore, Section 16 originally listed `src/api/server.ts` as implemented; this Node HTTP
> server was retired after being fully replaced by the Cloudflare Worker implementation (#276, 2026-09-13).
>
> Companion document: [`self-hosted-plan-archive.md`](self-hosted-plan-archive.md) (self-hosted deployment model).

---

## 1. Project Positioning

Antiproton is a runtime for long-running, stateful AI agents. It provides:
- **Structural multi-tenant isolation:** Zero cross-tenant data leakage by architecture rather than runtime filter checks.
- **Durable zero-idle cost:** Compute suspends completely when an agent is inactive; state resumes transparently on demand.
- **Provider-native tool execution:** Eliminates intermediate translation hops and keeps secret credentials isolated from model contexts.
- **Predictable compaction & memory:** Bounded context windows backed by verifiable transactional storage.

---

## 2. Scope & Design Boundaries

### 2.1 Empirical Design Principles
- **Model calls dominate wall-clock time:** Profiling demonstrates model RTT constitutes ~94% of operational latency. Framework overhead must stay negligible (<10ms).
- **Zero-trust credential isolation:** Agents invoke abstract tool aliases (`alias__tool`); credentials are injected server-side by the gateway and never exposed to model prompts or sandbox memory.
- **Deterministic state transitions:** The execution step is a pure function over state, producing explicit effect descriptors.

### 2.2 Deliberate Non-Goals for Initial Version
- Unconstrained shell execution environments: arbitrary bash execution is omitted in favor of discrete, audited capability plugins.
- Dynamic runtime plugin compilation: all plugins are registered at build time to maintain verification and security invariants.

---

## 3. Product Model: Continuous Stateful Entities

An agent represents a durable, stateful entity rather than an ephemeral completion request.
- **Concurrency control:** Strictly serialized mutation line per agent. Concurrent external triggers queue or suspend; double-execution is structurally prevented.
- **Lifecycle states:** `idle | active | suspended | completed | failed`. Transitions are transactional.

---

## 4. Overall Architecture & Responsibilities

```
 ┌────────────────────────────────────────────────────────┐
 │                   Cloudflare Worker                    │
 │               (Edge Routing & UI Console)              │
 └───────────────────────────┬────────────────────────────┘
                             │
                             ▼
 ┌────────────────────────────────────────────────────────┐
 │           Agent Durable Object (Per Agent)             │
 │  ┌──────────────────────────────────────────────────┐  │
 │  │      Harness Loop (pi-based driver & loop)       │  │
 │  ├──────────────────────────────────────────────────┤  │
 │  │      Tool Gateway (Security & Policy Gate)       │  │
 │  ├──────────────────────────────────────────────────┤  │
 │  │      Embedded Sandbox Executor (QuickJS / Isolates)│  │
 │  ├──────────────────────────────────────────────────┤  │
 │  │      DO SQLite Storage (Events, State, Cache)    │  │
 │  └──────────────────────────────────────────────────┘  │
 └────────────────────────────────────────────────────────┘
```

### 4.1 Runtime
The host container managing lifecycle, hibernation, alarm scheduling, and persistent storage. In the server edition, this maps directly to Cloudflare Durable Objects.

### 4.2 Harness
Orchestrates prompt assembly, turn progression, model interaction, and compaction routines. Rebuilt around pi's loop semantics (`drive` / `accept`).

### 4.3 JS Executor
Provides isolated JavaScript evaluation (`run_js`) with no ambient system access, constrained memory, and step-budgeted execution.

### 4.4 Tool Gateway
The single outbound enforcement point for all tool calls. Evaluates authorization, enforces rate limits, maps aliases to plugins, injects credentials, and audits side effects.

### 4.5 Plugins
Composable interfaces exposing discrete capabilities (e.g. `fs`, `http`, `state`, `artifacts`, `github`).

---

## 5. Agent Interface & Protocol

### 5.1 Tool Invocation Skeleton
The model interacts with tools through standard provider function calling. Calls targeting mounted capabilities follow qualified alias names:
```json
{
  "name": "state__remember",
  "arguments": { "key": "user_preference", "value": "concise" }
}
```

### 5.2 Progressive Discovery
Agents query mounted tools dynamically to minimize prompt token consumption. Tools describe capabilities on demand rather than dumping exhaustive schemas into every initial turn.

### 5.3 Unified Result Protocol
Standardized result envelopes:
- `succeeded`: Execution successful, returns structured output.
- `rejected`: Policy, credential, or rate limit refusal (does not leak secret paths or credentials).
- `failed`: Execution error inside the tool.

---

## 6. Execution Sandbox

### 6.1 Constraints
- **Zero ambient network:** No global `fetch`, WebSocket, or raw sockets inside the sandbox.
- **Zero ambient filesystem:** Sandboxed code cannot read host environment variables or file systems.
- **Step budgets:** QuickJS interrupt handlers terminate runaway loops after a deterministic number of execution steps.

---

## 7. Storage & Persistence

Three storage tiers:
1. **Event Log:** Immutable record of user inputs, agent decisions, and tool outputs.
2. **State & Memory (`state` plugin):** Key-value memory preserved across turns within an agent's private namespace.
3. **Artifacts Store:** Offloaded storage for large tool outputs (> 4 KiB), replacing bulky raw strings with inspectable reference handles.

---

## 8. Tool Gateway, Tracing & Side Effects

All side effects pass through `ToolGateway`.
- **Audit Logging:** Every invocation logs caller, mount alias, parameters (with credentials redacted), latency, and status.
- **Idempotency:** Mutations record deterministic command identifiers to guard against replay duplicates during network retries.

---

## 9. Plugins & Capabilities

Plugins declare static capability manifests:
- Name, description, parameter schemas.
- Credential shape requirements (`bearer`, `basic`, `oauth`).
- Idempotency guarantees (`native`, `key`, `none`).

Mount configurations associate plugins with individual agents under customizable alias names and scoped access rules.

---

## 10. Multi-Tenancy & Security Architecture

1. **Physical Boundary:** Tenants and agents map to distinct Durable Object instances or SQLite databases.
2. **Zero In-Memory Credential Exposure:** Model prompts and sandbox contexts operate exclusively on logical references.
3. **Auditability:** Complete, reproducible trajectory logs available for inspection via the management console.

---

## 11. Empirical Benchmarks & Historical Findings

Historical benchmarks evaluated on early milestones:
- **Harness Mode Comparison:** Evaluated pure codegen, direct tool calling, and hybrid mode. Hybrid mode achieved the lowest wall-clock latency (58s vs 132s for pure codegen) and highest completion rates on initial task suites.
- **Storage Conformance:** Standardized on SQLite conforming to pi's storage test suite (21/21 conformance tests passing).
