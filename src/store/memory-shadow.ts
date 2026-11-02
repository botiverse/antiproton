/**
 * What the memory subagent would have done, kept for us and never applied (`memoryWriter: "shadow"`,
 * src/runtime/memory-shadow.ts). One row per direct write the agent made to its `memory`: the document as it was before
 * that write, the request derived from the write, the agent's own edit and the document it left, then the edits the
 * subagent proposed for the same request, what each would have come to, and the document they would have left. It is
 * how the subagent is compared with the agent on the same intent, before it is made the only writer.
 *
 * A row is `queued` by the state plugin as the agent's write returns (src/plugins/state.ts `invoke`), `posted` when the
 * runtime starts the subagent's short session after the agent's run has ended, and `done` when that session has ended
 * (cf/src/runtime.ts `#memoryShadow`). The memory, the request and every edit are the owner's data, so they live here, in
 * the agent's own storage, and nowhere else: the trace rows (`memory.shadow_due`, `memory.shadow`) carry counts only, as
 * `assistant_decisions` does for a check's note (src/store/assistant-decisions.ts).
 *
 * Kept `MEMORY_SHADOW_RETENTION_MS` (30 days): every new row deletes this agent's older ones in the same transaction. An
 * agent's delete deletes all of its rows (`deleteAgent`, from cf/src/runtime.ts `stopTurn`): the agent's object outlives
 * its delete. Shared by both storage backends, as `assistant_decisions` is.
 */
import type { SqlHost } from "./pi-storage.ts";

