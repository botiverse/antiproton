import { getQuickJS, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { parseTemplateCall } from "../core/tools.ts";
import type { ToolResult } from "../core/tools.ts";
import type { Json } from "../core/types.ts";

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
  status: "completed" | "failed" | "interrupted";
  outputs: Json[];
  acceptedOperationIds: string[];
  hostCalls: number;
  error?: { code: string; message: string };
}

/**
 * One JSRuntime + one context per execution, destroyed at the end. Nothing from
 * the previous execution survives: no variables, no closures, no pending
 * promises. The only way out of the sandbox is the `tool` tag and `output`.
 */
export class QuickJsExecutor {
  async execute(
    source: string,
    host: ExecutorHost,
    limits: ExecutionLimits = DEFAULT_LIMITS,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.maxStackBytes);

    const start = Date.now();
    let interrupted: string | null = null;
    runtime.setInterruptHandler(() => {
      if (signal?.aborted) interrupted ??= "cancelled";
      else if (Date.now() - start > limits.wallTimeMs) interrupted ??= "wall_time_exceeded";
      return interrupted !== null;
    });

    const ctx = runtime.newContext();
    const outputs: Json[] = [];
    const acceptedOperationIds: string[] = [];
    let hostCalls = 0;
    let inFlight = 0;
    let outputBytes = 0;
    const pending = new Set<Promise<unknown>>();

    // JSON.parse-based marshalling: no eval, no ad-hoc handle construction.
    const jsonHandle = ctx.getProp(ctx.global, "JSON");
    const parseHandle = ctx.getProp(jsonHandle, "parse");
    const toVm = (v: unknown): QuickJSHandle => {
      const s = ctx.newString(JSON.stringify(v ?? null));
      const r = ctx.callFunction(parseHandle, ctx.undefined, s);
      s.dispose();
      return ctx.unwrapResult(r);
    };

    const settleWith = (deferred: ReturnType<QuickJSContext["newPromise"]>, value: ToolResult) => {
      if (value.status !== "rejected" && "operationId" in value) {
        acceptedOperationIds.push(value.operationId);
      }
      const h = toVm(value);
      deferred.resolve(h);
      h.dispose();
    };

    const toolFn = ctx.newFunction("tool", (stringsHandle, ...valueHandles) => {
      const strings = (ctx.dump(stringsHandle) as string[]) ?? [];
      const values = valueHandles.map((h) => ctx.dump(h));
      const deferred = ctx.newPromise();

      const parsed = parseTemplateCall(strings, values);
      if ("error" in parsed) {
        settleWith(deferred, { status: "rejected", error: parsed.error });
      } else if (hostCalls >= limits.maxHostCalls) {
        settleWith(deferred, {
          status: "rejected",
          error: { code: "host_call_budget_exceeded", message: `limit ${limits.maxHostCalls}` },
        });
      } else if (inFlight >= limits.maxConcurrentHostCalls) {
        settleWith(deferred, {
          status: "rejected",
          error: { code: "too_many_concurrent_calls", message: `limit ${limits.maxConcurrentHostCalls}` },
        });
      } else {
        hostCalls++;
        inFlight++;
        const name = `${parsed.ref.head}.${parsed.ref.tool}`;
        const p = host
          .invoke({ tool: name, args: parsed.args, opts: parsed.opts as Record<string, Json> })
          .then(
            (res) => settleWith(deferred, res),
            (err: Error) =>
              settleWith(deferred, {
                status: "rejected",
                error: { code: "host_error", message: err.message },
              }),
          )
          .finally(() => {
            inFlight--;
            pending.delete(p);
          });
        pending.add(p);
      }
      // Resolving a VM promise queues a job; the VM only advances when we pump.
      deferred.settled.then(() => runtime.executePendingJobs());
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "tool", toolFn);
    toolFn.dispose();

    const outputFn = ctx.newFunction("output", (valueHandle) => {
      const v = ctx.dump(valueHandle);
      const size = Buffer.byteLength(JSON.stringify(v ?? null));
      if (outputBytes + size > limits.maxOutputBytes) {
        outputs.push({ truncated: true, reason: "max_output_bytes" });
        return ctx.undefined;
      }
      outputBytes += size;
      outputs.push(v as Json);
      return ctx.undefined;
    });
    ctx.setProp(ctx.global, "output", outputFn);
    outputFn.dispose();

    let result: ExecutionResult;
    try {
      // Wrapped so agent code may use top-level await without module plumbing.
      const evalResult = ctx.evalCode(`(async () => {\n${source}\n})()`, "agent.js");
      if (evalResult.error) {
        const err = ctx.dump(evalResult.error) as any;
        evalResult.error.dispose();
        result = {
          status: interrupted ? "interrupted" : "failed",
          outputs,
          acceptedOperationIds,
          hostCalls,
          error: { code: interrupted ?? "eval_error", message: String(err?.message ?? err) },
        };
      } else {
        const promise = ctx.resolvePromise(evalResult.value);
        evalResult.value.dispose();
        runtime.executePendingJobs();
        // The interrupt handler only fires while JS is running; a script parked
        // on host I/O has to be cut loose from the outside.
        const aborted = new Promise<"aborted">((res) => {
          if (!signal) return;
          if (signal.aborted) res("aborted");
          else signal.addEventListener("abort", () => res("aborted"), { once: true });
        });
        const settled = await Promise.race([promise, aborted]);
        if (settled === "aborted") {
          return {
            status: "interrupted",
            outputs,
            acceptedOperationIds,
            hostCalls,
            error: { code: "cancelled", message: "execution cancelled" },
          };
        }
        if (settled.error) {
          const err = ctx.dump(settled.error) as any;
          settled.error.dispose();
          result = {
            status: interrupted ? "interrupted" : "failed",
            outputs,
            acceptedOperationIds,
            hostCalls,
            error: { code: interrupted ?? "uncaught", message: String(err?.message ?? err) },
          };
        } else {
          settled.value.dispose();
          result = { status: "completed", outputs, acceptedOperationIds, hostCalls };
        }
      }
    } catch (err) {
      result = {
        status: interrupted ? "interrupted" : "failed",
        outputs,
        acceptedOperationIds,
        hostCalls,
        error: { code: interrupted ?? "host_failure", message: (err as Error).message },
      };
    } finally {
      // Already-accepted operations keep running and are reported upward; only
      // un-accepted host work is abandoned with the context.
      await Promise.allSettled([...pending]);
      parseHandle.dispose();
      jsonHandle.dispose();
      try {
        ctx.dispose();
        runtime.dispose();
      } catch {
        /* handle bookkeeping only; the execution result stands */
      }
    }
    return result;
  }
}
