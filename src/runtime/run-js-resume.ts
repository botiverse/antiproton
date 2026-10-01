/**
 * Everything waiting for the model's `resume`, held in memory: run_js programs
 * waiting at `await pause(...)`, and tool calls that asked a question before
 * acting (plugins/types.ts `Interrupt`). One registry, so one `resume` tool
 * answers both and one keep-alive covers both.
 *
 * Memory only, on purpose. A suspended program is a live sandbox — a QuickJS
 * context in this process, or a Dynamic Worker isolate whose pending call is
 * this object's — and neither can be written down. So the continuation is a
 * convenience with a short life, never something correctness depends on: an
 * object that is evicted, redeployed or restarted loses every one, and
 * `resume` then says the continuation is gone and asks for a new program,
 * which is exactly what a pause did before it could be resumed. A tool's
 * question is kept the same way for the same reason: nothing has been done
 * yet, so losing it costs the model one more call, never a wrong action.
 *
 * One registry per agent runtime (one per Durable Object), shared by every
 * session's run_js and resume tools; a token is only answered in the session
 * that was given it.
 */
import type { AnswerSpec, Continuation } from "../core/execution.ts";
import type { Json } from "../core/types.ts";
import type { ToolInterrupt } from "../core/tools.ts";

/** How long a suspended program waits for `resume` before it is discarded. */
export const RUN_JS_RESUME_MS = 60_000;
/** While anything is suspended, the object wakes at least this often, so it stays in memory. */
export const RUN_JS_KEEP_ALIVE_MS = 10_000;

interface Waiting {
  /** Which session's model was given the token. */
  scope: string;
  /** The model call that asked: run_js for a program, the tool's own call for a tool. */
  callId: string;
  /** What was asked, and the answer it said it expects (checked by `resume`). */
  question?: string;
  answer?: AnswerSpec;
  expiresAt: number;
}

/** A run_js program waiting at `await pause(...)`. */
export interface SuspendedProgram extends Waiting {
  kind?: "program";
  continuation: Continuation;
  /** What had been counted when it suspended, so the next stretch is counted as a difference. */
  hostCalls: number;
  operations: number;
  /** Where the program's tool calls report a question they were asked (pi-tools.ts), carried so a resumed stretch can see them. */
  asked?: unknown[];
}

/** Where a tool's question goes back to: the runtime's side of the gateway (cf/src/runtime.ts). */
export interface InterruptHost {
  /** Delivers a checked answer; settles with the tool's next result (a ToolResult). */
  resumeInterrupt(i: ToolInterrupt, answer: Json, callId: string): Promise<unknown>;
  /** Tells the tool nobody will answer. Returns why that failed, or null. */
  cancelInterrupt?(i: ToolInterrupt): Promise<string | null>;
}

/** A tool call that asked the model before acting. */
export interface SuspendedTool extends Waiting {
  kind: "tool";
  /** The tool as the model named it. */
  tool: string;
  /** What the gateway handed back, `state` included: kept here, never shown. */
  interrupt: ToolInterrupt;
  host: InterruptHost;
  /** Asked from inside a run_js program, which has ended at that call. */
  inProgram?: boolean;
}

export type Suspended = SuspendedProgram | SuspendedTool;

/** What `hold` is given: either kind, without its expiry, which the registry sets. */
export type ToHold = Omit<SuspendedProgram, "expiresAt"> | Omit<SuspendedTool, "expiresAt">;

export class RunJsContinuations {
  #held = new Map<string, Suspended>();
  readonly ttlMs: number;
  #now: () => number;
  #onHold: ((wakeAt: number) => void) | undefined;

  constructor(opts: {
    ttlMs?: number;
    now?: () => number;
    /** Told when a program is suspended, with when the object should next wake to keep it. */
    onHold?: (wakeAt: number) => void;
  } = {}) {
    this.ttlMs = opts.ttlMs !== undefined && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : RUN_JS_RESUME_MS;
    this.#now = opts.now ?? Date.now;
    this.#onHold = opts.onHold;
  }

