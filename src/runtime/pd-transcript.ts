/**
 * A pi-durable conversation as the transcript entries the readers on the 0.85 side consume.
 *
 * The console (cf/src/pi-view.ts `entriesToEvents`), the operator's transcript and diagnosis
 * (cf/src/transcript-read.ts, cf/src/diagnose-read.ts) and the Agents API (cf/src/agents-api/transcript.ts
 * `sessionTranscript`, `callTurns`) all read pi-agent-core 0.85's `Entry`. `projectEntries` turns
 * pi-durable's `EntryRecord`s into that shape, so a `pd` agent is read by the same code as a `pi085`
 * one and renders the same: `DurableAgent.entries()`/`branch()` (src/runtime/durable-agent.ts) return it,
 * and `readPdEntries` is the same projection over a read-only scan for the operator's readers.
 *
 * What crosses is plain data: every message is a JSON copy, so no pi-ai 1.0 value reaches the 0.85 side.
 * The message shapes of the two (user, assistant with tool calls, usage and stop reason, tool result) are
 * field-for-field the same where both define them; a 1.0-only field (`thinkingLevel`, `nestedCalls`)
 * rides along as data nobody on the 0.85 side reads.
 *
 * | pi-durable kind   | 0.85 entry                                                              |
 * |-------------------|-------------------------------------------------------------------------|
 * | `pi.user`         | `message`, the user message                                             |
 * | `pi.assistant`    | `message`, the assistant message (content, usage, stopReason as stored) |
 * | `pi.tool-result`  | `message`, the tool result as the model saw it: content verbatim, so a  |
 * |                   | diagnostics block pi-durable appended (interrupted, aborted) is shown   |
 * | `pi.compaction`   | `compaction`, the summary unwrapped from its `<summary>` wrapper        |
 * | `pi.reset`        | `custom` `pi.reset`, its handoff text (if any) as `data.handoff`        |
 * | `pi.system`       | nothing: the prompt and tool set are configuration, which a 0.85        |
 * |                   | transcript does not carry either                                        |
 * | any other kind    | `custom` with `customType` = the kind and `data` as stored: the cancel  |
 * |                   | marker (`agents_api.turn_cancelled`) reads as the 0.85 one does. Its    |
 * |                   | model messages are context only, as a 0.85 projector's output is        |
 *
 * `seq` is pi-durable's entry id: it only grows, but it is per object rather than per conversation, so it
 * has gaps. `timestamp` is the entry's first model message's; an entry with none takes `data.at` when that
 * is a number, else the previous entry's, so the order of times follows the order of entries.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import { prefixedNamespace, SqlQualifier } from "../store/sql-namespace.ts";
import { PI_DURABLE_OBJECTS } from "../store/pi-durable-sqlite.ts";
import { AP_OBJECTS } from "../store/ap-store.ts";
import type { EngineEntry } from "./engine.ts";

/** pi-durable's compaction wrapper (harness/compaction.js `SUMMARY_PREFIX`/`SUMMARY_SUFFIX`, @earendil-works/pi-durable 1.0.0). */
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

const PI_KINDS = new Set(["pi.user", "pi.assistant", "pi.tool-result", "pi.compaction", "pi.reset", "pi.system"]);

const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("");
}

/** The summary inside the wrapper; the whole text when it is not wrapped (a hook may write its own). */
export function unwrapSummary(text: string): string {
  return text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)
    ? text.slice(SUMMARY_PREFIX.length, text.length - SUMMARY_SUFFIX.length)
    : text;
}

