/**
 * Tools on the `pd` engine (src/runtime/durable-tools.ts), measured against `pi085` doing the same
 * thing. Run over node:sqlite by test/pd-tools.ts and on a real Durable Object's storage by
 * cf/src/conformance.ts (test/pd-tools-do.sh).
 *
 * A parity case builds one world per engine — the real `ToolGateway` over a `DurableObjectStore`
 * on the case's storage, test plugins, the same catalogue, run_js over a scripted sandbox, one
 * `RunJsContinuations` — and has the same scripted model talk to `PiAgent` and to `DurableAgent`.
 * What is compared is what the model is sent: every request, through the real conversion
 * (`toRequest` on the job each engine wrote), tokens and expiry times aside. The transcript each
 * engine keeps is compared too, where both keep the same thing.
 *
 * The sandbox is scripted because what is under test is the bridge from a harness to `runJsTool`
 * and `resume`, not an executor: a program is JSON naming the calls it makes, where it pauses and
 * what it calls after. A call that comes back pending ends it, as both real executors end one.
 */
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { holdFrom } from "../../src/core/execution.ts";
import type { Json } from "../../src/core/types.ts";
import { fromResponse, toRequest } from "../../src/model/pi-bridge.ts";
import type { ModelMessage, ModelResponse, ToolDefinition } from "../../src/model/types.ts";
import { interrupt, type Plugin } from "../../src/plugins/types.ts";
import { DurableAgent, PdHost } from "../../src/runtime/durable-agent.ts";
import { ToolGateway } from "../../src/runtime/gateway.ts";
import { PiAgent } from "../../src/runtime/pi-agent.ts";
import {
  AFTER_PROGRAM_NOTE, TOOL_IN_PROGRAM_NOTE, TOOL_QUESTION_NOTE, qualifyMountedTools, runJsTools,
  type MountedTool, type Sandbox, type ToolHost,
} from "../../src/runtime/pi-tools.ts";
import { RunJsContinuations } from "../../src/runtime/run-js-resume.ts";
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { UnknownJob } from "../../cf/src/model-queue.ts";
import type { DriveCase, WithDriveHost } from "./durable-drive-spec.ts";

export const MODEL = { provider: "queue", id: "m1", contextWindow: 100_000 };
export const SYSTEM = "You are a test agent.";
const CTX = { tenantId: "t", agentId: "a", taskId: "t_a" };

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ---- the world: plugins, gateway, catalogue ---------------------------------------

type Call = [tool: string, args: Json];
/** A run_js program for the scripted sandbox. */
type Program = { calls?: Call[]; pause?: { reason: string; answer?: Json; data?: Json }; after?: Call[] };

/** The scripted sandbox: see the header. */
const sandbox: Sandbox = {
  async execute(source, host) {
    const p = JSON.parse(source) as Program;
    const outputs: unknown[] = [];
    const ops: string[] = [];
    let hostCalls = 0;
    const run = async (calls: Call[]) => {
      for (const [tool, args] of calls) {
        hostCalls++;
        const r = await host.invoke({ tool, args });
        if (r.status === "pending") return { tool, res: r };
        if (r.operationId) ops.push(r.operationId);
        outputs.push(r.status === "succeeded" ? r.result : { error: r.error?.code ?? r.status });
      }
      return null;
    };
    const held = (h: { tool: string; res: { operationId: string; error?: { code?: string } } }) => ({
      status: "paused" as const, pause: holdFrom(h.tool, h.res), outputs, hostCalls, acceptedOperationIds: ops,
      held: [{ tool: h.tool, operationId: h.res.operationId, status: "pending" as const }],
    });
    const first = await run(p.calls ?? []);
    if (first) return held(first);
    if (!p.pause) return { status: "completed", outputs, hostCalls, acceptedOperationIds: ops };
    return {
      status: "paused", outputs, hostCalls, acceptedOperationIds: ops, held: [],
      pause: { cause: "pause", reason: p.pause.reason, data: p.pause.data ?? null, ...(p.pause.answer === undefined ? {} : { answer: p.pause.answer }) },
      continuation: {
        resume: async (answer: Json) => {
          outputs.push({ answer });
          const next = await run(p.after ?? []);
          return next ? held(next) : { status: "completed", outputs, hostCalls, acceptedOperationIds: ops };
        },
        cancel: async () => ({ status: "interrupted", error: { code: "cancelled" }, outputs, hostCalls, acceptedOperationIds: ops }),
      },
    } as never;
  },
};

