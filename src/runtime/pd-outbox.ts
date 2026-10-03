/**
 * The bookkeeping an agent on the `pd` engine writes inside pi-durable's own commit: its trace outbox rows and its
 * `ap_model_jobs` rows; and the usage rows `PdHost.deliver` writes when an answer is delivered.
 *
 * The vendored storage (src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js) calls a commit hook
 * inside the one synchronous transaction that applies a batch, before the batch is applied. `bookCommit`
 * is that hook's body. What it writes on the object's connection commits or rolls back with the batch,
 * so a row here exists exactly when the state it accounts for does — the property pi 0.85 gives its own
 * `Storage.commit` (src/store/pi-storage.ts), which writes the same trace rows with the same builder
 * (`modelCallRow`), so the flusher (cf/src/trace-r2.ts, cf/src/activity-raft.ts) and the status derived from
 * trace rows (src/runtime/status.ts) read a pd agent as they read a pi085 one.
 *
 * - **Usage** is not written here. A model call is metered when its answer is delivered (`deliveryRows`, written by
 *   `PdHost.deliver` in the transaction that stores or refuses the answer): docs/metering.md. pi-durable's own
 *   `pi.usage` documents are the independent source that is reconciled against it (`pdUsageDrift`).
 * - **Trace**: a `model.call` row for an assistant entry that names the job it answers and ended, written
 *   by the batch that marks that job consumed — once per job, whatever later entry carries its id again.
 * - **Model jobs**: the provider's port only stages a job in memory (`PdHost.#startJob`). Its row is
 *   inserted here, by the batch whose `poll` checkpoint carries its handle — a generation's or a
 *   compaction's (the vendored harness/compaction.js) — and dispatched after that commit; a commit that
 *   never lands leaves no row and nothing dispatched. The batch that appends a job's answer marks it
 *   `consumed`, and so does the batch that moves a task off the `poll` of an answered job: a summary's
 *   answer is never an entry. The batch that ends a task on `poll` without its response (`no_model`, an abort, a
 *   fault, an orphaning) marks its job `cancelled`, as a cancel does (`cancelJob`): `takeJob` and the sweep read
 *   the marks, and a job either mark ends is never handed out or sent again.
 *
 * The job rows and the consumed and cancelled marks are all-or-nothing with the batch: a failure there throws, and
 * the commit rolls back. The trace row is not billing, so a failure building it is logged, kept in `trace_errors`
 * for /admin/diagnose (cf/src/diagnose-read.ts), and the batch commits without it; an entry whose messages are not
 * in the shape this reads is logged and skipped.
 *
 * A trace row's `at` is the commit's time, as pi085's is.
 */
import { apply } from "@earendil-works/chord/delta";
import type { StorageWrite } from "@earendil-works/pi-durable";
import type { SqliteSyncExecutor } from "../vendor/pi/pi-durable/dist/storage/sqlite/storage.js";
import { logEvent } from "../core/log.ts";
import { appendTrace, type TraceRow } from "../trace/outbox.ts";
import { answerEnded, modelCallRow } from "../trace/seams.ts";
import { modelTokenRows, UNACCEPTED_TOKENS, type UsageRow } from "../usage/outbox.ts";
import type { ApStore } from "../store/ap-store.ts";
import { prefixedNamespace } from "../store/sql-namespace.ts";

const TRACE_ERRORS = "CREATE TABLE IF NOT EXISTS trace_errors (at INTEGER NOT NULL, message TEXT NOT NULL)";
/**
 * How long a trace error stays on record: `TRACE_DROPS_KEEP_MS` (cf/src/trace-r2.ts), for the same reason — a fault
 * that repeats writes a line per commit, and the table would only grow. /admin/diagnose shows the last three.
 */
const TRACE_ERRORS_KEEP_MS = 7 * 24 * 60 * 60_000;

/** One line in `trace_errors`, in the commit's transaction: a trace row this commit failed to write. */
function recordTraceError(raw: Raw, at: number, message: string): void {
  raw.exec(TRACE_ERRORS);
  raw.exec("DELETE FROM trace_errors WHERE at < ?", at - TRACE_ERRORS_KEEP_MS);
  raw.exec("INSERT INTO trace_errors(at, message) VALUES (?, ?)", at, message);
}

/** The counters a usage row bills (`modelTokenRows`), as pi-ai names them. */
const COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning"] as const;
type Tokens = Partial<Record<(typeof COUNTERS)[number], number>>;

type Raw = { exec(query: string, ...bindings: Array<string | number | null>): { toArray(): Array<Record<string, unknown>> } };
type MessageLike = { role?: unknown; model?: unknown; provider?: unknown; jobId?: unknown; stopReason?: unknown; usage?: Tokens };

