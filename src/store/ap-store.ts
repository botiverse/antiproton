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
 *   commit.
 *
 * Only the engine and the directory have operations here; the other tables are
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

/**
 * Synchronous on purpose: on an object where pi-durable is open, run these inside
 * `PiDurableSqlite.exclusive`, which keeps them out of a pi-durable transaction.
 */
export class ApStore {
  #sql: ApSqlHost;
  #names: SqlQualifier;

  /** `namespace` places the tables: `prefixedNamespace("ap")` on a Durable Object. */
  constructor(sql: ApSqlHost, namespace: SqlNamespace) {
    this.#sql = sql;
    this.#names = new SqlQualifier(AP_OBJECTS, namespace);
  }

  /** Any statement over the `ap` objects; a name outside them throws before anything runs. */
  query(sql: string, ...bindings: Array<string | number | null>): Array<Record<string, unknown>> {
    return this.#sql.exec(this.#names.rewrite(sql), ...bindings).toArray();
  }

  ensure(): void { for (const s of SCHEMA) this.query(s); }

  /** The engine recorded at creation, or null for an agent that predates the choice. */
  engine(): AgentEngineName | null {
    const v = this.query("SELECT v FROM meta WHERE k = 'engine'")[0]?.v;
    if (v === undefined) return null;
    if (!(AGENT_ENGINES as readonly unknown[]).includes(v)) throw new Error(`unknown engine recorded: ${String(v)}`);
    return v as AgentEngineName;
  }

  /** Records the engine if none is; returns the one in force, which is the first ever written. */
  setEngineOnce(engine: AgentEngineName): AgentEngineName {
    if (!(AGENT_ENGINES as readonly string[]).includes(engine)) throw new Error(`unknown engine: ${engine}`);
    this.query("INSERT OR IGNORE INTO meta (k, v) VALUES ('engine', ?)", engine);
    return this.engine()!;
  }

  conversation(taskId: string): ApConversation | null {
    const r = this.query("SELECT task_id, tenant_id, agent_id, conversation_id, created_at FROM conversations WHERE task_id = ?", taskId)[0];
    return r ? {
      taskId: String(r.task_id), tenantId: String(r.tenant_id), agentId: String(r.agent_id),
      conversationId: Number(r.conversation_id), createdAt: Number(r.created_at),
    } : null;
  }

  /** Lists a conversation unless its task id is listed already; returns the row in force, the first one. */
  openConversation(c: ApConversation): ApConversation {
    this.query("INSERT OR IGNORE INTO conversations (task_id, tenant_id, agent_id, conversation_id, created_at) VALUES (?, ?, ?, ?, ?)",
      c.taskId, c.tenantId, c.agentId, c.conversationId, c.createdAt);
    const row = this.conversation(c.taskId);
    // OR IGNORE also swallows a second task id for an already-listed pi-durable conversation.
    if (row === null) throw new Error(`conversation ${c.conversationId} is already listed under another task id`);
    return row;
  }
}
