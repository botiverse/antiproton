# Local Self-Hosted Antiproton — Product Plan v1.0

> **Archive Note (2026-09-10, recorded at repository ingestion)**
>
> This document is an **early design specification, kept frozen**. It is archived to preserve
> the original design rationale (handled consistently with companion document
> [`server-plan-archive.md`](server-plan-archive.md)).
>
> **Current reality is governed by [`README.md`](../README.md).** Following the writing of this
> document, the kernel, harness, and storage implementations evolved significantly (e.g., the
> execution loop adopted pi's design, removing custom leases, fencing tokens, and transactional outbox
> mechanisms). Shared components described herein are likewise superseded.

> Companion document to `server-plan-archive.md` (SaaS / Cloudflare edition, v1.1), presenting the
> second deployment model. The kernel, harness, gateway, and plugin protocols are fully shared; the
> differences lie in **storage backends, execution engines, residency, and migration mechanisms**.
> This document details specifics unique to the self-hosted edition.

---

## 0. Executive Summary

A long-running agent service running from a **single binary + one data directory**:
state resides locally (one SQLite database per agent + one restricted workspace directory),
JavaScript executes locally in QuickJS, and failover across nodes relies on **incremental event log replication**.
An agent is served by exactly one node throughout its active lifecycle; only after transitioning to `idle`
**and** completing log replication may subsequent requests land on another node.

Zero external SaaS dependencies: no Cloudflare, no R2, no external databases.

---

## 1. Motivation

The SaaS edition outsourced three distributed systems challenges to Cloudflare:

| Challenge | Cloudflare Edition Solution | Self-Hosted Requirement |
|---|---|---|
| **Single-writer guarantee** (an agent cannot be advanced by two processes concurrently) | Enforced by Durable Object single-instance guarantee | **Section 8 — The core architectural hurdle** |
| Per-agent isolated storage | DO-native SQLite, `transactionSync` | One SQLite file per agent (Section 5) |
| Sleep and wake-up | Hibernation + Alarms | In-process scheduler + timer heap (Section 7.3) |

In exchange, self-hosting provides three primary advantages:

1. **Strict data residency:** Private deployment, enterprise compliance, and internal network tool integration.
2. **No platform execution quotas:** Elimination of DO subrequest limits, CPU-millisecond limits, and object size bounds; supports multi-megabyte workspaces and extended local processing.
3. **Transparent inspectability:** Runtime state is a local SQLite file inspectable via `sqlite3`, and workspace files can be inspected directly with `ls`.

Trade-off: **Losing platform-provided single-writer guarantees.** Section 8 addresses this debt.

---

## 2. Product Topology

Three topologies packaged into a single binary:

- **single:** `harness serve --data ./data`. One process, one machine, no migration. Development and single-server deployments.
- **pair:** Two nodes (primary/standby) with asynchronous event replication. Manual or automatic failover with bounded RPO (Section 9.5).
- **cluster:** N nodes + an external arbiter (Section 8.3, Option C). Agents partitioned across nodes, rebalanced during idle states.

**Default is single.** Bottlenecks in long-running agent execution are dominated by model inference latency (~94% of wall-clock time in empirical benchmarks), not node concurrency. Perfect the single-node baseline before adding clustering complexity.

---

## 3. Invariants Inherited from the Core Design

These invariant boundaries are preserved intact:

1. **Gateway is the sole egress:** Sandboxes, harnesses, and plugins cannot bypass `ToolGateway` to reach external systems or filesystem storage. Egress control is an architectural security invariant, not merely an API convention.
2. **Configuration-time binding:** Agents address tools by `alias`. Credentials are resolved server-side via `secret_ref` and never enter sandboxes, checkpoints, trajectories, or model prompts.
3. **Single result status channel:** `succeeded | pending | running | failed | cancelled | unknown | rejected`; `rejected` carries no operation ID.
4. **Three-layer fencing:** Commits validate fencing token, generation, and checkpoint version (`fenced`, `stale_generation`, `version_conflict`).
5. **Deterministic command IDs:** Derived deterministically via `sha256(taskId | generation | version | index | kind | payload)` rather than random UUIDs, preventing duplicated side effects across failovers.
6. **Structural isolation:** Physical separation of tenant and agent state. Tenants are directories; agents are discrete SQLite files (Section 11).

---

## 4. Architecture Overview