/** pi-durable entry records, oldest first, as 0.85 entries, oldest first. */
export function projectEntries(records: readonly EntryRecord[]): EngineEntry[] {
  const out: EngineEntry[] = [];
  let parentId: string | null = null;
  let last = 0;
  for (const r of records) {
    if (r.kind === "pi.system") continue;
    const first = r.model?.[0];
    const data = r.data as Record<string, unknown> | undefined;
    const timestamp = typeof first?.timestamp === "number" ? first.timestamp
      : typeof data?.at === "number" ? data.at : last;
    last = timestamp;
    const base: { id: string; parentId: string | null; seq: number; timestamp: number } = { id: String(r.id), parentId, seq: Number(r.id), timestamp };
    let entry: EngineEntry | null = null;
    if (r.kind === "pi.user" || r.kind === "pi.assistant" || r.kind === "pi.tool-result") {
      // Each of these carries exactly one message (pi-durable's entries.d.ts); a record without one shows nothing.
      if (first && first.role !== "system") entry = { ...base, type: "message", message: plain(first) };
    } else if (r.kind === "pi.compaction") {
      entry = {
        ...base, type: "compaction", summary: unwrapSummary(textOf(first?.content)),
        // pi-durable records neither the tokens it compacted nor a retained tail: its kept entries stay in place.
        retainedTail: [], tokensBefore: 0, fromHook: false,
        ...(r.data === undefined ? {} : { details: plain(r.data) }),
      };
    } else if (r.kind === "pi.reset") {
      entry = { ...base, type: "custom", customType: "pi.reset", data: first ? { handoff: textOf(first.content) } : {} };
    } else if (!PI_KINDS.has(r.kind)) {
      entry = { ...base, type: "custom", customType: r.kind, ...(r.data === undefined ? {} : { data: plain(r.data) }) };
    }
    if (!entry) continue;
    out.push(entry);
    parentId = entry.id;
  }
  return out;
}

type ReadSql = { exec(query: string, ...bindings: Array<string | number | null>): { toArray(): Array<Record<string, unknown>> } };

const PD = new SqlQualifier(PI_DURABLE_OBJECTS, prefixedNamespace("pd"));
const AP = new SqlQualifier(AP_OBJECTS, prefixedNamespace("ap"));

const tableExists = (sql: ReadSql, name: string) =>
  sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

/**
 * A session's pi-durable entry records, oldest first, read with SELECTs only: no harness is opened (opening
 * one runs pi-durable's migrations and may resume tasks), and nothing is written. A session with no
 * conversation yet, or an object with no pd tables, reads as none.
 *
 * It reads `entries` as pi-durable's `SqliteStorage.readEntries` does (dist/storage/sqlite/storage.js,
 * @earendil-works/pi-durable 1.0.0; the stored `record` is the `EntryRecord`), for a conversation with no
 * fork parent — which every conversation this engine makes is (`PdHost.conversation`). A forked one would
 * inherit its parent's entries, which this read does not follow, so it refuses instead of showing part.
 * test/pd-transcript.ts holds it equal to what `DurableAgent.entries()` reads through the harness.
 *
 * A read on a Durable Object while a pi-durable transaction is open sees that transaction's rows too; a
 * commit that then fails leaves one read showing entries that were never kept.
 */
export function readPdRecords(sql: ReadSql, session: string): EntryRecord[] {
  const id = pdConversationId(sql, session);
  if (id === null || !tableExists(sql, prefixedNamespace("pd").qualify("entries", "table"))) return [];
  const conversation = sql.exec(PD.rewrite("SELECT record FROM conversations WHERE id = ?"), id).toArray()[0];
  if (conversation && (JSON.parse(String(conversation.record)) as { parent?: unknown }).parent !== undefined) {
    throw new Error(`pi-durable conversation ${id} is a fork; reading a fork's inherited entries is not supported`);
  }
  return sql.exec(PD.rewrite("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id ASC"), id).toArray()
    .map((r) => JSON.parse(String(r.record)) as EntryRecord);
}

/** The pi-durable conversation a session is kept in (`ap_conversations`); null when it has none yet. */
export function pdConversationId(sql: ReadSql, session: string): number | null {
  if (!tableExists(sql, prefixedNamespace("ap").qualify("conversations", "table"))) return null;
  const row = sql.exec(AP.rewrite("SELECT conversation_id FROM conversations WHERE task_id = ?"), session).toArray()[0];
  return row ? Number(row.conversation_id) : null;
}

/** `readPdRecords`, projected. */
export function readPdEntries(sql: ReadSql, session: string): EngineEntry[] {
  return projectEntries(readPdRecords(sql, session));
}

