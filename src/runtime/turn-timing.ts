/**
 * Where a turn's wall time goes: one `turn.timing` trace row (src/trace/outbox.ts) per turn of a pi085 conversation,
 * so the time a caller waits that is not a model call can be split rather than inferred.
 *
 * A turn is what a caller waits on: from a message accepted by the object to the reply it can read. On the Agents API
 * a turn that asks for the caller's functions pauses (src/runtime/client-calls.ts) and goes on when their results
 * arrive; pi ends one run at the pause and starts another at the resume, so a turn here can span several runs, and
 * ends only when a run ends with none of its calls left to resume (`turnClientCalls`: made in this turn, answered or
 * not). A steer or a follow-up joins the turn in flight (`messages`). The caller's new input (through the Agents API
 * handler, the one route that passes `receivedAt`) to a turn paused on the caller, with a call still unanswered, ends
 * that turn as `abandoned` (verdict failed, its pause counted up to the input) and opens a new one: the caller chose not
 * to answer, and nothing else would ever end it. Anything else arriving then — a background completion, a push, a
 * lease warning — joins the paused turn.
 *
 * The points, each a millisecond timestamp from the object's clock:
 *   inboundAt      the message entered the object (`AgentRuntime.postMessage`, or the Agents API handler before it)
 *   saidAt         it was durable in the transcript: what lies between is the catalogue, the harness and the binding
 *   turnStartAt    the first step that drove the conversation after it (the alarm pass)
 *   firstJobAt     the first model job of the turn was written (`pi_model_jobs.created_at`)
 *   lastAnswerAt   the last model answer of the turn was delivered (`pi_model_jobs.answered_at`)
 *   replyAt        the step that saw the turn end returned: the reply is in the transcript and the lane is idle
 * and what was summed inside the turn: `modelMs` (each job, created to answered, as `model.call` measures it),
 * `betweenJobsMs` (each answer to the next job written, which holds the tools, the caller's functions and the passes
 * between), `toolMs` (tools that run in the object or through a mount, summed per call, so parallel calls overlap),
 * `clientWaitMs` (each pause, from the step that paused to the results that completed it). With every job answered,
 *   replyAt − inboundAt = inboundToStartMs + startToFirstJobMs + modelMs + betweenJobsMs + lastAnswerToReplyMs.
 *
 * The turn in flight is one row of `turn_timing` per conversation in the object's own storage, because a turn
 * outlives the isolate that started it (a model call is long enough to be evicted in); the job figures are read at the
 * end from `pi_model_jobs`, which already holds them. The trace row is appended in the step that ends the turn and
 * leaves with the alarm pass's existing trace export. Readings, never a reason to fail a turn: every writer here is
 * called inside a try by its caller's rule, and a turn whose start this code never saw (it was in flight across a
 * deploy) has no row and writes none.
 *
 * pd is not covered: its turn goes on inside the harness between steps (a delivered answer wakes it in-process,
 * src/runtime/durable-agent.ts), so no step sees the end, and its jobs and calls live in other tables.
 */
