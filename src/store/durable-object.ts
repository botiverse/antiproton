import type { StorageAdapter, StateEntry } from "../core/store.ts";
import type {
  AdvanceTxn, ApprovalRecord, CommitResult, Json, Lease, ModelBinding, MountPolicy, MountRecord,
  OperationRecord, OperationStatus, RuntimeEvent, TaskRecord, WaitSpec,
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
     fencing_token INTEGER NOT NULL DEFAULT 0, checkpoint TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
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
`CREATE TABLE IF NOT EXISTS model_bindings (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL, model TEXT NOT NULL, base_url TEXT NOT NULL,
  secret_ref TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id));`,
  `CREATE TABLE IF NOT EXISTS approvals (
  tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL, mount_alias TEXT NOT NULL, tool TEXT NOT NULL,
  request TEXT NOT NULL, state TEXT NOT NULL, approver TEXT, decided_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, operation_id));`,
  `CREATE TABLE IF NOT EXISTS snapshots (
  tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, through_sequence INTEGER NOT NULL,
  state TEXT NOT NULL, state_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, task_id, through_sequence));`,
  `CREATE TABLE IF NOT EXISTS quotas (
  tenant_id TEXT NOT NULL, resource TEXT NOT NULL,
  limit_value INTEGER, window_ms INTEGER,
  used INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, resource));`,
  `CREATE TABLE IF NOT EXISTS agent_state (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, key TEXT NOT NULL,
     value TEXT, ref TEXT, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (tenant_id, agent_id, key))`,
  `CREATE TABLE IF NOT EXISTS connections (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL,
  state TEXT NOT NULL, expires_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, alias));`,
    `CREATE TABLE IF NOT EXISTS mounts (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL, installation_id TEXT NOT NULL,
     connection_id TEXT, plugin TEXT NOT NULL, tool_version TEXT NOT NULL, public_config TEXT NOT NULL,
     secret_ref TEXT, policy TEXT, PRIMARY KEY (tenant_id, agent_id, alias))`,
];

const j = (v: Json) => JSON.stringify(v ?? null);

