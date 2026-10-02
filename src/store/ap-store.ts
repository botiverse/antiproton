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
 *   replaced by pi-durable's conversation id, and a `state`: null while the job
 *   is out, `consumed` once a commit appended its answer, `cancelled` once its
 *   generation was aborted (the row is kept, so a late answer is still billed).
 *   The row is inserted inside pi-durable's commit (src/runtime/pd-outbox.ts),
 *   which knows the conversation; a row from before that may hold null.
 * - `conversations`: the directory from the id a caller addresses (a task id:
 *   `t_<agent>` or an Agents API session id, which `#conversation` and
 *   `#openTask` in cf/src/index.ts accept through AgentDO's `tasks` rows) to the
 *   pi-durable conversation that holds it.
 *
 * The engine and the directory have operations here; `model_jobs` is read and
 * written through `query` by the pd engine (src/runtime/durable-agent.ts,
 * src/runtime/pd-outbox.ts). The calls
 * to functions an Agents API caller runs are pi-durable state, not a table here
 * (`ap.clientCalls`, src/runtime/durable-tools.ts).
 */
import { SqlQualifier, type SqlNamespace, type SqlObjects } from "./sql-namespace.ts";

export const AP_TABLES = ["meta", "model_jobs", "conversations"] as const;
export const AP_INDEXES = ["model_jobs_open"] as const;
export const AP_OBJECTS: SqlObjects = { tables: AP_TABLES, indexes: AP_INDEXES };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS model_jobs (
     id TEXT PRIMARY KEY, conversation_id INTEGER, request TEXT NOT NULL, answer TEXT,
     created_at INTEGER NOT NULL, dispatched_at INTEGER, answered_at INTEGER, state TEXT) STRICT`,
  // What a sweep for lost and unanswered calls reads.
  `CREATE INDEX IF NOT EXISTS model_jobs_open ON model_jobs (answered_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS conversations (
     task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
     conversation_id INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT`,
];
/** Columns added after a table was first made: each is added where it is missing (an object made before it). */
const ADDED_COLUMNS = [
  { table: "model_jobs", column: "state", sql: "ALTER TABLE model_jobs ADD COLUMN state TEXT" },
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
