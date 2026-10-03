/**
 * Our own tables for an agent that runs on pi-durable, in the `ap` namespace.
 *
 * pi-durable's tables sit in `pd` (src/store/pi-durable-sqlite.ts) so that its
 * names cannot meet AgentDO's. What we keep beside them for the same agent sits
 * in `ap` through the same `SqlNamespace`, for the same two reasons: on a Durable
 * Object it is `ap_meta`, on a store with schemas it would be `ap.meta` with
 * nothing here changing; and every statement below goes through the allowlist
 * rewriter, so this module can reach only the objects listed in `AP_OBJECTS` —
 * not pd's, not AgentDO's, not `sqlite_master`.
 *
 * Each table is the counterpart of one that exists for agents on pi 0.85:
 *
 * - `meta(k, v)`: per-object facts. `engine`: which kernel runs this agent,
 *   written once at creation (`setEngineOnce`), so an adopt that rebuilds the
 *   agent's config cannot move an agent between kernels; only a migration and
 *   its rollback move it (`migrateEngine`). A missing row means the agent
 *   predates the choice (pi 0.85). `migrated_from`: set while a migrated agent
 *   is on `pd`.
 * - `model_jobs`: `pi_model_jobs` (src/runtime/pi-agent.ts), with the session
 *   replaced by pi-durable's conversation id, and a `state`: null while the job
 *   is out, `consumed` once a commit appended its answer, `cancelled` once its
 *   generation was aborted (the row is kept, so a late answer is still accepted
 *   and metered as the tenant's).
 *   `taken_at` and `taken_by`: when a queue message last took the job for a
 *   model call, and which message (`PdHost.takeJob`).
 *   The row is inserted inside pi-durable's commit (src/runtime/pd-outbox.ts),
 *   which knows the conversation; a row from before that may hold null.
 * - `conversations`: the directory from the id a caller addresses (a task id:
 *   `t_<agent>` or an Agents API session id, which `#conversation` and
 *   `#openTask` in cf/src/index.ts accept through AgentDO's `tasks` rows) to the
 *   pi-durable conversation that holds it.
 * - `settled_runs`: inputs whose run ended (pi-durable settled the submission),
 *   written by the commit that settled them and deleted by the step that
 *   reports them (`PdHost.takeSettled`), so a run that ended between two steps,
 *   in whichever isolate, is reported once. pi 0.85 has no counterpart: its
 *   step reports the operations its own drive settled.
 * - `deliveries(job_id, taker)`: each delivery attempt `PdHost.deliver`
 *   metered (docs/metering.md) and its verdict (`accepted`, `refused`,
 *   `unknown`), kept for a day so a replayed delivery of the same attempt
 *   meters nothing a second time.
 *
 * The engine and the directory have operations here; `model_jobs` is read and
 * written through `query` by the pd engine (src/runtime/durable-agent.ts,
 * src/runtime/pd-outbox.ts). The calls
 * to functions an Agents API caller runs are pi-durable state, not a table here
 * (`ap.clientCalls`, src/runtime/durable-tools.ts).
 */
import { SqlQualifier, type SqlNamespace, type SqlObjects } from "./sql-namespace.ts";