/** A latch a tool waits on, and a promise that says the tool got there. */
function latch() {
  let open!: () => void, reached!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const arrived = new Promise<void>((r) => { reached = r; });
  return { open, opened, reached, arrived };
}

export type World = Awaited<ReturnType<typeof world>>;

export async function world(storage: DurableSqlHost) {
  const w = {
    invoked: [] as string[],
    /** How many plugin calls ran at once, at most, and now. */
    active: 0, most: 0,
    slow: latch(),
    resumes: [] as Json[],
  };
  const busy = async <T>(fn: () => T): Promise<T> => {
    w.active++; w.most = Math.max(w.most, w.active);
    try { await sleep(40); return fn(); } finally { w.active--; }
  };
  const obj = (props: Record<string, Json> = {}, required: string[] = []) => ({ type: "object", properties: props, required });
  const web: Plugin = {
    id: "web", version: "1.0.0",
    tools: [
      { name: "read_page", summary: "Read a page.", parameters: obj({ url: { type: "string" } }, ["url"]), sideEffects: "read", idempotency: "none" },
      { name: "send", summary: "Post to a page.", parameters: obj({ url: { type: "string" } }, ["url"]), sideEffects: "write", idempotency: "none" },
      { name: "slow", summary: "Takes its time.", parameters: obj(), sideEffects: "write", idempotency: "none" },
      { name: "slow_read", summary: "Takes its time, reading.", parameters: obj(), sideEffects: "read", idempotency: "none" },
      // Its result only counts once the model reads it: a program's call is refused (ToolSchema.modelOnly).
      { name: "inbox", summary: "Take what arrived.", parameters: obj(), sideEffects: "write", idempotency: "native", modelOnly: true },
    ] as never,
    async invoke(tool, args) {
      w.invoked.push(`web.${tool}`);
      const a = args as { url?: string };
      if (tool === "read_page") return busy(() => ({ title: `page ${a.url}` }));
      if (tool === "send") return { sent: a.url ?? null };
      if (tool === "inbox") return { taken: 2 };
      // Waits for the case: the call a close cuts off.
      w.slow.reached();
      await w.slow.opened;
      return { [tool]: "done" };
    },
  };
  // A mount that owns one thing: its calls must not overlap. No `holds`, so the gateway's mount lock
  // is not taken and what keeps the calls apart is the harness alone.
  const box: Plugin = {
    id: "box", version: "1.0.0",
    tools: [{ name: "shell", summary: "Run a command in the box.", parameters: obj({ cmd: { type: "string" } }, ["cmd"]), sideEffects: "write", idempotency: "none" }] as never,
    async invoke(_tool, args) { w.invoked.push("box.shell"); return busy(() => ({ ran: (args as { cmd: string }).cmd })); },
  };
  // A tool as a generator: an unbounded DELETE asks first (test/tool-interrupts.ts has the full plugin).
  const db: Plugin = {
    id: "sql", version: "1.0.0",
    tools: [{ name: "query", summary: "Run one SQL statement.", parameters: obj({ sql: { type: "string" } }, ["sql"]), sideEffects: "write", idempotency: "none" }] as never,
    async invoke(_tool, args) {
      const sql = String((args as { sql?: string }).sql ?? "");
      w.invoked.push(`db.query ${sql}`);
      if (/^delete from \w+$/i.test(sql)) {
        return interrupt({
          question: `${sql} removes every row. Run it?`, context: { rows: 3 },
          answer: { choices: ["confirm", "cancel"] }, state: { sql, secret: "plugin-state-never-shown" },
        });
      }
      return { ok: sql };
    },
    interrupts: {
      async resume(_tool, state, answer) {
        w.resumes.push(answer);
        return answer === "confirm" ? { deleted: 3, sql: (state as { sql: string }).sql } : { cancelled: true };
      },
      async cancel() { /* nothing to undo */ },
    },
  };
  const plugins = [web, box, db];
  const store = new DurableObjectStore({ storage });
  await store.init();
  await store.createAgent("t", "a");
  for (const [alias, plugin, policy] of [["web", "web", { tools: { send: "approval" } }], ["box", "box", null], ["db", "sql", null]] as const) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, plugin, installationId: "i", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: policy as never,
    });
  }
  const gw = new ToolGateway(store, plugins, new Set(plugins.map((p) => p.id)));
  // The runtime's host (cf/src/runtime.ts #host) minus its result finishing: the gateway, as is.
  const host: ToolHost = {
    async invoke(call) { return gw.invoke(CTX, call.tool, call.args, { ...(call.opts as object ?? {}), ...(call.callId ? { callId: call.callId } : {}) }) as never; },
    async resumeInterrupt(i, answer, callId) { return gw.resumeInterrupt(CTX, i, answer, { callId }) as never; },
    async cancelInterrupt(i) { return gw.cancelInterrupt(CTX, i); },
  };
  // As cf/src/runtime.ts `mountedToolEntries` builds it.
  const catalogue: MountedTool[] = qualifyMountedTools([["web", web], ["box", box], ["db", db]].flatMap(([alias, p]) =>
    (p as Plugin).tools!.map((t) => ({
      name: t.name, description: (t as { summary: string }).summary, parameters: t.parameters as Json,
      address: `${alias as string}.${t.name}`, sideEffects: t.sideEffects, idempotency: t.idempotency,
      ...((t as { modelOnly?: true }).modelOnly ? { modelOnly: true as const } : {}),
      ...(alias === "box" ? { exclusive: true } : {}),
    }))));
  const continuations = new RunJsContinuations();
  const extraTools = runJsTools(sandbox, host, { tools: catalogue, continuations, scope: "main" });
  // Assigned onto `w`, not spread: the plugins count into `w`, and a copy would freeze `most` at 0.
  return Object.assign(w, { store, catalogue, host, continuations, extraTools });
}

