/**
 * What an agent's object does after a first-turn call neither model answered (a busy answer, src/model/model-fallback.ts):
 * re-dispatch the same turn after the first of MODEL_FALLBACK's `retryAfterS`, again after the next if that is busy too,
 * and give up after the last.
 *
 * The retry is ours, not the queue's or pi's. The queue would redeliver within seconds, up to four times, each delivery
 * able to wait out a whole call deadline; pi would retry on its own backoff of one to four seconds. Both would ask
 * providers that have just failed two calls for a minute or more. So the busy answer is delivered as the job's answer
 * (the turn ends once, as a failure no harness retries), and this module keeps the schedule.
 *
 * Durable and idempotent, the way the import hold and the prewarm are: one row per agent, written in the same
 * transaction as the answer it is about (`AgentRuntime.deliverAnswer`, cf/src/runtime.ts). A retry is due when its
 * row is `scheduled` and `due_at` has passed; the alarm pass asks (`AgentRuntime.step`), and the step that is not yet
 * due says when to come back, so the wake survives an eviction like every other wake the pass computes. The
 * re-dispatch itself (`AgentEngine.retryTurn`) only runs while the busy answer is still the conversation's last
 * entry and nothing is running: a person's newer message has started its own run by then, which carries the same
 * turn on (the busy answer does not end the first turn, `inFirstTurn`), and the row is then `superseded` rather than
 * acted on — so a turn is never run twice. Once re-dispatched, the row says so, and a second pass finds nothing due.
 *
 * Counting: a busy answer to a run this module started continues the count (`redispatched`); any other — the
 * first, or one after a new post — starts it at one: a prompt or steer the engine took on the main conversation
 * (`AgentRuntime.postMessage`; not a follow-up, not a post that wrote nothing), or a cancel of it, ends the series
 * (`endBusyRetry`), whether a re-dispatch was still scheduled or had already run. After `retryAfterMs.length`
 * re-dispatches the next busy answer gives up (`gave_up`), and the turn stays failed until the person writes again.
 *
 * Which messages a series is about: the `messageKey` of the last push delivered when it started (`noteBusy`), kept
 * for the series' life. A service may push again about the same messages while they stay unanswered — Raft sends a
 * new notice, under a new id, while an inbox stays unread — and such a push is not a new message: posted, it would
 * end the series and start it again at one, so a turn could be retried for as long as the service keeps pushing and
 * never be given up. So while a series is open (`scheduled`, `redispatched`) or given up (`gave_up`), a push with its
 * key is answered as a duplicate and posts nothing (`seriesDuplicate`, asked by `AgentRuntime.receiveHook`); a push
 * about anything else is a new message and starts a new series as before. A series whose run then answered is
 * `answered` (`seriesAnswered`), and holds nothing back.
 */