interface BookContext {
  /** Whose rows these are. Null when the host is not bound yet: then no trace row is written. */
  owner: { tenantId: string; agentId: string } | null;
  /** The commit's time: every row's `at`. */
  now: number;
  /** The object's connection, for the outbox tables; inside the commit's transaction. */
  raw: Raw;
  /** The `ap` tables on the same connection, inside the same transaction. */
  ap: Pick<ApStore, "query">;
  /** Jobs the provider's port started and no commit has recorded yet, by id. */
  staged: ReadonlyMap<string, { request: string }>;
  /** A test seam, called last inside the transaction: a throw rolls the whole commit back. */
  fault?: (writes: readonly StorageWrite[]) => void;
}

/** pi-durable's compaction task's kind (`CompactionTask`, the vendored harness/compaction.js). */
const COMPACTION = "pi.compaction";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The assistant messages of the batch's new entries. An entry whose `model` is not a list is logged and skipped. */
function assistantMessages(writes: readonly StorageWrite[], owner: BookContext["owner"]): MessageLike[] {
  const out: MessageLike[] = [];
  for (const w of writes) {
    if (w.type !== "entry" || w.value.kind !== "pi.assistant") continue;
    const model: unknown = w.value.model ?? [];
    if (!Array.isArray(model)) {
      logEvent("pd.commit.unreadable_entry", { ...(owner ?? {}), entryId: Number(w.value.id), model: typeof model });
      continue;
    }
    for (const m of model as readonly MessageLike[]) if (isObject(m) && m.role === "assistant") out.push(m);
  }
  return out;
}

/** The jobs whose handle a `poll` checkpoint of this batch carries and that are staged, not yet recorded. */
function pollHandles(writes: readonly StorageWrite[], staged: BookContext["staged"]): Array<{ id: string; conversationId: number }> {
  const out: Array<{ id: string; conversationId: number }> = [];
  for (const w of writes) {
    if (w.type !== "task") continue;
    const checkpoint = (w.value.state as { checkpoint?: unknown } | undefined)?.checkpoint;
    if (!isObject(checkpoint) || checkpoint.phase !== "poll" || !isObject(checkpoint.handle)) continue;
    const id = checkpoint.handle.id;
    if (typeof id === "string" && staged.has(id)) out.push({ id, conversationId: Number(w.value.conversationId) });
  }
  return out;
}

/**
 * The jobs whose summary `poll` this batch ended: a compaction task's write whose stored record (the state the batch
 * is applied to) is a `poll` checkpoint with a handle, and whose new state is not a `poll` of the same handle. Most read
 * an answer and the batch acts on it; one that ended without its response (`unreadPolls`) is listed here too, and is
 * left alone because the hook cancels its job first and the consumed mark requires `state IS NULL`. A generation's
 * answer is an entry naming its job, which marks it (and writes its trace row); a summary's is not (the vendored
 * harness/compaction.js places a summary entry, or nothing), so this is how its job is consumed.
 */
function endedSummaryPolls(exec: SqliteSyncExecutor, writes: readonly StorageWrite[]): string[] {
  const out: string[] = [];
  for (const w of writes) {
    if (w.type !== "task" || w.value.kind !== COMPACTION) continue;
    const was = storedPoll(exec, Number(w.value.id));
    if (was === undefined) continue;
    const now = (w.value.state as { checkpoint?: unknown } | undefined)?.checkpoint;
    if (isObject(now) && now.phase === "poll" && isObject(now.handle) && now.handle.id === was) continue;
    out.push(was);
  }
  return out;
}

/** The job whose `poll` checkpoint a task's stored record (the state the batch is applied to) holds, if any. */
function storedPoll(exec: SqliteSyncExecutor, taskId: number): string | undefined {
  const row = exec.get<{ record: string }>("SELECT record FROM tasks WHERE id = ?", taskId);
  if (row === undefined) return undefined;
  const was = (JSON.parse(row.record) as { state?: { checkpoint?: unknown } }).state?.checkpoint;
  return isObject(was) && was.phase === "poll" && isObject(was.handle) && typeof was.handle.id === "string" ? was.handle.id : undefined;
}

/**
 * Whether a task's new state ends it (an outcome, `completing` or `terminal`) without its response. A poll's response
 * is recorded in the commit that moves the task off `poll` — its usage, and its entry or summary — and that commit ends
 * the task only as `completed` (an answer placed: generation.js `answer`, the vendored compaction.js `placeSummary`) or
 * `failed` with `model_error` (an answer that was an error: generation.js `classify`, compaction.js `respond`). Every
 * other ending of a task on `poll` is written without reading the answer: `failed` with `no_model` (the model the poll
 * names is no longer registered: it fails before fetching), `aborted` (the abort handler fetches nothing), and the
 * scheduler's own `faulted` and `orphaned` (the vendored harness/scheduler.js: `#step`, `abort`, the abort pass), which run no
 * task code. The two response endings are excluded rather than trusted to the order of the marks: a summary's answer
 * is consumed in that very commit (its usage is in `pi.usage`), so its job is marked consumed (`endedSummaryPolls`),
 * not cancelled, which is what the drift check reads (`pdUsageDrift`).
 */