/** The object's last `limit` model jobs (`ap_model_jobs`), newest first; none when the table was never made. */
export function readPdModelJobs(sql: ReadSql, limit: number): Array<{ id: string; createdAt: number; answeredAt: number | null; requestBytes: number }> {
  if (!tableExists(sql, prefixedNamespace("ap").qualify("model_jobs", "table"))) return [];
  return sql.exec(AP.rewrite("SELECT id, created_at, answered_at, LENGTH(request) AS request_bytes FROM model_jobs ORDER BY created_at DESC LIMIT ?"), limit).toArray()
    .map((r) => ({
      id: String(r.id), createdAt: Number(r.created_at),
      answeredAt: r.answered_at === null || r.answered_at === undefined ? null : Number(r.answered_at),
      requestBytes: Number(r.request_bytes ?? 0),
    }));
}

/**
 * The model jobs still owed an answer, as the engine counts them (`PdHost`, src/runtime/durable-agent.ts: `answer IS
 * NULL AND state IS NULL`). A job whose generation was aborted keeps its row with no answer, so that a late answer is
 * still billed (src/store/ap-store.ts); it is `cancelled`, and nothing waits on it.
 */
export function pdOutstandingJobs(sql: ReadSql): number {
  if (!tableExists(sql, prefixedNamespace("ap").qualify("model_jobs", "table"))) return 0;
  // `state` is added by a migration (ApStore.ensure); a table from before it has no cancelled job to leave out. Probed
  // the way ApStore.ensure probes it: a select of a missing column fails as it is prepared. Any other failure of the
  // count itself is not caught.
  let hasState = true;
  try { sql.exec(AP.rewrite("SELECT state FROM model_jobs WHERE 0")); } catch { hasState = false; }
  return Number(sql.exec(AP.rewrite(
    `SELECT COUNT(*) AS n FROM model_jobs WHERE answer IS NULL${hasState ? " AND state IS NULL" : ""}`)).toArray()[0]?.n ?? 0);
}

/**
 * Every status a task has before it is terminal: pi-durable's `tasks.status` CHECK (dist/storage/sqlite/migrations.js,
 * @earendil-works/pi-durable 1.0.0) is these and `terminal`. Named rather than `!= 'terminal'` so that a read of live
 * tasks searches `tasks_by_status` instead of scanning every task the object ever ran.
 */
const LIVE = "('pending', 'running', 'waiting', 'completing')";

/** `tasks.kind` as pi-durable stores it: JSON-encoded (storage.js `encodeIndexedString`). */
const GENERATION_KIND = JSON.stringify("pi.generation");

/** The object's tasks that are not finished (pending, running, waiting, completing): what its harness is still doing. */
export function readPdLiveTasks(sql: ReadSql, limit: number): Array<{ id: number; conversationId: number; kind: string; status: string; background: boolean }> {
  if (!tableExists(sql, prefixedNamespace("pd").qualify("tasks", "table"))) return [];
  return sql.exec(PD.rewrite(`SELECT record FROM tasks WHERE status IN ${LIVE} ORDER BY id DESC LIMIT ?`), limit).toArray()
    .map((r) => JSON.parse(String(r.record)) as { id: number; conversationId: number; kind: string; state: { status: string }; background: boolean })
    .map((t) => ({ id: Number(t.id), conversationId: Number(t.conversationId), kind: t.kind, status: t.state.status, background: !!t.background }));
}

/**
 * A session's compaction entries, newest first, with the size of each stored record. A compaction entry always has a
 * `head`, its first kept entry (src/vendor/pi/pi-durable/dist/harness/compaction.js `placeSummary`), so the read goes
 * through the partial index of entries that have one (`entry_heads_by_conversation`): resets and compactions, not the
 * whole transcript.
 */