import { busyGivenUp, busyRetrying } from "../model/model-fallback.ts";
import type { TraceRow } from "../trace/outbox.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const TABLE = `CREATE TABLE IF NOT EXISTS model_busy_retry (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, job_id TEXT NOT NULL, attempts INTEGER NOT NULL, state TEXT NOT NULL,
  due_at INTEGER, updated_at INTEGER NOT NULL, message_key TEXT, PRIMARY KEY (tenant_id, agent_id))`;
/** A table made before the column (a series opened before this was deployed) gets it, nullable: such a series holds nothing back. */
function ensureTable(sql: Sql) {
  sql.exec(TABLE);
  try { sql.exec("SELECT message_key FROM model_busy_retry WHERE 0"); } catch { sql.exec("ALTER TABLE model_busy_retry ADD COLUMN message_key TEXT"); }
}

export type BusyState = "scheduled" | "redispatched" | "superseded" | "cancelled" | "gave_up" | "answered";
export interface BusyRetryRow { jobId: string; attempts: number; state: BusyState; dueAt: number | null }

export function readBusyRetry(sql: Sql, tenantId: string, agentId: string): BusyRetryRow | null {
  let r: any;
  try { r = sql.exec("SELECT job_id, attempts, state, due_at FROM model_busy_retry WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()[0]; }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return null; throw e; }
  return r ? { jobId: String(r.job_id), attempts: Number(r.attempts), state: String(r.state) as BusyState, dueAt: r.due_at === null ? null : Number(r.due_at) } : null;
}

/**
 * A busy answer to `jobId` is being delivered: decide what follows, write it down, and return the sentence the answer
 * carries for its readers and Raft (`model_busy: …retrying in N` or `model_unavailable: …giving up`). `retryAfterMs`
 * empty (no fallback configured any more, or a call outside the scope) gives up at once.
 */
export function noteBusy(sql: Sql, tenantId: string, agentId: string, jobId: string, retryAfterMs: readonly number[], now: number,
  messageKey: string | null = null): { sentence: string; attempts: number; dueAt: number | null } {
  ensureTable(sql);
  const prev = readBusyRetry(sql, tenantId, agentId);
  const continues = prev?.state === "redispatched";
  const attempts = continues ? prev.attempts + 1 : 1;
  const wait = retryAfterMs[attempts - 1];
  const dueAt = wait === undefined ? null : now + wait;
  // A series keeps the messages it started with; a new one takes those of the last push delivered.
  const key = continues ? seriesMessageKey(sql, tenantId, agentId) : messageKey;
  sql.exec(`INSERT INTO model_busy_retry(tenant_id, agent_id, job_id, attempts, state, due_at, updated_at, message_key) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, agent_id) DO UPDATE SET job_id=excluded.job_id, attempts=excluded.attempts, state=excluded.state,
    due_at=excluded.due_at, updated_at=excluded.updated_at, message_key=excluded.message_key`,
    tenantId, agentId, jobId, attempts, dueAt === null ? "gave_up" : "scheduled", dueAt, now, key);
  return { sentence: dueAt === null ? busyGivenUp(attempts) : busyRetrying(wait!), attempts, dueAt };
}

/** The scheduled re-dispatch, if there is one: the busy job it retries and when. */
export function busyRetryScheduled(sql: Sql, tenantId: string, agentId: string): { jobId: string; dueAt: number; attempts: number } | null {
  const r = readBusyRetry(sql, tenantId, agentId);
  return r && r.state === "scheduled" && r.dueAt !== null ? { jobId: r.jobId, dueAt: r.dueAt, attempts: r.attempts } : null;
}

/**
 * The series ends without a re-dispatch of its own: a person's message carries the turn (`superseded`), or a cancel
 * stops it (`cancelled`). A scheduled re-dispatch is not made, and a run this module started no longer continues the
 * count. Returns the row's state before, so the caller knows whether a scheduled retry was stopped.
 */
export function endBusyRetry(sql: Sql, tenantId: string, agentId: string, state: "superseded" | "cancelled", now: number): BusyState | null {
  const r = readBusyRetry(sql, tenantId, agentId);
  if (!r || (r.state !== "scheduled" && r.state !== "redispatched")) return r?.state ?? null;
  sql.exec("UPDATE model_busy_retry SET state=?, due_at=NULL, updated_at=? WHERE tenant_id=? AND agent_id=?", state, now, tenantId, agentId);
  return r.state;
}

/** The agent is deleted: nothing of the schedule is kept, and nothing can re-dispatch. */
export function clearBusyRetry(sql: Sql, tenantId: string, agentId: string): boolean {
  if (!readBusyRetry(sql, tenantId, agentId)) return false;
  sql.exec("DELETE FROM model_busy_retry WHERE tenant_id=? AND agent_id=?", tenantId, agentId);
  return true;
}

/** The scheduled retry of `jobId` ended: re-dispatched, or superseded by a newer run. Only from `scheduled`, once. */
export function settleBusyRetry(sql: Sql, tenantId: string, agentId: string, jobId: string, state: "redispatched" | "superseded" | "gave_up", now: number): boolean {
  if (busyRetryScheduled(sql, tenantId, agentId)?.jobId !== jobId) return false;
  sql.exec("UPDATE model_busy_retry SET state=?, due_at=NULL, updated_at=? WHERE tenant_id=? AND agent_id=? AND state='scheduled' AND job_id=?",
    state, now, tenantId, agentId, jobId);
  return true;
}

/**
 * The `model.retry` trace row for a scheduled re-dispatch that has ended, spanned by the busy job it retried:
 * `started` (re-dispatched), `moved` (a newer run carried the turn), `refused` (given up — the engine would not
 * start it, or the registry stayed unreadable, `reason` — and `busy` carries the
 * `model_unavailable` sentence, which Raft is shown, src/runtime/activity.ts) or `cancelled` (Raft is shown the turn's
 * stop). `ms` is how late the pass was against the schedule.
 */
export function busyRetryRow(r: {
  tenantId: string; agentId: string; jobId: string; outcome: "started" | "moved" | "refused" | "cancelled"; attempt: number; at: number;
  lateMs?: number; sentence?: string | null;
  /** Why a `refused` was given up when it is not the engine's refusal: `registry_unreadable`. */
  reason?: string;
}): TraceRow {
  return {
    at: r.at, tenantId: r.tenantId, agentId: r.agentId, kind: "model.retry", spanId: r.jobId, status: r.outcome,
    verdict: r.outcome === "refused" ? "failed" : r.outcome === "cancelled" ? "cancelled" : "ok",
    attrs: { attempt: r.attempt, ...(r.sentence ? { busy: r.sentence } : {}), ...(r.reason ? { reason: r.reason } : {}),
      ...(r.lateMs !== undefined ? { lateMs: r.lateMs } : {}) },
  };
}

/** The messages the agent's series is about (`noteBusy`), or null. */
export function seriesMessageKey(sql: Sql, tenantId: string, agentId: string): string | null {
  try {
    const r = sql.exec("SELECT message_key FROM model_busy_retry WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()[0] as any;
    return r && r.message_key !== null && r.message_key !== undefined ? String(r.message_key) : null;
  } catch { return null; }
}

/**
 * Whether a push about `messageKey` repeats the messages of the agent's open or given-up series: then it is a
 * duplicate delivery, and posting it would only end the series and count again from one. Only within `windowMs` of the
 * series' last change, so a series nobody has touched for a day holds nothing back.
 */
export function seriesDuplicate(sql: Sql, tenantId: string, agentId: string, messageKey: string | null | undefined, now: number, windowMs: number): boolean {
  if (!messageKey) return false;
  let r: any;
  try { r = sql.exec("SELECT state, updated_at, message_key FROM model_busy_retry WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()[0]; }
  catch { return false; }
  return !!r && r.message_key === messageKey && ["scheduled", "redispatched", "gave_up"].includes(String(r.state))
    && now - Number(r.updated_at) < windowMs;
}

/** A model call of the main conversation was answered (not busy): a re-dispatched series is over, and holds nothing back. */
export function seriesAnswered(sql: Sql, tenantId: string, agentId: string, now: number): boolean {
  try {
    const r = readBusyRetry(sql, tenantId, agentId);
    if (r?.state !== "redispatched") return false;
    sql.exec("UPDATE model_busy_retry SET state='answered', updated_at=? WHERE tenant_id=? AND agent_id=? AND state='redispatched'", now, tenantId, agentId);
    return true;
  } catch { return false; }
}