function endedWithoutResponse(state: unknown): boolean {
  const outcome = isObject(state) ? state.outcome : undefined;
  if (!isObject(outcome)) return false;
  if (outcome.status === "completed") return false;
  const reason = outcome.status === "failed" && isObject(outcome.error) && isObject(outcome.error.detail) ? outcome.error.detail.reason : undefined;
  return reason !== "model_error";
}

/**
 * The jobs whose `poll` this batch ended without its response (`endedWithoutResponse`): a task, a generation's or a
 * compaction's, whose stored record is a `poll` checkpoint with a handle. No entry will name the job and nothing will
 * add its usage to `pi.usage`. An abort's handler cancels the job through the provider's port (`PdHost.#dropJob`), but
 * only while the model the poll names is registered; after the binding moved it skips the cancel, and the scheduler's
 * endings never cancel. Read from the record pi-durable commits, not inferred from the binding: the ending is the fact,
 * and this batch is the one that records it.
 */
function unreadPolls(exec: SqliteSyncExecutor, writes: readonly StorageWrite[]): string[] {
  const out: string[] = [];
  for (const w of writes) {
    if (w.type !== "task" || !endedWithoutResponse(w.value.state)) continue;
    const job = storedPoll(exec, Number(w.value.id));
    if (job !== undefined) out.push(job);
  }
  return out;
}

/** Mark a job cancelled, in the caller's transaction: it is never handed out or sent again. A no-op for one already consumed or cancelled. */
export function cancelJob(ap: Pick<ApStore, "query">, id: string): void {
  ap.query("UPDATE model_jobs SET state = 'cancelled' WHERE id = ? AND state IS NULL", id);
}

