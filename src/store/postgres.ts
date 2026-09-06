import pg from "pg";
import { randomUUID } from "node:crypto";
import type { StorageAdapter } from "../core/store.ts";
import type {
  AdvanceTxn, CommitResult, Json, Lease, MountRecord, OperationRecord,
  OperationStatus, RuntimeEvent, TaskRecord, WaitSpec,
} from "../core/types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  tenant_id TEXT NOT NULL, agent_id TEXT PRIMARY KEY, config JSONB NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  tenant_id TEXT NOT NULL, task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL,
  generation INT NOT NULL, checkpoint_version INT NOT NULL, fencing_token BIGINT NOT NULL DEFAULT 0,
  checkpoint JSONB NOT NULL, updated_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_tenant ON tasks(tenant_id, status);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT,
  thread_id TEXT, sequence BIGINT NOT NULL, kind TEXT NOT NULL, payload JSONB NOT NULL,
  dedup_key TEXT, created_at BIGINT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedup ON events(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS events_seq ON events(tenant_id, agent_id, sequence);
CREATE INDEX IF NOT EXISTS events_task ON events(tenant_id, task_id, sequence);
CREATE TABLE IF NOT EXISTS cursors (
  tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, consumer TEXT NOT NULL, consumed_through BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, task_id, consumer));
CREATE TABLE IF NOT EXISTS leases (
  task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, holder TEXT NOT NULL,
  fencing_token BIGINT NOT NULL, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  command_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, generation INT NOT NULL,
  kind TEXT NOT NULL, payload JSONB NOT NULL, state TEXT NOT NULL, created_at BIGINT NOT NULL,
  dispatched_at BIGINT);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, created_at);
