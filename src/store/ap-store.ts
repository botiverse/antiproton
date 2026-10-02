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
 * - `meta(k, v)`: per-object facts. `engine` is the one written now: which
 *   kernel runs this agent, written once at creation and never rewritten, so an
 *   adopt that rebuilds the agent's config cannot move an agent between
 *   kernels. A missing row means the agent predates the choice (pi 0.85).
 * - `model_jobs`: `pi_model_jobs` (src/runtime/pi-agent.ts), with the session
 *   replaced by pi-durable's conversation id. That id is nullable because the
 *   offloaded provider's port (src/model/durable-offloaded.ts) is handed only
 *   `{ model, context, options }`.
 * - `client_calls`: `api_client_calls` (src/runtime/client-calls.ts), keyed by
 *   pi-durable's conversation id instead of a session name.
 * - `conversations`: the directory from the id a caller addresses (a task id:
 *   `t_<agent>` or an Agents API session id, which `#conversation` and
 *   `#openTask` in cf/src/index.ts accept through AgentDO's `tasks` rows) to the
 *   pi-durable conversation that holds it.
 * - `outbox_marks`: how far the usage and trace outboxes have read pi-durable's
 *   entries. A watermark is pi-durable's commit sequence (`entries.commit_seq`,
 *   strictly increasing per atomic commit), so "through seq N" never splits a
 *   commit. Written by src/runtime/pd-outbox.ts through `unit`, in the same
 *   commit as the rows it accounts for.
 *
 * Only the engine, the directory and `unit` have operations here; the other tables are
 * declared so that the namespace's list is complete from the start, and their
 * operations arrive with the steps that use them.
 */
import { SqlQualifier, type SqlNamespace, type SqlObjects } from "./sql-namespace.ts";