export const AP_TABLES = ["meta", "model_jobs", "conversations", "settled_runs", "deliveries"] as const;
export const AP_INDEXES = ["model_jobs_open"] as const;
export const AP_OBJECTS: SqlObjects = { tables: AP_TABLES, indexes: AP_INDEXES };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS model_jobs (
     id TEXT PRIMARY KEY, conversation_id INTEGER, request TEXT NOT NULL, answer TEXT,
     created_at INTEGER NOT NULL, dispatched_at INTEGER, answered_at INTEGER, state TEXT,
     taken_at INTEGER, taken_by TEXT) STRICT`,
  // What a sweep for lost and unanswered calls reads.
  `CREATE INDEX IF NOT EXISTS model_jobs_open ON model_jobs (answered_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS conversations (
     task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
     conversation_id INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS settled_runs (
     operation_id TEXT PRIMARY KEY, status TEXT NOT NULL, settled_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS deliveries (
     job_id TEXT NOT NULL, taker TEXT NOT NULL, verdict TEXT NOT NULL, at INTEGER NOT NULL,
     PRIMARY KEY (job_id, taker)) STRICT`,
];
/** Columns added after a table was first made: each is added where it is missing (an object made before it). */
const ADDED_COLUMNS = [
  { table: "model_jobs", column: "state", sql: "ALTER TABLE model_jobs ADD COLUMN state TEXT" },
  { table: "model_jobs", column: "taken_at", sql: "ALTER TABLE model_jobs ADD COLUMN taken_at INTEGER" },
  { table: "model_jobs", column: "taken_by", sql: "ALTER TABLE model_jobs ADD COLUMN taken_by TEXT" },
];

/** The kernels an agent can run on. `pi085` is every agent created before the choice existed. */
export const AGENT_ENGINES = ["pi085", "pd"] as const;
export type AgentEngineName = (typeof AGENT_ENGINES)[number];

export type ApConversation = { taskId: string; tenantId: string; agentId: string; conversationId: number; createdAt: number };

/** The slice of `ctx.storage` this needs: its SQL, and the transaction `ensure` runs in. */
export type ApSqlHost = {
  sql: { exec(query: string, ...bindings: Array<string | number | null>): { toArray(): Array<Record<string, unknown>> } };
  transactionSync<T>(closure: () => T): T;
};

type Binding = string | number | null;


/**
 * Every statement runs when it is called, reads and writes alike. Nothing of pi-durable's can be open
 * meanwhile: each of its commits is one synchronous transaction (src/store/pi-durable-sqlite.ts), so
 * code of ours never runs inside one. A method whose statements must land together runs them in one
 * host `transactionSync` (`ensure`); the rest are one write each, or a read and a write with
 * no await between them.
 */
export class ApStore {
  #host: ApSqlHost;
  #names: SqlQualifier;

  /** `namespace` places the tables: `prefixedNamespace("ap")` on a Durable Object. */
  constructor(host: ApSqlHost, namespace: SqlNamespace) {
    this.#host = host;
    this.#names = new SqlQualifier(AP_OBJECTS, namespace);
  }

  #run(sql: string, bindings: Binding[]): Array<Record<string, unknown>> {
    return this.#host.sql.exec(this.#names.rewrite(sql), ...bindings).toArray();
  }

  /** Any statement over the `ap` objects, run at once — inside whatever transaction is open, the commit hook's included; a name outside them throws before anything runs. */
  query(sql: string, ...bindings: Binding[]): Array<Record<string, unknown>> {
    return this.#run(sql, bindings);
  }

  ensure(): void {
    this.#host.transactionSync(() => {
      for (const s of SCHEMA) this.#run(s, []);
      // A select of a missing column fails as it is prepared, before it runs, so it writes nothing either way.
      for (const a of ADDED_COLUMNS) {
        try { this.#run(`SELECT ${a.column} FROM ${a.table} WHERE 0`, []); } catch { this.#run(a.sql, []); }
      }
    });
  }


  /** The engine recorded at creation, or null for an agent that predates the choice. */
  engine(): AgentEngineName | null {
    const v = this.#run("SELECT v FROM meta WHERE k = 'engine'", [])[0]?.v;
    if (v === undefined) return null;
    if (!(AGENT_ENGINES as readonly unknown[]).includes(v)) throw new Error(`unknown engine recorded: ${String(v)}`);
    return v as AgentEngineName;
  }

  /** Records the engine if none is; resolves to the one in force, which is the first ever written. */
  setEngineOnce(engine: AgentEngineName): AgentEngineName {
    if (!(AGENT_ENGINES as readonly string[]).includes(engine)) throw new Error(`unknown engine: ${engine}`);
    this.#run("INSERT OR IGNORE INTO meta (k, v) VALUES ('engine', ?)", [engine]);
    return this.engine()!;
  }

  /**
   * Moves the agent from one engine to the other, which `setEngineOnce` never does: the explicit act of a migration
   * (src/runtime/pd-migrate.ts) and of its rollback. A compare-and-set: it throws, writing nothing, unless the engine in
   * force is `from` (a missing row is `pi085`, the engine every agent had before the choice existed). Moving to `pd`
   * records `migrated_from`, which is what lets the rollback tell a migrated agent from one created on `pd`; moving back
   * removes it.
   */
  migrateEngine(from: AgentEngineName, to: AgentEngineName): AgentEngineName {
    for (const e of [from, to]) if (!(AGENT_ENGINES as readonly string[]).includes(e)) throw new Error(`unknown engine: ${e}`);
    return this.#host.transactionSync(() => {
      const current = this.engine() ?? "pi085";
      if (current !== from) throw new Error(`engine is ${current}, not ${from}: nothing was changed`);
      this.#run("INSERT INTO meta (k, v) VALUES ('engine', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [to]);
      if (to === "pd") this.#run("INSERT INTO meta (k, v) VALUES ('migrated_from', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [from]);
      else this.#run("DELETE FROM meta WHERE k = 'migrated_from'", []);
      return this.engine()!;
    });
  }

  /** The engine a migration moved this agent from, while it is on `pd` because of one; null otherwise. */
  migratedFrom(): string | null {
    const v = this.#run("SELECT v FROM meta WHERE k = 'migrated_from'", [])[0]?.v;
    return v === undefined ? null : String(v);
  }

  conversation(taskId: string): ApConversation | null {
    const r = this.#run("SELECT task_id, tenant_id, agent_id, conversation_id, created_at FROM conversations WHERE task_id = ?", [taskId])[0];
    return r ? {
      taskId: String(r.task_id), tenantId: String(r.tenant_id), agentId: String(r.agent_id),
      conversationId: Number(r.conversation_id), createdAt: Number(r.created_at),
    } : null;
  }

  /**
   * Lists a conversation unless its task id is listed already; resolves to the row in force, the
   * first one. Its fields are checked first: `OR IGNORE` would also skip a NOT NULL violation, and
   * NaN binds as NULL, so a bad value would otherwise be reported as a conflict that is not there.
   */
  openConversation(c: ApConversation): ApConversation {
    for (const field of ["taskId", "tenantId", "agentId"] as const) {
      const v: unknown = c[field];
      if (typeof v !== "string" || v === "") throw new TypeError(`openConversation: ${field} must be a non-empty string, not ${describe(v)}`);
    }
    for (const field of ["conversationId", "createdAt"] as const) {
      const v: unknown = c[field];
      if (!Number.isSafeInteger(v)) throw new TypeError(`openConversation: ${field} must be a safe integer, not ${describe(v)}`);
    }
    this.#run("INSERT OR IGNORE INTO conversations (task_id, tenant_id, agent_id, conversation_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [c.taskId, c.tenantId, c.agentId, c.conversationId, c.createdAt]);
    const row = this.conversation(c.taskId);
    // With the fields checked, the only thing OR IGNORE can have skipped is the UNIQUE conversation id.
    if (row === null) throw new Error(`conversation ${c.conversationId} is already listed under another task id`);
    return row;
  }
}

const describe = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : typeof v === "number" ? String(v) : v === null ? "null" : typeof v);
