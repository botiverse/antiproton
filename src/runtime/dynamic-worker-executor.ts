import { parseTemplateCall } from "../core/tools.ts";
import type { ToolResult } from "../core/tools.ts";
import type { Json } from "../core/types.ts";
import { DEFAULT_LIMITS, PAUSE_FACTORY, holdFrom, pauseFrom } from "../core/execution.ts";
import type { ExecutionLimits, ExecutionResult, ExecutorHost, HeldCall, JsExecutor, Paused } from "../core/execution.ts";

export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  env?: Record<string, unknown>;
  globalOutbound?: unknown;
  limits?: { cpuMs?: number; subRequests?: number };
}
export interface WorkerStub {
  getEntrypoint(name?: string | null, opts?: unknown): { fetch(req: Request): Promise<Response> };
}
export interface WorkerLoader {
  load(code: WorkerCode): WorkerStub;
}

interface ExecutionState {
  host: ExecutorHost;
  limits: ExecutionLimits;
  hostCalls: number;
  inFlight: number;
  accepted: string[];
  aborted: boolean;
  pending: Set<Promise<unknown>>;
  /** Calls that came back `pending`, and the first one, which pauses the run. */
  held?: HeldCall[];
  hold?: Paused;
}

/**
 * Live executions, keyed by id. The tool binding runs in the same isolate as the
 * supervisor, so it can find its execution here; the sandbox only ever holds an
 * opaque RPC stub and never the id's meaning.
 */
export const executions = new Map<string, ExecutionState>();

/** Called by the loopback WorkerEntrypoint that the sandbox sees as env.TOOLS. */
export async function handleSandboxCall(
  execId: string,
  strings: string[],
  values: unknown[],
): Promise<ToolResult> {
  const state = executions.get(execId);
  if (!state) {
    return { status: "rejected", error: { code: "execution_gone", message: "no such execution" } };
  }
  if (state.aborted) {
    // §6.3: after cancellation the gateway refuses new calls.
    return { status: "rejected", error: { code: "execution_cancelled", message: "execution cancelled" } };
  }
  if (state.hold) {
    // Decided here, not in the sandbox: a program that caught the pause and
    // calls again is refused by the side it cannot touch.
    return { status: "rejected", error: { code: "execution_paused", message: `run_js paused: ${state.hold.reason}` } };
  }
  const parsed = parseTemplateCall(strings, values);
  if ("error" in parsed) return { status: "rejected", error: parsed.error };
  if (state.hostCalls >= state.limits.maxHostCalls) {
    return {
      status: "rejected",
      error: { code: "host_call_budget_exceeded", message: `limit ${state.limits.maxHostCalls}` },
    };
  }
  if (state.inFlight >= state.limits.maxConcurrentHostCalls) {
    return {
      status: "rejected",
      error: { code: "too_many_concurrent_calls", message: `limit ${state.limits.maxConcurrentHostCalls}` },
    };
  }

  state.hostCalls++;
  state.inFlight++;
  const name = parsed.name;
  const p = state.host
    .invoke({ tool: name, args: parsed.args, opts: parsed.opts as Record<string, Json> })
    .then(
      (res): ToolResult => {
        if (res.status !== "rejected" && "operationId" in res) state.accepted.push(res.operationId);
        if (res.status === "pending") {
          (state.held ??= []).push({ tool: name, operationId: res.operationId, status: "pending" });
          state.hold ??= holdFrom(name, res as { operationId: string; error?: { code?: string } });
        }
        return res;
      },
      (err: Error): ToolResult => ({
        status: "rejected",
        error: { code: "host_error", message: err.message },
      }),
    )
    .finally(() => {
      state.inFlight--;
      state.pending.delete(p);
    });
  state.pending.add(p);
  return p;
}

const RUNNER = (source: string, maxOutputBytes: number) => `
// The program is a module-level function, so it sees its three globals and
// nothing of fetch's scope: not env (it could call TOOLS around the tool tag),
// not the state below (it could unset a pause).
function makeBox(TOOLS) {
  const outputs = [];
  let bytes = 0;
  // { kind: "hold" } once a call came back held (the supervisor has its
  // details), or { kind: "pause", reason, json, problem, bytes } from pause().
  let paused = null;
  const stop = () => {
    const e = new Error("run_js paused" + (paused && paused.kind === "pause" ? ": " + paused.reason : ""));
    e.name = "RunJsPaused";
    return e;
  };
  const output = (v) => {
    if (paused) return;
    const value = v === undefined ? null : v;
    const size = JSON.stringify(value).length;
    if (bytes + size > ${maxOutputBytes}) {
      outputs.push({ truncated: true, reason: "max_output_bytes" });
      return;
    }
    bytes += size;
    outputs.push(value);
  };
  const call = async (strings, values) => {
    if (paused) throw stop();
    const res = await TOOLS.invoke(Array.from(strings), values);
    // The supervisor has recorded the hold already; this only ends the program here.
    if (res && (res.status === "pending" || (res.status === "rejected" && res.error && res.error.code === "execution_paused"))) {
      paused ??= { kind: "hold" };
      throw stop();
    }
    return res;
  };
  const tool = (strings, ...values) => {
    const p = call(strings, values);
    // A call the program never awaited would leave the stop unhandled once the
    // program has ended; the run's result already says it paused. Any other
    // rejection is left exactly as unhandled as it was.
    p.catch((e) => { if (!(e && e.name === "RunJsPaused")) throw e; });
    return p;
  };
  const pause = (${PAUSE_FACTORY})((reason, json, problem) => {
    if (!paused) paused = { kind: "pause", reason, json, problem, bytes };
  });
  const answer = (ok, error) => Response.json(
    { ok, outputs, ...(paused && paused.kind === "pause" ? { pause: paused } : {}), ...(error ? { error } : {}) },
  );
  return { tool, output, pause, answer };
}

// The inner arrow keeps the program free to declare its own \`output\` or
// \`pause\`, as it could when these were variables of an enclosing scope.
function program(tool, output, pause) {
  return (async () => {
${source}
  })();
}

export default {
  async fetch(request, env) {
    const box = makeBox(env.TOOLS);
    try {
      await program(box.tool, box.output, box.pause);
      return box.answer(true);
    } catch (e) {
      return box.answer(false, { code: "uncaught", message: String((e && e.message) || e) });
    }
  }
};`;