export const AP_TABLES = ["meta", "model_jobs", "client_calls", "conversations", "outbox_marks"] as const;
export const AP_INDEXES = ["model_jobs_open"] as const;
export const AP_OBJECTS: SqlObjects = { tables: AP_TABLES, indexes: AP_INDEXES };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS model_jobs (
     id TEXT PRIMARY KEY, conversation_id INTEGER, request TEXT NOT NULL, answer TEXT,
     created_at INTEGER NOT NULL, dispatched_at INTEGER, answered_at INTEGER) STRICT`,
  // What a sweep for lost and unanswered calls reads.
  `CREATE INDEX IF NOT EXISTS model_jobs_open ON model_jobs (answered_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS client_calls (
     conversation_id INTEGER NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
     arguments TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, output TEXT, is_error INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, call_id)) STRICT`,
  `CREATE TABLE IF NOT EXISTS conversations (
     task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
     conversation_id INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS outbox_marks (outbox TEXT PRIMARY KEY, through_seq INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`,
];

/** The kernels an agent can run on. `pi085` is every agent created before the choice existed. */
export const AGENT_ENGINES = ["pi085", "pd"] as const;
export type AgentEngineName = (typeof AGENT_ENGINES)[number];

export type ApConversation = { taskId: string; tenantId: string; agentId: string; conversationId: number; createdAt: number };

/** The slice of `ctx.storage.sql` this needs. */
export type ApSqlHost = { exec(query: string, ...bindings: Array<string | number | null>): { toArray(): Array<Record<string, unknown>> } };
/** What runs every write: `PiDurableSqlite.exclusive` on the facade pi-durable itself is opened on. */
export type ApWriter = { exclusive<T>(fn: () => T): Promise<T> };

type Binding = string | number | null;

/** The `ap` tables inside a unit (`ApStore.unit`): only valid until the unit's function returns. */
export type ApUnit = { run(sql: string, ...bindings: Binding[]): Array<Record<string, unknown>> };

/**
 * Every write goes through `writer.exclusive`, so it waits behind an open pi-durable transaction and
 * commits on its own instead of joining that transaction's savepoint and rolling back with it. A
 * caller cannot forget this: no method here writes any other way, and `query` writes through it too.
 *
 * Reads go straight to `sql`, synchronously, also while a pi-durable transaction is open. That is
 * safe because the only uncommitted state such a read could see is that transaction's, and it holds
 * none in our tables: pi-durable's facade is confined to the `pd` namespace, and every write to
 * ours runs through `exclusive`, which never runs while it is open. A read therefore sees exactly
 * what is committed in `ap`. The one way around that is code writing our tables with a raw
 * `sql.exec` inside the transaction, which is what this class exists to make unnecessary.
 */
export class ApStore {
  #sql: ApSqlHost;
  #writer: ApWriter;
  #names: SqlQualifier;

  /**
   * `writer` is the `PiDurableSqlite` pi-durable runs on in this object, so that its queue orders our
   * writes after its transactions; `namespace` places the tables: `prefixedNamespace("ap")` on a
   * Durable Object.
   */
  constructor(sql: ApSqlHost, writer: ApWriter, namespace: SqlNamespace) {
    this.#sql = sql;
    this.#writer = writer;
    this.#names = new SqlQualifier(AP_OBJECTS, namespace);
  }

  #run(sql: string, bindings: Binding[]): Array<Record<string, unknown>> {
    return this.#sql.exec(this.#names.rewrite(sql), ...bindings).toArray();
  }

  /**
   * Any statement over the `ap` objects, run as a write through `exclusive`; a name outside them
   * throws before anything runs.
   */
  query(sql: string, ...bindings: Binding[]): Promise<Array<Record<string, unknown>>> {
    return this.#writer.exclusive(() => this.#run(sql, bindings));
  }

  ensure(): Promise<void> { return this.#writer.exclusive(() => { for (const s of SCHEMA) this.#run(s, []); }); }

  /**
   * One synchronous unit through `exclusive`: `ap.run` reaches only the `ap` objects, and whatever
   * else `fn` runs on the host's connection before it returns commits or rolls back with it. That is
   * what lets the outbox derivation (src/runtime/pd-outbox.ts) append its rows and advance its
   * watermark in `outbox_marks` as one commit.
   */
  unit<T>(fn: (ap: ApUnit) => T): Promise<T> {
    return this.#writer.exclusive(() => fn({ run: (sql, ...bindings) => this.#run(sql, bindings) }));
  }

  /** The engine recorded at creation, or null for an agent that predates the choice. */
  engine(): AgentEngineName | null {
    const v = this.#run("SELECT v FROM meta WHERE k = 'engine'", [])[0]?.v;
    if (v === undefined) return null;
    if (!(AGENT_ENGINES as readonly unknown[]).includes(v)) throw new Error(`unknown engine recorded: ${String(v)}`);
    return v as AgentEngineName;
  }

  /** Records the engine if none is; resolves to the one in force, which is the first ever written. */
  setEngineOnce(engine: AgentEngineName): Promise<AgentEngineName> {
    if (!(AGENT_ENGINES as readonly string[]).includes(engine)) return Promise.reject(new Error(`unknown engine: ${engine}`));
    return this.#writer.exclusive(() => {
      this.#run("INSERT OR IGNORE INTO meta (k, v) VALUES ('engine', ?)", [engine]);
      return this.engine()!;
    });
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
  openConversation(c: ApConversation): Promise<ApConversation> {
    for (const field of ["taskId", "tenantId", "agentId"] as const) {
      const v: unknown = c[field];
      if (typeof v !== "string" || v === "") return Promise.reject(new TypeError(`openConversation: ${field} must be a non-empty string, not ${describe(v)}`));
    }
    for (const field of ["conversationId", "createdAt"] as const) {
      const v: unknown = c[field];
      if (!Number.isSafeInteger(v)) return Promise.reject(new TypeError(`openConversation: ${field} must be a safe integer, not ${describe(v)}`));
    }
    return this.#writer.exclusive(() => {
      this.#run("INSERT OR IGNORE INTO conversations (task_id, tenant_id, agent_id, conversation_id, created_at) VALUES (?, ?, ?, ?, ?)",
        [c.taskId, c.tenantId, c.agentId, c.conversationId, c.createdAt]);
      const row = this.conversation(c.taskId);
      // With the fields checked, the only thing OR IGNORE can have skipped is the UNIQUE conversation id.
      if (row === null) throw new Error(`conversation ${c.conversationId} is already listed under another task id`);
      return row;
    });
  }
}

const describe = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : typeof v === "number" ? String(v) : v === null ? "null" : typeof v);
