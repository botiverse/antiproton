import type { Json } from "./types.ts";
import type { ToolResult } from "./tools.ts";

export interface ExecutionLimits {
  wallTimeMs: number;
  memoryBytes: number;
  maxStackBytes: number;
  maxHostCalls: number;
  maxConcurrentHostCalls: number;
  maxOutputBytes: number;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  wallTimeMs: 5_000,
  memoryBytes: 64 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
  maxHostCalls: 64,
  maxConcurrentHostCalls: 8,
  maxOutputBytes: 64 * 1024,
};

export interface ExecutorHost {
  invoke(call: { tool: string; args: Json; opts: Record<string, Json> }): Promise<ToolResult>;
}

export interface ExecutionResult {
  status: "completed" | "failed" | "interrupted" | "paused";
  outputs: Json[];
  acceptedOperationIds: string[];
  hostCalls: number;
  error?: { code: string; message: string };
  /** Why a `paused` run stopped: the program called pause(), or a call came back held. */
  pause?: Paused;
  /** Every call that came back `pending` (awaiting a person), whatever ended the run. */
  held?: HeldCall[];
  /**
   * Set on a `paused` result when the program is waiting at its pause() and
   * can go on: it is suspended in memory, not ended. Absent when the run
   * ended (a hold, a pause the program never awaited). Whoever receives it
   * owns the program: resume it, cancel it, or it waits for ever.
   */
  continuation?: Continuation;
}

/**
 * A program suspended at `await pause(...)`. One use: `resume` or `cancel`,
 * once; a later stop comes with a continuation of its own. Outputs, host
 * calls and accepted operations in the results it returns are the whole
 * program's, counted from its start.
 */
export interface Continuation {
  /** `answer` becomes pause()'s return value; settles with how the program next stops. */
  resume(answer: Json): Promise<ExecutionResult>;
  /** pause() rejects with a cancellation the program cannot swallow; settles
   *  `interrupted` with code `cancelled` and what was output before. */
  cancel(): Promise<ExecutionResult>;
}

export interface HeldCall { tool: string; operationId: string; status: "pending" }

export interface Paused {
  /** `pause` when the program called pause(); `hold` when a call came back pending. */
  cause: "pause" | "hold";
  reason: string;
  data: Json;
  /** Set when `data` could not be kept: not JSON-serialisable. */
  dataError?: string;
  /**
   * pause()'s third argument, as the program gave it: what kind of answer it
   * expects. Raw here; run-js-resume.ts `answerSpecOf` decides what it means.
   * Absent when the program gave none.
   */
  answer?: Json;
  /** Set when the third argument could not be carried (not JSON, or too large). */
  answerError?: string;
}

/**
 * How a program asks to stop: `const answer = await pause(reason, data)`.
 *
 * Source text, not a function, because both executors install it INSIDE the
 * sandbox: QuickJS evaluates it in the context, the Dynamic Worker splices it
 * into the module. One text, so the two cannot drift. `record` and `wait` are
 * the host's side; they are closed over here and never reachable by the
 * program's own code. Serialising happens in the sandbox because only there
 * can a circular object or a BigInt be seen for what it is; the host receives
 * a string or a problem.
 *
 * The third argument says what answer the program expects (run-js-resume.ts
 * `answerSpecOf`); it travels as JSON text, "" when it is not JSON, null when
 * absent, and the host checks the model's answer against it.
 *
 * `record` sets the host's state first and says whether this pause is the
 * run's first stop. If it is not (a held call or an earlier pause stopped the
 * run already) pause() throws, so nothing after the line runs. If it is,
 * pause() returns something to await, and the program is SUSPENDED only when
 * it actually waits on it: `wait` is called from `then`, not from pause(). A
 * program that never awaits its pause goes on running with every tool call
 * and output refused, and ends the way it did before pauses could be resumed
 * — paused, with nothing to resume. Without that distinction a Dynamic Worker
 * supervisor, which cannot see the sandbox's microtask queue, could hand the
 * model a token for a program that had already finished.
 *
 * What `wait` returns settles with the model's answer — pause()'s return
 * value — or rejects: cancelled, discarded, or not resumable after all. A
 * program's own try/catch can catch that rejection, which is why it is not
 * what ends the run: the host's state refuses every later call and output,
 * and the result is read from that state when the program ends — however it
 * ends.
 */
