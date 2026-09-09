import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { StorageAdapter, StateEntry } from "../core/store.ts";
import type {
  AdvanceTxn,
  CommitResult,
  Json,
  Lease,
  ApprovalRecord,
  ModelBinding,
  MountPolicy,
  MountRecord,
  OperationRecord,
  OperationStatus,
  RuntimeEvent,
  TaskRecord,
  WaitSpec,
} from "../core/types.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- tenant_id is denormalised onto every table on purpose: §12.1 wants isolation
-- to be structural, not a join away.
CREATE TABLE IF NOT EXISTS agents (
  tenant_id TEXT NOT NULL, agent_id TEXT PRIMARY KEY,
  config TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS tasks (
  tenant_id TEXT NOT NULL, task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  status TEXT NOT NULL, generation INTEGER NOT NULL,
  checkpoint_version INTEGER NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_tenant ON tasks(tenant_id, status);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  task_id TEXT, thread_id TEXT, sequence INTEGER NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, dedup_key TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedup ON events(tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS events_seq ON events(tenant_id, agent_id, sequence);
CREATE INDEX IF NOT EXISTS events_task ON events(tenant_id, task_id, sequence);

-- Cursors live in their own record, not on the event row: consumption position
-- is per-consumer, and the plan's §7.2 model conflated the two.
CREATE TABLE IF NOT EXISTS cursors (
  tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, consumer TEXT NOT NULL,
  consumed_through INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, task_id, consumer));

CREATE TABLE IF NOT EXISTS leases (
  task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, holder TEXT NOT NULL,
  fencing_token INTEGER NOT NULL, expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS threads_agent ON threads(tenant_id, agent_id);

CREATE TABLE IF NOT EXISTS task_threads (
  tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, thread_id));

-- Command de-duplication: a retried POST must not act twice (§10.1 requestId).
CREATE TABLE IF NOT EXISTS requests (
  tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL,
  state TEXT NOT NULL, response TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, request_id));

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS outbox (
  command_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL,
  generation INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
  state TEXT NOT NULL, created_at INTEGER NOT NULL, dispatched_at INTEGER);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, created_at);

CREATE TABLE IF NOT EXISTS waits (
  wait_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL,
  generation INTEGER NOT NULL, kind TEXT NOT NULL, operation_id TEXT,
  deadline INTEGER, resolved INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS waits_op ON waits(tenant_id, operation_id, resolved);

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL, mount_alias TEXT NOT NULL, tool TEXT NOT NULL,
  tool_version TEXT NOT NULL, status TEXT NOT NULL, result_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS operations_task ON operations(tenant_id, task_id, status);

-- Config-time binding (alias -> installation + connection). The agent addresses
-- a mount; credentials never reach it.
CREATE TABLE IF NOT EXISTS model_bindings (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL, model TEXT NOT NULL, base_url TEXT NOT NULL,
  secret_ref TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id));

CREATE TABLE IF NOT EXISTS approvals (
  tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL, mount_alias TEXT NOT NULL, tool TEXT NOT NULL,
  request TEXT NOT NULL, state TEXT NOT NULL, approver TEXT, decided_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, operation_id));

CREATE TABLE IF NOT EXISTS snapshots (
  tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, through_sequence INTEGER NOT NULL,
  state TEXT NOT NULL, state_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, task_id, through_sequence));

CREATE TABLE IF NOT EXISTS quotas (
  tenant_id TEXT NOT NULL, resource TEXT NOT NULL,
  limit_value INTEGER, window_ms INTEGER,
  used INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, resource));

CREATE TABLE IF NOT EXISTS agent_state (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT, ref TEXT, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, key));

CREATE TABLE IF NOT EXISTS follow_ups (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS connections (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL,
  state TEXT NOT NULL, expires_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, alias));

CREATE TABLE IF NOT EXISTS mounts (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL,
  installation_id TEXT NOT NULL, connection_id TEXT, plugin TEXT NOT NULL,
  tool_version TEXT NOT NULL, public_config TEXT NOT NULL, secret_ref TEXT, policy TEXT,
  PRIMARY KEY (tenant_id, agent_id, alias));
