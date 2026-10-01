import { parseTemplateCall } from "../core/tools.ts";
import type { ToolResult } from "../core/tools.ts";
import type { Json } from "../core/types.ts";
import { CANCELLED_NAME, DEFAULT_LIMITS, PAUSE_FACTORY, holdFrom, pauseFrom } from "../core/execution.ts";
import type { Continuation, ExecutionLimits, ExecutionResult, ExecutorHost, HeldCall, JsExecutor, Paused } from "../core/execution.ts";

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
  /** Calls that have reached the supervisor, refused or not; told to `onArrive`. */
  arrived?: number;
  onArrive?: () => void;
  /** Calls that came back `pending`, and the first one, which pauses the run. */
  held?: HeldCall[];
  hold?: Paused;
  /**
   * The program waiting at `await pause(...)`: what it handed over, and the
   * one way to answer the sandbox's pending `suspend` call.
   */
  suspended?: { pause: Paused; outputs: Json[]; sent: number; resolve: (answer: SuspendAnswer) => void };
  /** Whoever is waiting to hear that the program suspended (the supervisor). */
  onSuspend?: () => void;
  /** Set by cancel: calls are refused and the run is reported cancelled however it ends. */
  cancelled?: boolean;
}

/** How the sandbox's `await pause(...)` settles: the model's answer, or an end. */
export type SuspendAnswer = { answer: Json } | { end: "stop" | "cancel" };

/** What the sandbox hands over when its program waits at a pause. */
export interface SuspendRequest {
  reason: string;
  json: string | null;
  problem: string | null;
  /** Output room already used when pause() was called, for the data's share of the cap. */
  bytes: number;
  /** How many calls the sandbox had sent: the supervisor waits until it has seen them all. */
  sent?: number;
  /** Everything output so far: the supervisor cannot read the sandbox's. */
  outputs: Json[];
  /** pause()'s third argument as JSON text (PAUSE_FACTORY), or null. */
  answer?: string | null;
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
  state.arrived = (state.arrived ?? 0) + 1;
  state.onArrive?.();
  if (state.aborted || state.cancelled) {
    // §6.3: after cancellation the gateway refuses new calls.
    return { status: "rejected", error: { code: "execution_cancelled", message: "execution cancelled" } };
  }
  // Not refused for a suspension: a call can arrive after the pause that was
  // sent before it (an RPC arrives when it arrives), and that one is owed its
  // answer. Calls made after a pause are refused in the sandbox, which the
  // program cannot reach around (RUNNER's `paused`).
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

/**
 * Called when the sandbox's program awaits its pause (the runner's `wait`).
 * Settles when the model resumes or cancels it — or at once with an end, when
 * nobody will ever answer: no such execution, or one the supervisor has
 * already given up on (aborted, and only waiting for its calls to settle).
 * A hold is not refused here: the supervisor decides that where it reports
 * the suspension (`untilStop`), after the calls still out have settled, which
 * covers a hold landing before this call as well as after it. The pending
 * call is what keeps the program alive: its await is this promise, and
 * nothing in the sandbox runs until it settles.
 */
export async function handleSandboxSuspend(execId: string, req: SuspendRequest): Promise<SuspendAnswer> {
  const state = executions.get(execId);
  if (!state || state.aborted || state.suspended) return { end: "stop" };
  const room = state.limits.maxOutputBytes - (Number(req.bytes) || 0);
  return new Promise<SuspendAnswer>((resolve) => {
    state.suspended = {
      sent: Number(req.sent) || 0,
      pause: pauseFrom(String(req.reason), req.json, req.problem, room, req.answer ?? null),
      outputs: Array.isArray(req.outputs) ? req.outputs : [],
      resolve,
    };
    state.onSuspend?.();
  });
}

/**
 * Until every call the sandbox says it sent has reached the supervisor and
 * settled, or `ms` has passed. The sandbox waits for its own calls before it
 * answers or suspends (RUNNER's settle); this is the supervisor's half, for a
 * sandbox whose wait ran out, or whose calls are still on their way: an RPC
 * reaches the supervisor when it gets there, not when it was sent.
 */
export async function untilCallsSettle(state: ExecutionState, sent: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  const left = () => Math.max(0, deadline - Date.now());
  while ((state.arrived ?? 0) < sent && left() > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((res) => { state.onArrive = res; timer = setTimeout(res, left()); });
    clearTimeout(timer);
    state.onArrive = undefined;
  }
  while (state.pending.size && left() > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...state.pending]),
      new Promise((res) => { timer = setTimeout(res, left()); }),
    ]);
    clearTimeout(timer);
  }
}