```
                    ┌──────────────────────────────────────────────┐
   HTTP / SSE  ───▶ │  Router          Sticky by agentId, check    │
                    │                  residency                   │
                    ├──────────────────────────────────────────────┤
                    │  Residency       Running/Draining/Idle/Released│
                    │                  Lease + epoch + self-fencing│
                    ├──────────────────────────────────────────────┤
                    │  Kernel          Three gates / outbox / waits│
                    │  Harness         codegen | toolcall | hybrid │
                    ├───────────────┬──────────────────────────────┤
                    │  JsExecutor   │  ToolGateway                 │
                    │  QuickJS local│  ├─ fs      Restricted WS    │
                    │               │  ├─ http    Outbound allow   │
                    │               │  └─ …       Plugins          │
                    ├───────────────┴──────────────────────────────┤
                    │  LocalStore      One SQLite per agent        │
                    │  Workspace       Restricted agent directory  │
                    ├──────────────────────────────────────────────┤
                    │  Syncer          Event log push + file sync  │
                    └──────────────────────────────────────────────┘
                              │ Only when idle and fully synced
                              ▼
                         Peer Node
```

The sole new in-process long-running component is **Residency**; remaining components reuse shared interfaces.

---

## 5. Storage: One SQLite File Per Agent

### 5.1 Rationale

Rather than flattening kernel state into loose filesystem files:
- The kernel commits `checkpoint`, `cursor`, `waits`, and `outbox` records **atomically**. Loose files lack cross-record ACID transactions.
- Events require strictly monotonic sequence counters per `(tenant, agent)`.
- Replication requires precise linear sync watermarks.

Conclusion: **Kernel state = per-agent SQLite database** (WAL mode), while the **agent-visible workspace = restricted directory tree**.
Unit of migration, replication, and isolation align cleanly per agent.

### 5.2 Directory Layout

```
data/
├── index.db                       # Root routing index (Section 5.3)
├── agents/
│   └── <tenant>/<agent>/
│       ├── state.db               # Internal kernel state (hidden from agent)
│       ├── state.db-wal
│       └── workspace/             # Agent-visible files accessible via fs plugin
│           └── …
└── sync/
    └── <tenant>/<agent>/cursor    # Peer sync cursors
```

`<tenant>` and `<agent>` paths enforce strict alphanumeric whitelisting `[A-Za-z0-9._-]` with explicit rejection of `.` and `..` to prevent directory traversal.

### 5.3 LocalStore Routing

`LocalStore` routes incoming calls to per-agent `SqliteStore` instances rather than rewriting existing storage logic.
A root index (`index.db`) handles operations lacking explicit `agentId`:

```sql
CREATE TABLE agent_index (tenant_id, agent_id, created_at, PRIMARY KEY(tenant_id, agent_id));
CREATE TABLE task_index  (tenant_id, task_id,  agent_id,   PRIMARY KEY(tenant_id, task_id));
CREATE TABLE op_index    (tenant_id, operation_id, agent_id, PRIMARY KEY(tenant_id, operation_id));
```

Index misses enforce tenant isolation structurally.
File descriptor limits are managed via an LRU pool of open SQLite databases (default max 64 open handles).

### 5.4 Kernel State vs. Workspace

| Property | Kernel State (`state.db`) | Workspace (`workspace/`) |
|---|---|---|
| Visible to agent | **No** | Yes (restricted via `fs` plugin) |
| Consistency guarantee | ACID transaction + linear order | Eventual consistency |
| Replication mechanism | Monotonic event log streaming | Incremental file syncing |
| Data loss impact | Replayed via log | Files regenerated by agent |

---

## 6. Restricted Filesystem Plugin (`fs`)

Replaces cloud object storage (R2 artifacts) for self-hosted deployments while preserving identical interface contracts.

### 6.1 Tool Surface

| Tool | Parameters | Description |
|---|---|---|
| `list` | `path?`, `depth?`, `limit?` | Default `depth=1`, `limit=200` to constrain context bloat |
| `read` | `path`, `offset?`, `limit?` | Offset and slice operations execute host-side |
| `write` | `path`, `content`, `mode?` | Overwrite, append, or create; parent dirs auto-created |
| `stat` | `path` | Size, mtime, file type |
| `delete` | `path` | File deletion; recursive directory deletion requires `recursive: true` |

Explicitly omits `exec`, `chmod`, symlinks, and cross-boundary renames.

### 6.2 Security Model

Root is locked to `data/agents/<tenant>/<agent>/workspace`:
1. Reject absolute paths, null bytes, and traversal segments (`..`).
2. Verify resolved target resides strictly within base directory.
3. Path components inspected with `lstat` to prevent symlink TOCTOU attacks.
4. Quotas enforced prior to writes: max 1 MiB per file, max 64 MiB total, max 2000 files.

---

## 7. Execution: Local QuickJS

### 7.1 Engine Boundary

`src/core/execution.ts` defines `JsExecutor`. QuickJS provides in-process sandboxing without host filesystem or network access.

### 7.2 Resource Limits