// ---- the two engines ------------------------------------------------------------

export type Engine = {
  name: "pi085" | "pd";
  agent: PiAgent | DurableAgent;
  dispatched: string[];
  pd?: PdHost;
};

export function toolOptions(w: World) {
  return { tools: w.catalogue, toolHost: w.host, interrupts: { continuations: w.continuations, scope: "main" }, extraTools: w.extraTools as never };
}

async function pi085(storage: DurableSqlHost, w: World): Promise<Engine> {
  const dispatched: string[] = [];
  const agent = await PiAgent.open({
    host: storage, sessionId: "t/a", session: "main", systemPrompt: SYSTEM, model: MODEL,
    dispatch: async (id) => { dispatched.push(id); }, ...toolOptions(w),
  });
  return { name: "pi085", agent, dispatched };
}

function pd(storage: DurableSqlHost, w: World, opts: { stepDeadlineMs?: number; openSession?: (s: string) => Promise<unknown>; session?: string } = {}): Engine {
  const dispatched: string[] = [];
  const host = new PdHost({ storage, pollAfterMs: 20, minParkMs: 1, ...(opts.stepDeadlineMs ? { stepDeadlineMs: opts.stepDeadlineMs } : {}) });
  const agent = DurableAgent.open({
    host, tenantId: "t", agentId: "a", model: MODEL, systemPrompt: SYSTEM,
    dispatch: async (id) => { dispatched.push(id); }, unknownJob: (id) => new UnknownJob(id),
    ...(opts.openSession ? { openSession: opts.openSession } : {}),
    ...(opts.session ? { session: opts.session } : {}),
    ...toolOptions(w),
  });
  return { name: "pd", agent, dispatched, pd: host };
}

// ---- the model ----------------------------------------------------------------------

export type Request = { messages: ModelMessage[]; tools?: ToolDefinition[] };
export type Turn = (req: Request) => ModelResponse;

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
export const say = (text: string): Turn => () => ({ text, finishReason: "stop", truncated: false, usage });
export const calls = (...c: Array<[id: string, name: string, args: unknown] | ((req: Request) => [string, string, unknown])>): Turn => (req) => ({
  text: "", finishReason: "tool_calls", truncated: false, usage,
  toolCalls: c.map((x) => (typeof x === "function" ? x(req) : x)).map(([id, name, args]) => ({ id, name, arguments: args })),
});
/** The last tool result the model was sent, parsed. */
const lastResult = (req: Request): Record<string, unknown> => {
  const m = [...req.messages].reverse().find((x) => x.role === "tool");
  check(m, `no tool result in ${show(req.messages)}`);
  // Not JSON (an error line): the script goes on, and the comparison of the requests says what differed.
  try { return JSON.parse(String(m.content)); } catch { return { unparsed: String(m.content) }; }
};

