import { parseTemplateCall } from "../core/tools.ts";
import type { ToolResult } from "../core/tools.ts";
import type { Json } from "../core/types.ts";
import { CANCELLED_NAME, DEFAULT_LIMITS, PAUSE_FACTORY, holdFrom, pauseFrom, tellRefused } from "../core/execution.ts";
import type { BridgeModule, Continuation, ExecutionLimits, ExecutionResult, ExecutorHost, HeldCall, JsExecutor, Paused } from "../core/execution.ts";

export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  /** A bare string for a name ending in `.js`; `{ js }` for any other name (an `sdk:` specifier). */
  modules: Record<string, string | { js: string }>;
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
  if ("error" in parsed) {
    tellRefused(state.host, strings[0]?.trim() || null, parsed.error.code);
    return { status: "rejected", error: parsed.error };
  }
  if (state.hostCalls >= state.limits.maxHostCalls) {
    tellRefused(state.host, parsed.name, "host_call_budget_exceeded");
    return {
      status: "rejected",
      error: { code: "host_call_budget_exceeded", message: `limit ${state.limits.maxHostCalls}` },
    };
  }
  if (state.inFlight >= state.limits.maxConcurrentHostCalls) {
    tellRefused(state.host, parsed.name, "too_many_concurrent_calls");
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

/**
 * The box's side of the SDK bridge (`ExecutorHost.bridges`): a `fetch` that makes each request one call of
 * `<alias>.request` through the program's own `tool` tag, bound once by the runner before the program starts. Through
 * the tag, not `env.TOOLS`, so a bridged call is a host call like any other: counted against the budget, refused after
 * a pause, and ending the run when it comes back held — the tag throws before this code sees the answer, and an SDK
 * that catches the throw changes nothing, since the supervisor recorded the hold and the box refuses what follows.
 *
 * It answers a real `Response`, for the SDK to read as it reads any: an upstream status with the headers the gateway
 * kept; a refusal (policy, route, budget) as a 403 whose JSON body carries the gateway's `error`; a call that failed
 * as a rejected fetch (a TypeError), which an SDK reports as a network error.
 *
 * `main.js` imports `bindBox` on its last line, after the program, so the program's lines stay where `PROGRAM_LINE`
 * says they are; an import is hoisted wherever it sits.
 */
const BRIDGE_SHIM = `
let tag = null;
export function bindBox(tool) {
  if (tag) throw new Error("the SDK bridge is already bound");
  tag = tool;
}
const NO_BODY = [101, 204, 205, 304];
export function gatewayFetch(alias) {
  const name = [alias + ".request ", ""];
  return async function fetch(input, init) {
    init = init || {};
    let method = "GET", url, body = null;
    const headers = {};
    if (typeof Request !== "undefined" && input instanceof Request) {
      method = input.method;
      url = input.url;
      input.headers.forEach((v, k) => { headers[k] = v; });
      if (method !== "GET" && method !== "HEAD") body = await input.text();
    } else {
      url = String(input);
    }
    if (init.method) method = String(init.method);
    if (init.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    if (init.body !== undefined && init.body !== null) {
      body = typeof init.body === "string" ? init.body : await new Response(init.body).text();
    }
    // The path as the SDK wrote it, origin dropped: the gateway owns the host, and folding or decoding is its to do.
    const path = url.replace(/^[a-z][a-z0-9+.-]*:\\/\\/[^/?#]*/i, "") || "/";
    if (!tag) throw new TypeError("the SDK bridge is not bound");
    const res = await tag(name, { method: method.toUpperCase(), path, body, headers });
    if (res && res.status === "succeeded" && res.result && typeof res.result.status === "number") {
      const r = res.result;
      if (r.status < 200 || r.status > 599) throw new TypeError("upstream answered status " + r.status);
      return new Response(NO_BODY.includes(r.status) ? null : r.text, { status: r.status, headers: r.headers || {} });
    }
    if (res && res.status === "rejected") {
      return new Response(JSON.stringify({ error: res.error }), { status: 403, headers: { "content-type": "application/json" } });
    }
    throw new TypeError((res && res.error && res.error.message) || "the bridged request failed");
  };
}
`;

/** Whether a specifier is one the bridge answers: `sdk:` and a name. */
export const BRIDGE_SPECIFIER = /^sdk:[A-Za-z0-9_.-]+$/;

/**
 * The modules the box gets besides `main.js` for these bridges: the shim, each plugin's files under `sdk/<plugin>/`,
 * and one `sdk:…` module per specifier that hands the SDK's exports, made with that mount's `fetch`. A specifier
 * module is an object with `js`, since the loader takes a bare string only for a name ending in `.js`.
 */
export function bridgeModules(bridges: readonly BridgeModule[]): Record<string, string | { js: string }> {
  const modules: Record<string, string | { js: string }> = { "bridge.js": BRIDGE_SHIM };
  for (const b of bridges) {
    for (const [name, src] of Object.entries(b.files)) modules[`sdk/${b.plugin}/${name}`] = src;
    const made = `import { gatewayFetch } from "bridge.js";\n` +
      `import make from ${JSON.stringify(`sdk/${b.plugin}/${b.entry}`)};\n` +
      `const made = make(gatewayFetch(${JSON.stringify(b.alias)}));\n` +
      `export default made;\n` +
      b.exports.map((e) => `export const ${e} = made[${JSON.stringify(e)}];\n`).join("");
    for (const s of b.specifiers) if (BRIDGE_SPECIFIER.test(s)) modules[s] = { js: made };
  }
  return modules;
}

const RUNNER = (source: string, maxOutputBytes: number, settleMs: number, bridged = false) => `
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
    const box = makeBox(env.TOOLS);${bridged ? " bindBox(box.tool);" : ""}
    try {
      await program(box.tool, box.output, box.pause);
    } catch (e) {
      return await box.answer(false, { code: "uncaught", message: String((e && e.message) || e) });
    }
    return await box.answer(true);
  }
};${bridged ? '\nimport { bindBox } from "bridge.js";' : ""}`;

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
  // workerd's loader wraps the engine's error in its own first line, then the engine's sentence, then where in the
  // module it stopped (measured with wrangler dev, 2026-10-15; the verbatim reading is test/run-js-errors.ts `ENGINE`).
  return /^(Failed to start Worker:\n)?(Uncaught )?SyntaxError\b/.test(String(e?.message ?? err));
}