export const MEMORY_SHADOW_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_shadow (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, id TEXT NOT NULL, trigger TEXT NOT NULL, session TEXT NOT NULL,
     state TEXT NOT NULL, due_at INTEGER NOT NULL, posted_at INTEGER, done_at INTEGER, outcome TEXT, error_code TEXT,
     request TEXT NOT NULL, main_op TEXT NOT NULL, memory_before TEXT NOT NULL, memory_main TEXT NOT NULL,
     memory_after TEXT, ops TEXT, counts TEXT,
     PRIMARY KEY (tenant_id, agent_id, id))`,
  `CREATE INDEX IF NOT EXISTS memory_shadow_by_state ON memory_shadow (tenant_id, agent_id, state, due_at)`,
  // Per conversation, the last entry a run was shown (`contextSlices`, src/runtime/memory-shadow.ts): the next run is
  // shown only what came after it. Ids only, never text.
  `CREATE TABLE IF NOT EXISTS memory_shadow_marks (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, conversation TEXT NOT NULL, entry_id TEXT NOT NULL, at INTEGER NOT NULL,
     PRIMARY KEY (tenant_id, agent_id, conversation))`,
];

/** How long a shadow run is kept. */
export const MEMORY_SHADOW_RETENTION_MS = 30 * 24 * 3_600_000;
/** The most one read returns. */
export const MEMORY_SHADOW_READ_MAX = 500;

/** What a finished run came to. */
export type ShadowOutcome = "changed" | "no_change" | "failed";

export interface MemoryShadowRun {
  id: string;
  /** Where the agent's write was made: its chat (the main conversation) or a check's short session. */
  trigger: "chat" | "check";
  /** The session the write was made in, whose run must end before this one is started. */
  session: string;
  state: "queued" | "posted" | "done";
  dueAt: number;
  postedAt: number | null;
  doneAt: number | null;
  outcome: ShadowOutcome | null;
  errorCode: string | null;
  /** What the subagent was asked: the agent's write, as a request (`requestOf`). */
  request: string;
  /** The agent's own write: the tool and its arguments. */
  mainOp: { tool: string; args: unknown; result: string };
  /** The memory document before the agent's write: what the subagent is shown and its edits are judged against. */
  memoryBefore: string;
  /** The document the agent's own write left. */
  memoryMain: string;
  /** The document the subagent's accepted edits would have left; null until done, and on a failure. */
  memoryAfter: string | null;
  /** Each proposed edit and what it would have come to (`ShadowOpResult`, src/runtime/memory-shadow.ts). */
  ops: unknown[] | null;
  /** The same counts as the `memory.shadow` trace row. */
  counts: Record<string, unknown> | null;
}

type Sql = SqlHost["sql"];

const json = <T>(cell: unknown, fallback: T): T => {
  if (cell === null || cell === undefined) return fallback;
  try { return JSON.parse(String(cell)) as T; } catch { return fallback; }
};
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function rowOf(r: Record<string, unknown>): MemoryShadowRun {
  return {
    id: String(r.id), trigger: r.trigger === "check" ? "check" : "chat", session: String(r.session),
    state: r.state === "done" ? "done" : r.state === "posted" ? "posted" : "queued",
    dueAt: Number(r.due_at), postedAt: num(r.posted_at), doneAt: num(r.done_at),
    outcome: r.outcome === null || r.outcome === undefined ? null : String(r.outcome) as ShadowOutcome,
    errorCode: r.error_code === null || r.error_code === undefined ? null : String(r.error_code),
    request: String(r.request), mainOp: json(r.main_op, { tool: "", args: null, result: "" }),
    memoryBefore: String(r.memory_before), memoryMain: String(r.memory_main),
    memoryAfter: r.memory_after === null || r.memory_after === undefined ? null : String(r.memory_after),
    ops: json<unknown[] | null>(r.ops, null), counts: json<Record<string, unknown> | null>(r.counts, null),
  };
}

const SELECT = "SELECT id, trigger, session, state, due_at, posted_at, done_at, outcome, error_code, request, main_op, " +
  "memory_before, memory_main, memory_after, ops, counts FROM memory_shadow";

export class MemoryShadowTables {
  #host: SqlHost;
  #now: () => number;

  constructor(host: SqlHost, opts: { now?: () => number } = {}) {
    this.#host = host;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Creates the tables when they are missing. Returns `this`, so a fixture is one expression. */
  ensure(): this {
    for (const stmt of MEMORY_SHADOW_SCHEMA) this.#host.sql.exec(stmt);
    return this;
  }

  /** A run owed for the agent's write, `queued` until its session's run has ended; drops this agent's expired rows. */
  queue(tenantId: string, agentId: string, r: {
    id: string; trigger: "chat" | "check"; session: string; request: string; mainOp: { tool: string; args: unknown; result: string };
    memoryBefore: string; memoryMain: string;
  }): void {
    this.#host.transactionSync(() => {
      this.#host.sql.exec(
        `INSERT INTO memory_shadow(tenant_id, agent_id, id, trigger, session, state, due_at, request, main_op, memory_before, memory_main)
         VALUES (?,?,?,?,?,'queued',?,?,?,?,?) ON CONFLICT(tenant_id, agent_id, id) DO NOTHING`,
        tenantId, agentId, r.id, r.trigger, r.session, this.#now(), r.request, JSON.stringify(r.mainOp), r.memoryBefore, r.memoryMain,
      );
      this.prune(tenantId, agentId);
    });
  }

  /** The runs still queued for writes made in `session`, oldest first. */
  queued(tenantId: string, agentId: string, session: string): MemoryShadowRun[] {
    if (!hasTable(this.#host.sql)) return [];
    return (this.#host.sql.exec(`${SELECT} WHERE tenant_id=? AND agent_id=? AND state='queued' AND session=? ORDER BY due_at, rowid`,
      tenantId, agentId, session).toArray() as Array<Record<string, unknown>>).map(rowOf);
  }

  /** Its short session was posted. */
  posted(tenantId: string, agentId: string, id: string, at: number): void {
    this.#host.sql.exec("UPDATE memory_shadow SET state='posted', posted_at=? WHERE tenant_id=? AND agent_id=? AND id=?", at, tenantId, agentId, id);
  }

  /** What the run came to. */
  finish(tenantId: string, agentId: string, id: string, r: {
    outcome: ShadowOutcome; errorCode: string | null; memoryAfter: string | null; ops: unknown[] | null; counts: Record<string, unknown> | null;
  }): void {
    this.#host.sql.exec(
      "UPDATE memory_shadow SET state='done', done_at=?, outcome=?, error_code=?, memory_after=?, ops=?, counts=? WHERE tenant_id=? AND agent_id=? AND id=?",
      this.#now(), r.outcome, r.errorCode, r.memoryAfter, r.ops === null ? null : JSON.stringify(r.ops),
      r.counts === null ? null : JSON.stringify(r.counts), tenantId, agentId, id,
    );
  }

  get(tenantId: string, agentId: string, id: string): MemoryShadowRun | null {
    if (!hasTable(this.#host.sql)) return null;
    const r = this.#host.sql.exec(`${SELECT} WHERE tenant_id=? AND agent_id=? AND id=?`, tenantId, agentId, id).toArray()[0];
    return r ? rowOf(r as Record<string, unknown>) : null;
  }

  /** One agent's runs due in [from, to), newest first, at most `MEMORY_SHADOW_READ_MAX`. SELECTs only. */
  list(tenantId: string, agentId: string, range: { from?: number; to?: number } = {}): MemoryShadowRun[] {
    if (!hasTable(this.#host.sql)) return [];
    const from = range.from ?? 0, to = range.to ?? Number.MAX_SAFE_INTEGER;
    return (this.#host.sql.exec(`${SELECT} WHERE tenant_id=? AND agent_id=? AND due_at >= ? AND due_at < ? ORDER BY due_at DESC, rowid DESC LIMIT ?`,
      tenantId, agentId, from, to, MEMORY_SHADOW_READ_MAX).toArray() as Array<Record<string, unknown>>).map(rowOf);
  }

  /** The last entry of `conversation` a run was shown, or null. */
  mark(tenantId: string, agentId: string, conversation: string): string | null {
    if (!hasTable(this.#host.sql)) return null;
    const r = this.#host.sql.exec("SELECT entry_id FROM memory_shadow_marks WHERE tenant_id=? AND agent_id=? AND conversation=?",
      tenantId, agentId, conversation).toArray()[0] as { entry_id?: unknown } | undefined;
    return r ? String(r.entry_id) : null;
  }

  setMark(tenantId: string, agentId: string, conversation: string, entryId: string): void {
    this.#host.sql.exec(
      `INSERT INTO memory_shadow_marks(tenant_id, agent_id, conversation, entry_id, at) VALUES (?,?,?,?,?)
       ON CONFLICT(tenant_id, agent_id, conversation) DO UPDATE SET entry_id=excluded.entry_id, at=excluded.at`,
      tenantId, agentId, conversation, entryId, this.#now());
  }

  /** Every row of this agent's, and its marks: its delete, since the object itself is kept. */
  deleteAgent(tenantId: string, agentId: string): void {
    if (!hasTable(this.#host.sql)) return;
    this.#host.sql.exec("DELETE FROM memory_shadow WHERE tenant_id=? AND agent_id=?", tenantId, agentId);
    this.#host.sql.exec("DELETE FROM memory_shadow_marks WHERE tenant_id=? AND agent_id=?", tenantId, agentId);
  }

  /** Deletes this agent's rows due, and marks set, more than `MEMORY_SHADOW_RETENTION_MS` ago. */
  prune(tenantId: string, agentId: string): void {
    const before = this.#now() - MEMORY_SHADOW_RETENTION_MS;
    this.#host.sql.exec("DELETE FROM memory_shadow WHERE tenant_id=? AND agent_id=? AND due_at < ?", tenantId, agentId, before);
    this.#host.sql.exec("DELETE FROM memory_shadow_marks WHERE tenant_id=? AND agent_id=? AND at < ?", tenantId, agentId, before);
  }
}

function hasTable(sql: Sql): boolean {
  return sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'memory_shadow'").toArray().length > 0;
}
