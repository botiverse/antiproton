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
 * Kept `MEMORY_SHADOW_RETENTION_MS` (7 days): pruned on every pass of the agent's object (cf/src/runtime.ts `step`) and
 * as a new row is queued. What the agent removes from its memory is redacted from here too (`redactRemoved`, from the
 * state plugin's write): every row's lines equal to a removed line, and a `revise`'s `old` text in the structured
 * fields, become FORGOTTEN; rows are never deleted for it. The run queued for the removing write itself is redacted as
 * it finishes (`finish`), once it has been judged. An agent's delete deletes all
 * of its rows (`deleteAgent`, from cf/src/runtime.ts `stopTurn`): the agent's object outlives its delete. Read by an
 * operator through `GET /admin/memory-shadow` alone (cf/src/admin-memory-shadow.ts, `readMemoryShadow`), audited as an
 * assistant's conversation read is. Shared by both storage backends, as `assistant_decisions` is.
 */
import type { SqlHost } from "./pi-storage.ts";
import { appendTrace } from "../trace/outbox.ts";
import { configOf, memoryWriterOf, type MemoryWriter } from "../plugins/state.ts";

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

/** How long a shadow run is kept: long enough for a few days' comparison, no longer. */
export const MEMORY_SHADOW_RETENTION_MS = 7 * 24 * 3_600_000;
/** The most one read returns. */
export const MEMORY_SHADOW_READ_MAX = 500;

/** What a finished run came to; `skipped` is a run never started (`per_run_cap`). */
export type ShadowOutcome = "changed" | "no_change" | "failed" | "skipped";

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
  mainOp: { tool: string; args: unknown; result: string; readFailed?: true };
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
    id: string; trigger: "chat" | "check"; session: string; request: string; mainOp: { tool: string; args: unknown; result: string; readFailed?: true };
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

  /**
   * What the run came to. Then what the agent's own write removed is redacted from the row (`redactRow`): the lines its
   * `memoryBefore` had and its `memoryMain` lacks, and for a `revise` its `old` text. The run needed them to be judged;
   * once it has been, what the agent removed is not kept here.
   */
  finish(tenantId: string, agentId: string, id: string, r: {
    outcome: ShadowOutcome; errorCode: string | null; memoryAfter: string | null; ops: unknown[] | null; counts: Record<string, unknown> | null;
  }): void {
    this.#host.sql.exec(
      "UPDATE memory_shadow SET state='done', done_at=?, outcome=?, error_code=?, memory_after=?, ops=?, counts=? WHERE tenant_id=? AND agent_id=? AND id=?",
      this.#now(), r.outcome, r.errorCode, r.memoryAfter, r.ops === null ? null : JSON.stringify(r.ops),
      r.counts === null ? null : JSON.stringify(r.counts), tenantId, agentId, id,
    );
    const row = this.get(tenantId, agentId, id);
    if (!row) return;
    this.#redact(tenantId, agentId, `AND id=?`, [id], removedLines(row.memoryBefore, row.memoryMain), reviseFragment(row.mainOp));
  }

  /** Whether this agent has any row: a write under `self` asks it before reading `memory` for a redaction (src/plugins/state.ts). */
  hasRows(tenantId: string, agentId: string): boolean {
    if (!hasTable(this.#host.sql)) return false;
    return this.#host.sql.exec("SELECT 1 AS x FROM memory_shadow WHERE tenant_id=? AND agent_id=? LIMIT 1", tenantId, agentId).toArray().length > 0;
  }

  /**
   * What a write to `memory` removed, redacted from every row of this agent's, queued, in flight or finished
   * (`redactRow`): `lines` (the write's removed lines, `removedLines`) and `fragment` (a `revise`'s `old`, or null).
   * Never deletes a row: a deleted queued run would leave its due row without a heartbeat, and since every row holds a
   * whole document, deleting the ones that mention a line would take nearly all of them. Called before the write's own
   * run is queued, which keeps its text until it has been judged and is redacted as it finishes (`finish`).
   * Returns how many rows changed, and how many held a structured cell that does not parse as JSON, which is left as
   * it is (`unparsable`): the caller says so on a trace row.
   *
   * Cost: one SELECT on the agent's rows by the (tenant_id, agent_id, …) index, which retention bounds to 7 days of
   * runs (at most three started per run of the agent's), and one UPDATE per row that changed; only writes that remove
   * something get here.
   */
  redactRemoved(tenantId: string, agentId: string, lines: readonly string[], fragment: string | null): { changed: number; unparsable: number } {
    if (!hasTable(this.#host.sql)) return { changed: 0, unparsable: 0 };
    return this.#redact(tenantId, agentId, "", [], lines, fragment);
  }

  #redact(tenantId: string, agentId: string, where: string, bind: unknown[], lines: readonly string[], fragment: string | null): { changed: number; unparsable: number } {
    const wanted = new Set(lines.map((l) => l.trimEnd()).filter(redactable));
    const frag = fragment !== null && redactable(fragment) ? fragment : null;
    if (!wanted.size && frag === null) return { changed: 0, unparsable: 0 };
    const rows = this.#host.sql.exec(
      `SELECT id, memory_before, memory_main, memory_after, request, main_op, ops FROM memory_shadow WHERE tenant_id=? AND agent_id=? ${where}`,
      tenantId, agentId, ...bind).toArray() as Array<Record<string, unknown>>;
    let changed = 0, unparsable = 0;
    for (const r of rows) {
      const { cells: next, unparsable: bad } = redactRow(r as never, wanted, frag);
      if (bad) unparsable++;
      if (next === null) continue;
      this.#host.sql.exec(
        "UPDATE memory_shadow SET memory_before=?, memory_main=?, memory_after=?, request=?, main_op=?, ops=? WHERE tenant_id=? AND agent_id=? AND id=?",
        next.memory_before, next.memory_main, next.memory_after, next.request, next.main_op, next.ops, tenantId, agentId, String(r.id));
      changed++;
    }
    return { changed, unparsable };
  }

  get(tenantId: string, agentId: string, id: string): MemoryShadowRun | null {
    if (!hasTable(this.#host.sql)) return null;
    const r = this.#host.sql.exec(`${SELECT} WHERE tenant_id=? AND agent_id=? AND id=?`, tenantId, agentId, id).toArray()[0];
    return r ? rowOf(r as Record<string, unknown>) : null;
  }

  /** One agent's runs due in [from, to), newest first, at most `MEMORY_SHADOW_READ_MAX` (`readMemoryShadow`). */
  list(tenantId: string, agentId: string, range: { from?: number; to?: number } = {}): MemoryShadowRun[] {
    return readMemoryShadow(this.#host.sql, tenantId, agentId, range);
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

/** What a redacted line or fragment reads as. */
export const FORGOTTEN = "[forgotten]";

/**
 * Whether a line or fragment is worth redacting: at least 4 letters or digits. A blank line, a bullet, a rule (`---`) or
 * a bare heading marker carries nothing of the owner's, and redacting it would blank the same marker in every kept line
 * of every row.
 */
export function redactable(text: string): boolean {
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 4;
}

/** The lines of `before` that are not in `after`, compared with trailing whitespace trimmed: what a write removed or reworded. */
export function removedLines(before: string, after: string): string[] {
  const kept = new Set(after.split("\n").map((l) => l.trimEnd()));
  return [...new Set(before.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !kept.has(l)))];
}

/** A `revise`'s `old` text, the fragment it removed wherever it was quoted, or null for any other write. */
export function reviseFragment(op: { tool: string; args: unknown }): string | null {
  const old = op.tool === "revise" && op.args && typeof op.args === "object" ? (op.args as { old?: unknown }).old : null;
  return typeof old === "string" && old ? old : null;
}

/** `text` with every line equal to one of `lines` (trailing whitespace trimmed) replaced by FORGOTTEN; never a part of a line. */
function redactLines(text: string, lines: ReadonlySet<string>): string {
  if (!lines.size) return text;
  return text.split("\n").map((l) => (lines.has(l.trimEnd()) ? FORGOTTEN : l)).join("\n");
}

/** A string value from a structured field: whole removed lines, then the fragment wherever it occurs. */
function redactString(text: string, lines: ReadonlySet<string>, fragment: string | null): string {
  const out = redactLines(text, lines);
  return fragment === null ? out : out.split(fragment).join(FORGOTTEN);
}

/** Every string value in a parsed JSON value, redacted; keys and structure as they were. */
function redactValue(v: unknown, lines: ReadonlySet<string>, fragment: string | null): unknown {
  if (typeof v === "string") return redactString(v, lines, fragment);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, lines, fragment));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x, lines, fragment)]));
  return v;
}

