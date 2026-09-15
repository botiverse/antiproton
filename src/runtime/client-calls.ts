/**
 * Function tools the caller runs itself (Agents API client tools, task #17 step 5).
 *
 * pi has no way to suspend a tool: `execute` is a promise, and one left pending
 * holds the step, and the object with it (measured 2026-09-14: the step never
 * returned and the run stayed "aborting"). So a client tool records the call,
 * aborts the run and fails; the run ends with that failure as the call's
 * result. When the caller's results arrive, the lane is moved back to the
 * assistant message that made the calls — a new branch, which leaves the
 * placeholder failure out of the model's context — and a run starts whose
 * first messages are the real results (measured: the next request carried the
 * user message, the assistant's calls and the real results, nothing else).
 *
 * A result can also arrive before the tool has run: the SDK answers as soon as
 * the stream shows the call, which can be before this object executes it. It
 * is kept, and the tool returns it at once instead of pausing.
 *
 * Several caller functions can arrive in one model message. Once the first of them requests the abort, pi
 * cancels the calls that have not started and records "Tool execution was cancelled before completion." as
 * their result, so the caller was never asked for them and the model read them as cancelled (found
 * 2026-09-15; it was so in every build before). The pause therefore records every caller function of its
 * message as waiting, and the turn continues only when the caller has answered all of them.
 *
 * Depends on: @earendil-works/pi-agent-core 0.85.1 — AgentLane requestAbort / navigateTree / accept, the
 *   measured behaviour that a tool throwing after an abort is recorded as that call's result, that pi
 *   cancels a batch's unstarted calls once the abort is requested (harness/runtime/drive/tools.js), and the tool
 *   signature execute(toolCallId, params, onUpdate, toolContext, invocation, context) with the abort on
 *   context.abortSignal (harness/execution/tools.js). When pi is upgraded, re-run test/client-calls.ts
 *   (it times the pause) and re-check the pause-and-branch design.
 */
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";

type Sql = { exec(query: string, ...bindings: any[]): { toArray(): any[] } };

export interface ClientToolDef { name: string; description: string; parameters: unknown }
export interface PendingClientCall { call_id: string; name: string; arguments: string }

const TABLE = "api_client_calls";

/** What the model's transcript holds for a call while the caller runs it. Never in the model's context once resumed. */
export const CLIENT_PENDING = "waiting for the caller to run this function";

export function ensureClientCalls(sql: Sql) {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (session TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
       arguments TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, output TEXT, is_error INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL, PRIMARY KEY (session, call_id))`);
}

/** Calls in this session that paused their turn and still wait for the caller. */
export function pendingClientCalls(sql: Sql, session: string): PendingClientCall[] {
  ensureClientCalls(sql);
  return sql.exec(
    `SELECT call_id, name, arguments FROM ${TABLE} WHERE session = ? AND state = 'pending' ORDER BY created_at, call_id`, session)
    .toArray().map((r) => ({ call_id: String(r.call_id), name: String(r.name), arguments: String(r.arguments) }));
}

/**
 * The caller's result for a call, kept even when the tool has not run yet.
 * False when that call already has a result.
 */
export function answerClientCall(
  sql: Sql, session: string, callId: string, result: { output: string; isError: boolean }, now = Date.now(),
): boolean {
  ensureClientCalls(sql);
  const row = sql.exec(`SELECT state FROM ${TABLE} WHERE session = ? AND call_id = ?`, session, callId).toArray()[0];
  if (row && row.state !== "pending") return false;
  if (row) {
    sql.exec(`UPDATE ${TABLE} SET state = 'answered', output = ?, is_error = ? WHERE session = ? AND call_id = ?`,
      result.output, result.isError ? 1 : 0, session, callId);
  } else {
    sql.exec(`INSERT INTO ${TABLE}(session, call_id, state, output, is_error, created_at) VALUES (?, ?, 'answered', ?, ?, ?)`,
      session, callId, result.output, result.isError ? 1 : 0, now);
  }
  return true;
}

/** Forget a session's calls, when its turn is cancelled. How many were still waiting. */
export function dropClientCalls(sql: Sql, session: string): number {
  const waiting = pendingClientCalls(sql, session).length;
  sql.exec(`DELETE FROM ${TABLE} WHERE session = ?`, session);
  return waiting;
}

/**
 * Every other caller function in the model message that made `toolCallId`, recorded as waiting. A call the
 * caller already answered keeps its state and gains its name, so the resume uses that answer.
 */
async function recordBatch(
  d: { sql: Sql; session: string; branch(tipId: string): Promise<any[]> }, names: Set<string>, toolCallId: string, tipId: string, at: number,
) {
  const path = await d.branch(tipId);
  const message = [...path].reverse().find((e) => e?.type === "message" && e.message?.role === "assistant"
    && (e.message.content ?? []).some((c: any) => c?.type === "toolCall" && String(c.id) === toolCallId))?.message;
  for (const c of (message?.content ?? []) as any[]) {
    if (c?.type !== "toolCall" || String(c.id) === toolCallId || !names.has(String(c.name))) continue;
    d.sql.exec(
      `INSERT INTO ${TABLE}(session, call_id, name, arguments, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(session, call_id) DO UPDATE SET name = excluded.name, arguments = excluded.arguments`,
      d.session, String(c.id), String(c.name), JSON.stringify(c.arguments ?? {}), at);
  }
}

/** Resolves when the signal aborts, or after `capMs`, whichever is first. */
function abortedOrAfter(signal: AbortSignal | undefined, capMs: number): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, capMs);
    signal.addEventListener("abort", done, { once: true });
  });
}

type PausingLane = {
  inspectExecution(context: typeof CTX): Promise<any>;
  requestAbort(operationId: string, context: typeof CTX): Promise<any>;
};

/** The harness tools for an agent's client functions, in one session. */
export function clientTools(defs: ClientToolDef[], d: {
  sql: Sql; session: string; lane(): PausingLane; branch(tipId: string): Promise<any[]>; now?: () => number;
}) {
  const names = new Set(defs.map((def) => def.name));
  return defs.map((def) => ({
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: def.parameters as any,
    async execute(toolCallId: string, params: unknown, _onUpdate?: unknown, _toolContext?: unknown, _invocation?: unknown,
      context?: { abortSignal?: AbortSignal }) {
      ensureClientCalls(d.sql);
      const early = d.sql.exec(
        `SELECT state, output, is_error FROM ${TABLE} WHERE session = ? AND call_id = ?`, d.session, toolCallId).toArray()[0];
      if (early?.state === "answered") {
        // Marked used, not deleted: a pause elsewhere in this message records all of its caller functions,
        // and must find this one already answered instead of asking the caller for it again.
        d.sql.exec(`UPDATE ${TABLE} SET state = 'used' WHERE session = ? AND call_id = ?`, d.session, toolCallId);
        if (Number(early.is_error)) throw new Error(String(early.output ?? "the caller's function failed"));
        return { content: [{ type: "text" as const, text: String(early.output ?? "") }], details: { client: true } };
      }
      const at = (d.now ?? Date.now)();
      d.sql.exec(
        `INSERT OR REPLACE INTO ${TABLE}(session, call_id, name, arguments, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
        d.session, toolCallId, def.name, JSON.stringify(params ?? {}), at);
      const info = await d.lane().inspectExecution(CTX);
      // Before the abort: the calls it cancels must already be waiting when the caller next reads the session.
      if (info?.tipId) await recordBatch(d, names, toolCallId, String(info.tipId), at);
      const current = info?.current;
      if (current) await d.lane().requestAbort(current.id, CTX);
      // The abort lands on the signal a moment later; failing before it would record a failure the model acts on.
      // The signal is the sixth argument's abortSignal. This read the third (onUpdate, a function) until
      // 2026-09-15, so the wait never saw the abort and always ran to its cap: every caller-run function
      // showed its output 2.00 s after the result was posted (measured on preview, 3 of 3 and 6 of 6).
      // The cap stays only for an abort that never lands.
      await abortedOrAfter(context?.abortSignal, 2000);
      throw new Error(CLIENT_PENDING);
    },
  }));
}