  get size(): number { return this.#held.size; }

  hold(entry: ToHold): { token: string; expiresAt: number } {
    this.sweep();
    const token = `rjc_${crypto.randomUUID().replace(/-/g, "")}`;
    const expiresAt = this.#now() + this.ttlMs;
    this.#held.set(token, { ...entry, expiresAt } as Suspended);
    try { this.#onHold?.(this.#now() + Math.min(RUN_JS_KEEP_ALIVE_MS, this.ttlMs)); } catch { /* the sweep still runs on the next wake */ }
    return { token, expiresAt };
  }

  /**
   * The suspended program behind `token`, left in place: for checking an
   * answer before committing to it. Null exactly when `take` would be.
   */
  peek(token: string, scope: string): Suspended | null {
    const s = this.#held.get(token);
    if (!s || s.scope !== scope) return null;
    if (this.#now() >= s.expiresAt) { this.#held.delete(token); discard(s); return null; }
    return s;
  }

  /**
   * The suspended program behind `token`, removed from the registry: one
   * resume per token. Null when there is none for this scope — unknown, used,
   * expired, or lost with the object's memory. An expired one is discarded here.
   */
  take(token: string, scope: string): Suspended | null {
    const s = this.peek(token, scope);
    if (s) this.#held.delete(token);
    return s;
  }

  /** Discard every program past its time, releasing its sandbox. Returns how many. */
  sweep(): number {
    const now = this.#now();
    let n = 0;
    for (const [token, s] of this.#held) {
      if (now >= s.expiresAt) { this.#held.delete(token); discard(s); n++; }
    }
    return n;
  }

  /**
   * When the object should wake next for these programs, in ms from now: at
   * the keep-alive interval, or sooner when one expires sooner. Null when
   * nothing is suspended, so the keep-alive stops by itself. Sweeps first.
   */
  wakeInMs(): number | null {
    this.sweep();
    if (!this.#held.size) return null;
    const now = this.#now();
    let soonest = RUN_JS_KEEP_ALIVE_MS;
    for (const s of this.#held.values()) soonest = Math.min(soonest, Math.max(0, s.expiresAt - now));
    return soonest;
  }
}

/** Ends the program, or tells the tool nobody will answer; nobody is waiting for what either says. */
function discard(s: Suspended) {
  try {
    if (s.kind === "tool") void s.host.cancelInterrupt?.(s.interrupt).catch(() => {});
    else void s.continuation.cancel().catch(() => {});
  } catch { /* already ended */ }
}

// ---- what answer a pause expects ------------------------------------------

/**
 * What answer a waiting thing expects: pause()'s third argument, or a plugin
 * interrupt's `answer`. Defined in core/execution.ts so a plugin can name it
 * without reaching into the runtime; re-exported here, beside its checks.
 */
export type { AnswerSpec } from "../core/execution.ts";

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const isObject = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);

/** The spec a program gave, or why it cannot be used (the pause then goes on without a check). */
export function answerSpecOf(raw: Json | undefined): { spec: AnswerSpec } | { error: string } {
  const shapes = 'expected { choices: [strings] }, { kind: "yes_no" }, { kind: "text" } or { schema: {...} }';
  if (!isObject(raw)) return { error: `pause()'s third argument: ${shapes}` };
  const keys = Object.keys(raw);
  if (keys.length !== 1) return { error: `pause()'s third argument has ${keys.length} fields: ${shapes}` };
  if ("choices" in raw) {
    const c = raw.choices;
    if (!Array.isArray(c) || !c.length || !c.every((x) => typeof x === "string")) {
      return { error: "pause()'s answer.choices must be a non-empty list of strings" };
    }
    return { spec: { choices: c as string[] } };
  }
  if ("kind" in raw) {
    if (raw.kind === "yes_no" || raw.kind === "text") return { spec: { kind: raw.kind } };
    return { error: `pause()'s answer.kind must be "yes_no" or "text", not ${JSON.stringify(raw.kind)}` };
  }
  if ("schema" in raw) {
    if (!isObject(raw.schema)) return { error: "pause()'s answer.schema must be a JSON schema object" };
    const bad = schemaProblem(raw.schema, "schema");
    if (bad) return { error: `pause()'s answer.${bad}` };
    return { spec: { schema: raw.schema } };
  }
  return { error: `pause()'s third argument: ${shapes}` };
}

/** Whether a schema uses the checked keywords in a form they can be checked in. */
function schemaProblem(schema: Record<string, Json>, at: string): string | null {
  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || !types.every((t) => typeof t === "string" && SCHEMA_TYPES.has(t))) {
      return `${at}.type must be one of ${[...SCHEMA_TYPES].join(", ")}, or a list of them`;
    }
  }
  if ("enum" in schema && !Array.isArray(schema.enum)) return `${at}.enum must be a list`;
  if ("required" in schema && !(Array.isArray(schema.required) && schema.required.every((k) => typeof k === "string"))) {
    return `${at}.required must be a list of property names`;
  }
  if ("properties" in schema) {
    if (!isObject(schema.properties)) return `${at}.properties must be an object`;
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (!isObject(sub)) return `${at}.properties.${k} must be a schema object`;
      const bad = schemaProblem(sub, `${at}.properties.${k}`);
      if (bad) return bad;
    }
  }
  if ("items" in schema) {
    if (!isObject(schema.items)) return `${at}.items must be a schema object`;
    const bad = schemaProblem(schema.items, `${at}.items`);
    if (bad) return bad;
  }
  return null;
}

/** Why `answer` does not fit `spec`, in a line the model can act on; null when it fits. */
export function answerProblem(spec: AnswerSpec, answer: Json | undefined): string | null {
  if ("choices" in spec) {
    return typeof answer === "string" && spec.choices.includes(answer)
      ? null
      : `the answer must be exactly one of ${spec.choices.map((c) => JSON.stringify(c)).join(", ")}; got ${shown(answer)}`;
  }
  if ("kind" in spec) {
    if (spec.kind === "yes_no") return typeof answer === "boolean" ? null : `the answer must be true or false; got ${shown(answer)}`;
    return typeof answer === "string" ? null : `the answer must be a string; got ${shown(answer)}`;
  }
  return schemaMismatch(spec.schema, answer === undefined ? null : answer, "answer");
}

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function schemaMismatch(schema: Record<string, Json>, v: Json, at: string): string | null {
  if ("type" in schema) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    const t = typeOf(v);
    const fits = types.some((want) => want === t || (want === "integer" && t === "number" && Number.isInteger(v)));
    if (!fits) return `${at} must be ${types.join(" or ")}; got ${shown(v)}`;
  }
  if (Array.isArray(schema.enum)) {
    const s = JSON.stringify(v);
    if (!schema.enum.some((e) => JSON.stringify(e) === s)) {
      return `${at} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}; got ${shown(v)}`;
    }
  }
  if (isObject(v)) {
    for (const k of (Array.isArray(schema.required) ? schema.required : []) as string[]) {
      if (!(k in v)) return `${at}.${k} is required`;
    }
    if (isObject(schema.properties)) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in v && isObject(sub)) {
          const bad = schemaMismatch(sub, v[k]!, `${at}.${k}`);
          if (bad) return bad;
        }
      }
    }
  }
  if (Array.isArray(v) && isObject(schema.items)) {
    for (let i = 0; i < v.length; i++) {
      const bad = schemaMismatch(schema.items, v[i]!, `${at}[${i}]`);
      if (bad) return bad;
    }
  }
  return null;
}

function shown(v: Json | undefined): string {
  if (v === undefined) return "nothing";
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