import { appendTrace, type TraceRow, type TraceVerdict } from "../trace/outbox.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const TABLE = "CREATE TABLE IF NOT EXISTS turn_timing(" +
  "session TEXT PRIMARY KEY, inbound_at INTEGER NOT NULL, said_at INTEGER, start_at INTEGER, " +
  "paused_at INTEGER, client_wait_ms INTEGER NOT NULL DEFAULT 0, client_pauses INTEGER NOT NULL DEFAULT 0, " +
  "tool_ms INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 1)";

export function ensureTurnTiming(sql: Sql) {
  sql.exec(TABLE);
}

/** A turn's id: the span of its `turn.timing` row, and what `turnIdOf` answers while it is open. */
const turnIdFor = (session: string, inboundAt: number) => `tt_${session}@${inboundAt}`;

/**
 * The id of the session's turn in flight, or null when none is open. It is the `turn.timing` row's span, so a fact
 * tagged with it while the turn runs (a model call's row, a plugin's call) joins that turn and no other: a turn that was
 * lost without an end is replaced when the next message finds its lane idle (`turnInbound`'s `stale`), under a new id.
 * Never throws: a reading.
 */
export function turnIdOf(sql: Sql, session: string): string | null {
  try {
    const has = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'turn_timing'").toArray().length > 0;
    if (!has) return null;
    const r = sql.exec("SELECT inbound_at FROM turn_timing WHERE session = ?", session).toArray()[0];
    return r ? turnIdFor(session, Number(r.inbound_at)) : null;
  } catch { return null; }
}

/** The conversation's turn in flight, or null. */
export function openTurn(sql: Sql, session: string): { inboundAt: number; startAt: number | null; pausedAt: number | null } | null {
  ensureTurnTiming(sql);
  const r = sql.exec("SELECT inbound_at, start_at, paused_at FROM turn_timing WHERE session = ?", session).toArray()[0];
  if (!r) return null;
  return { inboundAt: Number(r.inbound_at), startAt: r.start_at === null ? null : Number(r.start_at), pausedAt: r.paused_at === null ? null : Number(r.paused_at) };
}

/**
 * A message is about to be written. Opens a turn at `inboundAt` unless one is in flight, which the message joins.
 * `stale`: the row there belongs to no turn (its lane is idle and nothing waits on the caller), so it is replaced.
 * Returns whether this call opened the turn, so a write that fails can take back only what it made.
 */
export function turnInbound(sql: Sql, session: string, inboundAt: number, o: { stale: boolean }): boolean {
  ensureTurnTiming(sql);
  if (o.stale) sql.exec("DELETE FROM turn_timing WHERE session = ?", session);
  const had = sql.exec("SELECT 1 AS x FROM turn_timing WHERE session = ?", session).toArray().length > 0;
  if (had) {
    sql.exec("UPDATE turn_timing SET messages = messages + 1 WHERE session = ?", session);
    return false;
  }
  sql.exec("INSERT INTO turn_timing(session, inbound_at) VALUES (?, ?)", session, Math.floor(inboundAt));
  return true;
}

/** The message is durable. The first write of a turn is its `saidAt`; a later message that joins it changes nothing. */
export function turnSaid(sql: Sql, session: string, at: number) {
  ensureTurnTiming(sql);
  sql.exec("UPDATE turn_timing SET said_at = ? WHERE session = ? AND said_at IS NULL", Math.floor(at), session);
}

/** A record that is no turn's (a cancel found nothing running and nothing waiting): forgotten, with no row. */
export function discardTurn(sql: Sql, session: string) {
  ensureTurnTiming(sql);
  sql.exec("DELETE FROM turn_timing WHERE session = ?", session);
}

/** The message was not written: the turn it opened is not one. A message that joined a turn takes nothing back. */
export function turnNotSaid(sql: Sql, session: string, opened: boolean) {
  ensureTurnTiming(sql);
  if (opened) sql.exec("DELETE FROM turn_timing WHERE session = ?", session);
  else sql.exec("UPDATE turn_timing SET messages = MAX(1, messages - 1) WHERE session = ?", session);
}

/** A step is about to drive the conversation: the first one after the message is the turn's start. */
export function turnStepStart(sql: Sql, session: string, at: number) {
  ensureTurnTiming(sql);
  sql.exec("UPDATE turn_timing SET start_at = ? WHERE session = ? AND start_at IS NULL", Math.floor(at), session);
}

/** A tool ran inside the conversation's turn for `ms`. Nothing when no turn is open. */
export function turnToolRan(sql: Sql, session: string, ms: number) {
  ensureTurnTiming(sql);
  sql.exec("UPDATE turn_timing SET tool_ms = tool_ms + ?, tools = tools + 1 WHERE session = ?", Math.max(0, Math.round(ms)), session);
}

/** The step ended with the turn waiting on the caller's functions. The first such step of a pause is its start. */
export function turnPaused(sql: Sql, session: string, at: number) {
  ensureTurnTiming(sql);
  sql.exec("UPDATE turn_timing SET paused_at = ? WHERE session = ? AND paused_at IS NULL", Math.floor(at), session);
}

/** The caller's results completed a pause: its wait is counted and it is over. A partial submission is not this. */
export function turnResumed(sql: Sql, session: string, at: number) {
  ensureTurnTiming(sql);
  sql.exec("UPDATE turn_timing SET client_wait_ms = client_wait_ms + MAX(0, ? - paused_at), client_pauses = client_pauses + 1, " +
    "paused_at = NULL WHERE session = ? AND paused_at IS NOT NULL", Math.floor(at), session);
}

/** pi's run outcome as the trace reads it: `completed` ok, `aborted` a cancel, anything else a failure — `abandoned`
 *  included, a turn the caller left waiting on its functions and sent new input instead (`AgentRuntime.postMessage`). */
export function turnVerdict(status: string): TraceVerdict {
  if (status === "completed") return "ok";
  if (status === "aborted" || status === "cancelled") return "cancelled";
  return "failed";
}

/**
 * The turn ended at `replyAt`: its row, built from the turn's own record and the jobs written inside it, appended to
 * the trace, and the record forgotten, in one synchronous run of statements. Null, and nothing written, when no turn
 * was open. A pause still open at the end (a cancel while waiting) counts up to `replyAt`.
 */
export function closeTurn(sql: Sql, o: {
  tenantId: string; agentId: string; session: string; replyAt: number; status: string;
}): TraceRow | null {
  ensureTurnTiming(sql);
  const t = sql.exec("SELECT * FROM turn_timing WHERE session = ?", o.session).toArray()[0];
  if (!t) return null;
  const replyAt = Math.floor(o.replyAt);
  const inboundAt = Number(t.inbound_at);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const saidAt = num(t.said_at), startAt = num(t.start_at), pausedAt = num(t.paused_at);
  let clientWaitMs = Number(t.client_wait_ms), clientPauses = Number(t.client_pauses);
  if (pausedAt !== null) { clientWaitMs += Math.max(0, replyAt - pausedAt); clientPauses += 1; }

  // The jobs this turn wrote, oldest first. A table that does not exist yet holds none.
  const hasJobs = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'pi_model_jobs'").toArray().length > 0;
  const jobs = hasJobs
    ? sql.exec("SELECT created_at, answered_at FROM pi_model_jobs WHERE session = ? AND created_at >= ? AND created_at <= ? " +
      "ORDER BY created_at, rowid", o.session, inboundAt, replyAt).toArray()
      .map((j) => ({ created: Number(j.created_at), answered: j.answered_at === null ? null : Number(j.answered_at) }))
    : [];
  const firstJobAt = jobs.length ? jobs[0]!.created : null;
  const first = hasJobs && jobs.length ? firstCallTokens(sql, o.session, inboundAt, replyAt) : null;
  const answered = jobs.filter((j) => j.answered !== null) as Array<{ created: number; answered: number }>;
  const lastAnswerAt = answered.length ? Math.max(...answered.map((j) => j.answered)) : null;
  const modelMs = answered.reduce((s, j) => s + Math.max(0, j.answered - j.created), 0);
  let betweenJobsMs = 0;
  for (let i = 1; i < jobs.length; i++) {
    const prev = jobs[i - 1]!.answered;
    if (prev !== null) betweenJobsMs += Math.max(0, jobs[i]!.created - prev);
  }
  const gap = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.max(0, b - a));

  const row: TraceRow = {
    at: replyAt, tenantId: o.tenantId, agentId: o.agentId, kind: "turn.timing",
    spanId: turnIdFor(o.session, inboundAt),
    status: o.status, verdict: turnVerdict(o.status),
    ms: Math.max(0, replyAt - inboundAt),
    // The split first and the raw points after: keys drop from the end when attrs are too long (outbox.ts `attrsOf`).
    attrs: {
      session: o.session, engine: "pi085",
      inboundToStartMs: gap(inboundAt, startAt), startToFirstJobMs: gap(startAt, firstJobAt), modelMs, betweenJobsMs,
      lastAnswerToReplyMs: gap(lastAnswerAt, replyAt), toolMs: Number(t.tool_ms), clientWaitMs,
      prepMs: gap(inboundAt, saidAt), modelJobs: jobs.length, tools: Number(t.tools), clientPauses, messages: Number(t.messages),
      firstCallPromptTokens: first?.prompt ?? null, firstCallCachedTokens: first?.cached ?? null,
      inboundAt, saidAt, turnStartAt: startAt, firstJobAt, lastAnswerAt, replyAt,
    },
  };
  appendTrace(sql as never, [row]);
  sql.exec("DELETE FROM turn_timing WHERE session = ?", o.session);
  return row;
}

