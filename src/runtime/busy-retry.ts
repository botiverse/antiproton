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
 * first, or one after a person's message started a new run — starts it at one. After `retryAfterMs.length`
 * re-dispatches the next busy answer gives up (`gave_up`), and the turn stays failed until the person writes again.
 */
import { busyGivenUp, busyRetrying } from "../model/model-fallback.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const TABLE = `CREATE TABLE IF NOT EXISTS model_busy_retry (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, job_id TEXT NOT NULL, attempts INTEGER NOT NULL, state TEXT NOT NULL,
  due_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, agent_id))`;

export type BusyState = "scheduled" | "redispatched" | "superseded" | "gave_up";
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
export function noteBusy(sql: Sql, tenantId: string, agentId: string, jobId: string, retryAfterMs: readonly number[], now: number):
  { sentence: string; attempts: number; dueAt: number | null } {
  sql.exec(TABLE);
  const prev = readBusyRetry(sql, tenantId, agentId);
  const attempts = prev?.state === "redispatched" ? prev.attempts + 1 : 1;
  const wait = retryAfterMs[attempts - 1];
  const dueAt = wait === undefined ? null : now + wait;
  sql.exec(`INSERT INTO model_busy_retry(tenant_id, agent_id, job_id, attempts, state, due_at, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, agent_id) DO UPDATE SET job_id=excluded.job_id, attempts=excluded.attempts, state=excluded.state,
    due_at=excluded.due_at, updated_at=excluded.updated_at`,
    tenantId, agentId, jobId, attempts, dueAt === null ? "gave_up" : "scheduled", dueAt, now);
  return { sentence: dueAt === null ? busyGivenUp(attempts) : busyRetrying(wait!), attempts, dueAt };
}

/** The scheduled re-dispatch, if there is one: the busy job it retries and when. */
export function busyRetryScheduled(sql: Sql, tenantId: string, agentId: string): { jobId: string; dueAt: number; attempts: number } | null {
  const r = readBusyRetry(sql, tenantId, agentId);
  return r && r.state === "scheduled" && r.dueAt !== null ? { jobId: r.jobId, dueAt: r.dueAt, attempts: r.attempts } : null;
}

/** The scheduled retry of `jobId` ended: re-dispatched, or superseded by a newer run. Only from `scheduled`, once. */
export function settleBusyRetry(sql: Sql, tenantId: string, agentId: string, jobId: string, state: "redispatched" | "superseded", now: number): boolean {
  if (busyRetryScheduled(sql, tenantId, agentId)?.jobId !== jobId) return false;
  sql.exec("UPDATE model_busy_retry SET state=?, due_at=NULL, updated_at=? WHERE tenant_id=? AND agent_id=? AND state='scheduled' AND job_id=?",
    state, now, tenantId, agentId, jobId);
  return true;
}