/** Drive one engine through a user message and the model's turns. Returns every request the model was sent. */
export async function converse(e: Engine, user: string, script: Turn[]): Promise<Request[]> {
  const requests: Request[] = [];
  const answered = new Set<string>();
  await e.agent.say(user);
  for (let guard = 0; guard < 300; guard++) {
    const out = await e.agent.step();
    const pending = e.dispatched.filter((id) => !answered.has(id));
    for (const id of pending) {
      answered.add(id);
      const job = await e.agent.takeJob(id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] } | null;
      if (!job) continue;
      const req = toRequest(job.context) as Request;
      requests.push(req);
      const turn = script[requests.length - 1];
      check(turn, `${e.name}: the model was called ${requests.length} times; the script has ${script.length} turns. Last request: ${show(req.messages.slice(-2))}`);
      await e.agent.deliver(id, fromResponse(turn(req), { api: job.model.api, provider: job.model.provider, id: job.model.id }, id));
    }
    if (pending.length) continue;
    if (out.open === 0 && out.wakeInMs === null) return requests;
    check(out.wakeInMs !== null && out.wakeInMs <= 5_000, `${e.name}: stuck: ${show(out)}`);
    await sleep(out.wakeInMs);
  }
  throw new Error(`${e.name}: the conversation did not settle`);
}

/** What differs between two runs and is not behaviour: a token, an expiry time. */
export const norm = (s: string) => s.replace(/rjc_[0-9a-f]+/g, "<token>").replace(/\\?"expiresAt\\?":\\?"[^"\\]*\\?"/g, "<expiresAt>");
/** A request as the model reads it, system prompt aside (the prompt's own parity is the runtime's case). */
export const seen = (r: Request) => ({ tools: r.tools ?? [], messages: r.messages.filter((m) => m.role !== "system").map((m) => norm(show(m))) });

/**
 * Each round's tool results in a fixed order. pi085 stores a round's results in call order; pd
 * appends each as its call settles, so a quick call's result can come first. Both send the model
 * call order (the requests are compared as sent); this is about the stored order only.
 */
export function roundsSorted(lines: string[]): string[] {
  const out: string[] = [];
  let block: string[] = [];
  const flush = () => { out.push(...block.sort()); block = []; };
  for (const line of lines) {
    if (line.startsWith("toolResult")) block.push(line);
    else { flush(); out.push(line); }
  }
  flush();
  return out;
}

