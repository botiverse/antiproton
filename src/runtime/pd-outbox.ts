/**
 * The bookkeeping an agent on the `pd` engine writes inside pi-durable's own commit: its usage and
 * trace outbox rows, and its `ap_model_jobs` rows.
 *
 * The vendored storage (src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js) calls a commit hook
 * inside the one synchronous transaction that applies a batch, before the batch is applied. `bookCommit`
 * is that hook's body. What it writes on the object's connection commits or rolls back with the batch,
 * so a row here exists exactly when the state it accounts for does — the property pi 0.85 gives its own
 * `Storage.commit` (src/store/pi-storage.ts), which writes the same rows with the same builders
 * (`modelTokenRows`, `modelCallRow`), so the flushers (cf/src/usage-d1.ts, cf/src/trace-r2.ts,
 * cf/src/activity-raft.ts), billing and the status derived from trace rows (src/runtime/status.ts) read a
 * pd agent as they read a pi085 one.
 *
 * - **Usage** is the batch's change to the `pi.usage` documents, pi-durable's own ledger: every writer
 *   that records spend (`appendAssistant` in harness/generation.js, a failed attempt it retries included;
 *   compaction's model call in harness/compaction.js, which appends no entry) adds to it in the commit
 *   that records the response. A `model.tokens` row per counter that moved, per key: a model's under its
 *   name, a tool's under `unknown` (what pi-storage's `#modelOf` makes of a usage row that is not an
 *   assistant's). A batch that does not touch `pi.usage` — an importer's `appendEntry` — bills nothing;
 *   a document copied into a fork is not spend, and is not counted.
 *   A counter that went down writes a negative row, on purpose: `appendUsage` keeps negatives as the
 *   correction of an earlier count they are, so the rows always sum to what `pi.usage` says.
 * - **Trace**: a `model.call` row for an assistant entry that names the job it answers and ended, written
 *   by the batch that marks that job consumed — once per job, whatever later entry carries its id again.
 * - **Model jobs**: the provider's port only stages a job in memory (`PdHost.#startJob`). Its row is
 *   inserted here, by the batch whose `poll` checkpoint carries its handle — a generation's or a
 *   compaction's (the vendored harness/compaction.js) — and dispatched after that commit; a commit that
 *   never lands leaves no row and nothing dispatched. The batch that appends a job's answer marks it
 *   `consumed`, and so does the batch that moves a task off the `poll` of an answered job: a summary's
 *   answer is never an entry. The batch that ends a `poll` unread — pi-durable's `no_model` failure, or an abort —
 *   marks its job `cancelled`, billing an answer already in, as a cancel does (`cancelJob`).
 *
 * Usage, the job rows and the consumed and cancelled marks are all-or-nothing with the batch: a failure
 * there throws, and the commit rolls back. The trace row is not billing, so a failure building it is
 * logged, kept in `trace_errors` for /admin/diagnose (cf/src/diagnose-read.ts), and the batch commits
 * without it; an entry whose messages are not in the shape this reads is logged and
 * skipped, as it bills nothing (billing reads `pi.usage`, not entries).
 *
 * A row's `at` is the commit's time, as pi085's is.
 */
import { apply } from "@earendil-works/chord/delta";
import type { StorageWrite } from "@earendil-works/pi-durable";
import type { SqliteSyncExecutor } from "../vendor/pi/pi-durable/dist/storage/sqlite/storage.js";
import { logEvent } from "../core/log.ts";
import { appendTrace, type TraceRow } from "../trace/outbox.ts";
import { answerEnded, modelCallRow } from "../trace/seams.ts";
import { appendUsage, modelTokenRows, type UsageRow } from "../usage/outbox.ts";
import type { ApStore } from "../store/ap-store.ts";

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

/** The counters a usage row bills (`modelTokenRows`). */
const COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning"] as const;
type Tokens = Partial<Record<(typeof COUNTERS)[number], number>>;
/** Keyed as `pi.usage` keys them: `models` by `provider/model`, `tools` by tool name. */
type UsageTotals = { models: Record<string, Tokens>; tools: Record<string, Tokens> };

type Raw = { exec(query: string, ...bindings: Array<string | number | null>): { toArray(): Array<Record<string, unknown>> } };
type MessageLike = { role?: unknown; model?: unknown; provider?: unknown; jobId?: unknown; stopReason?: unknown; usage?: Tokens };