CREATE TABLE IF NOT EXISTS waits (
  wait_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, generation INT NOT NULL,
  kind TEXT NOT NULL, operation_id TEXT, deadline BIGINT, resolved INT NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS waits_op ON waits(tenant_id, operation_id, resolved);
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL,
  mount_alias TEXT NOT NULL, tool TEXT NOT NULL, tool_version TEXT NOT NULL, status TEXT NOT NULL,
  result_ref TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS operations_task ON operations(tenant_id, task_id, status);
CREATE TABLE IF NOT EXISTS mounts (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL, installation_id TEXT NOT NULL,
  connection_id TEXT, plugin TEXT NOT NULL, tool_version TEXT NOT NULL, public_config JSONB NOT NULL,
  secret_ref TEXT, PRIMARY KEY (tenant_id, agent_id, alias));
`;

const now = () => Date.now();
/** Percolator-style backends surface write conflicts as 40001 even for plain
 *  inserts with distinct keys, so every transaction needs a retry envelope. */
const RETRYABLE = new Set(["40001", "40P01"]);

export class PostgresStore implements StorageAdapter {
  readonly name = "postgres";
  #pool: pg.Pool;

  constructor(cfg: { connectionString: string; max?: number }) {
    this.#pool = new pg.Pool({
      connectionString: cfg.connectionString,
      max: cfg.max ?? 8,
      ssl: { rejectUnauthorized: false },
    });
  }

  async init() {
    for (const stmt of SCHEMA.split(";\n").map((s) => s.trim()).filter(Boolean)) {
      await this.#pool.query(stmt);
    }
    await this.#pool.query(
      "INSERT INTO counters(name, value) VALUES ('fencing', 0) ON CONFLICT (name) DO NOTHING",
    );
  }

  async close() {
    await this.#pool.end();
  }

  async #q(sql: string, params: unknown[] = []) {
    return this.#pool.query(sql, params);
  }

  async #tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = await this.#pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        lastErr = err;
        if (!RETRYABLE.has((err as any)?.code)) throw err;
        await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
      } finally {
        c.release();
      }
    }
    throw lastErr;
  }

  async #nextCounter(c: pg.PoolClient, name: string): Promise<number> {
    await c.query("INSERT INTO counters(name, value) VALUES ($1, 0) ON CONFLICT (name) DO NOTHING", [name]);
    const r = await c.query("UPDATE counters SET value = value + 1 WHERE name = $1 RETURNING value", [name]);
    return Number(r.rows[0].value);
  }

  async createAgent(tenantId: string, agentId: string, config: Json = {}) {
    await this.#q("INSERT INTO agents(tenant_id, agent_id, config, created_at) VALUES ($1,$2,$3,$4)",
      [tenantId, agentId, JSON.stringify(config ?? {}), now()]);
  }

  async createTask(tenantId: string, agentId: string, taskId: string, checkpoint: Json) {
    await this.#q(
      `INSERT INTO tasks(tenant_id, task_id, agent_id, status, generation, checkpoint_version,
         fencing_token, checkpoint, updated_at) VALUES ($1,$2,$3,'runnable',0,0,0,$4,$5)`,
      [tenantId, taskId, agentId, JSON.stringify(checkpoint ?? null), now()]);
  }

  #task(r: any): TaskRecord {
    return {
      tenantId: r.tenant_id, agentId: r.agent_id, taskId: r.task_id, status: r.status,
      generation: r.generation, checkpointVersion: r.checkpoint_version,
      fencingToken: Number(r.fencing_token), checkpoint: r.checkpoint,
    };
  }

  async loadTask(tenantId: string, taskId: string) {
    const r = await this.#q("SELECT * FROM tasks WHERE tenant_id=$1 AND task_id=$2", [tenantId, taskId]);
    return r.rows[0] ? this.#task(r.rows[0]) : null;
  }

  async #insertEvent(c: pg.PoolClient, e: any) {
    if (e.taskId) {
      const owner = await c.query("SELECT agent_id FROM tasks WHERE tenant_id=$1 AND task_id=$2",
        [e.tenantId, e.taskId]);
      if (owner.rows[0] && owner.rows[0].agent_id !== e.agentId) {
        throw new Error(`event agent "${e.agentId}" does not own task ${e.taskId}`);
      }
    }
    if (e.dedupKey) {
      const dup = await c.query(
        "SELECT event_id, sequence FROM events WHERE tenant_id=$1 AND dedup_key=$2", [e.tenantId, e.dedupKey]);
      if (dup.rows[0]) {
        return { inserted: false, sequence: Number(dup.rows[0].sequence), eventId: dup.rows[0].event_id };
      }
    }
    const sequence = await this.#nextCounter(c, `seq:${e.tenantId}:${e.agentId}`);
    const eventId = randomUUID();
    await c.query(
      `INSERT INTO events(event_id, tenant_id, agent_id, task_id, thread_id, sequence, kind, payload,
         dedup_key, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [eventId, e.tenantId, e.agentId, e.taskId ?? null, e.threadId ?? null, sequence, e.kind,
       JSON.stringify(e.payload ?? null), e.dedupKey ?? null, now()]);
    return { inserted: true, sequence, eventId };
  }

  async appendEvent(e: any) {
    return this.#tx((c) => this.#insertEvent(c, e));
  }

  async pendingEvents(tenantId: string, taskId: string, consumer: string): Promise<RuntimeEvent[]> {
    const cur = await this.#q(
      "SELECT consumed_through FROM cursors WHERE tenant_id=$1 AND task_id=$2 AND consumer=$3",
      [tenantId, taskId, consumer]);
    const from = cur.rows[0] ? Number(cur.rows[0].consumed_through) : 0;
    const r = await this.#q(
      "SELECT * FROM events WHERE tenant_id=$1 AND task_id=$2 AND sequence > $3 ORDER BY sequence ASC",
      [tenantId, taskId, from]);
    return r.rows.map((x: any) => ({
      eventId: x.event_id, tenantId: x.tenant_id, agentId: x.agent_id, taskId: x.task_id,
      threadId: x.thread_id, sequence: Number(x.sequence), kind: x.kind, payload: x.payload,
      dedupKey: x.dedup_key, createdAt: Number(x.created_at),
    }));
  }

  async acquireLease(tenantId: string, taskId: string, holder: string, ttlMs: number): Promise<Lease | null> {
    return this.#tx(async (c) => {
      const t = now();
      const cur = await c.query("SELECT * FROM leases WHERE task_id=$1", [taskId]);
      const row = cur.rows[0];
      if (row && Number(row.expires_at) > t && row.holder !== holder) return null;
      const token = await this.#nextCounter(c, "fencing");
      await c.query(
        `INSERT INTO leases(task_id, tenant_id, holder, fencing_token, expires_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (task_id) DO UPDATE SET holder=EXCLUDED.holder,
           fencing_token=EXCLUDED.fencing_token, expires_at=EXCLUDED.expires_at`,
        [taskId, tenantId, holder, token, t + ttlMs]);
      return { tenantId, taskId, holder, fencingToken: token, expiresAt: t + ttlMs };
    });
  }

  async commitAdvance(txn: AdvanceTxn): Promise<CommitResult> {
    return this.#tx(async (c) => {
      const r = await c.query("SELECT * FROM tasks WHERE tenant_id=$1 AND task_id=$2",
        [txn.tenantId, txn.taskId]);
      const t = r.rows[0];
      if (!t) return { ok: false, reason: "no_task" } as const;
      if (txn.fencingToken < Number(t.fencing_token)) return { ok: false, reason: "fenced" } as const;
      if (txn.generation !== t.generation) return { ok: false, reason: "stale_generation" } as const;
      if (txn.expectedCheckpointVersion !== t.checkpoint_version)
        return { ok: false, reason: "version_conflict" } as const;

      const nextVersion = t.checkpoint_version + 1;
      await c.query(
        `UPDATE tasks SET status=$1, checkpoint=$2, checkpoint_version=$3, fencing_token=$4, updated_at=$5
         WHERE tenant_id=$6 AND task_id=$7`,
        [txn.status, JSON.stringify(txn.checkpoint ?? null), nextVersion, txn.fencingToken, now(),
         txn.tenantId, txn.taskId]);

      if (txn.consumedThrough !== null) {
        await c.query(
          `INSERT INTO cursors(tenant_id, task_id, consumer, consumed_through) VALUES ($1,$2,'harness',$3)
           ON CONFLICT (tenant_id, task_id, consumer) DO UPDATE
             SET consumed_through = GREATEST(cursors.consumed_through, EXCLUDED.consumed_through)`,
          [txn.tenantId, txn.taskId, txn.consumedThrough]);
      }
      await c.query("DELETE FROM waits WHERE tenant_id=$1 AND task_id=$2 AND resolved=1",
        [txn.tenantId, txn.taskId]);
      for (const w of txn.waits) {
        await c.query(
          `INSERT INTO waits(wait_id, tenant_id, task_id, generation, kind, operation_id, deadline)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), txn.tenantId, txn.taskId, txn.generation, w.kind, w.operationId ?? null,
           w.deadline ?? null]);
      }
      for (const cmd of txn.commands) {
        await c.query(
          `INSERT INTO outbox(command_id, tenant_id, task_id, generation, kind, payload, state, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) ON CONFLICT (command_id) DO NOTHING`,
          [cmd.commandId, txn.tenantId, txn.taskId, txn.generation, cmd.kind,
           JSON.stringify(cmd.payload ?? null), now()]);
      }
      return { ok: true, checkpointVersion: nextVersion } as const;
    });
  }

  async releaseIfNoWork(tenantId: string, taskId: string, fencingToken: number, consumer: string) {
    return this.#tx(async (c) => {
      const lease = await c.query("SELECT * FROM leases WHERE task_id=$1", [taskId]);
      if (lease.rows[0] && Number(lease.rows[0].fencing_token) > fencingToken) return "fenced" as const;
      const cur = await c.query(
        "SELECT consumed_through FROM cursors WHERE tenant_id=$1 AND task_id=$2 AND consumer=$3",
        [tenantId, taskId, consumer]);
      const from = cur.rows[0] ? Number(cur.rows[0].consumed_through) : 0;
      const pending = await c.query(
        "SELECT count(*) AS n FROM events WHERE tenant_id=$1 AND task_id=$2 AND sequence > $3",
        [tenantId, taskId, from]);
      if (Number(pending.rows[0].n) > 0) return "has_work" as const;
      const resolved = await c.query(
        "SELECT count(*) AS n FROM waits WHERE tenant_id=$1 AND task_id=$2 AND resolved=1", [tenantId, taskId]);
      if (Number(resolved.rows[0].n) > 0) return "has_work" as const;
      await c.query("DELETE FROM leases WHERE task_id=$1 AND fencing_token=$2", [taskId, fencingToken]);
      return "released" as const;
    });
  }

  async claimOutbox(limit: number, tenantId?: string) {
    return this.#tx(async (c) => {
      const r = tenantId
        ? await c.query(
            `SELECT * FROM outbox WHERE state='pending' AND tenant_id=$2 ORDER BY created_at ASC
             LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit, tenantId])
        : await c.query(
            `SELECT * FROM outbox WHERE state='pending' ORDER BY created_at ASC
             LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
      for (const row of r.rows) {
        await c.query("UPDATE outbox SET state='claimed' WHERE command_id=$1", [row.command_id]);
      }
      return r.rows.map((x: any) => ({
        commandId: x.command_id, taskId: x.task_id, kind: x.kind, payload: x.payload,
      }));
    });
  }

  async markDispatched(commandId: string) {
    await this.#q("UPDATE outbox SET state='dispatched', dispatched_at=$1 WHERE command_id=$2",
      [now(), commandId]);
  }

  async recordOperation(op: Omit<OperationRecord, "status" | "resultRef">) {
    await this.#q(
      `INSERT INTO operations(operation_id, tenant_id, agent_id, task_id, mount_alias, tool, tool_version,
         status, result_ref, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',NULL,$8,$8)`,
      [op.operationId, op.tenantId, op.agentId, op.taskId, op.mountAlias, op.tool, op.toolVersion, now()]);
  }

  async getOperation(tenantId: string, operationId: string): Promise<OperationRecord | null> {
    const r = await this.#q("SELECT * FROM operations WHERE tenant_id=$1 AND operation_id=$2",
      [tenantId, operationId]);
    const x = r.rows[0];
    return x ? {
      operationId: x.operation_id, tenantId: x.tenant_id, agentId: x.agent_id, taskId: x.task_id,
      mountAlias: x.mount_alias, tool: x.tool, toolVersion: x.tool_version, status: x.status,
      resultRef: x.result_ref,
    } : null;
  }

  async completeOperation(tenantId: string, operationId: string, status: OperationStatus, resultRef: string | null) {
    await this.#tx(async (c) => {
      await c.query(
        "UPDATE operations SET status=$1, result_ref=$2, updated_at=$3 WHERE tenant_id=$4 AND operation_id=$5",
        [status, resultRef, now(), tenantId, operationId]);
      await c.query("UPDATE waits SET resolved=1 WHERE tenant_id=$1 AND operation_id=$2 AND resolved=0",
        [tenantId, operationId]);
      const op = await c.query("SELECT agent_id, task_id FROM operations WHERE tenant_id=$1 AND operation_id=$2",
        [tenantId, operationId]);
      if (op.rows[0]) {
        await this.#insertEvent(c, {
          tenantId, agentId: op.rows[0].agent_id, taskId: op.rows[0].task_id,
          kind: "operation.completed", payload: { operationId, status, resultRef },
          dedupKey: `op:${operationId}:completed`,
        });
      }
    });
  }

  async registerWait(tenantId: string, taskId: string, generation: number, wait: WaitSpec) {
    return this.#tx(async (c) => {
      if (wait.kind === "operation" && wait.operationId) {
        const op = await c.query("SELECT status FROM operations WHERE tenant_id=$1 AND operation_id=$2",
          [tenantId, wait.operationId]);
        if (op.rows[0] && ["succeeded", "failed", "cancelled", "unknown"].includes(op.rows[0].status)) {
          return "already_satisfied" as const;
        }
      }
      await c.query(
        `INSERT INTO waits(wait_id, tenant_id, task_id, generation, kind, operation_id, deadline)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), tenantId, taskId, generation, wait.kind, wait.operationId ?? null, wait.deadline ?? null]);
      return "registered" as const;
    });
  }

  async interrupt(tenantId: string, taskId: string): Promise<number> {
    const r = await this.#q(
      `UPDATE tasks SET generation = generation + 1, status='interrupted', updated_at=$1
       WHERE tenant_id=$2 AND task_id=$3 RETURNING generation`,
      [now(), tenantId, taskId]);
    return r.rows[0].generation;
  }

  async addMount(m: MountRecord) {
    await this.#q(
      `INSERT INTO mounts(tenant_id, agent_id, alias, installation_id, connection_id, plugin, tool_version,
         public_config, secret_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [m.tenantId, m.agentId, m.alias, m.installationId, m.connectionId, m.plugin, m.toolVersion,
       JSON.stringify(m.publicConfig ?? {}), m.secretRef]);
  }

  #mount(r: any): MountRecord {
    return {
      tenantId: r.tenant_id, agentId: r.agent_id, alias: r.alias, plugin: r.plugin,
      installationId: r.installation_id, connectionId: r.connection_id, toolVersion: r.tool_version,
      publicConfig: r.public_config, secretRef: r.secret_ref,
    };
  }

  async getMountByAlias(tenantId: string, agentId: string, alias: string) {
    const r = await this.#q("SELECT * FROM mounts WHERE tenant_id=$1 AND agent_id=$2 AND alias=$3",
      [tenantId, agentId, alias]);
    return r.rows[0] ? this.#mount(r.rows[0]) : null;
  }

  async findMountsByPlugin(tenantId: string, agentId: string, plugin: string) {
    const r = await this.#q(
      "SELECT * FROM mounts WHERE tenant_id=$1 AND agent_id=$2 AND plugin=$3 ORDER BY alias",
      [tenantId, agentId, plugin]);
    return r.rows.map((x: any) => this.#mount(x));
  }

  async listMounts(tenantId: string, agentId: string) {
    const r = await this.#q("SELECT * FROM mounts WHERE tenant_id=$1 AND agent_id=$2 ORDER BY alias",
      [tenantId, agentId]);
    return r.rows.map((x: any) => this.#mount(x));
  }
}