/** The transcript as the console reads it: role, tool, text, error flag. */
export async function transcript(e: Engine): Promise<string[]> {
  const entries = await e.agent.entries({});
  type M = { role: string; toolName?: string; isError?: boolean; stopReason?: string; content: unknown };
  // pi085 records each "not ready yet" of the offloaded provider as a `deferred` assistant message,
  // which no request carries (pi-offloaded.ts); pd's poll writes no entry.
  return entries.filter((x) => x.type === "message" && (x as unknown as { message: M }).message.stopReason !== "deferred").map((x) => {
    const m = (x as unknown as { message: M }).message;
    const text = typeof m.content === "string" ? m.content
      : (m.content as Array<{ type: string; text?: string; name?: string; arguments?: unknown }>)
        .map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[call ${c.name} ${show(c.arguments)}]` : "")).join("");
    return norm(`${m.role}${m.toolName ? `(${m.toolName})` : ""}${m.isError ? " error" : ""}: ${text}`);
  }).filter((line) => !line.startsWith("system"));
}

type Run = { requests: Request[]; transcript: string[]; tools: string[]; approvals: Array<{ request: unknown }>; world: World; engine: Engine };

/** The same conversation on both engines, each on fresh storage. */
async function both(withHost: WithDriveHost, user: string, script: Turn[]): Promise<{ pi: Run; pd: Run }> {
  const out: Partial<Record<"pi" | "pd", Run>> = {};
  for (const which of ["pi", "pd"] as const) {
    await withHost(async (storage) => {
      const w = await world(storage);
      const e = which === "pi" ? await pi085(storage, w) : pd(storage, w);
      try {
        const requests = await converse(e, user, script);
        out[which] = { requests, transcript: roundsSorted(await transcript(e)), tools: (await e.agent.tools()).map((t) => t.name),
          approvals: await w.store.listApprovals("t", "pending") as Run["approvals"], world: w, engine: e };
      } finally { await e.agent.close(); }
    });
  }
  return out as { pi: Run; pd: Run };
}

/** Every request the same, in order; the transcript the same unless told otherwise. */
function same(r: { pi: Run; pd: Run }, opts: { transcript?: boolean } = {}) {
  check(r.pi.requests.length === r.pd.requests.length, `model calls: pi085 ${r.pi.requests.length}, pd ${r.pd.requests.length}`);
  r.pi.requests.forEach((p, i) => {
    const a = seen(p), b = seen(r.pd.requests[i]!);
    check(show(a.tools) === show(b.tools), `request ${i}: tools differ\n pi085 ${show(a.tools.map((t) => t.name))}\n pd    ${show(b.tools.map((t) => t.name))}`);
    a.messages.forEach((m, j) => check(m === b.messages[j], `request ${i}, message ${j} differs\n pi085 ${m}\n pd    ${b.messages[j]}`));
    check(a.messages.length === b.messages.length, `request ${i}: ${a.messages.length} messages on pi085, ${b.messages.length} on pd`);
  });
  if (opts.transcript !== false) {
    check(show(r.pi.transcript) === show(r.pd.transcript), `transcripts differ\n pi085 ${show(r.pi.transcript)}\n pd    ${show(r.pd.transcript)}`);
  }
}

/**
 * Step until `reached` resolves (a tool call has started) and return the step that was in flight
 * then, which settles once the call does — or never, for a harness abandoned mid-call. A step
 * before the poll is due parks at once, so it is asked again after the wake.
 */
export async function stepUntil(e: Engine, reached: Promise<void>): Promise<{ step: ReturnType<Engine["agent"]["step"]> }> {
  let there = false;
  void reached.then(() => { there = true; });
  for (let i = 0; i < 200; i++) {
    const stepping = e.agent.step();
    stepping.catch(() => {});
    const first = await Promise.race([stepping.then((out) => ({ out })), reached.then(() => null)]);
    if (first === null || there) return { step: stepping };
    await sleep(Math.min(first.out.wakeInMs ?? 10, 100));
  }
  throw new Error(`${e.name}: the tool call never started`);
}

export const toolMessages = (req: Request) => req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));

// ---- the cases ----------------------------------------------------------------------

export function pdToolsCases(withHost: WithDriveHost): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (group: string, name: string, run: () => Promise<void>) => cases.push({ group, name, run });

  add("parity", "the model is offered the same tools — names, descriptions, schemas, order — run_js and resume among them", async () => {
    const r = await both(withHost, "hello", [say("hi")]);
    same(r);
    const names = (r.pd.requests[0]!.tools ?? []).map((t) => t.name);
    check(show(names) === show([...r.pd.world.catalogue.map((t) => t.name), "run_js", "resume"]), `offered ${show(names)}`);
    check(show(r.pd.tools) === show(names) && show(r.pi.tools) === show(names), `engine.tools(): pi085 ${show(r.pi.tools)}, pd ${show(r.pd.tools)}`);
  });

  add("gateway", "a plugin call and a policy-held call reach the gateway once each and read the same on both engines", async () => {
    const r = await both(withHost, "read and post", [
      calls(["c1", "web__read_page", { url: "u1" }], ["c2", "web__send", { url: "u2" }]),
      say("done"),
    ]);
    same(r);
    const results = toolMessages(r.pd.requests[1]!);
    check(results[0] === show({ title: "page u1" }), `the read's result: ${results[0]}`);
    check(results[1] === "web__send: this call is held for approval", `the held call: ${results[1]}`);
    for (const run of [r.pi, r.pd]) {
      check(show(run.world.invoked) === show(["web.read_page"]), `${run.engine.name}: the plugin ran ${show(run.world.invoked)} (a held call must not run)`);
      const held = run.approvals;
      check(held.length === 1 && (held[0]!.request as { tool: string }).tool === "web.send", `${run.engine.name}: approvals ${show(held)}`);
    }
  });

  add("generator", "a tool's question → a resume that does not fit → a resume that does: the same texts, the plugin resumed once", async () => {
    const r = await both(withHost, "clear the users table", [
      calls(["c1", "db__query", { sql: "DELETE FROM users" }]),
      calls((req) => ["c2", "resume", { token: lastResult(req).token, answer: "maybe" }]),
      calls((req) => ["c3", "resume", { token: lastResult(req).token, answer: "confirm" }]),
      say("cleared"),
    ]);
    same(r);
    const asked = lastResult(r.pd.requests[1]!);
    check(asked.state === "yielded" && asked.tool === "db__query" && asked.note === TOOL_QUESTION_NOTE, `the question: ${show(asked)}`);
    check(show(asked.answer) === show({ choices: ["confirm", "cancel"] }) && !show(asked).includes("plugin-state-never-shown"), `the question: ${show(asked)}`);
    const refused = lastResult(r.pd.requests[2]!);
    check(typeof refused.invalidAnswer === "string" && refused.token === asked.token, `the refusal: ${show(refused)}`);
    check(show(lastResult(r.pd.requests[3]!)) === show({ deleted: 3, sql: "DELETE FROM users" }), `the answer's result: ${show(lastResult(r.pd.requests[3]!))}`);
    for (const run of [r.pi, r.pd]) check(show(run.world.resumes) === show(["confirm"]), `${run.engine.name}: resumes ${show(run.world.resumes)}`);
    check(r.pd.transcript.length === 8, `transcript ${show(r.pd.transcript)}`);
  });

  add("run_js", "a program calls tools, pauses, is resumed; a second program's call asks a question, answered by resume", async () => {
    const program: Program = {
      calls: [["web__read_page", { url: "a" }]],
      pause: { reason: "which next?", answer: { choices: ["b", "c"] } },
      after: [["web__read_page", { url: "b" }]],
    };
    const r = await both(withHost, "run it", [
      calls(["c1", "run_js", { source: show(program) }]),
      calls((req) => ["c2", "resume", { token: lastResult(req).token, answer: "b" }]),
      calls(["c3", "run_js", { source: show({ calls: [["web__read_page", { url: "d" }], ["db__query", { sql: "DELETE FROM logs" }], ["web__read_page", { url: "e" }]] }) }]),
      calls((req) => ["c4", "resume", { token: lastResult(req).token, answer: "confirm" }]),
      say("all done"),
    ]);
    same(r);
    const paused = lastResult(r.pd.requests[1]!);
    check(paused.state === "yielded" && paused.question === "which next?" && show(paused.soFar) === show({ outputs: [{ title: "page a" }], calls: 1 }), `the pause: ${show(paused)}`);
    check(show(lastResult(r.pd.requests[2]!) as unknown) === show([{ title: "page a" }, { answer: "b" }, { title: "page b" }]), `the resumed program: ${show(lastResult(r.pd.requests[2]!))}`);
    const asked = lastResult(r.pd.requests[3]!);
    check(asked.tool === "db__query" && asked.note === TOOL_IN_PROGRAM_NOTE, `the question inside a program: ${show(asked)}`);
    const after = lastResult(r.pd.requests[4]!);
    check(after.note === AFTER_PROGRAM_NOTE && show(after.result) === show({ deleted: 3, sql: "DELETE FROM logs" }), `after the program: ${show(after)}`);
    for (const run of [r.pi, r.pd]) {
      check(show(run.world.invoked) === show(["web.read_page", "web.read_page", "web.read_page", "db.query DELETE FROM logs"]),
        `${run.engine.name}: the plugins ran ${show(run.world.invoked)}`);
    }
  });

  add("run_js", "a model-only tool is refused from a program by its name and by its address, never reaching the plugin; the model's own call runs it", async () => {
    const r = await both(withHost, "take the inbox", [
      calls(["c1", "run_js", { source: show({ calls: [["web__inbox", {}], ["web.inbox", {}], ["web__read_page", { url: "z" }]] }) }]),
      calls(["c2", "web__inbox", {}]),
      say("taken"),
    ]);
    same(r);
    const program = lastResult(r.pd.requests[1]!);
    check(show(program) === show([{ error: "not_from_a_program" }, { error: "not_from_a_program" }, { title: "page z" }]), `the program: ${show(program)}`);
    check(show(lastResult(r.pd.requests[2]!)) === show({ taken: 2 }), `the model's own call: ${show(lastResult(r.pd.requests[2]!))}`);
    for (const run of [r.pi, r.pd]) {
      check(show(run.world.invoked) === show(["web.read_page", "web.inbox"]), `${run.engine.name}: the plugin ran ${show(run.world.invoked)}`);
    }
  });

  add("sequential", "an exclusive mount's calls make the round sequential on pd; without one the round runs in parallel", async () => {
    const r = await both(withHost, "two shells and two reads", [
      calls(["c1", "box__shell", { cmd: "a" }], ["c2", "web__read_page", { url: "x" }], ["c3", "box__shell", { cmd: "b" }], ["c4", "web__read_page", { url: "y" }]),
      calls(["c5", "web__read_page", { url: "p" }], ["c6", "web__read_page", { url: "q" }]),
      say("ok"),
    ]);
    same(r);
    // One `most` for the whole conversation. pd: 2, from the second round's two reads — the control that
    // an overlap is seen — so its first round is measured alone below. pi085: all four of the first
    // round at once, because pi-agent-core 0.85's harness does not read a tool's `executionMode`; on
    // pi085 a real exclusive mount (one that `holds`) is kept apart by the gateway's mount lock instead.
    check(r.pd.world.most === 2, `control: pd's parallel reads did not overlap (${r.pd.world.most})`);
    check(r.pi.world.most === 4, `pi085 ran ${r.pi.world.most} of the first round's calls at once`);
    await withHost(async (storage) => {
      const w = await world(storage);
      const e = pd(storage, w);
      try {
        await converse(e, "two shells and two reads", [
          calls(["c1", "box__shell", { cmd: "a" }], ["c2", "web__read_page", { url: "x" }], ["c3", "box__shell", { cmd: "b" }], ["c4", "web__read_page", { url: "y" }]),
          say("ok"),
        ]);
        check(w.most === 1, `pd ran ${w.most} calls at once in a round with an exclusive mount`);
        check(show(w.invoked) === show(["box.shell", "web.read_page", "box.shell", "web.read_page"]), `call order ${show(w.invoked)}`);
      } finally { await e.agent.close(); }
    });
  });

  add("interrupted", "an unsafe call cut off by a close is not run again, and the model reads that it was interrupted (pd: pi-durable's own result, shown as stored)", async () => {
    const script = [calls(["c1", "web__slow", {}]), say("noted")];
    const requests: Partial<Record<"pi085" | "pd", Request[]>> = {};
    for (const which of ["pi085", "pd"] as const) {
      await withHost(async (storage) => {
        const w = await world(storage);
        const first = which === "pi085" ? await pi085(storage, w) : pd(storage, w);
        await first.agent.say("go slow");
        // The first step parks waiting for the answer; answering and stepping again runs the tool.
        await first.agent.step();
        const [job] = first.dispatched;
        const taken = await first.agent.takeJob(job!) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
        await first.agent.deliver(job!, fromResponse(script[0]!(toRequest(taken.context) as Request), taken.model, job!));
        await stepUntil(first, w.slow.arrived);
        // The object goes away mid-call. pd: its harness is closed, and the call, outliving it, finishes —
        // nothing may record that. pi085: the harness is never used again and its call never returns,
        // as in an evicted isolate (a pi085 harness left running would write its own result).
        if (which === "pd") {
          await first.agent.close();
          w.slow.open();
          await sleep(20);
        }
        const second = which === "pi085" ? await pi085(storage, w) : pd(storage, w);
        const answered = new Set<string>();
        const seenHere: Request[] = [];
        for (let guard = 0; guard < 100; guard++) {
          const out = await second.agent.step();
          const pending = second.dispatched.filter((x) => !answered.has(x));
          for (const id of pending) {
            answered.add(id);
            const j = await second.agent.takeJob(id) as typeof taken | null;
            if (!j) continue;
            const req = toRequest(j.context) as Request;
            seenHere.push(req);
            await second.agent.deliver(id, fromResponse(script[1]!(req), j.model, id));
          }
          if (pending.length) continue;
          if (out.open === 0 && out.wakeInMs === null) break;
          await sleep(Math.min(out.wakeInMs ?? 10, 1_000));
        }
        requests[which] = seenHere;
        check(show(w.invoked) === show(["web.slow"]), `${which}: the unsafe call ran ${w.invoked.length} times`);
        if (which === "pd") {
          // What the model is sent is what the transcript shows: the stored result, unrewritten.
          const shown = (await second.agent.entries({})).map((x) => (x as unknown as { message?: { role?: string; content?: Array<{ text?: string }> } }).message)
            .filter((m) => m?.role === "toolResult").map((m) => (m!.content ?? []).map((c) => c.text ?? "").join(""));
          check(show(shown) === show(toolMessages(seenHere[0]!)), `the transcript shows ${show(shown)}, the model read ${show(toolMessages(seenHere[0]!))}`);
        }
        await second.agent.close();
      });
    }
    for (const which of ["pi085", "pd"] as const) {
      const reqs = requests[which]!;
      check(reqs.length === 1, `${which}: ${reqs.length} model calls after the reopen`);
      const read = toolMessages(reqs[0]!);
      check(read.length === 1 && read[0]!.includes("interrupted"), `${which}: the model read ${show(read)}`);
    }
    check(toolMessages(requests.pd![0]!)[0]!.includes("Tool web__slow was interrupted and may have partially run"), `pd: the model read ${show(toolMessages(requests.pd![0]!))}`);
  });

  add("interrupted", "a read-safe call cut off by a close runs again on reopen, and its result is the model's", async () => {
    await withHost(async (storage) => {
      const w = await world(storage);
      const first = pd(storage, w);
      await first.agent.say("read slowly");
      await first.agent.step();
      const [job] = first.dispatched;
      const taken = await first.agent.takeJob(job!) as { model: { api: string; provider: string; id: string } };
      await first.agent.deliver(job!, fromResponse(calls(["c1", "web__slow_read", {}])({ messages: [] }), taken.model, job!));
      await stepUntil(first, w.slow.arrived);
      await first.agent.close();
      w.slow.open();
      const second = pd(storage, w);
      const reqs = await (async () => {
        const out: Request[] = [];
        const answered = new Set<string>();
        for (let guard = 0; guard < 100; guard++) {
          const s = await second.agent.step();
          const pending = second.dispatched.filter((x) => !answered.has(x));
          for (const id of pending) {
            answered.add(id);
            const j = await second.agent.takeJob(id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
            const req = toRequest(j.context) as Request;
            out.push(req);
            await second.agent.deliver(id, fromResponse(say("read")(req), j.model, id));
          }
          if (pending.length) continue;
          if (s.open === 0 && s.wakeInMs === null) return out;
          await sleep(s.wakeInMs ?? 10);
        }
        throw new Error("did not settle");
      })();
      check(show(w.invoked) === show(["web.slow_read", "web.slow_read"]), `the safe call ran ${show(w.invoked)}`);
      check(show(toolMessages(reqs[0]!)) === show([show({ slow_read: "done" })]), `the model read ${show(toolMessages(reqs[0]!))}`);
      await second.agent.close();
    });
  });

  add("park", "while a tool call runs, step() keeps the harness open and returns only after the call settles", async () => {
    await withHost(async (storage) => {
      const w = await world(storage);
      const e = pd(storage, w, { stepDeadlineMs: 10_000 });
      await e.agent.say("go slow");
      await e.agent.step();
      const [job] = e.dispatched;
      const taken = await e.agent.takeJob(job!) as { model: { api: string; provider: string; id: string } };
      await e.agent.deliver(job!, fromResponse(calls(["c1", "web__slow", {}])({ messages: [] }), taken.model, job!));
      let done = false;
      const stepping = stepUntil(e, w.slow.arrived).then(({ step }) => step).then((out) => { done = true; return out; });
      await w.slow.arrived;
      // Longer than a poll interval and a min park: a park predicate that ignored the busy slot would have closed by now.
      await sleep(300);
      check(!done && e.pd!.open, `step returned (${done}) or the harness closed (open ${e.pd!.open}) while the tool ran`);
      w.slow.open();
      const out = await stepping;
      check(out.wakeInMs !== null && !e.pd!.open, `after the call: ${show(out)}, open ${e.pd!.open}`);
      const results = (await e.agent.entries({})).filter((x) => (x as unknown as { message: { role: string } }).message.role === "toolResult");
      check(results.length === 1 && show(results[0]).includes("done"), `the result: ${show(results)}`);
      await e.agent.close();
    });
  });

  add("sessions", "a harness resumed for one session first installs every listed session's tools", async () => {
    for (const install of [true, false]) {
      await withHost(async (storage) => {
        const w = await world(storage);
        // Session "other" asks for a tool and its object goes away before the call runs.
        const first = pd(storage, w, { session: "other" });
        await first.agent.say("read it");
        await first.agent.step();
        const [job] = first.dispatched;
        const taken = await first.agent.takeJob(job!) as { model: { api: string; provider: string; id: string } };
        await first.agent.deliver(job!, fromResponse(calls(["c1", "web__read_page", { url: "z" }])({ messages: [] }), taken.model, job!));
        await first.agent.close();
        // A new object steps only "main": the harness it resumes runs "other"'s generation too.
        const opened: string[] = [];
        let other: Engine | null = null;
        const main = pd(storage, w, install ? {
          openSession: async (s) => {
            opened.push(s);
            // What the runtime's `agent()` does for a session: open its engine on this object's host.
            other = { name: "pd", dispatched: [], agent: DurableAgent.open({
              host: main.pd!, tenantId: "t", agentId: "a", model: MODEL, systemPrompt: SYSTEM, session: s,
              dispatch: async () => {}, unknownJob: (id) => new UnknownJob(id), ...toolOptions(w),
            }) };
          },
        } : {});
        await sleep(60);
        for (let i = 0; i < 20; i++) {
          const out = await main.agent.step();
          const records = await main.pd!.withHarness(async (h) => {
            const c = await main.pd!.handle(h, await main.pd!.conversation("other"));
            return (await c.entries({}, 50, undefined, BACKGROUND)).items.filter((r) => r.kind === "pi.tool-result");
          });
          if (records.length > 0) {
            const text = show(records[0]!.model);
            if (install) {
              check(show(opened) === show(["other"]), `opened ${show(opened)}`);
              check(other !== null && text.includes("page z"), `with the session opened, the result is ${text}`);
            } else {
              // The control: the same step without it resolves no tool for "other".
              check(text.includes("is not available"), `control: without openSession the result is ${text}`);
            }
            break;
          }
          check(i < 19, "the other session's tool never ran");
          await sleep(out.wakeInMs ?? 10);
        }
        await main.agent.close();
      });
    }
  });

  return cases;
}