type ResumingLane = {
  inspectExecution(context: typeof CTX): Promise<any>;
  navigateTree(targetId: string | null, options: { summarize?: boolean } | undefined, context: typeof CTX): Promise<any>;
  accept(request: any, context: typeof CTX): Promise<any>;
};

/**
 * Continue a paused turn once every call that paused it has the caller's result.
 * Returns whether a run was started. Does nothing while the lane is busy — the
 * abort may not have settled — or while any call still waits.
 */
export async function resumeClientCalls(d: {
  sql: Sql; session: string; lane: ResumingLane; branch(tipId: string): Promise<any[]>; now?: () => number;
}): Promise<boolean> {
  ensureClientCalls(d.sql);
  // A row with a name was recorded by a tool that paused; one without is an early answer for a call not yet run.
  const paused = d.sql.exec(`SELECT call_id, state, output, is_error FROM ${TABLE} WHERE session = ? AND name != ''`, d.session).toArray();
  if (!paused.length || paused.some((r) => r.state === "pending")) return false;
  const info = await d.lane.inspectExecution(CTX);
  if (info?.current || !info?.tipId) return false;
  const path = await d.branch(String(info.tipId));
  const answers = new Map(paused.map((r) => [String(r.call_id), r]));
  const isCall = (c: any) => c?.type === "toolCall";
  const callEntry = [...path].reverse().find((e) =>
    e?.type === "message" && e.message?.role === "assistant" && (e.message.content ?? []).some((c: any) => isCall(c) && answers.has(String(c.id))));
  if (!callEntry) return false;
  // The other calls in the same message ran here and have results on the branch being left: they come along.
  const after = path.slice(path.indexOf(callEntry) + 1);
  const ranHere = new Map(after
    .filter((e) => e?.type === "message" && e.message?.role === "toolResult" && !answers.has(String(e.message.toolCallId)))
    .map((e) => [String(e.message.toolCallId), e.message]));
  const now = (d.now ?? Date.now)();
  const results = (callEntry.message.content as any[]).filter(isCall).flatMap((c) => {
    const answer = answers.get(String(c.id));
    if (answer) {
      return [{ role: "toolResult", toolCallId: String(c.id), toolName: String(c.name),
        content: [{ type: "text", text: String(answer.output ?? "") }], isError: !!Number(answer.is_error), timestamp: now }];
    }
    const ran = ranHere.get(String(c.id));
    return ran ? [ran] : [];
  });
  const moved = await d.lane.navigateTree(String(callEntry.id), { summarize: false }, CTX);
  if (moved?.ok === false) return false;
  const started = await d.lane.accept({ kind: "prompt", prompt: results }, CTX);
  if (started?.ok === false) return false;
  // The paused calls, and early answers already used (none can belong to a run in flight: the lane is idle).
  d.sql.exec(`DELETE FROM ${TABLE} WHERE session = ? AND (name != '' OR state = 'used')`, d.session);
  return true;
}