type Cells = { memory_before: unknown; memory_main: unknown; memory_after: unknown; request: unknown; main_op: unknown; ops: unknown };

/**
 * One row's text with what a write removed redacted, or null when nothing changed. The three documents by whole lines
 * alone; the request and the parsed string values of the agent's write and the proposed edits by whole lines and the
 * `revise` fragment. A JSON cell is parsed, redacted value by value and serialized again, never edited as text, so it
 * stays JSON; one that does not parse is left as it is and reported (`unparsable`).
 */
export function redactRow(r: Cells, lines: ReadonlySet<string>, fragment: string | null): { cells: Cells | null; unparsable: boolean } {
  let unparsable = false;
  const doc = (c: unknown) => (c === null || c === undefined ? c : redactLines(String(c), lines));
  const json = (c: unknown) => {
    if (c === null || c === undefined) return c;
    try { return JSON.stringify(redactValue(JSON.parse(String(c)), lines, fragment)); } catch { unparsable = true; return c; }
  };
  const next: Cells = {
    memory_before: doc(r.memory_before), memory_main: doc(r.memory_main), memory_after: doc(r.memory_after),
    request: r.request === null || r.request === undefined ? r.request : redactString(String(r.request), lines, fragment),
    main_op: json(r.main_op), ops: json(r.ops),
  };
  const same = (Object.keys(next) as Array<keyof Cells>).every((k) => next[k] === r[k] || (next[k] === null && r[k] === null));
  return { cells: same ? null : next, unparsable };
}