/** The line of the generated module (`main.js`, 1-based) on which the program's first line sits. */
const PROGRAM_LINE = (() => {
  const mark = "\u0000program\u0000";
  const module = RUNNER(mark, 0, 0);
  return module.slice(0, module.indexOf(mark)).split("\n").length;
})();

/**
 * The engine's own error for a program that does not parse, as the model is to read it. The engine reports where in
 * the generated module it stopped (`at main.js:<line>[:<column>]`, the column 0-based and left out when 0, in the
 * message or in the stack), and the model never saw that module, so that place is given in the program's own lines,
 * with the program's line and a caret under the column. Nothing else is added: the engine's sentence is what the
 * model gets, and where the engine names no place, or one outside the program, the sentence goes alone. The loader's
 * own first line ("Failed to start Worker:") says nothing about the program and is dropped.
 */
export function compileErrorMessage(err: unknown, source: string): string {
  const e = err as { message?: unknown; stack?: unknown } | null | undefined;
  const lines = String(e?.message ?? err).split("\n").filter((l, i) => !(i === 0 && /^Failed to start Worker:?\s*$/.test(l)));
  const where = /at main\.js:(\d+)(?::(\d+))?/;
  const found = where.exec(lines.join("\n")) ?? where.exec(typeof e?.stack === "string" ? e.stack : "");
  const kept = lines.filter((l) => !/^\s*at main\.js:\d+(:\d+)?\s*$/.test(l));
  if (!found) return kept.join("\n");
  const programLines = source.split("\n");
  const line = Number(found[1]) - PROGRAM_LINE + 1;
  const column = Number(found[2] ?? 0);
  if (line < 1 || line > programLines.length) return kept.join("\n");
  const text = programLines[line - 1]!.replace(/\t/g, " ");
  // A long line is shown around the column, so the caret stays on screen.
  const from = Math.max(0, column - 60), to = Math.min(text.length, column + 60);
  const shown = `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
  const gutter = `${line} | `;
  return [...kept, `  at line ${line}, column ${column + 1} of the program`,
    `${gutter}${shown}`, `${" ".repeat(gutter.length + (from > 0 ? 1 : 0) + column - from)}^`].join("\n");
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

    const bridged = (host.bridges?.length ?? 0) > 0;
    let running: Promise<Response>;
    try {
      const stub = this.#loader.load({
        compatibilityDate: this.#compatibilityDate,
        mainModule: "main.js",
        modules: {
          "main.js": RUNNER(source, limits.maxOutputBytes, limits.wallTimeMs, bridged),
          ...(bridged ? bridgeModules(host.bridges!) : {}),
        },
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
            return finish({ status: "failed", outputs: [], error: { code: "eval_error", message: compileErrorMessage(err, source) } });
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