interface BookContext {
  /** Whose rows these are. Null when the host is not bound yet: then a batch that bills anything throws. */
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

interface Booked {
  /** Jobs this batch recorded: dispatch each once the commit has landed. */
  jobs: string[];
  usage: UsageRow[];
  trace: TraceRow[];
}

const PI_USAGE = "pi.usage";
/** pi-durable's compaction task's kind (`CompactionTask`, the vendored harness/compaction.js). */
const COMPACTION = "pi.compaction";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** A `pi.usage` value as the two buckets, whatever was stored: a missing or malformed bucket is empty. */
function totalsOf(value: unknown): UsageTotals {
  const v = isObject(value) ? value : {};
  const bucket = (b: unknown) => (isObject(b) ? b as Record<string, Tokens> : {});
  return { models: bucket(v.models), tools: bucket(v.tools) };
}

/** A document's current value, read through the commit's executor: the state the batch is applied to. */
function currentValue(exec: SqliteSyncExecutor, id: number): unknown {
  const base = exec.get<{ seq: number; content: string }>(
    "SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1", id);
  if (base === undefined) return undefined;
  let value = JSON.parse(base.content) as unknown;
  const tail = exec.all<{ content: string }>(
    "SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq", id, base.seq);
  for (const t of tail) value = apply(value as never, JSON.parse(t.content));
  return value;
}

/**
 * What this batch adds to the `pi.usage` documents, summed over them: each changed or created one's new
 * value minus its value before the batch. Copies and retirements add nothing.
 */
function usageDelta(exec: SqliteSyncExecutor, writes: readonly StorageWrite[]): UsageTotals {
  const out: UsageTotals = { models: {}, tools: {} };
  for (const w of writes) {
    let before: unknown;
    let after: unknown;
    if (w.type === "document.create") {
      if (w.record.kind !== PI_USAGE) continue;
      before = undefined;
      after = w.content.value;
    } else if (w.type === "document.change") {
      const row = exec.get<{ record: string }>("SELECT record FROM documents WHERE id = ?", w.id);
      if (row === undefined || (JSON.parse(row.record) as { kind?: unknown }).kind !== PI_USAGE) continue;
      before = currentValue(exec, w.id);
      after = w.content.kind === "base" ? w.content.value : apply(structuredClone(before) as never, w.content.ops as never);
    } else continue;
    const was = totalsOf(before), now = totalsOf(after);
    for (const bucket of ["models", "tools"] as const) {
      for (const [key, usage] of Object.entries(now[bucket])) {
        const prev = own(was[bucket], key) ?? {};
        const into = own(out[bucket], key) ?? {};
        for (const c of COUNTERS) {
          const d = num(usage?.[c]) - num(prev[c]);
          if (d !== 0) into[c] = (into[c] ?? 0) + d;
        }
        // Defined, not assigned: a tool may be called `__proto__`.
        Object.defineProperty(out[bucket], key, { value: into, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return out;
}

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
 * is applied to) is a `poll` checkpoint with a handle, and whose new state is not a `poll` of the same handle, and
 * that did not end it unread (`unreadPolls`, whose jobs are cancelled instead): the poll read an answer and the batch
 * acts on it. An abort is not one of these: its handler cancels the job only while the model the poll names is still
 * registered, so its job may well be open here. A generation's answer is an entry naming its job, which marks it (and writes its trace row); a summary's is not
 * (the vendored harness/compaction.js places a summary entry, or nothing), so this is how its job is consumed.
 */
function endedSummaryPolls(exec: SqliteSyncExecutor, writes: readonly StorageWrite[]): string[] {
  const out: string[] = [];
  for (const w of writes) {
    if (w.type !== "task" || w.value.kind !== COMPACTION || endedUnread(w.value.state)) continue;
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
 * Whether a task's new state is an outcome that ends a `poll` without reading its answer: pi-durable's `no_model`
 * failure, or an abort. Both a generation and a compaction write them (harness/generation.js and the vendored
 * harness/compaction.js): `failNoModel` when the model the poll names is no longer registered — the agent's binding
 * moved while the call was out — and it fails before fetching; `abort` settles the task without fetching at all.
 */
function endedUnread(state: unknown): boolean {
  const outcome = isObject(state) ? state.outcome : undefined;
  if (!isObject(outcome)) return false;
  if (outcome.status === "aborted") return true;
  return outcome.status === "failed" && isObject(outcome.error) && isObject(outcome.error.detail) && outcome.error.detail.reason === "no_model";
}

/**
 * The jobs whose `poll` this batch ended unread (`endedUnread`): a task, a generation's or a compaction's, whose stored
 * record is a `poll` checkpoint and whose new state is such an outcome. No entry will name the job and nothing will add
 * its usage to `pi.usage`. An abort's handler cancels the job through the provider's port (`PdHost.#dropJob`), but only
 * while the model the poll names is registered; after the binding moved it skips the cancel, and the job would stay
 * open, to be sent again and its answer stored unbilled. Read from the outcome pi-durable commits, not inferred from
 * the binding: the outcome is the fact, and this batch is the one that records it.
 */
function unreadPolls(exec: SqliteSyncExecutor, writes: readonly StorageWrite[]): string[] {
  const out: string[] = [];
  for (const w of writes) {
    if (w.type !== "task" || !endedUnread(w.value.state)) continue;
    const job = storedPoll(exec, Number(w.value.id));
    if (job !== undefined) out.push(job);
  }
  return out;
}

/**
 * Mark a job cancelled, in the caller's transaction, and return the usage rows of an answer already delivered to it:
 * no commit will append that answer now, so this is where it is billed. One delivered later is billed by
 * `PdHost.deliver`, which reads the mark. Nothing for a job already consumed or cancelled.
 */
export function cancelJob(ap: Pick<ApStore, "query">, id: string, owner: { tenantId: string; agentId: string }, now: number): UsageRow[] {
  const [row] = ap.query("UPDATE model_jobs SET state = 'cancelled' WHERE id = ? AND state IS NULL RETURNING answer", id);
  return row && typeof row.answer === "string" ? strandedAnswerRows(owner, now, row.answer) : [];
}

/** Subtract `usage` from `delta[bucket][key]`: spend already billed elsewhere. */
function subtract(delta: UsageTotals, key: string, usage: Tokens | undefined): void {
  const into = own(delta.models, key);
  if (!into || !usage) return;
  for (const c of COUNTERS) if (num(usage[c]) !== 0) into[c] = (into[c] ?? 0) - num(usage[c]);
}

/** The model named by a `pi.usage` models key, `provider/model`: as an entry of the batch names it, else after the first `/`. */
function modelOf(key: string, named: ReadonlyMap<string, string>): string {
  const known = named.get(key);
  if (known !== undefined) return known;
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/** The commit hook's body. Synchronous, inside the commit's transaction; see the header for what it writes. */
/** Returns the jobs the batch recorded: each is dispatched once the commit has landed. */
export function bookCommit(exec: SqliteSyncExecutor, writes: readonly StorageWrite[], ctx: BookContext): string[] {
  const booked: Booked = { jobs: [], usage: [], trace: [] };

  // Model jobs: recorded by the batch whose poll checkpoint carries the handle. Written as dispatched now: the
  // dispatch follows this commit at once (`PdHost.#afterCommit`), and a sweep that ran before it returned
  // would read an unmarked row as one nobody is carrying and send it a second time. A dispatch that fails
  // is sent again by the sweep once this is a redelivery interval old.
  for (const job of pollHandles(writes, ctx.staged)) {
    ctx.ap.query("INSERT INTO model_jobs (id, conversation_id, request, created_at, dispatched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      job.id, Number.isSafeInteger(job.conversationId) ? job.conversationId : null, ctx.staged.get(job.id)!.request, ctx.now, ctx.now);
    booked.jobs.push(job.id);
  }

  // Answers: the job is consumed. One whose cancel already billed a delivered answer is not billed again.
  const delta = usageDelta(exec, writes);
  const messages = assistantMessages(writes, ctx.owner);
  const named = new Map<string, string>();
  /** Jobs this batch moved to consumed, with their instants: the ones that get a trace row. */
  const jobs = new Map<string, { created_at: unknown; answered_at: unknown }>();
  for (const m of messages) {
    if (typeof m.provider === "string" && typeof m.model === "string") named.set(`${m.provider}/${m.model}`, m.model);
    if (typeof m.jobId !== "string") continue;
    const row = ctx.ap.query("SELECT state, answer, created_at, answered_at FROM model_jobs WHERE id = ?", m.jobId)[0];
    if (!row) continue;
    if (row.state === "cancelled" && row.answer !== null) {
      subtract(delta, `${String(m.provider)}/${String(m.model)}`, m.usage);
      logEvent("pd.jobs.consumed_after_cancel", { ...(ctx.owner ?? {}), jobId: m.jobId });
      continue;
    }
    if (ctx.ap.query("UPDATE model_jobs SET state = 'consumed' WHERE id = ? AND state IS NULL RETURNING id", m.jobId).length > 0) {
      jobs.set(m.jobId, row as { created_at: unknown; answered_at: unknown });
    }
  }

  // A poll that ended unread (`no_model`, or an abort) never read its answer: the job is cancelled, as `PdHost.#dropJob`
  // does — a no-op for one that already did it — so its answer is billed as a stranded one: here if it is in already, by
  // `deliver` when it comes.
  const who = { tenantId: ctx.owner?.tenantId ?? "", agentId: ctx.owner?.agentId ?? "" };
  const base = { at: ctx.now, ...who };
  for (const id of unreadPolls(exec, writes)) {
    const rows = cancelJob(ctx.ap, id, who, ctx.now);
    booked.usage.push(...rows);
    logEvent("pd.jobs.cancelled_unread", { ...(ctx.owner ?? {}), jobId: id, billed: rows.length > 0 });
  }

  // A poll that ended with no entry naming its job (a compaction's summary): consumed, once answered. No trace row:
  // a `model.call` row reads as the turn's own call (src/runtime/status.ts), and a summary is not one.
  for (const id of endedSummaryPolls(exec, writes)) {
    ctx.ap.query("UPDATE model_jobs SET state = 'consumed' WHERE id = ? AND state IS NULL AND answer IS NOT NULL", id);
  }

  // Usage: the pi.usage delta, as rows.
  for (const [key, usage] of Object.entries(delta.models)) booked.usage.push(...modelTokenRows(base, modelOf(key, named), usage));
  for (const usage of Object.values(delta.tools)) booked.usage.push(...modelTokenRows(base, "unknown", usage));
  if (booked.usage.length > 0 && ctx.owner === null) {
    throw new Error("the pd host is not bound to an agent, so the usage this commit records cannot be attributed");
  }
  appendUsage(ctx.raw as Parameters<typeof appendUsage>[0], booked.usage);

  // Trace: not billing, so a failure here is logged and the batch commits without it.
  if (ctx.owner !== null) {
    const owner = ctx.owner;
    try {
      for (const m of messages) {
        if (typeof m.jobId !== "string" || !answerEnded(m.stopReason as Parameters<typeof answerEnded>[0])) continue;
        const job = jobs.get(m.jobId);
        if (!job) continue;
        jobs.delete(m.jobId);
        booked.trace.push(modelCallRow({
          ...owner, jobId: m.jobId, stopReason: m.stopReason as Parameters<typeof modelCallRow>[0]["stopReason"],
          model: typeof m.model === "string" ? m.model : "unknown", at: ctx.now,
          createdAt: Number(job.created_at),
          answeredAt: job.answered_at !== null ? Number(job.answered_at) : null,
        }));
      }
      appendTrace(ctx.raw as Parameters<typeof appendTrace>[0], booked.trace);
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 200);
      logEvent("pd.commit.trace_error", { ...owner, error: message });
      booked.trace = [];
      // Kept where an operator reads, as the drain's refusals are (`trace_drops`, cf/src/trace-r2.ts): a log line
      // alone is gone once it scrolls. Not billing either, so failing to keep it does not fail the commit.
      try { recordTraceError(ctx.raw, ctx.now, message); }
      catch (e) { logEvent("pd.commit.trace_error_unrecorded", { ...owner, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    }
  }

  ctx.fault?.(writes);
  return booked.jobs;
}

/**
 * The usage rows of an answer that no commit will bill: one delivered to a job that was cancelled, or a
 * job cancelled after its answer was delivered and before any commit appended it. Written by the caller in
 * the same transaction as the write that made it so (`PdHost.deliver`, `PdHost.#dropJob`).
 */
export function strandedAnswerRows(owner: { tenantId: string; agentId: string }, now: number, answer: string): UsageRow[] {
  const m = JSON.parse(answer) as MessageLike;
  return m.usage ? modelTokenRows({ at: now, ...owner }, typeof m.model === "string" ? m.model : "unknown", m.usage) : [];
}