/**
 * One agent's runs due in [from, to), newest first, at most `MEMORY_SHADOW_READ_MAX`. SELECTs only, for the operator's
 * route (cf/src/admin-memory-shadow.ts), which must not run the store's migrations; an object that never made the table
 * reads as having none.
 */
export function readMemoryShadow(sql: Sql, tenantId: string, agentId: string, range: { from?: number; to?: number } = {}): MemoryShadowRun[] {
  if (!hasTable(sql)) return [];
  const from = range.from ?? 0, to = range.to ?? Number.MAX_SAFE_INTEGER;
  return (sql.exec(`${SELECT} WHERE tenant_id=? AND agent_id=? AND due_at >= ? AND due_at < ? ORDER BY due_at DESC, rowid DESC LIMIT ?`,
    tenantId, agentId, from, to, MEMORY_SHADOW_READ_MAX).toArray() as Array<Record<string, unknown>>).map(rowOf);
}

/**
 * The operator's clear (`DELETE /admin/memory-shadow`, cf/src/admin-memory-shadow.ts): every row and mark of this
 * agent's, deleted at once rather than at the end of their retention. A run still queued would then never get its
 * heartbeat, so each is given one here first, `memory.shadow` with status `skipped` and error `cleared`; a run already in
 * flight finds no row as it ends and says `job_missing` on its own. So due rows and heartbeats still balance.
 * Idempotent: a second call deletes nothing and says `deleted: 0`. The count is written as a `memory.shadow_clear` trace
 * row (counts only), beside the route's audit row, whose table has no column for it. It clears what is kept and does
 * not stop recording: `stillRecording` says whether the agent's state mounts still ask for `shadow`, which only setting
 * `memoryWriter` back to `self` changes; the setting is never touched here.
 */
export function clearMemoryShadow(sql: Sql, tenantId: string, agentId: string, now = Date.now()): { deleted: number; stillRecording: boolean } {
  const stillRecording = memoryWriterOfRows(sql, tenantId, agentId) === "shadow";
  if (!hasTable(sql)) return { deleted: 0, stillRecording };
  const queued = sql.exec("SELECT id, trigger FROM memory_shadow WHERE tenant_id=? AND agent_id=? AND state='queued'", tenantId, agentId)
    .toArray() as Array<{ id: unknown; trigger: unknown }>;
  if (queued.length) {
    appendTrace(sql as never, queued.map((r) => ({
      at: now, tenantId, agentId, kind: "memory.shadow" as const, spanId: `memory_shadow:${String(r.id)}`, status: "skipped", verdict: "cancelled" as const,
      ms: 0, attrs: { job: String(r.id), trigger: r.trigger === "check" ? "check" : "chat", error: "cleared" },
    })));
  }
  const n = sql.exec("SELECT COUNT(*) AS n FROM memory_shadow WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()[0] as { n?: unknown };
  sql.exec("DELETE FROM memory_shadow WHERE tenant_id=? AND agent_id=?", tenantId, agentId);
  sql.exec("DELETE FROM memory_shadow_marks WHERE tenant_id=? AND agent_id=?", tenantId, agentId);
  const deleted = Number(n?.n ?? 0);
  appendTrace(sql as never, [{ at: now, tenantId, agentId, kind: "memory.shadow_clear", spanId: `memory_shadow_clear:${now}`, status: "cleared", verdict: "ok",
    attrs: { deleted, queued: queued.length, stillRecording } }]);
  return { deleted, stillRecording };
}

/** The agent's memory writer, read from its state mounts' rows with a SELECT (src/plugins/state.ts `memoryWriterOf`). */
function memoryWriterOfRows(sql: Sql, tenantId: string, agentId: string): MemoryWriter {
  const has = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'mounts'").toArray().length > 0;
  if (!has) return "self";
  const rows = sql.exec("SELECT public_config FROM mounts WHERE tenant_id=? AND agent_id=? AND plugin='state'", tenantId, agentId).toArray() as Array<{ public_config: unknown }>;
  return memoryWriterOf(rows.map((r) => { try { return configOf(JSON.parse(String(r.public_config))); } catch { return configOf({}); } }));
}