/**
 * Whether a load failed because the script itself does not parse: reported as
 * the script's error, as QuickJS reports it (eval_error), and one the model can
 * fix, where "interrupted" told it the outcome was unknown (task #19). By the
 * error's name, or a message that starts as one; a message that only mentions
 * the word is some other failure (Vera, #341).
 */
export function isCompileError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  if (e?.name === "SyntaxError") return true;
  return /^(Uncaught )?SyntaxError\b/.test(String(e?.message ?? err));
}

/**
 * Cloudflare Dynamic Workers as the JS executor. Compared with the QuickJS
 * implementation the isolation and the budgets stop being things we implement
 * and become things the platform enforces: `globalOutbound: null` refuses the
 * network outright, and `cpuMs` terminates a runaway script.
 */
export class DynamicWorkerExecutor implements JsExecutor {
  #loader: WorkerLoader;
  #makeToolBinding: (execId: string) => unknown;
  #compatibilityDate: string;

  constructor(deps: {
    loader: WorkerLoader;
    makeToolBinding: (execId: string) => unknown;
    compatibilityDate?: string;
  }) {
    this.#loader = deps.loader;
    this.#makeToolBinding = deps.makeToolBinding;
    this.#compatibilityDate = deps.compatibilityDate ?? "2026-09-05";
  }

  async execute(
    source: string,
    host: ExecutorHost,
    limits: ExecutionLimits = DEFAULT_LIMITS,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const execId = crypto.randomUUID();
    const state: ExecutionState = {
      host, limits, hostCalls: 0, inFlight: 0, accepted: [], aborted: false, pending: new Set(),
    };
    executions.set(execId, state);

    const finish = async (r: Omit<ExecutionResult, "acceptedOperationIds" | "hostCalls">): Promise<ExecutionResult> => {
      // Already-accepted operations must be reported, not lost, so let in-flight
      // host work settle before answering.
      await Promise.allSettled([...state.pending]);
      executions.delete(execId);
      // A call that came back held after the program ended still waits on a person.
      const late = state.hold && (r.status === "completed" || r.status === "failed")
        ? { status: "paused" as const, pause: state.hold, error: undefined }
        : {};
      return { ...r, ...late, acceptedOperationIds: state.accepted, hostCalls: state.hostCalls, held: state.held ?? [] };
    };

    try {
      const stub = this.#loader.load({
        compatibilityDate: this.#compatibilityDate,
        mainModule: "main.js",
        modules: { "main.js": RUNNER(source, limits.maxOutputBytes) },
        globalOutbound: null,
        env: { TOOLS: this.#makeToolBinding(execId) },
        limits: {
          cpuMs: limits.wallTimeMs,
          // A hard backstop only: the per-call budget is refused in-band above so
          // the script can see why, rather than being killed without a reason.
          subRequests: Math.max(limits.maxHostCalls * 2, 16),
        },
      });

      const running = stub.getEntrypoint().fetch(new Request("https://sandbox/"));
      const aborted = new Promise<"aborted">((res) => {
        if (!signal) return;
        if (signal.aborted) res("aborted");
        else signal.addEventListener("abort", () => res("aborted"), { once: true });
      });
      let settled: Response | "aborted";
      try {
        settled = await Promise.race([running, aborted]);
      } catch (err) {
        // Only the load can fail because of the script: a module that does not
        // parse is rejected here. Reading the answer below is ours, and a
        // SyntaxError from parsing it is not the script's (Vera, #341).
        if (isCompileError(err)) {
          return finish({ status: "failed", outputs: [], error: { code: "eval_error", message: String((err as Error)?.message ?? err) } });
        }
        throw err;
      }

      if (settled === "aborted") {
        state.aborted = true;
        return finish({
          status: "interrupted",
          outputs: [],
          error: { code: "cancelled", message: "execution cancelled" },
        });
      }

      const body = (await (settled as Response).json()) as {
        ok: boolean; outputs: Json[]; error?: { code: string; message: string };
        pause?: { reason: string; json: string | null; problem: string | null; bytes: number };
      };
      const asked = body.pause
        ? pauseFrom(String(body.pause.reason), body.pause.json, body.pause.problem, limits.maxOutputBytes - (Number(body.pause.bytes) || 0))
        : undefined;
      return finish(
        asked || state.hold
          // A pause decides the result however the program ended (see PAUSE_FACTORY).
          ? { status: "paused", outputs: body.outputs, pause: asked ?? state.hold }
          : body.ok
            ? { status: "completed", outputs: body.outputs }
            : { status: "failed", outputs: body.outputs, error: body.error },
      );
    } catch (err) {
      // A CPU or subrequest kill is not catchable inside the sandbox: it lands
      // here, in the supervisor. Unwrapped, it takes down the whole request.
      const message = String((err as Error)?.message ?? err);
      const code = /CPU/i.test(message)
        ? "wall_time_exceeded"
        : /subrequest/i.test(message)
          ? "host_call_budget_exceeded"
          : "host_failure";
      state.aborted = true;
      return finish({ status: "interrupted", outputs: [], error: { code, message } });
    }
  }
}
