import { getQuickJS, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { parseTemplateCall } from "../core/tools.ts";
import type { ToolResult } from "../core/tools.ts";
import type { Json } from "../core/types.ts";
import { CANCELLED_NAME, DEFAULT_LIMITS as LIMITS, PAUSE_FACTORY, holdFrom, pauseFrom } from "../core/execution.ts";
import type { Continuation, ExecutionLimits, ExecutionResult, ExecutorHost, HeldCall, JsExecutor, Paused } from "../core/execution.ts";

export { DEFAULT_LIMITS } from "../core/execution.ts";
export type { ExecutionLimits, ExecutorHost, ExecutionResult, JsExecutor } from "../core/execution.ts";

/**
 * One JSRuntime + one context per execution, destroyed at the end. Nothing from
 * the previous execution survives: no variables, no closures, no pending
 * promises. The only way out of the sandbox is the `tool` tag and `output`;
 * `pause` is the only way to stop early on purpose.
 *
 * "The end" is when the program ends, not when `execute` returns: a program
 * waiting at `await pause(...)` is returned as `paused` with a continuation,
 * and its context lives on in this process until the continuation resumes it
 * to its end or cancels it.
 */
export class QuickJsExecutor implements JsExecutor {
  async execute(
    source: string,
    host: ExecutorHost,
    limits: ExecutionLimits = LIMITS,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.maxStackBytes);

    const start = Date.now();
    // Time spent suspended at a pause is the model's, not the program's: it is
    // taken off the wall-time budget, which only the program's own running
    // spends. How long a suspension may last is the continuation holder's cap.
    let suspendedMs = 0;
    let interrupted: string | null = null;
    runtime.setInterruptHandler(() => {
      if (signal?.aborted) interrupted ??= "cancelled";
      else if (Date.now() - start - suspendedMs > limits.wallTimeMs) interrupted ??= "wall_time_exceeded";
      return interrupted !== null;
    });

    const ctx = runtime.newContext();
    const outputs: Json[] = [];
    const acceptedOperationIds: string[] = [];
    let hostCalls = 0;
    let inFlight = 0;
    let outputBytes = 0;
    const pending = new Set<Promise<unknown>>();
    // Host state, out of the program's reach: once set, the run ends paused
    // whatever the program does next (see PAUSE_FACTORY) — unless the model
    // resumes it, which clears it.
    let paused: Paused | null = null;
    const held: HeldCall[] = [];
    // The program waiting at its pause, and whoever is waiting to hear that it is.
    let suspension: { deferred: ReturnType<QuickJSContext["newPromise"]>; at: number } | null = null;
    let onSuspend: (() => void) | null = null;
    // Set by cancel: pause() rejects, and nothing the program does after counts.
    let cancelled = false;

    // JSON.parse-based marshalling: no eval, no ad-hoc handle construction.
    const jsonHandle = ctx.getProp(ctx.global, "JSON");
    const parseHandle = ctx.getProp(jsonHandle, "parse");
    const toVm = (v: unknown): QuickJSHandle => {
      const s = ctx.newString(JSON.stringify(v ?? null));
      const r = ctx.callFunction(parseHandle, ctx.undefined, s);
      s.dispose();
      return ctx.unwrapResult(r);
    };

    // What the program's await sees once the run is paused: a throw, so the
    // line after it does not run. The host state above is what decides.
    const rejectPaused = (deferred: ReturnType<QuickJSContext["newPromise"]>, name = "RunJsPaused") => {
      const e = ctx.newError({
        name,
        message: name === CANCELLED_NAME ? "run_js cancelled at pause()" : `run_js paused: ${paused?.reason ?? ""}`,
      });
      deferred.reject(e);
      e.dispose();
    };

    const settleWith = (deferred: ReturnType<QuickJSContext["newPromise"]>, value: ToolResult, tool?: string) => {
      if (value.status !== "rejected" && "operationId" in value) {
        acceptedOperationIds.push(value.operationId);
      }
      if (value.status === "pending" && tool !== undefined) {
        held.push({ tool, operationId: value.operationId, status: "pending" });
        paused ??= holdFrom(tool, value as { operationId: string; error?: { code?: string } });
        rejectPaused(deferred);
        return;
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
      if (paused) {
        // Never reaches the host: a program that caught the pause cannot go on calling.
        rejectPaused(deferred);
      } else if ("error" in parsed) {
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
        const name = parsed.name;
        const p = host
          .invoke({ tool: name, args: parsed.args, opts: parsed.opts as Record<string, Json> })
          .then(
            (res) => settleWith(deferred, res, name),
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
      // Outputs are "what the program produced before it stopped".
      if (paused) return ctx.undefined;
      const v = ctx.dump(valueHandle);
      // String.length, UTF-16 code units, like every other `…Bytes` cap on a
      // string in this tree; the one byte-accurate bound is on binary, in
      // src/store/artifacts.ts. Counting real bytes here was the single
      // disagreement, and a cap that disagrees with its siblings is a bug
      // waiting for a non-ASCII payload.
      const size = JSON.stringify(v ?? null).length;
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

    const recordFn = ctx.newFunction("record", (reasonH, jsonH, problemH, answerH) => {
      if (paused) return ctx.false; // the first stop is the one reported, and it is not resumable
      const json = ctx.typeof(jsonH) === "string" ? ctx.getString(jsonH) : null;
      const problem = ctx.typeof(problemH) === "string" ? ctx.getString(problemH) : null;
      const answer = answerH && ctx.typeof(answerH) === "string" ? ctx.getString(answerH) : null;
      paused = pauseFrom(ctx.getString(reasonH), json, problem, limits.maxOutputBytes - outputBytes, answer);
      return ctx.true;
    });
    // Called when the program awaits its pause (PAUSE_FACTORY): from here it is suspended.
    const waitFn = ctx.newFunction("wait", () => {
      const deferred = ctx.newPromise();
      if (!paused || suspension) {
        // Not this run's pause to wait on. A hold that came in after the pause
        // is decided where the suspension is reported (untilStop), which has
        // to wait for calls still out in any case.
        rejectPaused(deferred);
      } else {
        suspension = { deferred, at: Date.now() };
        onSuspend?.();
      }
      deferred.settled.then(() => runtime.executePendingJobs());
      return deferred.handle;
    });
    {
      const factory = ctx.unwrapResult(ctx.evalCode(PAUSE_FACTORY, "pause.js"));
      const pauseFn = ctx.unwrapResult(ctx.callFunction(factory, ctx.undefined, recordFn, waitFn));
      ctx.setProp(ctx.global, "pause", pauseFn);
      pauseFn.dispose();
      factory.dispose();
      recordFn.dispose();
      waitFn.dispose();
    }

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      // A pause the program never awaited, or one left waiting when the program
      // ended some other way: its promise is the last handle the context holds.
      if (suspension) { suspension.deferred.dispose(); suspension = null; }
      parseHandle.dispose();
      jsonHandle.dispose();
      try {
        ctx.dispose();
        runtime.dispose();
      } catch {
        /* handle bookkeeping only; the execution result stands */
      }
    };

    // Wrapped so agent code may use top-level await without module plumbing.
    let evalResult: ReturnType<QuickJSContext["evalCode"]>;
    try {
      evalResult = ctx.evalCode(`(async () => {\n${source}\n})()`, "agent.js");
    } catch (err) {
      dispose();
      return {
        status: interrupted ? "interrupted" : "failed", outputs, acceptedOperationIds, hostCalls,
        error: { code: interrupted ?? "host_failure", message: (err as Error).message },
      };
    }
    if (evalResult.error) {
      const err = ctx.dump(evalResult.error) as any;
      evalResult.error.dispose();
      dispose();
      return {
        status: interrupted ? "interrupted" : "failed",
        outputs,
        acceptedOperationIds,
        hostCalls,
        error: { code: interrupted ?? "eval_error", message: String(err?.message ?? err) },
      };
    }
    const program = ctx.resolvePromise(evalResult.value);
    evalResult.value.dispose();
    // The interrupt handler only fires while JS is running; a script parked
    // on host I/O has to be cut loose from the outside. Only the first
    // stretch has a signal: a resumed program is the continuation holder's.
    const aborted = new Promise<"aborted">((res) => {
      if (!signal) return;
      if (signal.aborted) res("aborted");
      else signal.addEventListener("abort", () => res("aborted"), { once: true });
    });

    // Runs the program until it ends or waits at a pause, whichever is first.
    const untilStop = async (first: boolean): Promise<ExecutionResult> => {
      let result: ExecutionResult;
      try {
        const suspended = new Promise<"suspended">((res) => {
          onSuspend = () => res("suspended");
          if (suspension) res("suspended");
        });
        if (first) runtime.executePendingJobs();
        let settled = await Promise.race([program, aborted, suspended]);
        onSuspend = null;
        if (settled === "suspended") {
          // Accepted operations are reported, not lost: whatever the program
          // started before it paused settles first.
          await Promise.allSettled([...pending]);
          if (suspension && !held.length && !interrupted) {
            return {
              status: "paused", outputs: [...outputs], acceptedOperationIds: [...acceptedOperationIds], hostCalls,
              pause: paused!, held: [...held], continuation: continuation(),
            };
          }
          // A call that was still out came back held: that ends the run, as a hold always has.
          if (suspension) { const s = suspension; suspension = null; rejectPaused(s.deferred); }
          settled = await Promise.race([program, aborted]);
        }
        if (settled === "aborted") {
          result = {
            status: "interrupted",
            outputs,
            acceptedOperationIds,
            hostCalls,
            error: { code: "cancelled", message: "execution cancelled" },
          };
        } else if (settled.error) {
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
          result = { status: "completed", outputs, acceptedOperationIds, hostCalls, held };
        }
      } catch (err) {
        result = {
          status: interrupted ? "interrupted" : "failed",
          outputs,
          acceptedOperationIds,
          hostCalls,
          error: { code: interrupted ?? "host_failure", message: (err as Error).message },
        };
      }
      // Already-accepted operations keep running and are reported upward; only
      // un-accepted host work is abandoned with the context.
      await Promise.allSettled([...pending]);
      // A cancel decides the result however the program then ended: it may
      // have caught the rejection, but nothing it did after counted.
      if (cancelled && result.status !== "interrupted") {
        result = {
          status: "interrupted", outputs, acceptedOperationIds, hostCalls, held,
          error: { code: "cancelled", message: "cancelled at pause()" },
        };
      }
      // A pause recorded on the host decides the result whether the program
      // then returned or threw — a caught pause followed by either is still a
      // pause — and so does a call that was still in flight when the program
      // ended and came back held after it, since it now waits on a person.
      // An interruption (wall time, cancel) stays one, as in the Dynamic
      // Worker, where a kill leaves nothing of the sandbox's pause to read.
      if (paused && (result.status === "completed" || result.status === "failed")) {
        result = { status: "paused", outputs, acceptedOperationIds, hostCalls, pause: paused, held };
      }
      dispose();
      return result;
    };

    // One per suspension: resume or cancel, once.
    const continuation = (): Continuation => {
      let used = false;
      const take = () => {
        if (used || disposed || !suspension) throw new Error("this continuation was already used");
        used = true;
        const s = suspension;
        suspension = null;
        suspendedMs += Date.now() - s.at;
        return s.deferred;
      };
      return {
        resume: (answer: Json) => {
          const deferred = take();
          // The program goes on: its later calls and outputs count again.
          paused = null;
          const h = toVm(answer === undefined ? null : answer);
          deferred.resolve(h);
          h.dispose();
          return untilStop(false);
        },
        cancel: () => {
          const deferred = take();
          cancelled = true;
          rejectPaused(deferred, CANCELLED_NAME);
          return untilStop(false);
        },
      };
    };

    return untilStop(true);
  }
}
