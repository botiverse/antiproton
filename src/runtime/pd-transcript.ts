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
 * |                   | diagnostics block pi-durable appended is shown, except an interrupted   |
 * |                   | call's, which the model is sent as pi085's line (`pi085Interrupted`,    |
 * |                   | src/runtime/durable-tools.ts) and is shown so                           |
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
import { pi085Interrupted } from "./durable-tools.ts";
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
      if (first && first.role !== "system") entry = { ...base, type: "message", message: plain(pi085Interrupted(first)) };
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
  const directory = AP.rewrite("SELECT conversation_id FROM conversations WHERE task_id = ?");
  if (!tableExists(sql, prefixedNamespace("ap").qualify("conversations", "table"))) return [];
  const row = sql.exec(directory, session).toArray()[0];
  if (!row) return [];
  const id = Number(row.conversation_id);
  if (!tableExists(sql, prefixedNamespace("pd").qualify("entries", "table"))) return [];
  const conversation = sql.exec(PD.rewrite("SELECT record FROM conversations WHERE id = ?"), id).toArray()[0];
  if (conversation && (JSON.parse(String(conversation.record)) as { parent?: unknown }).parent !== undefined) {
    throw new Error(`pi-durable conversation ${id} is a fork; reading a fork's inherited entries is not supported`);
  }
  return sql.exec(PD.rewrite("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id ASC"), id).toArray()
    .map((r) => JSON.parse(String(r.record)) as EntryRecord);
}

/** `readPdRecords`, projected. */
export function readPdEntries(sql: ReadSql, session: string): EngineEntry[] {
  return projectEntries(readPdRecords(sql, session));
}

/** The object's last `limit` model jobs (`ap_model_jobs`), newest first; none when the table was never made. */
export function readPdModelJobs(sql: ReadSql, limit: number): Array<{ id: string; createdAt: number; answeredAt: number | null }> {
  if (!tableExists(sql, prefixedNamespace("ap").qualify("model_jobs", "table"))) return [];
  return sql.exec(AP.rewrite("SELECT id, created_at, answered_at FROM model_jobs ORDER BY created_at DESC LIMIT ?"), limit).toArray()
    .map((r) => ({ id: String(r.id), createdAt: Number(r.created_at), answeredAt: r.answered_at === null || r.answered_at === undefined ? null : Number(r.answered_at) }));
}

/**
 * What moves when a session's transcript does, cheaply: its last entry id, its entry count, and the object's
 * unanswered model jobs. The console polls this (cf/src/index.ts `uiVersion`) to decide whether to re-render.
 */
export function pdVersion(sql: ReadSql, session: string): string {
  let last = 0, count = 0, open = 0;
  if (tableExists(sql, prefixedNamespace("ap").qualify("conversations", "table"))) {
    const row = sql.exec(AP.rewrite("SELECT conversation_id FROM conversations WHERE task_id = ?"), session).toArray()[0];
    if (row && tableExists(sql, prefixedNamespace("pd").qualify("entries", "table"))) {
      const r = sql.exec(PD.rewrite("SELECT MAX(id) AS s, COUNT(*) AS n FROM entries WHERE conversation_id = ?"), Number(row.conversation_id)).toArray()[0];
      last = Number(r?.s ?? 0); count = Number(r?.n ?? 0);
    }
  }
  if (tableExists(sql, prefixedNamespace("ap").qualify("model_jobs", "table"))) {
    open = Number(sql.exec(AP.rewrite("SELECT COUNT(*) AS n FROM model_jobs WHERE answer IS NULL")).toArray()[0]?.n ?? 0);
  }
  return `${last}.${count}.${open}`;
}
