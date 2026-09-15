import { parseTemplateCall } from "../core/tools.ts";
import type { ToolResult } from "../core/tools.ts";
import type { Json } from "../core/types.ts";
import { DEFAULT_LIMITS } from "../core/execution.ts";
import type { ExecutionLimits, ExecutionResult, ExecutorHost, JsExecutor } from "../core/execution.ts";

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
export default {
  async fetch(request, env) {
    const outputs = [];
    let bytes = 0;
    const output = (v) => {
      const value = v === undefined ? null : v;
      const size = JSON.stringify(value).length;
      if (bytes + size > ${maxOutputBytes}) {
        outputs.push({ truncated: true, reason: "max_output_bytes" });
        return;
      }
      bytes += size;
      outputs.push(value);
    };
    const tool = (strings, ...values) => env.TOOLS.invoke(Array.from(strings), values);
    try {
      await (async () => {
${source}
      })();
      return Response.json({ ok: true, outputs });
    } catch (e) {
      return Response.json({
        ok: false,
        outputs,
        error: { code: "uncaught", message: String((e && e.message) || e) },
      });
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

    const finish = async (r: Omit<ExecutionResult, "acceptedOperationIds" | "hostCalls">) => {
      // Already-accepted operations must be reported, not lost, so let in-flight
      // host work settle before answering.
      await Promise.allSettled([...state.pending]);
      executions.delete(execId);
      return { ...r, acceptedOperationIds: state.accepted, hostCalls: state.hostCalls };
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
      };
      return finish(
        body.ok
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
