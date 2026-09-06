import type { StorageAdapter } from "../core/store.ts";
import type {
  AdvanceTxn, CommitResult, Json, Lease, MountRecord, OperationRecord,
  OperationStatus, RuntimeEvent, TaskRecord, WaitSpec,
} from "../core/types.ts";

/**
 * Durable Object SQLite backend. Same schema and same guards as the sqlite
 * backend; the difference is that storage lives inside the object, so an advance
 * costs no network round trips at all.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agents (
     tenant_id TEXT NOT NULL, agent_id TEXT PRIMARY KEY, config TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (
     tenant_id TEXT NOT NULL, task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL,
     generation INTEGER NOT NULL, checkpoint_version INTEGER NOT NULL,
     fencing_token INTEGER NOT NULL DEFAULT 0, checkpoint TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tasks_tenant ON tasks(tenant_id, status)`,
  `CREATE TABLE IF NOT EXISTS events (
     event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT,
     thread_id TEXT, sequence INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
     dedup_key TEXT, created_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS events_dedup ON events(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS events_seq ON events(tenant_id, agent_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS events_task ON events(tenant_id, task_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS cursors (
     tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, consumer TEXT NOT NULL,
     consumed_through INTEGER NOT NULL, PRIMARY KEY (tenant_id, task_id, consumer))`,
  `CREATE TABLE IF NOT EXISTS leases (
     task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, holder TEXT NOT NULL,
     fencing_token INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS outbox (
     command_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL,
     kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
     dispatched_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, created_at)`,
  `CREATE TABLE IF NOT EXISTS waits (
     wait_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL,
     kind TEXT NOT NULL, operation_id TEXT, deadline INTEGER, resolved INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS waits_op ON waits(tenant_id, operation_id, resolved)`,
  `CREATE TABLE IF NOT EXISTS operations (
     operation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL,
     mount_alias TEXT NOT NULL, tool TEXT NOT NULL, tool_version TEXT NOT NULL, status TEXT NOT NULL,
     result_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS operations_task ON operations(tenant_id, task_id, status)`,
  `CREATE TABLE IF NOT EXISTS mounts (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL, installation_id TEXT NOT NULL,
     connection_id TEXT, plugin TEXT NOT NULL, tool_version TEXT NOT NULL, public_config TEXT NOT NULL,
     secret_ref TEXT, PRIMARY KEY (tenant_id, agent_id, alias))`,
];

const j = (v: Json) => JSON.stringify(v ?? null);

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
type Ctx = { storage: { sql: Sql; transactionSync<T>(cb: () => T): T } };

export class DurableObjectStore implements StorageAdapter {
  readonly name = "durable-object";
  #ctx: Ctx;
  #sql: Sql;
  #now: () => number;

  constructor(ctx: Ctx, opts: { now?: () => number } = {}) {
    this.#ctx = ctx;
    this.#sql = ctx.storage.sql;
    this.#now = opts.now ?? (() => Date.now());
  }

  async init() {
    for (const stmt of SCHEMA) this.#sql.exec(stmt);
    this.#sql.exec("INSERT OR IGNORE INTO counters(name, value) VALUES ('fencing', 0)");
  }

  async close() {
    /* storage is the object; nothing to release */
  }

  #all(q: string, ...b: unknown[]) { return this.#sql.exec(q, ...b).toArray(); }
  #one(q: string, ...b: unknown[]) { return this.#all(q, ...b)[0]; }
  #tx<T>(fn: () => T): T { return this.#ctx.storage.transactionSync(fn); }

  #nextCounter(name: string): number {
    this.#sql.exec("INSERT OR IGNORE INTO counters(name, value) VALUES (?, 0)", name);
    this.#sql.exec("UPDATE counters SET value = value + 1 WHERE name = ?", name);
    return Number(this.#one("SELECT value FROM counters WHERE name = ?", name).value);
  }

  async createAgent(tenantId: string, agentId: string, config: Json = {}) {
    this.#sql.exec("INSERT INTO agents(tenant_id, agent_id, config, created_at) VALUES (?,?,?,?)",
      tenantId, agentId, j(config), this.#now());
  }

  async createTask(tenantId: string, agentId: string, taskId: string, checkpoint: Json) {
    this.#sql.exec(
      `INSERT INTO tasks(tenant_id, task_id, agent_id, status, generation, checkpoint_version,
         fencing_token, checkpoint, updated_at) VALUES (?,?,?,'runnable',0,0,0,?,?)`,
      tenantId, taskId, agentId, j(checkpoint), this.#now());
  }

  async loadTask(tenantId: string, taskId: string): Promise<TaskRecord | null> {
    const r = this.#one("SELECT * FROM tasks WHERE tenant_id=? AND task_id=?", tenantId, taskId);
    if (!r) return null;
    return {
      tenantId: r.tenant_id, agentId: r.agent_id, taskId: r.task_id, status: r.status,
      generation: Number(r.generation), checkpointVersion: Number(r.checkpoint_version),
      fencingToken: Number(r.fencing_token), checkpoint: JSON.parse(r.checkpoint),
    };
  }

  #insertEvent(e: any) {
    if (e.taskId) {
      const owner = this.#one("SELECT agent_id FROM tasks WHERE tenant_id=? AND task_id=?", e.tenantId, e.taskId);
      if (owner && owner.agent_id !== e.agentId) {
        throw new Error(`event agent "${e.agentId}" does not own task ${e.taskId}`);
      }
    }
    if (e.dedupKey) {
      const dup = this.#one("SELECT event_id, sequence FROM events WHERE tenant_id=? AND dedup_key=?",
        e.tenantId, e.dedupKey);
      if (dup) return { inserted: false, sequence: Number(dup.sequence), eventId: dup.event_id };
    }
    const sequence = this.#nextCounter(`seq:${e.tenantId}:${e.agentId}`);
    const eventId = crypto.randomUUID();
    this.#sql.exec(
      `INSERT INTO events(event_id, tenant_id, agent_id, task_id, thread_id, sequence, kind, payload,
         dedup_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      eventId, e.tenantId, e.agentId, e.taskId ?? null, e.threadId ?? null, sequence, e.kind,
      j(e.payload), e.dedupKey ?? null, this.#now());
    return { inserted: true, sequence, eventId };
  }

  async appendEvent(e: any) { return this.#tx(() => this.#insertEvent(e)); }

  #cursor(tenantId: string, taskId: string, consumer: string): number {
    const r = this.#one(
      "SELECT consumed_through FROM cursors WHERE tenant_id=? AND task_id=? AND consumer=?",
      tenantId, taskId, consumer);
    return r ? Number(r.consumed_through) : 0;
  }

  async pendingEvents(tenantId: string, taskId: string, consumer: string): Promise<RuntimeEvent[]> {
    const from = this.#cursor(tenantId, taskId, consumer);
    return this.#all(
      "SELECT * FROM events WHERE tenant_id=? AND task_id=? AND sequence > ? ORDER BY sequence ASC",
      tenantId, taskId, from,
    ).map((r) => ({
      eventId: r.event_id, tenantId: r.tenant_id, agentId: r.agent_id, taskId: r.task_id,
      threadId: r.thread_id, sequence: Number(r.sequence), kind: r.kind,
      payload: JSON.parse(r.payload), dedupKey: r.dedup_key, createdAt: Number(r.created_at),
    }));
  }

  async acquireLease(tenantId: string, taskId: string, holder: string, ttlMs: number): Promise<Lease | null> {
    return this.#tx(() => {
      const t = this.#now();
      const cur = this.#one("SELECT * FROM leases WHERE task_id = ?", taskId);
      if (cur && Number(cur.expires_at) > t && cur.holder !== holder) return null;
      const token = this.#nextCounter("fencing");
      this.#sql.exec(
        `INSERT INTO leases(task_id, tenant_id, holder, fencing_token, expires_at) VALUES (?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET holder=excluded.holder,
           fencing_token=excluded.fencing_token, expires_at=excluded.expires_at`,
        taskId, tenantId, holder, token, t + ttlMs);
      return { tenantId, taskId, holder, fencingToken: token, expiresAt: t + ttlMs };
    });
  }

  async commitAdvance(txn: AdvanceTxn): Promise<CommitResult> {
    return this.#tx(() => {
      const t = this.#one("SELECT * FROM tasks WHERE tenant_id=? AND task_id=?", txn.tenantId, txn.taskId);
      if (!t) return { ok: false, reason: "no_task" } as const;
      if (txn.fencingToken < Number(t.fencing_token)) return { ok: false, reason: "fenced" } as const;
      if (txn.generation !== Number(t.generation)) return { ok: false, reason: "stale_generation" } as const;
      if (txn.expectedCheckpointVersion !== Number(t.checkpoint_version))
        return { ok: false, reason: "version_conflict" } as const;

      const nextVersion = Number(t.checkpoint_version) + 1;
      this.#sql.exec(
        `UPDATE tasks SET status=?, checkpoint=?, checkpoint_version=?, fencing_token=?, updated_at=?
         WHERE tenant_id=? AND task_id=?`,
        txn.status, j(txn.checkpoint), nextVersion, txn.fencingToken, this.#now(),
        txn.tenantId, txn.taskId);

      if (txn.consumedThrough !== null) {
        this.#sql.exec(
          `INSERT INTO cursors(tenant_id, task_id, consumer, consumed_through) VALUES (?,?,'harness',?)
           ON CONFLICT(tenant_id, task_id, consumer) DO UPDATE SET
             consumed_through = MAX(cursors.consumed_through, excluded.consumed_through)`,
          txn.tenantId, txn.taskId, txn.consumedThrough);
      }
      this.#sql.exec("DELETE FROM waits WHERE tenant_id=? AND task_id=? AND resolved=1",
        txn.tenantId, txn.taskId);
      for (const w of txn.waits) {
        this.#sql.exec(
          `INSERT INTO waits(wait_id, tenant_id, task_id, generation, kind, operation_id, deadline)
           VALUES (?,?,?,?,?,?,?)`,
          crypto.randomUUID(), txn.tenantId, txn.taskId, txn.generation, w.kind,
          w.operationId ?? null, w.deadline ?? null);
      }
      for (const c of txn.commands) {
        this.#sql.exec(
          `INSERT OR IGNORE INTO outbox(command_id, tenant_id, task_id, generation, kind, payload,
             state, created_at) VALUES (?,?,?,?,?,?,'pending',?)`,
          c.commandId, txn.tenantId, txn.taskId, txn.generation, c.kind, j(c.payload), this.#now());
      }
      return { ok: true, checkpointVersion: nextVersion } as const;
    });
  }

  async releaseIfNoWork(tenantId: string, taskId: string, fencingToken: number, consumer: string) {
    return this.#tx(() => {
      const lease = this.#one("SELECT * FROM leases WHERE task_id=?", taskId);
      if (lease && Number(lease.fencing_token) > fencingToken) return "fenced" as const;
      const from = this.#cursor(tenantId, taskId, consumer);
      const pending = this.#one(
        "SELECT COUNT(*) AS n FROM events WHERE tenant_id=? AND task_id=? AND sequence > ?",
        tenantId, taskId, from);
      if (Number(pending.n) > 0) return "has_work" as const;
      const resolved = this.#one(
        "SELECT COUNT(*) AS n FROM waits WHERE tenant_id=? AND task_id=? AND resolved=1", tenantId, taskId);
      if (Number(resolved.n) > 0) return "has_work" as const;
      this.#sql.exec("DELETE FROM leases WHERE task_id=? AND fencing_token=?", taskId, fencingToken);
      return "released" as const;
    });
  }

  async claimOutbox(limit: number, tenantId?: string) {
    return this.#tx(() => {
      const rows = tenantId
        ? this.#all("SELECT * FROM outbox WHERE state='pending' AND tenant_id=? ORDER BY created_at ASC LIMIT ?",
            tenantId, limit)
        : this.#all("SELECT * FROM outbox WHERE state='pending' ORDER BY created_at ASC LIMIT ?", limit);
      for (const r of rows) this.#sql.exec("UPDATE outbox SET state='claimed' WHERE command_id=?", r.command_id);
      return rows.map((r) => ({
        commandId: r.command_id, taskId: r.task_id, kind: r.kind, payload: JSON.parse(r.payload),
      }));
    });
  }

  async markDispatched(commandId: string) {
    this.#sql.exec("UPDATE outbox SET state='dispatched', dispatched_at=? WHERE command_id=?",
      this.#now(), commandId);
  }

  async recordOperation(op: Omit<OperationRecord, "status" | "resultRef">) {
    this.#sql.exec(
      `INSERT INTO operations(operation_id, tenant_id, agent_id, task_id, mount_alias, tool, tool_version,
         status, result_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'pending',NULL,?,?)`,
      op.operationId, op.tenantId, op.agentId, op.taskId, op.mountAlias, op.tool, op.toolVersion,
      this.#now(), this.#now());
  }

  async getOperation(tenantId: string, operationId: string): Promise<OperationRecord | null> {
    const r = this.#one("SELECT * FROM operations WHERE tenant_id=? AND operation_id=?", tenantId, operationId);
    if (!r) return null;
    return {
      operationId: r.operation_id, tenantId: r.tenant_id, agentId: r.agent_id, taskId: r.task_id,
      mountAlias: r.mount_alias, tool: r.tool, toolVersion: r.tool_version, status: r.status,
      resultRef: r.result_ref,
    };
  }

  async completeOperation(tenantId: string, operationId: string, status: OperationStatus, resultRef: string | null) {
    this.#tx(() => {
      this.#sql.exec(
        "UPDATE operations SET status=?, result_ref=?, updated_at=? WHERE tenant_id=? AND operation_id=?",
        status, resultRef, this.#now(), tenantId, operationId);
      this.#sql.exec("UPDATE waits SET resolved=1 WHERE tenant_id=? AND operation_id=? AND resolved=0",
        tenantId, operationId);
      const op = this.#one("SELECT agent_id, task_id FROM operations WHERE tenant_id=? AND operation_id=?",
        tenantId, operationId);
      if (op) {
        this.#insertEvent({
          tenantId, agentId: op.agent_id, taskId: op.task_id, kind: "operation.completed",
          payload: { operationId, status, resultRef }, dedupKey: `op:${operationId}:completed`,
        });
      }
    });
  }

  async registerWait(tenantId: string, taskId: string, generation: number, wait: WaitSpec) {
    return this.#tx(() => {
      if (wait.kind === "operation" && wait.operationId) {
        const op = this.#one("SELECT status FROM operations WHERE tenant_id=? AND operation_id=?",
          tenantId, wait.operationId);
        if (op && ["succeeded", "failed", "cancelled", "unknown"].includes(op.status)) {
          return "already_satisfied" as const;
        }
      }
      this.#sql.exec(
        `INSERT INTO waits(wait_id, tenant_id, task_id, generation, kind, operation_id, deadline)
         VALUES (?,?,?,?,?,?,?)`,
        crypto.randomUUID(), tenantId, taskId, generation, wait.kind,
        wait.operationId ?? null, wait.deadline ?? null);
      return "registered" as const;
    });
  }

  async interrupt(tenantId: string, taskId: string): Promise<number> {
    return this.#tx(() => {
      this.#sql.exec(
        "UPDATE tasks SET generation = generation + 1, status='interrupted', updated_at=? WHERE tenant_id=? AND task_id=?",
        this.#now(), tenantId, taskId);
      return Number(this.#one("SELECT generation FROM tasks WHERE tenant_id=? AND task_id=?",
        tenantId, taskId).generation);
    });
  }

  #mount(r: any): MountRecord {
    return {
      tenantId: r.tenant_id, agentId: r.agent_id, alias: r.alias, plugin: r.plugin,
      installationId: r.installation_id, connectionId: r.connection_id, toolVersion: r.tool_version,
      publicConfig: JSON.parse(r.public_config), secretRef: r.secret_ref,
    };
  }

  async addMount(m: MountRecord) {
    this.#sql.exec(
      `INSERT INTO mounts(tenant_id, agent_id, alias, installation_id, connection_id, plugin,
         tool_version, public_config, secret_ref) VALUES (?,?,?,?,?,?,?,?,?)`,
      m.tenantId, m.agentId, m.alias, m.installationId, m.connectionId, m.plugin, m.toolVersion,
      j(m.publicConfig), m.secretRef);
  }

  async getMountByAlias(tenantId: string, agentId: string, alias: string) {
    const r = this.#one("SELECT * FROM mounts WHERE tenant_id=? AND agent_id=? AND alias=?",
      tenantId, agentId, alias);
    return r ? this.#mount(r) : null;
  }

  async findMountsByPlugin(tenantId: string, agentId: string, plugin: string) {
    return this.#all("SELECT * FROM mounts WHERE tenant_id=? AND agent_id=? AND plugin=? ORDER BY alias",
      tenantId, agentId, plugin).map((r) => this.#mount(r));
  }

  async listMounts(tenantId: string, agentId: string) {
    return this.#all("SELECT * FROM mounts WHERE tenant_id=? AND agent_id=? ORDER BY alias",
      tenantId, agentId).map((r) => this.#mount(r));
  }
}