export function readPdCompactions(sql: ReadSql, session: string, limit: number): Array<{ id: string; seq: number; timestamp: number; bytes: number }> {
  const id = pdConversationId(sql, session);
  if (id === null || !tableExists(sql, prefixedNamespace("pd").qualify("entries", "table"))) return [];
  return sql.exec(PD.rewrite(
    "SELECT record, LENGTH(record) AS bytes FROM entries WHERE conversation_id = ? AND head IS NOT NULL " +
    "AND json_extract(record, '$.kind') = 'pi.compaction' ORDER BY id DESC LIMIT ?"),
  id, limit).toArray().map((r) => {
    const [e] = projectEntries([JSON.parse(String(r.record)) as EntryRecord]);
    return { id: String(e?.id), seq: Number(e?.seq), timestamp: Number(e?.timestamp ?? 0), bytes: Number(r.bytes) };
  });
}

/**
 * Model calls of a session whose generation ended failed, faulted or orphaned with nothing in the transcript saying so.
 * pi-durable records the ending only as the `pi.generation` task's terminal outcome, so without this the transcript
 * shows the input and then nothing: a generation that failed before its request went out (no model, a context overflow
 * it could not compact away), one that threw (faulted), one whose definition could not be resolved (orphaned) — before
 * its first call, or after it appended a tool-calling reply — and one that failed on a retry after an error reply.
 *
 * The one ending the transcript already shows is a reply that is itself the failure: the generation's last assistant
 * entry is an error whose message is the outcome's (harness/generation.js `classify`, @earendil-works/pi-durable 1.0.0,
 * appends it and fails with its `errorMessage`). That one is left out, so no failure is drawn twice. Aborted generations are a cancel, which has its
 * own marker entry.
 *
 * Bounded reads: the failed generations come from `tasks` filtered in SQL, and a generation's own entries are looked
 * for only between its id and the next generation's, since a generation appends nothing once it is terminal and the
 * next one is created no earlier (ids only grow: pi-durable's `record_ids`). Entries have no task column, so `byTaskId`
 * is read from the record, but only in that range.
 *
 * `seq` is the generation's last entry in that range, its own or its tool tasks' (the tool-calling reply and the
 * results), else its own id, which sorts after the input that started it; `at` is that entry's time, else the last
 * entry's before it, as pi 0.85's failed run takes the tip it started from.
 */