/** The commit hook's body. Synchronous, inside the commit's transaction; see the header for what it writes. */
/** Returns the jobs the batch recorded: each is dispatched once the commit has landed. */
export function bookCommit(exec: SqliteSyncExecutor, writes: readonly StorageWrite[], ctx: BookContext): string[] {
  const recorded: string[] = [];

  // Model jobs: recorded by the batch whose poll checkpoint carries the handle. Written as dispatched now: the
  // dispatch follows this commit at once (`PdHost.#afterCommit`), and a sweep that ran before it returned
  // would read an unmarked row as one nobody is carrying and send it a second time. A dispatch that fails
  // is sent again by the sweep once this is a redelivery interval old.
  for (const job of pollHandles(writes, ctx.staged)) {
    ctx.ap.query("INSERT INTO model_jobs (id, conversation_id, request, created_at, dispatched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      job.id, Number.isSafeInteger(job.conversationId) ? job.conversationId : null, ctx.staged.get(job.id)!.request, ctx.now, ctx.now);
    recorded.push(job.id);
  }

  // Answers: the job is consumed.
  const messages = assistantMessages(writes, ctx.owner);
  /** Jobs this batch moved to consumed, with their instants: the ones that get a trace row. */
  const jobs = new Map<string, { created_at: unknown; answered_at: unknown }>();
  for (const m of messages) {
    if (typeof m.jobId !== "string") continue;
    const [row] = ctx.ap.query("UPDATE model_jobs SET state = 'consumed' WHERE id = ? AND state IS NULL RETURNING created_at, answered_at", m.jobId);
    if (row) jobs.set(m.jobId, row as { created_at: unknown; answered_at: unknown });
  }

  // A poll that ended without its response never read its answer: the job is cancelled, as `PdHost.#dropJob` does —
  // a no-op for one that already did it.
  for (const id of unreadPolls(exec, writes)) {
    cancelJob(ctx.ap, id);
    logEvent("pd.jobs.cancelled_unread", { ...(ctx.owner ?? {}), jobId: id });
  }

  // A poll that ended with no entry naming its job (a compaction's summary): consumed, once answered. No trace row:
  // a `model.call` row reads as the turn's own call (src/runtime/status.ts), and a summary is not one.
  for (const id of endedSummaryPolls(exec, writes)) {
    ctx.ap.query("UPDATE model_jobs SET state = 'consumed' WHERE id = ? AND state IS NULL AND answer IS NOT NULL", id);
  }

  // Trace: not billing, so a failure here is logged and the batch commits without it.
  if (ctx.owner !== null) {
    const owner = ctx.owner;
    try {
      const trace: TraceRow[] = [];
      for (const m of messages) {
        if (typeof m.jobId !== "string" || !answerEnded(m.stopReason as Parameters<typeof answerEnded>[0])) continue;
        const job = jobs.get(m.jobId);
        if (!job) continue;
        jobs.delete(m.jobId);
        trace.push(modelCallRow({
          ...owner, jobId: m.jobId, stopReason: m.stopReason as Parameters<typeof modelCallRow>[0]["stopReason"],
          model: typeof m.model === "string" ? m.model : "unknown", at: ctx.now,
          createdAt: Number(job.created_at),
          answeredAt: job.answered_at !== null ? Number(job.answered_at) : null,
        }));
      }
      appendTrace(ctx.raw as Parameters<typeof appendTrace>[0], trace);
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 200);
      logEvent("pd.commit.trace_error", { ...owner, error: message });
      // Kept where an operator reads, as the drain's refusals are (`trace_drops`, cf/src/trace-r2.ts): a log line
      // alone is gone once it scrolls. Not billing either, so failing to keep it does not fail the commit.
      try { recordTraceError(ctx.raw, ctx.now, message); }
      catch (e) { logEvent("pd.commit.trace_error_unrecorded", { ...owner, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    }
  }

  ctx.fault?.(writes);
  return recorded;
}

/**
 * The usage rows of one delivered answer, at the delivery's time: `model.tokens` when a job accepted it, else
 * `UNACCEPTED_TOKENS`. Named by the model the answer names, which the queue consumer stamps with the model it called.
 */
export function deliveryRows(owner: { tenantId: string; agentId: string }, now: number, answer: MessageLike, accepted: boolean): UsageRow[] {
  if (!answer.usage) return [];
  const rows = modelTokenRows({ at: now, ...owner }, typeof answer.model === "string" ? answer.model : "unknown", answer.usage);
  return accepted ? rows : rows.map((r) => ({ ...r, resource: UNACCEPTED_TOKENS }));
}

type ReadSql = { exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> } };
const AP_JOBS = prefixedNamespace("ap").qualify("model_jobs", "table");
const PD_DOCUMENTS = prefixedNamespace("pd").qualify("documents", "table");
const PD_REVISIONS = prefixedNamespace("pd").qualify("document_revisions", "table");
const hasTable = (sql: ReadSql, name: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

/**
 * The reconciliation of a pd object's metering (docs/metering.md): per `provider/model` key and counter, the usage on
 * the answers of consumed jobs minus every conversation's `pi.usage` `models` bucket. Only the differences that are not
 * zero; an empty object is in step. Plain reads: the jobs summed by SQLite without parsing an answer, and each
 * `pi.usage` document's current value (its last base revision and the deltas after it).
 *
 * Left out on purpose: an unaccepted delivery (it is on no job's row), an accepted answer that was never consumed (its
 * job was cancelled first: tenant usage that never reaches `pi.usage`), and `pi.usage`'s `tools` bucket (what a tool
 * reported spending, not a call we paid for).
 */
export function pdUsageDrift(sql: ReadSql): Record<string, Tokens> {
  const totals = new Map<string, Record<string, number>>();
  const add = (key: string, usage: unknown, sign: 1 | -1) => {
    if (!isObject(usage)) return;
    const into = totals.get(key) ?? {};
    for (const c of COUNTERS) into[c] = (into[c] ?? 0) + sign * num(usage[c]);
    totals.set(key, into);
  };
  if (hasTable(sql, AP_JOBS)) {
    const sums = COUNTERS.map((c) => `SUM(json_extract(answer, '$.usage.${c}')) AS ${c}`).join(", ");
    for (const r of sql.exec(`SELECT json_extract(answer, '$.provider') || '/' || json_extract(answer, '$.model') AS k, ${sums}
        FROM ${AP_JOBS} WHERE state = 'consumed' AND answer IS NOT NULL GROUP BY k`).toArray()) add(String(r.k), r, 1);
  }
  if (hasTable(sql, PD_DOCUMENTS)) {
    for (const d of sql.exec(`SELECT id FROM ${PD_DOCUMENTS} WHERE json_extract(record, '$.kind') = 'pi.usage'`).toArray()) {
      const revisions = sql.exec(`SELECT kind, content FROM ${PD_REVISIONS} WHERE document_id = ? AND seq >= COALESCE(
          (SELECT MAX(seq) FROM ${PD_REVISIONS} WHERE document_id = ? AND kind = 'base'), 0) ORDER BY seq`, d.id, d.id).toArray();
      let value: unknown;
      for (const r of revisions) value = r.kind === "base" ? JSON.parse(String(r.content)) : apply(value as never, JSON.parse(String(r.content)));
      const models = isObject(value) && isObject(value.models) ? value.models : {};
      for (const [key, usage] of Object.entries(models)) add(key, usage, -1);
    }
  }
  const out: Record<string, Tokens> = {};
  for (const [key, t] of totals) {
    const off = Object.fromEntries(Object.entries(t).filter(([, n]) => n !== 0));
    if (Object.keys(off).length > 0) Object.defineProperty(out, key, { value: off, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