const mapApproval = (r: any): ApprovalRecord => ({
  tenantId: r.tenant_id, operationId: r.operation_id, agentId: r.agent_id,
  taskId: r.task_id, mountAlias: r.mount_alias, tool: r.tool,
  request: JSON.parse(r.request), state: r.state, approver: r.approver ?? null,
  decidedAt: r.decided_at == null ? null : Number(r.decided_at),
  createdAt: Number(r.created_at),
});

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
    // Columns added after a table already exists are invisible to
    // CREATE TABLE IF NOT EXISTS; each ALTER is idempotent by trial.
    for (const alter of [
      "ALTER TABLE tasks ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE mounts ADD COLUMN policy TEXT",
    ]) {
      try { this.#sql.exec(alter); } catch { /* already present */ }
    }

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

  async createTask(
    tenantId: string, agentId: string, taskId: string, checkpoint: Json, stateVersion = 0,
  ) {
    this.#sql.exec(
      `INSERT INTO tasks(tenant_id, task_id, agent_id, status, generation, checkpoint_version,
         fencing_token, checkpoint, state_version, updated_at) VALUES (?,?,?,'runnable',0,0,0,?,?,?)`,
      tenantId, taskId, agentId, j(checkpoint), stateVersion, this.#now());
    // The log alone cannot rebuild a task without somewhere to start.
    await this.putSnapshot(tenantId, taskId, 0, checkpoint, stateVersion);
  }

  async putSnapshot(
    tenantId: string, taskId: string, throughSequence: number, state: Json, stateVersion: number,
  ) {
    this.#sql.exec(
      `INSERT INTO snapshots(tenant_id, task_id, through_sequence, state, state_version, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(tenant_id, task_id, through_sequence) DO UPDATE SET
         state=excluded.state, state_version=excluded.state_version`,
      tenantId, taskId, throughSequence, j(state), stateVersion, this.#now());
  }

  async pruneSnapshots(tenantId: string, taskId: string, keep: number) {
    return this.#tx(() => {
      const rows = this.#all(
        "SELECT through_sequence FROM snapshots WHERE tenant_id=? AND task_id=? ORDER BY through_sequence ASC",
        tenantId, taskId) as any[];
      if (rows.length <= keep + 1) return 0;
      const doomed = rows.slice(1, rows.length - keep);
      for (const r of doomed) {
        this.#sql.exec("DELETE FROM snapshots WHERE tenant_id=? AND task_id=? AND through_sequence=?",
          tenantId, taskId, r.through_sequence);
      }
      return doomed.length;
    });
  }

  async getSnapshot(tenantId: string, taskId: string, atOrBefore = Number.MAX_SAFE_INTEGER) {
    const r = this.#one(
      `SELECT * FROM snapshots WHERE tenant_id=? AND task_id=? AND through_sequence <= ?
       ORDER BY through_sequence DESC LIMIT 1`,
      tenantId, taskId, atOrBefore);
    if (!r) return null;
    return {
      throughSequence: Number(r.through_sequence),
      state: JSON.parse(r.state),
      stateVersion: Number(r.state_version),
    };
  }

  async taskEvents(tenantId: string, taskId: string, after = 0, through = Number.MAX_SAFE_INTEGER) {
    return this.#all(
      `SELECT * FROM events WHERE tenant_id=? AND task_id=? AND sequence > ? AND sequence <= ?
       ORDER BY sequence ASC`,
      tenantId, taskId, after, through,
    ).map((r: any) => ({
      eventId: r.event_id, tenantId: r.tenant_id, agentId: r.agent_id, taskId: r.task_id,
      threadId: r.thread_id, sequence: Number(r.sequence), kind: r.kind,
      payload: JSON.parse(r.payload), dedupKey: r.dedup_key, createdAt: Number(r.created_at),
    }));
  }

  async loadTask(tenantId: string, taskId: string): Promise<TaskRecord | null> {
    const r = this.#one("SELECT * FROM tasks WHERE tenant_id=? AND task_id=?", tenantId, taskId);
    if (!r) return null;
    return {
      tenantId: r.tenant_id, agentId: r.agent_id, taskId: r.task_id, status: r.status,
      generation: Number(r.generation), checkpointVersion: Number(r.checkpoint_version),
      fencingToken: Number(r.fencing_token), checkpoint: JSON.parse(r.checkpoint),
      stateVersion: Number(r.state_version ?? 0),
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
        `UPDATE tasks SET status=?, checkpoint=?, checkpoint_version=?, fencing_token=?,
           state_version=?, updated_at=? WHERE tenant_id=? AND task_id=?`,
        txn.status, j(txn.checkpoint), nextVersion, txn.fencingToken, txn.stateVersion ?? 0,
        this.#now(), txn.tenantId, txn.taskId);

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
      // Stamp the claim too: a dispatch that throws leaves the row 'claimed'
      // for ever, and claimOutbox only ever looks at 'pending'.
      for (const r of rows) {
        this.#sql.exec("UPDATE outbox SET state='claimed', dispatched_at=? WHERE command_id=?",
          this.#now(), r.command_id);
      }
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
         status, result_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'pending',NULL,?,?)
       ON CONFLICT(operation_id) DO NOTHING`,
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

  async completeOperation(
    tenantId: string, operationId: string, status: OperationStatus, resultRef: string | null,
    result?: Json,
  ) {
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
          payload: { operationId, status, resultRef, ...(result === undefined ? {} : { result }) }, dedupKey: `op:${operationId}:completed`,
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
      publicConfig: JSON.parse(r.public_config),
      policy: r.policy ? JSON.parse(r.policy) : null, secretRef: r.secret_ref,
    };
  }

  #quotaRow(tenantId: string, resource: string) {
    return this.#all("SELECT * FROM quotas WHERE tenant_id=? AND resource=?", tenantId, resource)[0] as any;
  }

  async setQuota(tenantId: string, resource: string, limit: number | null, windowMs: number | null = null) {
    this.#sql.exec(
      `INSERT INTO quotas(tenant_id, resource, limit_value, window_ms, used, window_start)
       VALUES (?,?,?,?,0,?)
       ON CONFLICT(tenant_id, resource) DO UPDATE SET
         limit_value=excluded.limit_value, window_ms=excluded.window_ms`,
      tenantId, resource, limit, windowMs, this.#now(),
    );
  }

  async consumeQuota(tenantId: string, resource: string, amount: number) {
    return this.#tx(() => {
      const own = this.#quotaRow(tenantId, resource);
      const fallback = own?.limit_value != null ? null : this.#quotaRow("*", resource);
      const limit: number | null = own?.limit_value ?? fallback?.limit_value ?? null;
      const windowMs: number | null = own?.window_ms ?? fallback?.window_ms ?? null;
      const t = this.#now();

      let used = Number(own?.used ?? 0);
      let windowStart = Number(own?.window_start ?? t);
      if (windowMs != null && t - windowStart >= windowMs) { used = 0; windowStart = t; }

      const allowed = limit == null || used + amount <= limit;
      if (allowed) used += amount;
      this.#sql.exec(
        `INSERT INTO quotas(tenant_id, resource, limit_value, window_ms, used, window_start)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(tenant_id, resource) DO UPDATE SET used=excluded.used, window_start=excluded.window_start`,
        tenantId, resource, own?.limit_value ?? null, own?.window_ms ?? null, used, windowStart,
      );
      return { allowed, used, limit };
    });
  }

  async usage(tenantId: string) {
    return (this.#all("SELECT * FROM quotas WHERE tenant_id=?", tenantId) as any[]).map((r) => ({
      resource: r.resource, used: Number(r.used),
      limit: r.limit_value == null ? null : Number(r.limit_value),
      windowStart: Number(r.window_start),
    }));
  }

  async getConnection(tenantId: string, agentId: string, alias: string): Promise<Json | null> {
    const r = this.#all(
      "SELECT state, expires_at FROM connections WHERE tenant_id=? AND agent_id=? AND alias=?",
      tenantId, agentId, alias,
    )[0] as any;
    if (!r || (r.expires_at != null && Number(r.expires_at) <= this.#now())) return null;
    return JSON.parse(r.state);
  }

  // ------------------------------------------------------------ agent state

  async putState(tenantId: string, agentId: string, key: string, entry: StateEntry) {
    this.#sql.exec(
      `INSERT INTO agent_state(tenant_id, agent_id, key, value, ref, bytes, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, agent_id, key) DO UPDATE SET
           value=excluded.value, ref=excluded.ref, bytes=excluded.bytes,
           updated_at=excluded.updated_at`,
      tenantId, agentId, key, entry.value === null ? null : j(entry.value),
      entry.ref, entry.bytes, this.#now());
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
    const r = this.#one("SELECT * FROM agent_state WHERE tenant_id=? AND agent_id=? AND key=?", tenantId, agentId, key) as any;
    if (!r) return null;
    return {
      value: r.value === null || r.value === undefined ? null : JSON.parse(r.value),
      ref: r.ref ?? null, bytes: Number(r.bytes), updatedAt: Number(r.updated_at),
    };
  }

  async deleteState(tenantId: string, agentId: string, key: string) {
    const had = !!this.#one("SELECT * FROM agent_state WHERE tenant_id=? AND agent_id=? AND key=?", tenantId, agentId, key) as any;
    this.#sql.exec("DELETE FROM agent_state WHERE tenant_id=? AND agent_id=? AND key=?", tenantId, agentId, key);
    return had;
  }

  async listState(tenantId: string, agentId: string, prefix = "", limit = 100) {
    return this.#all(
      "SELECT key, bytes, ref, updated_at FROM agent_state WHERE tenant_id=? AND agent_id=? AND key LIKE ? ORDER BY key ASC LIMIT ?",
      tenantId, agentId, `${prefix}%`, limit).map((r: any) => ({
      key: r.key, bytes: Number(r.bytes), ref: r.ref ?? null, updatedAt: Number(r.updated_at),
    }));
  }

  async stateUsage(tenantId: string, agentId: string) {
    const r = this.#one(
      "SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM agent_state WHERE tenant_id=? AND agent_id=?",
      tenantId, agentId) as any;
    return { keys: Number(r?.n ?? 0), bytes: Number(r?.b ?? 0) };
  }

  async putConnection(
    tenantId: string, agentId: string, alias: string, state: Json, expiresAt: number | null = null,
  ) {
    this.#sql.exec(
      `INSERT INTO connections(tenant_id, agent_id, alias, state, expires_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(tenant_id, agent_id, alias) DO UPDATE SET
         state=excluded.state, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
      tenantId, agentId, alias, JSON.stringify(state ?? null), expiresAt, this.#now(),
    );
  }

  async setModelBinding(b: ModelBinding) {
    this.#sql.exec(
      `INSERT INTO model_bindings(tenant_id, agent_id, provider, model, base_url, secret_ref, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
         provider=excluded.provider, model=excluded.model, base_url=excluded.base_url,
         secret_ref=excluded.secret_ref, updated_at=excluded.updated_at`,
      b.tenantId, b.agentId ?? "", b.provider, b.model, b.baseUrl, b.secretRef, this.#now(),
    );
  }

  async getModelBinding(tenantId: string, agentId: string): Promise<ModelBinding | null> {
    // Most specific wins: the agent's own row, else the tenant default.
    const rows = this.#all(
      "SELECT * FROM model_bindings WHERE tenant_id=? AND (agent_id=? OR agent_id='')", tenantId, agentId
    ) as any[];
    const pick = rows.find((r: any) => r.agent_id === agentId) ?? rows.find((r: any) => r.agent_id === "");
    if (!pick) return null;
    return {
      tenantId: pick.tenant_id, agentId: pick.agent_id === "" ? null : pick.agent_id,
      provider: pick.provider, model: pick.model, baseUrl: pick.base_url, secretRef: pick.secret_ref,
    };
  }

  async requireApproval(a: Omit<ApprovalRecord, "state" | "approver" | "decidedAt" | "createdAt">) {
    this.#sql.exec(
      `INSERT INTO approvals(tenant_id, operation_id, agent_id, task_id, mount_alias, tool,
         request, state, approver, decided_at, created_at)
       VALUES (?,?,?,?,?,?,?,'pending',NULL,NULL,?)
       ON CONFLICT(tenant_id, operation_id) DO NOTHING`,
      a.tenantId, a.operationId, a.agentId, a.taskId, a.mountAlias, a.tool,
      j(a.request), this.#now());
  }

  async getApproval(tenantId: string, operationId: string): Promise<ApprovalRecord | null> {
    const r = this.#one("SELECT * FROM approvals WHERE tenant_id=? AND operation_id=?", tenantId, operationId);
    return r ? mapApproval(r) : null;
  }

  async decideApproval(
    tenantId: string, operationId: string, decision: "approved" | "denied", approver: string,
  ) {
    return this.#tx(() => {
      const r = this.#one("SELECT * FROM approvals WHERE tenant_id=? AND operation_id=?", tenantId, operationId);
      if (!r) return { ok: false as const, reason: "not_found" as const };
      // Deciding twice would let one approval authorise two executions.
      if (r.state !== "pending") return { ok: false as const, reason: "already_decided" as const };
      const at = this.#now();
      this.#sql.exec(
        "UPDATE approvals SET state=?, approver=?, decided_at=? WHERE tenant_id=? AND operation_id=?",
        decision, approver, at, tenantId, operationId);
      return { ok: true as const, record: mapApproval({ ...r, state: decision, approver, decided_at: at }) };
    });
  }

  async listApprovals(tenantId: string, state?: "pending" | "approved" | "denied") {
    const rows = state
      ? this.#all("SELECT * FROM approvals WHERE tenant_id=? AND state=? ORDER BY created_at ASC", tenantId, state)
      : this.#all("SELECT * FROM approvals WHERE tenant_id=? ORDER BY created_at ASC", tenantId);
    return (rows as any[]).map(mapApproval);
  }

  async addMount(m: MountRecord) {
    this.#sql.exec(
      `INSERT INTO mounts(tenant_id, agent_id, alias, installation_id, connection_id, plugin,
         tool_version, public_config, secret_ref, policy) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      m.tenantId, m.agentId, m.alias, m.installationId, m.connectionId, m.plugin, m.toolVersion,
      j(m.publicConfig), m.secretRef, m.policy ? j(m.policy) : null);
  }

  async updateMountPolicy(
    tenantId: string, agentId: string, alias: string, policy: MountPolicy | null,
  ) {
    this.#sql.exec("UPDATE mounts SET policy=? WHERE tenant_id=? AND agent_id=? AND alias=?",
      policy ? j(policy) : null, tenantId, agentId, alias);
    return !!this.#one("SELECT alias FROM mounts WHERE tenant_id=? AND agent_id=? AND alias=?",
      tenantId, agentId, alias);
  }

  async updateMountConfig(tenantId: string, agentId: string, alias: string, publicConfig: Json) {
    this.#sql.exec("UPDATE mounts SET public_config=? WHERE tenant_id=? AND agent_id=? AND alias=?",
      j(publicConfig), tenantId, agentId, alias);
    return !!this.#one("SELECT alias FROM mounts WHERE tenant_id=? AND agent_id=? AND alias=?",
      tenantId, agentId, alias);
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

  /** What the alarm needs: which tasks still have unconsumed events. */
  async tasksWithPendingWork(limit = 25) {
    return this.#all(
      `SELECT DISTINCT t.tenant_id, t.task_id FROM tasks t
         JOIN events e ON e.tenant_id = t.tenant_id AND e.task_id = t.task_id
         LEFT JOIN cursors c ON c.tenant_id = t.tenant_id AND c.task_id = t.task_id
                            AND c.consumer = 'harness'
        WHERE t.status NOT IN ('completed','failed')
          AND e.sequence > COALESCE(c.consumed_through, 0)
        LIMIT ?`,
      limit,
    ).map((r) => ({ tenantId: r.tenant_id, taskId: r.task_id }));
  }


  /**
   * A finished task that gets another message is not finished. The scheduler
   * skips terminal tasks (see tasksWithPendingWork), so without this the reply
   * is appended, nothing ever wakes, and the caller keeps reading the previous
   * answer — which is exactly what the benchmark saw: six identical turns.
   *
   * `failed` is deliberately not reopened: that is a permanent state.
   */
  async reopenTask(tenantId: string, taskId: string): Promise<boolean> {
    const r = this.#all("SELECT status FROM tasks WHERE tenant_id=? AND task_id=?", tenantId, taskId)[0] as any;
    if (!r) return false;
    if (["completed", "blocked"].includes(r.status)) {
      this.#sql.exec("UPDATE tasks SET status='runnable', updated_at=? WHERE tenant_id=? AND task_id=?",
        this.#now(), tenantId, taskId);
      return true;
    }
    // `waiting` means "something outstanding will wake this". When nothing is
    // outstanding that is not a wait, it is a strand: the reply that was going
    // to arrive never will, and no message could rescue the task because this
    // method used to refuse the status outright. Reopen only when the task is
    // genuinely orphaned, so a real approval gate is never bypassed by typing.
    if (r.status === "waiting" && !this.#outstanding(tenantId, taskId)) {
      this.#sql.exec("UPDATE tasks SET status='runnable', updated_at=? WHERE tenant_id=? AND task_id=?",
        this.#now(), tenantId, taskId);
      return true;
    }
    return false;
  }

  /** Anything that could still wake a waiting task: a command not yet answered,
   *  or a decision not yet made. */
  #outstanding(tenantId: string, taskId: string): boolean {
    const cmds = this.#all(
      `SELECT 1 FROM outbox WHERE tenant_id=? AND task_id=?
         AND state IN ('pending','claimed','dispatched') LIMIT 1`, tenantId, taskId);
    if (cmds.length) return true;
    const appr = this.#all(
      "SELECT 1 FROM approvals WHERE tenant_id=? AND task_id=? AND state='pending' LIMIT 1",
      tenantId, taskId);
    return appr.length > 0;
  }


  /**
   * Retire rows whose reply has already arrived. Nothing did this, so every
   * command a task ever issued stayed `dispatched` for the life of the object:
   * the table grew without bound and the state told you nothing, because the
   * only thing distinguishing a finished command from a lost one was a
   * subquery. Keeping the row's state true makes a stall visible at a glance.
   */
  async settleAnswered(): Promise<number> {
    const done = this.#all(
      `SELECT command_id FROM outbox
        WHERE state IN ('pending','claimed','dispatched')
          AND EXISTS (SELECT 1 FROM events e
                       WHERE e.tenant_id = outbox.tenant_id
                         AND e.dedup_key IN ('cmd:' || outbox.command_id || ':response',
                                             'cmd:' || outbox.command_id || ':result'))`);
    for (const r of done) {
      this.#sql.exec("UPDATE outbox SET state='done' WHERE command_id=?", (r as any).command_id);
    }
    return done.length;
  }

  /**
   * Is anything still out, at any age?
   *
   * The in-flight check used to reuse the age-based query with `olderThanMs: 0`,
   * which compares `dispatched_at < now` — false for a command dispatched in the
   * same millisecond as the check. Offloading a model request takes microseconds
   * (the dispatcher answers 202 immediately), so the alarm handler regularly
   * asked "is anything in flight?" in the very millisecond it had put something
   * there, got "no", and deleted its own alarm. Age has no business in this
   * question.
   */
  async outstandingCommands(kinds?: string[]): Promise<number> {
    const filter = kinds?.length ? `AND o.kind IN (${kinds.map(() => "?").join(",")})` : "";
    const rows = this.#all(
      `SELECT COUNT(*) AS n FROM outbox o
         JOIN tasks t ON t.tenant_id = o.tenant_id AND t.task_id = o.task_id
        WHERE o.state IN ('pending','claimed','dispatched') ${filter}
          AND t.status NOT IN ('completed','failed')
          AND NOT EXISTS (SELECT 1 FROM events e
                           WHERE e.tenant_id = o.tenant_id
                             AND e.dedup_key IN ('cmd:' || o.command_id || ':response',
                                                 'cmd:' || o.command_id || ':result'))`,
      ...(kinds ?? []));
    return Number((rows[0] as any)?.n ?? 0);
  }

  /**
   * Hand a command that died mid-flight back to the queue.
   *
   * Only offloaded model requests were ever recovered. A `js.execute` runs
   * inside this object, so it seemed safe — until the invocation running it was
   * cancelled by the platform, and the row sat `dispatched` with no result and
   * nothing in existence that would run it again. Re-running is safe for the
   * same reason re-dispatching is: the result event's dedup key is derived from
   * the command id, and a replayed write answers `unknown` rather than
   * executing twice.
   */
  async requeueStale(olderThanMs: number, kinds: string[]): Promise<number> {
    const marks = kinds.map(() => "?").join(",");
    const doomed = this.#all(
      `SELECT o.command_id FROM outbox o
         JOIN tasks t ON t.tenant_id = o.tenant_id AND t.task_id = o.task_id
        WHERE o.state = 'dispatched' AND o.kind IN (${marks})
          AND t.status NOT IN ('completed','failed')
          AND o.dispatched_at < ?
          AND NOT EXISTS (SELECT 1 FROM events e
                           WHERE e.tenant_id = o.tenant_id
                             AND e.dedup_key = 'cmd:' || o.command_id || ':result')`,
      ...kinds, this.#now() - olderThanMs);
    for (const r of doomed) {
      this.#sql.exec("UPDATE outbox SET state='pending', dispatched_at=NULL WHERE command_id=?",
        (r as any).command_id);
    }
    return doomed.length;
  }

  /** A claim whose dispatch threw is invisible to claimOutbox; hand it back. */
  async reclaimStuckClaims(olderThanMs: number): Promise<number> {
    const stuck = this.#all(
      "SELECT command_id FROM outbox WHERE state='claimed' AND dispatched_at < ?",
      this.#now() - olderThanMs,
    );
    for (const r of stuck) {
      this.#sql.exec("UPDATE outbox SET state='pending' WHERE command_id=?", (r as any).command_id);
    }
    return stuck.length;
  }

  async listTasks(tenantId: string, agentId: string) {
    return this.#all(
      "SELECT * FROM tasks WHERE tenant_id=? AND agent_id=? ORDER BY updated_at DESC", tenantId, agentId,
    ).map((r) => ({
      taskId: r.task_id, status: r.status, generation: Number(r.generation),
      checkpointVersion: Number(r.checkpoint_version), updatedAt: Number(r.updated_at),
    }));
  }

  async eventsSince(tenantId: string, agentId: string, after: number, limit = 200) {
    return this.#all(
      `SELECT * FROM events WHERE tenant_id=? AND agent_id=? AND sequence > ?
       ORDER BY sequence ASC LIMIT ?`, tenantId, agentId, after, limit,
    ).map((r) => ({
      eventId: r.event_id, sequence: Number(r.sequence), kind: r.kind, taskId: r.task_id,
      threadId: r.thread_id, payload: JSON.parse(r.payload), createdAt: Number(r.created_at),
    }));
  }
}