export function pdFailedRuns(sql: ReadSql, session: string): Array<{ seq: number; operationId: string; code: string; message: string; at: number }> {
  const id = pdConversationId(sql, session);
  if (id === null || !tableExists(sql, prefixedNamespace("pd").qualify("tasks", "table"))) return [];
  type Outcome = { status: string; error?: { message?: string; detail?: { reason?: unknown } }; reason?: string };
  const ended = sql.exec(PD.rewrite(
    // `+conversation_id` keeps the planner off tasks_by_conversation, which holds every task of the conversation; by
    // kind it reads the generations only. The outcome is in the record alone, so each generation's row is still read.
    "SELECT id, record FROM tasks WHERE +conversation_id = ? AND kind = ? AND status = 'terminal' " +
    "AND json_extract(record, '$.state.outcome.status') IN ('failed', 'faulted', 'orphaned') ORDER BY id ASC"), id, GENERATION_KIND).toArray()
    .map((r) => JSON.parse(String(r.record)) as { id: number; state: { outcome: Outcome } });
  if (ended.length === 0) return [];
  const hasEntries = tableExists(sql, prefixedNamespace("pd").qualify("entries", "table"));
  const timeOf = (record: unknown): number => {
    const e = JSON.parse(String(record)) as EntryRecord;
    const data = e.data as Record<string, unknown> | undefined;
    return typeof e.model?.[0]?.timestamp === "number" ? e.model[0].timestamp : typeof data?.at === "number" ? data.at : 0;
  };
  const out: Array<{ seq: number; operationId: string; code: string; message: string; at: number }> = [];
  for (const t of ended) {
    const o = t.state.outcome;
    const gen = Number(t.id);
    const next = sql.exec(PD.rewrite("SELECT MIN(id) AS n FROM tasks WHERE +conversation_id = ? AND kind = ? AND id > ?"), id, GENERATION_KIND, gen)
      .toArray()[0]?.n;
    const bound = next === null || next === undefined ? Number.MAX_SAFE_INTEGER : Number(next);
    // Its tool tasks: owned by it, so created after it and before the next generation.
    const tools = sql.exec(PD.rewrite("SELECT id FROM tasks WHERE conversation_id = ? AND id > ? AND id < ? AND json_extract(record, '$.owner') = ?"),
      id, gen, bound, gen).toArray().map((r) => Number(r.id));
    const by = [gen, ...tools];
    const own = hasEntries
      ? sql.exec(PD.rewrite(
        `SELECT id, record, json_extract(record, '$.kind') AS kind, json_extract(record, '$.byTaskId') AS task FROM entries
           WHERE conversation_id = ? AND id > ? AND id < ? AND json_extract(record, '$.byTaskId') IN (${by.map(() => "?").join(", ")})
           ORDER BY id ASC`), id, gen, bound, ...by).toArray()
      : [];
    const reply = own.filter((e) => e.kind === "pi.assistant" && Number(e.task) === gen).at(-1);
    const said = reply ? (JSON.parse(String(reply.record)) as EntryRecord).model?.[0] as { stopReason?: string; errorMessage?: string } | undefined : undefined;
    if (said?.stopReason === "error" && o.error?.message !== undefined && said.errorMessage === o.error.message) continue;
    const shown = own.filter((e) => e.kind !== "pi.system").at(-1);
    const before = shown === undefined && hasEntries
      ? sql.exec(PD.rewrite("SELECT record FROM entries WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 1"), id, gen).toArray()[0]
      : undefined;
    const reason = o.error?.detail?.reason;
    out.push({
      seq: shown ? Number(shown.id) : gen, operationId: String(gen),
      code: o.status === "failed" ? String(typeof reason === "string" ? reason : "failed") : o.status,
      message: String(o.error?.message ?? o.reason ?? ""),
      at: shown ? timeOf(shown.record) : before ? timeOf(before.record) : 0,
    });
  }
  return out;
}

/**
 * What moves when a session's transcript does, cheaply: its last entry id and entry count, how many of its tasks are
 * live and the newest of them, and the object's unanswered model jobs. The console polls this (cf/src/index.ts
 * `uiVersion`) to decide whether to re-render. The live tasks are there for a run that fails before its first model
 * call: it appends no entry and leaves no job, so without them the version would not move and the failure
 * (`pdFailedRuns`) would never be drawn. A task ending changes the count, or, when its successor starts in the same
 * commit, the newest id; read through `tasks_by_status` (`+conversation_id` keeps the planner off tasks_by_conversation,
 * which holds every task the conversation ever ran), so it reads the few live tasks however many have ended.
 */
export function pdVersion(sql: ReadSql, session: string): string {
  let last = 0, count = 0, live = 0, newest = 0, open = 0;
  const id = pdConversationId(sql, session);
  if (id !== null && tableExists(sql, prefixedNamespace("pd").qualify("entries", "table"))) {
    const r = sql.exec(PD.rewrite("SELECT MAX(id) AS s, COUNT(*) AS n FROM entries WHERE conversation_id = ?"), id).toArray()[0];
    last = Number(r?.s ?? 0); count = Number(r?.n ?? 0);
  }
  if (id !== null && tableExists(sql, prefixedNamespace("pd").qualify("tasks", "table"))) {
    const r = sql.exec(PD.rewrite(`SELECT COUNT(*) AS n, MAX(id) AS m FROM tasks WHERE status IN ${LIVE} AND +conversation_id = ?`), id).toArray()[0];
    live = Number(r?.n ?? 0); newest = Number(r?.m ?? 0);
  }
  if (tableExists(sql, prefixedNamespace("ap").qualify("model_jobs", "table"))) {
    open = Number(sql.exec(AP.rewrite("SELECT COUNT(*) AS n FROM model_jobs WHERE answer IS NULL")).toArray()[0]?.n ?? 0);
  }
  return `${last}.${count}.${live}.${newest}.${open}`;
}