`;

const now = () => Date.now();

const mapApproval = (r: any): ApprovalRecord => ({
  tenantId: r.tenant_id, operationId: r.operation_id, agentId: r.agent_id,
  taskId: r.task_id, mountAlias: r.mount_alias, tool: r.tool,
  request: JSON.parse(r.request), state: r.state, approver: r.approver ?? null,
  decidedAt: r.decided_at == null ? null : Number(r.decided_at),
  createdAt: Number(r.created_at),
});
const j = (v: Json) => JSON.stringify(v ?? null);

export class SqliteStore implements StorageAdapter {
  readonly name = "sqlite";
  #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
  }

  async init() {
    this.#db.exec(SCHEMA);
    // CREATE TABLE IF NOT EXISTS silently accepts an existing table that lacks
    // the column, so an object created before this change would never get it.
    for (const alter of [
      "ALTER TABLE tasks ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE mounts ADD COLUMN policy TEXT",
    ]) {
      try { this.#db.exec(alter); } catch { /* already present */ }
    }
    this.#db
      .prepare("INSERT OR IGNORE INTO counters(name, value) VALUES ('fencing', 0)")
      .run();
  }

  async close() {
    this.#db.close();
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  #nextCounter(name: string): number {
    this.#db
      .prepare("INSERT INTO counters(name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING")
      .run(name);
    this.#db.prepare("UPDATE counters SET value = value + 1 WHERE name = ?").run(name);
    const row = this.#db.prepare("SELECT value FROM counters WHERE name = ?").get(name) as
      | { value: number }
      | undefined;
    return row!.value;
  }

  async createAgent(tenantId: string, agentId: string, config: Json = {}) {
    this.#db
      .prepare("INSERT INTO agents(tenant_id, agent_id, config, created_at) VALUES (?,?,?,?)")
      .run(tenantId, agentId, j(config), now());
  }

  async createTask(
    tenantId: string, agentId: string, taskId: string, checkpoint: Json, stateVersion = 0,
  ) {
    this.#db
      .prepare(
        `INSERT INTO tasks(tenant_id, task_id, agent_id, status, generation,
           checkpoint_version, fencing_token, checkpoint, state_version, updated_at)
         VALUES (?,?,?,'runnable',0,0,0,?,?,?)`,
      )
      .run(tenantId, taskId, agentId, j(checkpoint), stateVersion, now());
    // The log alone cannot rebuild a task without somewhere to start.
    await this.putSnapshot(tenantId, taskId, 0, checkpoint, stateVersion);
  }

  async putSnapshot(
    tenantId: string, taskId: string, throughSequence: number, state: Json, stateVersion: number,
  ) {
    this.#db
      .prepare(
        `INSERT INTO snapshots(tenant_id, task_id, through_sequence, state, state_version, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(tenant_id, task_id, through_sequence) DO UPDATE SET
           state=excluded.state, state_version=excluded.state_version`,
      )
      .run(tenantId, taskId, throughSequence, j(state), stateVersion, now());
  }

  async pruneSnapshots(tenantId: string, taskId: string, keep: number) {
    return this.#tx(() => {
      const rows = this.#db
        .prepare("SELECT through_sequence FROM snapshots WHERE tenant_id=? AND task_id=? ORDER BY through_sequence ASC")
        .all(tenantId, taskId) as any[];
      if (rows.length <= keep + 1) return 0;
      const doomed = rows.slice(1, rows.length - keep);
      for (const r of doomed) {
        this.#db
          .prepare("DELETE FROM snapshots WHERE tenant_id=? AND task_id=? AND through_sequence=?")
          .run(tenantId, taskId, r.through_sequence);
      }
      return doomed.length;
    });
  }

  async getSnapshot(tenantId: string, taskId: string, atOrBefore = Number.MAX_SAFE_INTEGER) {
    const r = this.#db
      .prepare(
        `SELECT * FROM snapshots WHERE tenant_id=? AND task_id=? AND through_sequence <= ?
         ORDER BY through_sequence DESC LIMIT 1`,
      )
      .get(tenantId, taskId, atOrBefore) as any;
    if (!r) return null;
    return {
      throughSequence: Number(r.through_sequence),
      state: JSON.parse(r.state),
      stateVersion: Number(r.state_version),
    };
  }

  async taskEvents(tenantId: string, taskId: string, after = 0, through = Number.MAX_SAFE_INTEGER) {
    const rows = this.#db
      .prepare(
        `SELECT * FROM events WHERE tenant_id=? AND task_id=? AND sequence > ? AND sequence <= ?
         ORDER BY sequence ASC`,
      )
      .all(tenantId, taskId, after, through) as any[];
    return rows.map((r) => ({
      eventId: r.event_id, tenantId: r.tenant_id, agentId: r.agent_id, taskId: r.task_id,
      threadId: r.thread_id, sequence: Number(r.sequence), kind: r.kind,
      payload: JSON.parse(r.payload), dedupKey: r.dedup_key, createdAt: Number(r.created_at),
    }));
  }

  async loadTask(tenantId: string, taskId: string): Promise<TaskRecord | null> {
    const r = this.#db
      .prepare("SELECT * FROM tasks WHERE tenant_id = ? AND task_id = ?")
      .get(tenantId, taskId) as any;
    if (!r) return null;
    return {
      tenantId: r.tenant_id,
      agentId: r.agent_id,
      taskId: r.task_id,
      status: r.status,
      generation: r.generation,
      checkpointVersion: r.checkpoint_version,
      fencingToken: r.fencing_token,
      checkpoint: JSON.parse(r.checkpoint),
      stateVersion: Number(r.state_version ?? 0),
    };
  }

  async appendEvent(e: {
    tenantId: string;
    agentId: string;
    taskId?: string | null;
    threadId?: string | null;
    kind: string;
    payload: Json;
    dedupKey?: string | null;
  }) {
    return this.#tx(() => this.#insertEvent(e));
  }

  /** Non-transactional insert, so callers already inside #tx can reuse it. */
  #insertEvent(e: {
    tenantId: string;
    agentId: string;
    taskId?: string | null;
    threadId?: string | null;
    kind: string;
    payload: Json;
    dedupKey?: string | null;
  }): { inserted: boolean; sequence: number; eventId: string } {
    // Sequence numbers are per (tenant, agent) while consumption cursors are per
    // task. If an event for a task carried a different agent it would get its own
    // counter, land at a sequence at or below the cursor, and never be consumed —
    // a silent stall. Fail loudly instead.
    if (e.taskId) {
      const owner = this.#db
        .prepare("SELECT agent_id FROM tasks WHERE tenant_id=? AND task_id=?")
        .get(e.tenantId, e.taskId) as any;
      if (owner && owner.agent_id !== e.agentId) {
        throw new Error(
          `event agent "${e.agentId}" does not own task ${e.taskId} (owner: ${owner.agent_id})`,
        );
      }
    }
    if (e.dedupKey) {
      const dup = this.#db
        .prepare("SELECT event_id, sequence FROM events WHERE tenant_id = ? AND dedup_key = ?")
        .get(e.tenantId, e.dedupKey) as any;
      if (dup) return { inserted: false, sequence: dup.sequence, eventId: dup.event_id };
    }
    const sequence = this.#nextCounter(`seq:${e.tenantId}:${e.agentId}`);
    const eventId = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO events(event_id, tenant_id, agent_id, task_id, thread_id,
           sequence, kind, payload, dedup_key, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        e.tenantId,
        e.agentId,
        e.taskId ?? null,
        e.threadId ?? null,
        sequence,
        e.kind,
        j(e.payload),
        e.dedupKey ?? null,
        now(),
      );
    return { inserted: true, sequence, eventId };
  }

  #cursor(tenantId: string, taskId: string, consumer: string): number {
    const r = this.#db
      .prepare(
        "SELECT consumed_through FROM cursors WHERE tenant_id=? AND task_id=? AND consumer=?",
      )
      .get(tenantId, taskId, consumer) as any;
    return r ? r.consumed_through : 0;
  }

  async pendingEvents(tenantId: string, taskId: string, consumer: string): Promise<RuntimeEvent[]> {
    const from = this.#cursor(tenantId, taskId, consumer);
    const rows = this.#db
      .prepare(
        `SELECT * FROM events WHERE tenant_id=? AND task_id=? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(tenantId, taskId, from) as any[];
    return rows.map((r) => ({
      eventId: r.event_id,
      tenantId: r.tenant_id,
      agentId: r.agent_id,
      taskId: r.task_id,
      threadId: r.thread_id,
      sequence: r.sequence,
      kind: r.kind,
      payload: JSON.parse(r.payload),
      dedupKey: r.dedup_key,
      createdAt: r.created_at,
    }));
  }

  async acquireLease(
    tenantId: string,
    taskId: string,
    holder: string,
    ttlMs: number,
  ): Promise<Lease | null> {
    return this.#tx(() => {
      const t = now();
      const cur = this.#db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) as any;
      if (cur && cur.expires_at > t && cur.holder !== holder) return null;
      const token = this.#nextCounter("fencing");
      this.#db
        .prepare(
          `INSERT INTO leases(task_id, tenant_id, holder, fencing_token, expires_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(task_id) DO UPDATE SET
             holder=excluded.holder, fencing_token=excluded.fencing_token,
             expires_at=excluded.expires_at`,
        )
        .run(taskId, tenantId, holder, token, t + ttlMs);
      return { tenantId, taskId, holder, fencingToken: token, expiresAt: t + ttlMs };
    });
  }

  async commitAdvance(txn: AdvanceTxn): Promise<CommitResult> {
    return this.#tx(() => {
      const t = this.#db
        .prepare("SELECT * FROM tasks WHERE tenant_id=? AND task_id=?")
        .get(txn.tenantId, txn.taskId) as any;
      if (!t) return { ok: false, reason: "no_task" } as const;
      // Fencing first: a resurrected worker must never win, whatever else is true.
      if (txn.fencingToken < t.fencing_token) return { ok: false, reason: "fenced" } as const;
      if (txn.generation !== t.generation) return { ok: false, reason: "stale_generation" } as const;
      if (txn.expectedCheckpointVersion !== t.checkpoint_version)
        return { ok: false, reason: "version_conflict" } as const;

      const nextVersion = t.checkpoint_version + 1;
      this.#db
        .prepare(
          `UPDATE tasks SET status=?, checkpoint=?, checkpoint_version=?,
             fencing_token=?, state_version=?, updated_at=? WHERE tenant_id=? AND task_id=?`,
        )
        .run(
          txn.status,
          j(txn.checkpoint),
          nextVersion,
          txn.fencingToken,
          txn.stateVersion ?? 0,
          now(),
          txn.tenantId,
          txn.taskId,
        );

      if (txn.consumedThrough !== null) {
        this.#db
          .prepare(
            `INSERT INTO cursors(tenant_id, task_id, consumer, consumed_through)
             VALUES (?,?, 'harness', ?)
             ON CONFLICT(tenant_id, task_id, consumer) DO UPDATE SET
               consumed_through = MAX(cursors.consumed_through, excluded.consumed_through)`,
          )
          .run(txn.tenantId, txn.taskId, txn.consumedThrough);
      }

      // Resolved waits have been folded into this checkpoint; clearing them keeps
      // releaseIfNoWork() from reporting phantom work forever.
      this.#db
        .prepare("DELETE FROM waits WHERE tenant_id=? AND task_id=? AND resolved=1")
        .run(txn.tenantId, txn.taskId);

      for (const w of txn.waits) {
        this.#db
          .prepare(
            `INSERT INTO waits(wait_id, tenant_id, task_id, generation, kind, operation_id, deadline)
             VALUES (?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            txn.tenantId,
            txn.taskId,
            txn.generation,
            w.kind,
            w.operationId ?? null,
            w.deadline ?? null,
          );
      }

      // Deterministic command_id + INSERT OR IGNORE == replaying advance after a
      // pre-commit crash cannot double-dispatch.
      for (const c of txn.commands) {
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO outbox(command_id, tenant_id, task_id, generation,
               kind, payload, state, created_at)
             VALUES (?,?,?,?,?,?,'pending',?)`,
          )
          .run(c.commandId, txn.tenantId, txn.taskId, txn.generation, c.kind, j(c.payload), now());
      }
      return { ok: true, checkpointVersion: nextVersion } as const;
    });
  }

  async releaseIfNoWork(
    tenantId: string,
    taskId: string,
    fencingToken: number,
    consumer: string,
  ): Promise<"released" | "has_work" | "fenced"> {
    return this.#tx(() => {
      const lease = this.#db.prepare("SELECT * FROM leases WHERE task_id=?").get(taskId) as any;
      if (lease && lease.fencing_token > fencingToken) return "fenced" as const;
      const from = this.#cursor(tenantId, taskId, consumer);
      const pending = this.#db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE tenant_id=? AND task_id=? AND sequence > ?",
        )
        .get(tenantId, taskId, from) as any;
      if (pending.n > 0) return "has_work" as const;
      const resolved = this.#db
        .prepare(
          "SELECT COUNT(*) AS n FROM waits WHERE tenant_id=? AND task_id=? AND resolved=1",
        )
        .get(tenantId, taskId) as any;
      if (resolved.n > 0) return "has_work" as const;
      this.#db.prepare("DELETE FROM leases WHERE task_id=? AND fencing_token=?").run(taskId, fencingToken);
      return "released" as const;
    });
  }

  async claimOutbox(limit: number, tenantId?: string) {
    return this.#tx(() => {
      const rows = (tenantId
        ? this.#db.prepare(
            "SELECT * FROM outbox WHERE state='pending' AND tenant_id=? ORDER BY created_at ASC LIMIT ?",
          ).all(tenantId, limit)
        : this.#db.prepare(
            "SELECT * FROM outbox WHERE state='pending' ORDER BY created_at ASC LIMIT ?",
          ).all(limit)) as any[];
      for (const r of rows) {
        this.#db.prepare("UPDATE outbox SET state='claimed' WHERE command_id=?").run(r.command_id);
      }
      return rows.map((r) => ({
        commandId: r.command_id,
        taskId: r.task_id,
        kind: r.kind,
        payload: JSON.parse(r.payload),
      }));
    });
  }

  async markDispatched(commandId: string) {
    this.#db
      .prepare("UPDATE outbox SET state='dispatched', dispatched_at=? WHERE command_id=?")
      .run(now(), commandId);
  }

  async recordOperation(op: Omit<OperationRecord, "status" | "resultRef">) {
    this.#db
      .prepare(
        `INSERT INTO operations(operation_id, tenant_id, agent_id, task_id, mount_alias,
           tool, tool_version, status, result_ref, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'pending', NULL, ?, ?)
         ON CONFLICT(operation_id) DO NOTHING`,
      )
      .run(
        op.operationId,
        op.tenantId,
        op.agentId,
        op.taskId,
        op.mountAlias,
        op.tool,
        op.toolVersion,
        now(),
        now(),
      );
  }

  async getOperation(tenantId: string, operationId: string): Promise<OperationRecord | null> {
    const r = this.#db
      .prepare("SELECT * FROM operations WHERE tenant_id=? AND operation_id=?")
      .get(tenantId, operationId) as any;
    if (!r) return null;
    return {
      operationId: r.operation_id,
      tenantId: r.tenant_id,
      agentId: r.agent_id,
      taskId: r.task_id,
      mountAlias: r.mount_alias,
      tool: r.tool,
      toolVersion: r.tool_version,
      status: r.status,
      resultRef: r.result_ref,
    };
  }

  async completeOperation(
    tenantId: string,
    operationId: string,
    status: OperationStatus,
    resultRef: string | null,
    result?: Json,
  ) {
    this.#tx(() => {
      this.#db
        .prepare(
          "UPDATE operations SET status=?, result_ref=?, updated_at=? WHERE tenant_id=? AND operation_id=?",
        )
        .run(status, resultRef, now(), tenantId, operationId);
      this.#db
        .prepare(
          "UPDATE waits SET resolved=1 WHERE tenant_id=? AND operation_id=? AND resolved=0",
        )
        .run(tenantId, operationId);
      // Uniform wakeup: everything the harness reacts to arrives as an event.
      const op = this.#db
        .prepare("SELECT agent_id, task_id FROM operations WHERE tenant_id=? AND operation_id=?")
        .get(tenantId, operationId) as any;
      if (op) {
        this.#insertEvent({
          tenantId,
          agentId: op.agent_id,
          taskId: op.task_id,
          kind: "operation.completed",
          payload: { operationId, status, resultRef, ...(result === undefined ? {} : { result }) },
          dedupKey: `op:${operationId}:completed`,
        });
      }
    });
  }

  async registerWait(
    tenantId: string,
    taskId: string,
    generation: number,
    wait: WaitSpec,
  ): Promise<"registered" | "already_satisfied"> {
    return this.#tx(() => {
      if (wait.kind === "operation" && wait.operationId) {
        const op = this.#db
          .prepare("SELECT status FROM operations WHERE tenant_id=? AND operation_id=?")
          .get(tenantId, wait.operationId) as any;
        // Result-arrived-before-wait-registered race (§7.3).
        if (op && ["succeeded", "failed", "cancelled", "unknown"].includes(op.status)) {
          return "already_satisfied" as const;
        }
      }
      this.#db
        .prepare(
          `INSERT INTO waits(wait_id, tenant_id, task_id, generation, kind, operation_id, deadline)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          tenantId,
          taskId,
          generation,
          wait.kind,
          wait.operationId ?? null,
          wait.deadline ?? null,
        );
      return "registered" as const;
    });
  }

  async interrupt(tenantId: string, taskId: string): Promise<number> {
    return this.#tx(() => {
      this.#db
        .prepare(
          "UPDATE tasks SET generation = generation + 1, status='interrupted', updated_at=? WHERE tenant_id=? AND task_id=?",
        )
        .run(now(), tenantId, taskId);
      const r = this.#db
        .prepare("SELECT generation FROM tasks WHERE tenant_id=? AND task_id=?")
        .get(tenantId, taskId) as any;
      return r.generation as number;
    });
  }

  #mountRow(r: any): MountRecord {
    return {
      tenantId: r.tenant_id,
      agentId: r.agent_id,
      alias: r.alias,
      plugin: r.plugin,
      installationId: r.installation_id,
      connectionId: r.connection_id,
      toolVersion: r.tool_version,
      publicConfig: JSON.parse(r.public_config),
      policy: r.policy ? JSON.parse(r.policy) : null,
      secretRef: r.secret_ref,
    };
  }

  #quotaRow(tenantId: string, resource: string) {
    return this.#db
      .prepare("SELECT * FROM quotas WHERE tenant_id=? AND resource=?")
      .get(tenantId, resource) as any;
  }

  async setQuota(tenantId: string, resource: string, limit: number | null, windowMs: number | null = null) {
    this.#db
      .prepare(
        `INSERT INTO quotas(tenant_id, resource, limit_value, window_ms, used, window_start)
         VALUES (?,?,?,?,0,?)
         ON CONFLICT(tenant_id, resource) DO UPDATE SET
           limit_value=excluded.limit_value, window_ms=excluded.window_ms`,
      )
      .run(tenantId, resource, limit, windowMs, now());
  }

  async consumeQuota(tenantId: string, resource: string, amount: number) {
    return this.#tx(() => {
      const own = this.#quotaRow(tenantId, resource);
      const fallback = own?.limit_value != null ? null : this.#quotaRow("*", resource);
      const limit: number | null = own?.limit_value ?? fallback?.limit_value ?? null;
      const windowMs: number | null = own?.window_ms ?? fallback?.window_ms ?? null;
      const t = now();

      let used = Number(own?.used ?? 0);
      let windowStart = Number(own?.window_start ?? t);
      // A window that has elapsed starts over; a lifetime cap never does.
      if (windowMs != null && t - windowStart >= windowMs) { used = 0; windowStart = t; }

      if (limit != null && used + amount > limit) {
        this.#db
          .prepare(
            `INSERT INTO quotas(tenant_id, resource, limit_value, window_ms, used, window_start)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(tenant_id, resource) DO UPDATE SET used=excluded.used, window_start=excluded.window_start`,
          )
          .run(tenantId, resource, own?.limit_value ?? null, own?.window_ms ?? null, used, windowStart);
        return { allowed: false, used, limit };
      }
      used += amount;
      this.#db
        .prepare(
          `INSERT INTO quotas(tenant_id, resource, limit_value, window_ms, used, window_start)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(tenant_id, resource) DO UPDATE SET used=excluded.used, window_start=excluded.window_start`,
        )
        .run(tenantId, resource, own?.limit_value ?? null, own?.window_ms ?? null, used, windowStart);
      return { allowed: true, used, limit };
    });
  }

  async usage(tenantId: string) {
    return (this.#db.prepare("SELECT * FROM quotas WHERE tenant_id=?").all(tenantId) as any[]).map((r) => ({
      resource: r.resource, used: Number(r.used),
      limit: r.limit_value == null ? null : Number(r.limit_value),
      windowStart: Number(r.window_start),
    }));
  }

  async getConnection(tenantId: string, agentId: string, alias: string): Promise<Json | null> {
    const r = this.#db
      .prepare("SELECT state, expires_at FROM connections WHERE tenant_id=? AND agent_id=? AND alias=?")
      .get(tenantId, agentId, alias) as any;
    // An expired session is not a session: returning it would send the plugin
    // out with a token the far side has already rejected.
    if (!r || (r.expires_at != null && Number(r.expires_at) <= now())) return null;
    return JSON.parse(r.state);
  }

  // ------------------------------------------------------------ agent state

  async putState(tenantId: string, agentId: string, key: string, entry: StateEntry) {
    this.#db.prepare(
      `INSERT INTO agent_state(tenant_id, agent_id, key, value, ref, bytes, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, agent_id, key) DO UPDATE SET
           value=excluded.value, ref=excluded.ref, bytes=excluded.bytes,
           updated_at=excluded.updated_at`,
    ).run(tenantId, agentId, key, entry.value === null ? null : j(entry.value),
          entry.ref, entry.bytes, now());
  }

  async appendState(
    tenantId: string, agentId: string, key: string, text: string, maxBytes: number,
  ) {
    const prior = await this.getState(tenantId, agentId, key);
    // Appending to something that was spilled would mean fetching it back and
    // rewriting it, which is exactly the read-modify-write this exists to avoid.
    if (prior?.ref) throw new Error(`${key} is too large to append to; read it and put a new one`);
    const before = typeof prior?.value === "string" ? prior.value : "";
    const joined = before ? `${before}\n${text}` : text;
    // Keep the tail: a journal's recent end is the part worth having.
    const truncated = joined.length > maxBytes;
    const kept = truncated ? joined.slice(joined.length - maxBytes) : joined;
    await this.putState(tenantId, agentId, key, { value: kept, ref: null, bytes: kept.length });
    return { bytes: kept.length, truncated };
  }

  async getState(tenantId: string, agentId: string, key: string) {
    const r = this.#db.prepare("SELECT * FROM agent_state WHERE tenant_id=? AND agent_id=? AND key=?").get(tenantId, agentId, key) as any;
    if (!r) return null;
    return {
      value: r.value === null || r.value === undefined ? null : JSON.parse(r.value),
      ref: r.ref ?? null, bytes: Number(r.bytes), updatedAt: Number(r.updated_at),
    };
  }

  async deleteState(tenantId: string, agentId: string, key: string) {
    const had = !!this.#db.prepare("SELECT * FROM agent_state WHERE tenant_id=? AND agent_id=? AND key=?").get(tenantId, agentId, key) as any;
    this.#db.prepare("DELETE FROM agent_state WHERE tenant_id=? AND agent_id=? AND key=?").run(tenantId, agentId, key);
    return had;
  }

  async listState(tenantId: string, agentId: string, prefix = "", limit = 100) {
    return (this.#db.prepare(
      "SELECT key, bytes, ref, updated_at FROM agent_state WHERE tenant_id=? AND agent_id=? AND key LIKE ? ORDER BY key ASC LIMIT ?",
    ).all(tenantId, agentId, `${prefix}%`, limit) as any[]).map((r: any) => ({
      key: r.key, bytes: Number(r.bytes), ref: r.ref ?? null, updatedAt: Number(r.updated_at),
    }));
  }

  async stateUsage(tenantId: string, agentId: string) {
    const r = this.#db.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM agent_state WHERE tenant_id=? AND agent_id=?",
    ).get(tenantId, agentId) as any;
    return { keys: Number(r?.n ?? 0), bytes: Number(r?.b ?? 0) };
  }

  // ---------------------------------------------------------- follow-ups

  async reopenTask(tenantId: string, taskId: string): Promise<boolean> {
    const r = this.#db
      .prepare("SELECT status FROM tasks WHERE tenant_id=? AND task_id=?")
      .get(tenantId, taskId) as any;
    if (!r) return false;
    const runnable = () => {
      this.#db
        .prepare("UPDATE tasks SET status='runnable', updated_at=? WHERE tenant_id=? AND task_id=?")
        .run(now(), tenantId, taskId);
      return true;
    };
    if (["completed", "blocked"].includes(r.status)) return runnable();
    if (r.status !== "waiting") return false;
    const cmds = this.#db
      .prepare(`SELECT 1 FROM outbox WHERE tenant_id=? AND task_id=?
                  AND state IN ('pending','claimed','dispatched') LIMIT 1`)
      .get(tenantId, taskId);
    if (cmds) return false;
    const appr = this.#db
      .prepare("SELECT 1 FROM approvals WHERE tenant_id=? AND task_id=? AND state='pending' LIMIT 1")
      .get(tenantId, taskId);
    return appr ? false : runnable();
  }

  async queueFollowUp(tenantId: string, agentId: string, taskId: string, text: string) {
    this.#db.prepare(
      "INSERT INTO follow_ups(tenant_id, agent_id, task_id, text, created_at) VALUES (?,?,?,?,?)",
    ).run(tenantId, agentId, taskId, text, now());
  }

  async flushFollowUps(tenantId: string, agentId: string, taskId: string) {
    const rows = this.#db.prepare(
      "SELECT rowid, text FROM follow_ups WHERE tenant_id=? AND agent_id=? AND task_id=? ORDER BY created_at ASC, rowid ASC",
    ).all(tenantId, agentId, taskId) as any[];
    for (const r of rows) {
      await this.appendEvent({
        tenantId, agentId, taskId, kind: "message",
        payload: { text: (r as any).text, followUp: true },
      });
    }
    if (rows.length) this.#db.prepare("DELETE FROM follow_ups WHERE tenant_id=? AND agent_id=? AND task_id=?").run(tenantId, agentId, taskId);
    return rows.length;
  }

  async putConnection(
    tenantId: string, agentId: string, alias: string, state: Json, expiresAt: number | null = null,
  ) {
    this.#db
      .prepare(
        `INSERT INTO connections(tenant_id, agent_id, alias, state, expires_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(tenant_id, agent_id, alias) DO UPDATE SET
           state=excluded.state, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
      )
      .run(tenantId, agentId, alias, j(state), expiresAt, now());
  }

  async setModelBinding(b: ModelBinding) {
    this.#db
      .prepare(
        `INSERT INTO model_bindings(tenant_id, agent_id, provider, model, base_url, secret_ref, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
           provider=excluded.provider, model=excluded.model, base_url=excluded.base_url,
           secret_ref=excluded.secret_ref, updated_at=excluded.updated_at`,
      )
      .run(b.tenantId, b.agentId ?? "", b.provider, b.model, b.baseUrl, b.secretRef, now());
  }

  async getModelBinding(tenantId: string, agentId: string): Promise<ModelBinding | null> {
    // Most specific wins: the agent's own row, else the tenant default.
    const rows = this.#db
      .prepare("SELECT * FROM model_bindings WHERE tenant_id=? AND (agent_id=? OR agent_id='')")
      .all(tenantId, agentId) as any[];
    const pick = rows.find((r: any) => r.agent_id === agentId) ?? rows.find((r: any) => r.agent_id === "");
    if (!pick) return null;
    return {
      tenantId: pick.tenant_id, agentId: pick.agent_id === "" ? null : pick.agent_id,
      provider: pick.provider, model: pick.model, baseUrl: pick.base_url, secretRef: pick.secret_ref,
    };
  }

  async requireApproval(a: Omit<ApprovalRecord, "state" | "approver" | "decidedAt" | "createdAt">) {
    this.#db
      .prepare(
        `INSERT INTO approvals(tenant_id, operation_id, agent_id, task_id, mount_alias, tool,
           request, state, approver, decided_at, created_at)
         VALUES (?,?,?,?,?,?,?,'pending',NULL,NULL,?)
         ON CONFLICT(tenant_id, operation_id) DO NOTHING`,
      )
      .run(a.tenantId, a.operationId, a.agentId, a.taskId, a.mountAlias, a.tool, j(a.request), now());
  }

  async getApproval(tenantId: string, operationId: string): Promise<ApprovalRecord | null> {
    const r = this.#db
      .prepare("SELECT * FROM approvals WHERE tenant_id=? AND operation_id=?")
      .get(tenantId, operationId) as any;
    return r ? mapApproval(r) : null;
  }

  async decideApproval(
    tenantId: string, operationId: string, decision: "approved" | "denied", approver: string,
  ) {
    return this.#tx(() => {
      const r = this.#db
        .prepare("SELECT * FROM approvals WHERE tenant_id=? AND operation_id=?")
        .get(tenantId, operationId) as any;
      if (!r) return { ok: false as const, reason: "not_found" as const };
      // Deciding twice would let one approval authorise two executions.
      if (r.state !== "pending") return { ok: false as const, reason: "already_decided" as const };
      this.#db
        .prepare("UPDATE approvals SET state=?, approver=?, decided_at=? WHERE tenant_id=? AND operation_id=?")
        .run(decision, approver, now(), tenantId, operationId);
      return { ok: true as const, record: mapApproval({ ...r, state: decision, approver, decided_at: now() }) };
    });
  }

  async listApprovals(tenantId: string, state?: "pending" | "approved" | "denied") {
    const rows = state
      ? this.#db.prepare("SELECT * FROM approvals WHERE tenant_id=? AND state=? ORDER BY created_at ASC").all(tenantId, state)
      : this.#db.prepare("SELECT * FROM approvals WHERE tenant_id=? ORDER BY created_at ASC").all(tenantId);
    return (rows as any[]).map(mapApproval);
  }

  async addMount(m: MountRecord) {
    this.#db
      .prepare(
        `INSERT INTO mounts(tenant_id, agent_id, alias, installation_id, connection_id,
           plugin, tool_version, public_config, secret_ref, policy)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.tenantId, m.agentId, m.alias, m.installationId, m.connectionId,
        m.plugin, m.toolVersion, j(m.publicConfig), m.secretRef,
        m.policy ? j(m.policy) : null,
      );
  }

  async updateMountPolicy(
    tenantId: string, agentId: string, alias: string, policy: MountPolicy | null,
  ) {
    const r = this.#db
      .prepare("UPDATE mounts SET policy=? WHERE tenant_id=? AND agent_id=? AND alias=?")
      .run(policy ? j(policy) : null, tenantId, agentId, alias);
    return Number(r.changes) > 0;
  }

  async updateMountConfig(tenantId: string, agentId: string, alias: string, publicConfig: Json) {
    const r = this.#db
      .prepare("UPDATE mounts SET public_config=? WHERE tenant_id=? AND agent_id=? AND alias=?")
      .run(j(publicConfig), tenantId, agentId, alias);
    return Number(r.changes) > 0;
  }

  async getMountByAlias(tenantId: string, agentId: string, alias: string) {
    const r = this.#db
      .prepare("SELECT * FROM mounts WHERE tenant_id=? AND agent_id=? AND alias=?")
      .get(tenantId, agentId, alias) as any;
    return r ? this.#mountRow(r) : null;
  }

  async findMountsByPlugin(tenantId: string, agentId: string, plugin: string) {
    return (
      this.#db
        .prepare("SELECT * FROM mounts WHERE tenant_id=? AND agent_id=? AND plugin=? ORDER BY alias")
        .all(tenantId, agentId, plugin) as any[]
    ).map((r) => this.#mountRow(r));
  }

  async listMounts(tenantId: string, agentId: string) {
    return (
      this.#db
        .prepare("SELECT * FROM mounts WHERE tenant_id=? AND agent_id=? ORDER BY alias")
        .all(tenantId, agentId) as any[]
    ).map((r) => this.#mountRow(r));
  }

  async createThread(tenantId: string, agentId: string, threadId: string, metadata: Json = {}) {
    this.#db
      .prepare("INSERT INTO threads(thread_id, tenant_id, agent_id, metadata, created_at) VALUES (?,?,?,?,?)")
      .run(threadId, tenantId, agentId, j(metadata), now());
  }

  async getThread(tenantId: string, threadId: string) {
    const r = this.#db
      .prepare("SELECT * FROM threads WHERE tenant_id=? AND thread_id=?")
      .get(tenantId, threadId) as any;
    return r ? { threadId: r.thread_id, tenantId: r.tenant_id, agentId: r.agent_id, metadata: JSON.parse(r.metadata) } : null;
  }

  async linkTaskThread(tenantId: string, taskId: string, threadId: string) {
    this.#db
      .prepare("INSERT OR IGNORE INTO task_threads(tenant_id, task_id, thread_id) VALUES (?,?,?)")
      .run(tenantId, taskId, threadId);
  }

  async listTasks(tenantId: string, agentId: string) {
    return (
      this.#db
        .prepare("SELECT * FROM tasks WHERE tenant_id=? AND agent_id=? ORDER BY updated_at DESC")
        .all(tenantId, agentId) as any[]
    ).map((r) => ({
      taskId: r.task_id, status: r.status, generation: r.generation,
      checkpointVersion: r.checkpoint_version, updatedAt: r.updated_at,
    }));
  }

  /** Everything the scheduler needs to know: which tasks have unconsumed work. */
  async tasksWithPendingWork(limit = 50) {
    return (
      this.#db
        .prepare(
          `SELECT DISTINCT t.tenant_id, t.task_id FROM tasks t
             JOIN events e ON e.tenant_id = t.tenant_id AND e.task_id = t.task_id
             LEFT JOIN cursors c ON c.tenant_id = t.tenant_id AND c.task_id = t.task_id
                                AND c.consumer = 'harness'
                    -- blocked is excluded for the same reason completed is: a blocked task
        -- cannot consume its events, so leaving it here made the drain pick it
        -- up, fail the same way, and pick it up again -- a loop that feeds
        -- itself, since the record of being blocked is itself an event.
        -- Something outside has to unblock it (a decision, a message), which is
        -- what reopenTask does.
        WHERE t.status NOT IN ('completed','failed','blocked')
              AND e.sequence > COALESCE(c.consumed_through, 0)
            LIMIT ?`,
        )
        .all(limit) as any[]
    ).map((r) => ({ tenantId: r.tenant_id, taskId: r.task_id }));
  }

  async eventsSince(tenantId: string, agentId: string, after: number, limit = 200) {
    return (
      this.#db
        .prepare(
          `SELECT * FROM events WHERE tenant_id=? AND agent_id=? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(tenantId, agentId, after, limit) as any[]
    ).map((r) => ({
      eventId: r.event_id, sequence: r.sequence, kind: r.kind, taskId: r.task_id,
      threadId: r.thread_id, payload: JSON.parse(r.payload), createdAt: r.created_at,
    }));
  }

  async oldestEventSequence(tenantId: string, agentId: string): Promise<number> {
    const r = this.#db
      .prepare("SELECT MIN(sequence) AS s FROM events WHERE tenant_id=? AND agent_id=?")
      .get(tenantId, agentId) as any;
    return r?.s ?? 0;
  }

  /** Claims a request id. Returns null when this caller won the claim, or the
   *  prior record (pending or done) when someone already has it. */
  async claimRequest(
    tenantId: string,
    requestId: string,
    kind: string,
  ): Promise<{ state: "pending" | "done"; response: Json } | null> {
    return this.#tx(() => {
      const prior = this.#db
        .prepare("SELECT state, response FROM requests WHERE tenant_id=? AND request_id=?")
        .get(tenantId, requestId) as any;
      if (prior) {
        return { state: prior.state, response: prior.response ? JSON.parse(prior.response) : null };
      }
      this.#db
        .prepare(
          "INSERT INTO requests(tenant_id, request_id, kind, state, response, created_at) VALUES (?,?,?,'pending',NULL,?)",
        )
        .run(tenantId, requestId, kind, now());
      return null;
    });
  }

  async finishRequest(tenantId: string, requestId: string, response: Json) {
    this.#db
      .prepare("UPDATE requests SET state='done', response=? WHERE tenant_id=? AND request_id=?")
      .run(j(response), tenantId, requestId);
  }

  async interruptAgent(tenantId: string, agentId: string): Promise<string[]> {
    return this.#tx(() => {
      const rows = this.#db
        .prepare(
          "SELECT task_id FROM tasks WHERE tenant_id=? AND agent_id=? AND status NOT IN ('completed','failed')",
        )
        .all(tenantId, agentId) as any[];
      for (const r of rows) {
        this.#db
          .prepare(
            "UPDATE tasks SET generation = generation + 1, status='interrupted', updated_at=? WHERE tenant_id=? AND task_id=?",
          )
          .run(now(), tenantId, r.task_id);
      }
      return rows.map((r) => r.task_id as string);
    });
  }
}