const RUNNER = (source: string, maxOutputBytes: number, settleMs: number) => `
// The program is a module-level function, so it sees its three globals and
// nothing of fetch's scope: not env (it could call TOOLS around the tool tag),
// not the state below (it could unset a pause).
function makeBox(TOOLS) {
  const outputs = [];
  let bytes = 0;
  // { kind: "hold" } once a call came back held (the supervisor has its
  // details), or { kind: "pause", reason, json, problem, bytes, answer } from pause().
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
  // Calls sent and not yet answered. On the platform a call is an RPC: it
  // reaches the supervisor when it gets there, and one still out when this
  // handler returns is never answered. So nothing is decided — the run's end,
  // or a pause handed to the model — until every call sent has come back:
  // one of them may have been held, which changes what the run is.
  const inflight = new Set();
  let sent = 0;
  const settle = async () => {
    const deadline = Date.now() + ${settleMs};
    while (inflight.size && Date.now() < deadline) {
      let timer;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise((r) => { timer = setTimeout(r, Math.max(0, deadline - Date.now())); }),
      ]);
      clearTimeout(timer);
    }
  };
  const call = async (strings, values) => {
    if (paused) throw stop();
    sent++;
    const out = TOOLS.invoke(Array.from(strings), values);
    inflight.add(out);
    const done = () => { inflight.delete(out); };
    out.then(done, done);
    const res = await out;
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
    p.catch((e) => { if (!(e && (e.name === "RunJsPaused" || e.name === "${CANCELLED_NAME}"))) throw e; });
    return p;
  };
  const cancelled = () => {
    const e = new Error("run_js cancelled at pause()");
    e.name = "${CANCELLED_NAME}";
    return e;
  };
  const pause = (${PAUSE_FACTORY})(
    (reason, json, problem, answer) => {
      if (paused) return false;
      paused = { kind: "pause", reason, json, problem, bytes, answer };
      return true;
    },
    // The program is awaiting its pause: hand the supervisor what it needs and
    // wait for the model. An answer clears the pause here (the supervisor has
    // cleared its own); an end leaves it set, so nothing after it counts.
    () => {
      const p = paused;
      if (!p || p.kind !== "pause") return Promise.reject(stop());
      return settle()
        .then(() => TOOLS.suspend({ reason: p.reason, json: p.json, problem: p.problem, bytes: p.bytes, answer: p.answer, sent, outputs: outputs.slice() }))
        .then((res) => {
          if (res && "answer" in res && paused === p) { paused = null; return res.answer; }
          throw res && res.end === "cancel" ? cancelled() : stop();
        });
    },
  );
  const answer = async (ok, error) => {
    await settle();
    return Response.json(
      { ok, outputs, sent, ...(paused && paused.kind === "pause" ? { pause: paused } : {}), ...(error ? { error } : {}) },
    );
  };
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
    } catch (e) {
      return await box.answer(false, { code: "uncaught", message: String((e && e.message) || e) });
    }
    return await box.answer(true);
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
      // A cancel decides the result however the program then ended.
      if (state.cancelled && r.status !== "interrupted") {
        r = { status: "interrupted", outputs: r.outputs, error: { code: "cancelled", message: "cancelled at pause()" } };
      }
      // A call that came back held after the program ended still waits on a person.
      const late = state.hold && (r.status === "completed" || r.status === "failed")
        ? { status: "paused" as const, pause: state.hold, error: undefined }
        : {};
      return { ...r, ...late, acceptedOperationIds: state.accepted, hostCalls: state.hostCalls, held: state.held ?? [] };
    };

    // A CPU or subrequest kill is not catchable inside the sandbox: it lands
    // here, in the supervisor. Unwrapped, it takes down the whole request.
    const killed = (err: unknown) => {
      const message = String((err as Error)?.message ?? err);
      const code = /CPU/i.test(message)
        ? "wall_time_exceeded"
        : /subrequest/i.test(message)
          ? "host_call_budget_exceeded"
          : "host_failure";
      state.aborted = true;
      return finish({ status: "interrupted", outputs: [], error: { code, message } });
    };

    let running: Promise<Response>;
    try {
      const stub = this.#loader.load({
        compatibilityDate: this.#compatibilityDate,
        mainModule: "main.js",
        modules: { "main.js": RUNNER(source, limits.maxOutputBytes, limits.wallTimeMs) },
        globalOutbound: null,
        env: { TOOLS: this.#makeToolBinding(execId) },
        limits: {
          // CPU, not wall clock: a program suspended at a pause spends none of
          // it, so the time it waits for the model is not taken from its budget.
          cpuMs: limits.wallTimeMs,
          // A hard backstop only: the per-call budget is refused in-band above so
          // the script can see why, rather than being killed without a reason.
          subRequests: Math.max(limits.maxHostCalls * 2, 16),
        },
      });
      running = stub.getEntrypoint().fetch(new Request("https://sandbox/"));
    } catch (err) {
      return killed(err);
    }
    // Read once, however many times a resumed program is waited on.
    running.catch(() => {});
    // Only the first stretch has a signal: a resumed program is the continuation holder's.
    const aborted = new Promise<"aborted">((res) => {
      if (!signal) return;
      if (signal.aborted) res("aborted");
      else signal.addEventListener("abort", () => res("aborted"), { once: true });
    });

    // Waits for the program to end or to wait at a pause, whichever is first.
    const untilStop = async (first: boolean): Promise<ExecutionResult> => {
      try {
        const suspended = new Promise<"suspended">((res) => {
          state.onSuspend = () => res("suspended");
          if (state.suspended) res("suspended");
        });
        let settled: Response | "aborted" | "suspended";
        try {
          settled = await Promise.race([running, aborted, suspended]);
        } catch (err) {
          // Only the load can fail because of the script: a module that does not
          // parse is rejected here. Reading the answer below is ours, and a
          // SyntaxError from parsing it is not the script's (Vera, #341).
          if (first && isCompileError(err)) {
            return finish({ status: "failed", outputs: [], error: { code: "eval_error", message: String((err as Error)?.message ?? err) } });
          }
          throw err;
        } finally {
          state.onSuspend = undefined;
        }

        if (settled === "suspended") {
          // Nothing is handed to the model until every call the program sent
          // has come back: one may have been held, and a held run is not
          // resumable. Accepted operations are reported, not lost.
          const s = state.suspended!;
          await untilCallsSettle(state, s.sent, limits.wallTimeMs);
          if (!state.hold) {
            return {
              status: "paused", outputs: s.outputs, pause: s.pause,
              acceptedOperationIds: [...state.accepted], hostCalls: state.hostCalls, held: [...(state.held ?? [])],
              continuation: continuation(),
            };
          }
          // A call that was still out came back held: that ends the run, as a hold always has.
          state.suspended = undefined;
          s.resolve({ end: "stop" });
          settled = await Promise.race([running, aborted]);
        }

        if (settled === "aborted") {
          state.aborted = true;
          // A program waiting at a pause is let go, so its isolate can end.
          state.suspended?.resolve({ end: "cancel" });
          return finish({
            status: "interrupted",
            outputs: [],
            error: { code: "cancelled", message: "execution cancelled" },
          });
        }

        const body = (await (settled as Response).json()) as {
          ok: boolean; outputs: Json[]; error?: { code: string; message: string }; sent?: number;
          pause?: { reason: string; json: string | null; problem: string | null; bytes: number; answer?: string | null };
        };
        // The program has ended; whether it ended paused depends on calls that
        // may still be on their way to this side (see untilCallsSettle).
        await untilCallsSettle(state, Number(body.sent) || 0, limits.wallTimeMs);
        const asked = body.pause
          ? pauseFrom(String(body.pause.reason), body.pause.json, body.pause.problem, limits.maxOutputBytes - (Number(body.pause.bytes) || 0), body.pause.answer ?? null)
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
        return killed(err);
      }
    };

    // One per suspension: resume or cancel, once.
    const continuation = (): Continuation => {
      let used = false;
      const take = () => {
        const s = state.suspended;
        if (used || !s || !executions.has(execId)) throw new Error("this continuation was already used");
        used = true;
        state.suspended = undefined;
        return s;
      };
      return {
        resume: (answer: Json) => {
          take().resolve({ answer: answer === undefined ? null : answer });
          return untilStop(false);
        },
        cancel: () => {
          const s = take();
          state.cancelled = true;
          s.resolve({ end: "cancel" });
          return untilStop(false);
        },
      };
    };

    return untilStop(true);
  }
}
