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
 * Which messages a series is about: those of every push its turn was given (`AgentRuntime.postMessage` records them,
 * `addTurnMessages`, before any call of the run it starts exists), and those of the series before it, kept
 * for the series' life. A service may push again about messages it already pushed while they stay unanswered — Raft's
 * sweep sends a new notice, under a new id, a few minutes later, and its notice carries the whole unread inbox where the
 * first carried only the conversation that changed — and such a push brings nothing new: posted, it would end the series
 * and count it again from one, so a turn could be retried for as long as the service keeps pushing and never be given
 * up. So while a series is open (`scheduled`, `redispatched`) or given up (`gave_up`), a push each of whose messages the
 * series already holds is answered as a duplicate and posts nothing (`seriesDuplicate`, asked by
 * `AgentRuntime.receiveHook` where MODEL_FALLBACK is on); a push with any message the series does not hold is a new
 * message and starts a new series as before. A series whose run then answered is `answered`, and holds nothing back.
 */
import { busyGivenUp, busyRetrying } from "../model/model-fallback.ts";
import type { TraceRow } from "../trace/outbox.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const TABLE = `CREATE TABLE IF NOT EXISTS model_busy_retry (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, job_id TEXT NOT NULL, attempts INTEGER NOT NULL, state TEXT NOT NULL,
  due_at INTEGER, updated_at INTEGER NOT NULL, message_ids TEXT, PRIMARY KEY (tenant_id, agent_id))`;
/** A table made before the column (a series opened before this was deployed) gets it, nullable: such a series holds nothing back. */
function ensureTable(sql: Sql) {
  sql.exec(TABLE);
  try { sql.exec("SELECT message_ids FROM model_busy_retry WHERE 0"); } catch { sql.exec("ALTER TABLE model_busy_retry ADD COLUMN message_ids TEXT"); }
}

/** A stored JSON array of message ids; empty for anything else. */
function idsOf(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
}

const TURN = "CREATE TABLE IF NOT EXISTS busy_turn_messages (id INTEGER PRIMARY KEY CHECK (id = 1), message_ids TEXT, at INTEGER NOT NULL)";

/**
 * The messages the main conversation's unanswered turn has been given: every push's (`InboundResult.messageIds`)
 * posted since its last answer, added by `AgentRuntime.postMessage` once the engine took the post — before any call of
 * the run it starts or joins exists, so a busy answer in that run finds its own post's messages — and cleared when a
 * call ends a turn with an answer (`clearTurnMessages`), so a later turn never holds an earlier one's. A post that is
 * no push adds nothing.
 */
export function addTurnMessages(sql: Sql, ids: readonly string[] | null | undefined, now: number) {
  if (!ids?.length) return;
  sql.exec(TURN);
  const all = [...new Set([...turnMessages(sql), ...ids])].sort();
  sql.exec("INSERT INTO busy_turn_messages(id, message_ids, at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET message_ids = excluded.message_ids, at = excluded.at",
    JSON.stringify(all), now);
}

/** The turn was answered: its messages are handled. */
export function clearTurnMessages(sql: Sql) {
  try { sql.exec("DELETE FROM busy_turn_messages"); } catch { /* never written */ }
}

export function turnMessages(sql: Sql): string[] {
  try { return idsOf((sql.exec("SELECT message_ids FROM busy_turn_messages WHERE id = 1").toArray()[0] as any)?.message_ids); }
  catch { return []; }
}

export type BusyState = "scheduled" | "redispatched" | "superseded" | "cancelled" | "gave_up" | "answered";
export interface BusyRetryRow { jobId: string; attempts: number; state: BusyState; dueAt: number | null; updatedAt: number }

export function readBusyRetry(sql: Sql, tenantId: string, agentId: string): BusyRetryRow | null {
  let r: any;
  try { r = sql.exec("SELECT job_id, attempts, state, due_at, updated_at FROM model_busy_retry WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()[0]; }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return null; throw e; }
  return r ? { jobId: String(r.job_id), attempts: Number(r.attempts), state: String(r.state) as BusyState, dueAt: r.due_at === null ? null : Number(r.due_at),
    updatedAt: Number(r.updated_at) } : null;
}

/**
 * A busy answer to `jobId` is being delivered: decide what follows, write it down, and return the sentence the answer
 * carries for its readers and Raft (`model_busy: …retrying in N` or `model_unavailable: …giving up`). `retryAfterMs`
 * empty (no fallback configured any more, or a call outside the scope) gives up at once.
 */
export function noteBusy(sql: Sql, tenantId: string, agentId: string, jobId: string, retryAfterMs: readonly number[], now: number,
  turnIds: readonly string[] = [], windowMs = 0): { sentence: string; attempts: number; dueAt: number | null } {
  ensureTable(sql);
  const prev = readBusyRetry(sql, tenantId, agentId);
  const continues = prev?.state === "redispatched";
  const attempts = continues ? prev.attempts + 1 : 1;
  const wait = retryAfterMs[attempts - 1];
  const dueAt = wait === undefined ? null : now + wait;
  // The messages the series holds: its turn's (`addTurnMessages`), and those of the series it continues — the same turn
  // re-dispatched, or one a new post carried on (`superseded`) — within `windowMs` of its last change: given to the agent
  // and still unanswered, they are not new when a service pushes them again. Never those of a series that is over
  // (`answered`, `gave_up`, `cancelled`): its messages were answered or let go, and a set carried from episode to episode
  // would only grow.
  const inherits = prev && (prev.state === "redispatched" || prev.state === "superseded") && now - prev.updatedAt < windowMs;
  const before = inherits ? seriesMessageIds(sql, tenantId, agentId) : [];
  const ids = [...new Set([...before, ...turnIds])].sort();
  sql.exec(`INSERT INTO model_busy_retry(tenant_id, agent_id, job_id, attempts, state, due_at, updated_at, message_ids) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, agent_id) DO UPDATE SET job_id=excluded.job_id, attempts=excluded.attempts, state=excluded.state,
    due_at=excluded.due_at, updated_at=excluded.updated_at, message_ids=excluded.message_ids`,
    tenantId, agentId, jobId, attempts, dueAt === null ? "gave_up" : "scheduled", dueAt, now, ids.length ? JSON.stringify(ids) : null);
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

/** The messages the agent's series holds (`noteBusy`). */
export function seriesMessageIds(sql: Sql, tenantId: string, agentId: string): string[] {
  try { return idsOf((sql.exec("SELECT message_ids FROM model_busy_retry WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()[0] as any)?.message_ids); }
  catch { return []; }
}

/**
 * Whether a push about `ids` brings nothing new to the agent's open or given-up series: every one of its messages is one
 * the series already holds. Then it is a duplicate delivery, and posting it would only end the series and count again
 * from one. A push with any message the series does not hold — a newer latest message anywhere — is not. Only within
 * `windowMs` of the series' last change, so a series nobody has touched for a day holds nothing back.
 */
export function seriesDuplicate(sql: Sql, tenantId: string, agentId: string, ids: readonly string[] | null | undefined, now: number, windowMs: number): boolean {
  if (!ids?.length) return false;
  let r: any;
  try { r = sql.exec("SELECT state, updated_at, message_ids FROM model_busy_retry WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()[0]; }
  catch { return false; }
  if (!r || !["scheduled", "redispatched", "gave_up"].includes(String(r.state)) || now - Number(r.updated_at) >= windowMs) return false;
  const held = new Set(idsOf(r.message_ids));
  return ids.every((id) => held.has(id));
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