export const PAUSE_FACTORY = `(function (record, wait) {
  return function pause(reason, data, answer) {
    var r, json = null, problem = null;
    try { r = String(reason); } catch (e) { r = "(a reason that could not be turned into text)"; }
    try {
      json = data === undefined ? "null" : JSON.stringify(data);
      if (typeof json !== "string") { json = null; problem = "pause data is not JSON-serialisable (" + typeof data + "); nothing of it was kept"; }
    } catch (e) {
      json = null;
      problem = "pause data is not JSON-serialisable (" + String((e && e.message) || e) + "); nothing of it was kept";
    }
    var spec = null;
    if (answer !== undefined) {
      try { spec = JSON.stringify(answer); } catch (e) { spec = null; }
      if (typeof spec !== "string") spec = "";
    }
    if (!record(r, json, problem, spec)) {
      var stop = new Error("run_js paused: " + r);
      stop.name = "RunJsPaused";
      throw stop;
    }
    var waiting = null;
    var start = function () { return waiting || (waiting = wait()); };
    return {
      then: function (ok, fail) { return start().then(ok, fail); },
      catch: function (fail) { return start().then(undefined, fail); },
      finally: function (f) { return start().finally(f); }
    };
  };
})`;

/** What pause()'s promise rejects with when the model cancels the suspended program, or it expires. */
export const CANCELLED_NAME = "RunJsCancelled";

/** A reason is a line for the model, not a payload; `data` is the payload. */
export const MAX_PAUSE_REASON = 500;

/**
 * The host's side of pause(): what the sandbox handed over, kept within the
 * room the output cap has left, so outputs and data together never exceed
 * `maxOutputBytes` (counted the same way: UTF-16 code units of the JSON).
 */
export function pauseFrom(
  reason: string, json: string | null, problem: string | null, room: number, answer: string | null = null,
): Paused {
  const r = reason.length > MAX_PAUSE_REASON ? `${reason.slice(0, MAX_PAUSE_REASON)}…` : reason;
  const spec = answerFrom(answer);
  if (json === null) return { cause: "pause", reason: r, data: null, dataError: problem ?? "pause data is missing", ...spec };
  if (json.length > room) return { cause: "pause", reason: r, data: { truncated: true, reason: "max_output_bytes" }, ...spec };
  return { cause: "pause", reason: r, data: JSON.parse(json) as Json, ...spec };
}

/** A description of an answer is a few choices or a small schema, not a payload. */
export const MAX_ANSWER_SPEC = 4_096;

function answerFrom(text: string | null): { answer?: Json; answerError?: string } {
  if (text === null || text === undefined) return {};
  if (typeof text !== "string" || text === "") return { answerError: "pause()'s third argument is not JSON; no answer check applies" };
  if (text.length > MAX_ANSWER_SPEC) return { answerError: `pause()'s third argument is over ${MAX_ANSWER_SPEC} characters; no answer check applies` };
  try { return { answer: JSON.parse(text) as Json }; } catch { return { answerError: "pause()'s third argument is not JSON; no answer check applies" }; }
}

/** A call held for approval stops the run the same way pause() does. */
export function holdFrom(tool: string, res: { operationId: string; error?: { code?: string } }): Paused {
  return {
    cause: "hold",
    reason: res.error?.code ?? "awaiting_approval",
    data: { tool, operationId: res.operationId },
  };
}

/**
 * The seam §15 asked for. QuickJS satisfies it in Node; Cloudflare Dynamic
 * Workers satisfy it at the edge. Both must pass test/spec/executor-spec.ts.
 */
export interface JsExecutor {
  execute(
    source: string,
    host: ExecutorHost,
    limits?: ExecutionLimits,
    signal?: AbortSignal,
  ): Promise<ExecutionResult>;
}