/**
 * The turn's first model call's prompt, and how much of it the provider read from its cache: pi's `usage.input` and
 * `usage.cacheRead` on the answer (src/model/pi-bridge.ts `usageOf`: the provider's `prompt_tokens` /
 * `input_tokens`, and DeepSeek's `prompt_cache_hit_tokens` or OpenAI's `cached_tokens`). What tells a first reply
 * slowed by a cold cache from one slowed by the model. Null when that call has no answer yet or its answer says no usage.
 */
function firstCallTokens(sql: Sql, session: string, from: number, to: number): { prompt: number; cached: number } | null {
  const r = sql.exec("SELECT answer FROM pi_model_jobs WHERE session = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at, rowid LIMIT 1",
    session, from, to).toArray()[0];
  if (!r || r.answer === null || r.answer === undefined) return null;
  let u: any;
  try { u = JSON.parse(String(r.answer))?.usage; } catch { return null; }
  if (!u || typeof u.input !== "number") return null;
  return { prompt: u.input, cached: typeof u.cacheRead === "number" ? u.cacheRead : 0 };
}

/**
 * The tools a harness is handed, each timed into the conversation's turn (`turnToolRan`). A copy of each with only
 * `execute` replaced: name, description and parameters are the same values, so what the model is offered is the same
 * bytes. `skip` keeps a tool as it is: the caller's functions, whose time is the pause and is counted there.
 */
export function timedTools<T extends { execute?: (...args: any[]) => unknown }>(
  tools: readonly T[], o: { skip(tool: T): boolean; ran(ms: number): void; now(): number },
): T[] {
  return tools.map((tool) => {
    const execute = tool.execute;
    if (typeof execute !== "function" || o.skip(tool)) return tool;
    const copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as T;
    copy.execute = async function (this: unknown, ...args: unknown[]) {
      const started = o.now();
      try { return await execute.apply(this, args); }
      finally {
        try { o.ran(o.now() - started); } catch (e) { console.error("timing a tool call failed:", e); }
      }
    };
    return copy;
  });
}
