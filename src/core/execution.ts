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
}

export interface HeldCall { tool: string; operationId: string; status: "pending" }

export interface Paused {
  /** `pause` when the program called pause(); `hold` when a call came back pending. */
  cause: "pause" | "hold";
  reason: string;
  data: Json;
  /** Set when `data` could not be kept: not JSON-serialisable. */
  dataError?: string;
}

/**
 * How a program asks to stop: `pause(reason, data)`.
 *
 * Source text, not a function, because both executors install it INSIDE the
 * sandbox: QuickJS evaluates it in the context, the Dynamic Worker splices it
 * into the module. One text, so the two cannot drift. `record` is the host's
 * side; it is closed over here and never reachable by the program's own code.
 * Serialising happens in the sandbox because only there can a circular object
 * or a BigInt be seen for what it is; the host receives a string or a problem.
 *
 * It throws so that nothing after the line runs. A program's own try/catch can
 * catch that throw, which is why the throw is not what makes the run paused:
 * `record` sets the host's state first, every later tool call and output is
 * refused by the host, and the result is read from that state when the program
 * ends — however it ends.
 */
export const PAUSE_FACTORY = `(function (record) {
  return function pause(reason, data) {
    var r, json = null, problem = null;
    try { r = String(reason); } catch (e) { r = "(a reason that could not be turned into text)"; }
    try {
      json = data === undefined ? "null" : JSON.stringify(data);
      if (typeof json !== "string") { json = null; problem = "pause data is not JSON-serialisable (" + typeof data + "); nothing of it was kept"; }
    } catch (e) {
      json = null;
      problem = "pause data is not JSON-serialisable (" + String((e && e.message) || e) + "); nothing of it was kept";
    }
    record(r, json, problem);
    var stop = new Error("run_js paused: " + r);
    stop.name = "RunJsPaused";
    throw stop;
  };
})`;

/** A reason is a line for the model, not a payload; `data` is the payload. */
export const MAX_PAUSE_REASON = 500;

/**
 * The host's side of pause(): what the sandbox handed over, kept within the
 * room the output cap has left, so outputs and data together never exceed
 * `maxOutputBytes` (counted the same way: UTF-16 code units of the JSON).
 */
export function pauseFrom(reason: string, json: string | null, problem: string | null, room: number): Paused {
  const r = reason.length > MAX_PAUSE_REASON ? `${reason.slice(0, MAX_PAUSE_REASON)}…` : reason;
  if (json === null) return { cause: "pause", reason: r, data: null, dataError: problem ?? "pause data is missing" };
  if (json.length > room) return { cause: "pause", reason: r, data: { truncated: true, reason: "max_output_bytes" } };
  return { cause: "pause", reason: r, data: JSON.parse(json) as Json };
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