- Instruction step limit via QuickJS interrupt handler (prevents infinite loops).
- Memory allocation ceilings.
- Wall-clock timeouts.
- Outbound isolation: sandbox contains no `fetch`, raw sockets, or host filesystem handles.

### 7.3 Sleep and Scheduling

Replaces Cloudflare DO alarms with an in-process min-heap priority queue keyed by `waits` deadlines.

### 7.4 Harness Hybrid Mode

Defaults to hybrid execution: direct tool invocation for routine API calls, routing to JavaScript when multi-step filtering or iterative transformation is required.

---

## 8. Residency and Migration

The central distributed systems challenge of a shared-nothing deployment.

### 8.1 Lifecycle State Machine

```
   ┌──────────┐  Request received  ┌──────────┐
   │ Released │ ─────────────────▶ │ Running  │◀─┐ New message/operation
   └──────────┘                    └────┬─────┘  │
        ▲                               │ No pending work
        │ Sync complete & lease expired ▼        │
   ┌────┴─────┐  Sync complete     ┌──────────┐  │
   │IdleSynced│◀────────────────── │IdleDirty │──┘
   └──────────┘                    └──────────┘
```

- **Running:** Active lease held. **Migration prohibited**.
- **IdleDirty:** Kernel has no active work, but outbound replication buffer has unsynced events.
- **IdleSynced:** All registered peers have acknowledged replication up to current sequence.
- **Released:** Lease expired or explicitly relinquished. Router may now assign agent to another node.

### 8.2 Single-Writer Arbitration

Shared-nothing disk architectures cannot achieve both zero-split-brain and high availability without linearizable consensus.

### 8.3 Topology Trade-offs

- **Option A (Single node):** OS file locks (`flock` on `state.db`). Zero operational overhead, no split-brain risk, no HA. Default configuration.
- **Option B (Lease + bounded clock drift + self-fencing):** Two nodes. Takeover permitted only after `now > lease_expiry + skew_max`. Requires NTP synchronization and reliable self-fencing.
- **Option C (External consensus):** Dedicated coordinator (etcd, Raft, or shared Postgres) managing leases. Strongest safety, additional operational component.

### 8.4 Self-Fencing Rules (Option B)

1. `commitAdvance` checks remaining lease validity prior to write: aborts commit if `now + margin >= leaseExpiry`.
2. ToolGateway validates lease expiration before executing external side effects.
3. Epoch recorded in event stream: nodes detecting higher remote epochs terminate local execution immediately.

---

## 9. Incremental Synchronization

### 9.1 Event Log Streaming

Kernel state is replicated by streaming monotonic event log sequences rather than synchronizing raw SQLite database files:

```
push(peer, agent):  ship events where sequence > peer.cursor
                    ship checkpoint blobs where version > peer.ckpt_version
                    ship operations rows where updated_at > peer.watermark
```

Receivers insert events by sequence idempotently (`UNIQUE(tenant_id, agent_id, sequence)`).

### 9.2 Workspace Synchronization

Workspace files replicate via incremental manifest diffs `(path, size, mtime, blake3)`.

### 9.3 Failover Sequence

1. Verify prior lease expiration + conservative clock skew allowance.
2. Restore local `state.db` and workspace directories from replicated store.
3. Append `ownership.claimed` with incremented epoch.
4. Acquire local lease under updated fencing token.
5. Replay unacknowledged outbox commands.
6. Open request routing.

---

## 10. Multi-Tenancy

Physical isolation by default:
- Kernel state: discrete SQLite files per tenant and agent.
- Workspaces: discrete directories per tenant and agent.
- Routing: indexed with required `tenant_id` compound keys.

---

## 11. Maintenance and Retention

- **Event Retention:** Automated pruning of events older than retention thresholds; completed operations moved to cold storage.
- **Execution Budgets:** Per-tenant and per-agent token limits and tool rate limits.

---

## 12. Architectural Comparison

| Dimension | Cloudflare Edition | Self-Hosted Edition |
|---|---|---|
| Single-writer enforcement | Platform-level (Durable Objects) | Local `flock` (single) / Leases (pair) |
| Cold-start overhead | Minimal | In-process daemon (zero) |
| Execution limits | Worker CPU/subrequest limits | Uncapped local hardware limits |
| Storage boundaries | DO single-object storage bounds | Local disk capacity |
| Network locality | Global edge routing | Single datacenter / on-premise |
| Operational footprint | Fully managed serverless | Self-managed process and disk |
| Data residency | Cloudflare edge network | In-perimeter local disk |
| Debuggability | Cloudflare dashboard and logs | Local `sqlite3` and filesystem inspection |

Both editions share identical core interfaces and conformance specifications.
