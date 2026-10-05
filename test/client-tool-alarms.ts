/**
 * How many alarms a turn costs, by path (#778). A turn that pauses for an Agents API caller's function results
 * is resumed in the alarm the caller's results wake (cf/src/runtime.ts `step`), so each submission costs one
 * alarm: alarms = delivered model answers + customer messages + tool-result submissions. Before #778 the
 * resuming pass returned a 0 ms wake and a further alarm only sent the next model call, so each submission
 * that completed a batch cost two.
 *
 * The whole `AgentDO` under node, as test/bench-pd.ts runs it: a `cloudflare:workers` stand-in, a virtual
 * clock that jumps to the armed alarm, D1 as node:sqlite with every migration, and the model answered at the
 * queue (`takeJob` / `deliverAnswer`, what cf/src/model-queue.ts calls) from a script. Alarms are counted at
 * the one place the platform calls them, so a count is "calls to `AgentDO.alarm`".
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { PiAgent } from "../src/runtime/pi-agent.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

let clock = Date.now();
Date.now = () => ++clock;

function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    q, b,
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.prepare(q).get(...(b as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...(b as any[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  return {
    prepare: (q: string) => stmt(q),
    batch: async (s: any[]) => s.map((x) => {
      const read = x.q.trim().toUpperCase().startsWith("SELECT");
      return { results: read ? db.prepare(x.q).all(...(x.b as any[])) : [], meta: { changes: read ? 0 : Number(db.prepare(x.q).run(...(x.b as any[])).changes) } };
    }),
  };
}
const control = d1();

/** A bench task's base database, read by the `retail` plugin the `/bench` object mounts. */
const BASE_DB = JSON.stringify({
  users: {}, products: {},
  orders: { "#W1": { order_id: "#W1", user_id: "u", address: {}, status: "pending", fulfillments: [], items: [], payment_history: [] } },
});

const USAGE = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Reply = { calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> } | { text: string };
const answer = (r: Reply) => ({
  role: "assistant",
  content: "text" in r ? [{ type: "text", text: r.text }] : r.calls.map((c) => ({ type: "toolCall", ...c })),
  api: "openai-completions", provider: "deepseek", model: "deepseek-flash", usage: USAGE,
  stopReason: "text" in r ? "stop" : "toolUse", timestamp: 0,
});

/** One agent object: its own storage and alarm, the shared D1. */
function object(name: string) {
  const raw = sqliteHost();
  const jobs: string[] = [];
  const state = { alarmAt: null as number | null, alarms: 0, sent: 0 };
  /** Each alarm: the model calls it sent, when it asked to be woken next (ms from its end), whether it threw. */
  const passes: Array<{ sent: number; armedInMs: number | null; threw: boolean }> = [];
  const ctx = {
    storage: {
      sql: raw.sql, transactionSync: raw.transactionSync,
      getAlarm: async () => state.alarmAt,
      setAlarm: async (at: number) => { state.alarmAt = at; },
      deleteAlarm: async () => { state.alarmAt = null; },
    },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(),
    id: { toString: () => name }, getWebSockets: () => [], exports: {},
  };
  const env = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); state.sent++; } },
    ARTIFACTS: {
      put: async () => ({}), head: async () => null, list: async () => ({ objects: [] }),
      get: async (key: string) => (key === "bench/tau2-db.json" ? { text: async () => BASE_DB } : null),
    },
    ARTIFACT_BUCKET: "b", CONTROL_DB: control, HARNESS_MODEL: "deepseek-flash",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk-test",
    SECRET_KEK: Buffer.alloc(32, 7).toString("base64"),
  };
  const D: any = new AgentDO(ctx as never, env as never);
  /** What each model call was handed: the roles and texts of its messages. */
  const asked: string[][] = [];
  /**
   * Run the platform until the object is quiet: answer each queued model call with the script's next reply,
   * fire the alarm when it is due, and stop when no alarm is armed.
   */
  const settle = async (tenantId: string, agentId: string, script: Reply[], max = 40) => {
    for (;;) {
      if (jobs.length) {
        const id = jobs.shift()!;
        const job = await D.takeJob(tenantId, agentId, id) as any;
        if (!job || job.unknownJob) continue;
        asked.push(readable(job.context.messages));
        const next = script.shift();
        must(next, `a model call the script has no reply for (call ${asked.length})`);
        await D.deliverAnswer(tenantId, agentId, id, answer(next), 5);
        continue;
      }
      if (state.alarmAt === null) return;
      must(state.alarms < max, `the object did not settle in ${max} alarms`);
      clock = Math.max(clock, state.alarmAt);
      state.alarmAt = null;
      state.alarms++;
      const sentBefore = state.sent;
      let threw = false;
      try { await D.alarm(); } catch { threw = true; /* recorded by the handler in alarm_errors, as the platform would see it */ }
      passes.push({ sent: state.sent - sentBefore, armedInMs: state.alarmAt === null ? null : state.alarmAt - Date.now(), threw });
      clock += 5;
    }
  };
  const alarmErrors = () => (raw.sql.exec("SELECT name FROM sqlite_master WHERE name = 'alarm_errors'").toArray().length
    ? raw.sql.exec("SELECT message FROM alarm_errors").toArray().map((r: any) => String(r.message)) : []);
  return { D, raw, state, jobs, asked, passes, settle, alarmErrors };
}

const textOf = (m: any): string => typeof m.content === "string" ? m.content
  : (m.content ?? []).map((c: any) => c.type === "text" ? c.text : c.type === "toolCall" ? `call ${c.name}(${show(c.arguments)})` : "").join("");

/**
 * Messages in roles and texts, without the offloaded call's `deferred` placeholders: those record that a call
 * was out when the run was driven (src/model/pi-offloaded.ts), so they count passes, not what was said.
 */
function readable(messages: any[]): string[] {
  return messages.filter((m) => m.stopReason !== "deferred").map((m) =>
    m.role === "toolResult" ? `toolResult:${m.toolName}=${textOf(m)}${m.isError ? " (error)" : ""}` : `${m.role}:${textOf(m)}`);
}

/** The branch a session's transcript reads as: what the caller and the model see. */
async function branch(o: ReturnType<typeof object>, tenantId: string, agentId: string, session: string) {
  const t = JSON.parse(await o.D.apiTranscript(tenantId, agentId, session));
  return readable(t.entries.filter((e: any) => e.type === "message").map((e: any) => e.message));
}

// ---- the Agents API: functions the caller runs -------------------------------------------------------

const TENANT = "t-api";
const FUNCS = [
  { name: "lookup", description: "Look an order up.", parameters: { type: "object", properties: { id: { type: "string" } } } },
  { name: "cancel", description: "Cancel an order.", parameters: { type: "object", properties: { id: { type: "string" } } } },
];
const AGENT = { name: "Clerk", instructions: "Help.", model: "default", metadata: {}, tools: FUNCS, createdAt: 1, updatedAt: 1 };

/**
 * One turn over the API: the customer's message, then each model reply in `script`; whenever the session
 * waits on the caller, the caller answers what `submit` returns for the pending calls (one submission each).
 */
async function apiTurn(label: string, script: Reply[], submit: (pending: any[]) => Array<Array<{ callId: string; output: string }>>) {
  const agentId = `a-${label}`, session = `sess_${label}`;
  const o = object(`api:${TENANT}/${agentId}`);
  const agentJson = JSON.stringify(AGENT);
  await o.D.apiOpenSession(TENANT, agentId, agentJson, session);
  await o.D.apiPostInput(TENANT, agentId, agentJson, session, "Please cancel order W1.");
  const status = () => o.D.apiSessionStatus(TENANT, agentId, session);
  const turnOf = async (callId: string) => (await status()).pending.find((p: any) => p.call_id === callId)?.turn_id;
  let submissions = 0;
  /** The index in `passes` of the alarm each submission woke. */
  const woken: number[] = [];
  for (let round = 0; round < 10; round++) {
    await o.settle(TENANT, agentId, script);
    const s = await status();
    if (s.status !== "requires_action") break;
    // One submission at a time, each settled before the next, as a caller that reads the status between them.
    for (const batch of submit(s.pending)) {
      const sent = await Promise.all(batch.map(async (b) => ({ turnId: await turnOf(b.callId) ?? "", callId: b.callId, output: b.output, isError: false })));
      const out = await o.D.apiToolResults(TENANT, agentId, session, sent);
      must(out.unknown.length === 0, `results refused: ${show(out)}`);
      submissions++;
      woken.push(o.passes.length);
      await o.settle(TENANT, agentId, script);
    }
  }
  must(script.length === 0, `the script was not used up: ${show(script)}`);
  return { o, agentId, session, submissions, woken, status: await status(), branch: await branch(o, TENANT, agentId, session) };
}

const TWO_IN_SEQUENCE: Reply[] = [
  { calls: [{ id: "c_lookup", name: "lookup", arguments: { id: "W1" } }] },
  { calls: [{ id: "c_cancel", name: "cancel", arguments: { id: "W1" } }] },
  { text: "Order W1 is cancelled." },
];
/** The transcript and model inputs of that turn, the same before and after #778. */
const EXPECTED_BRANCH = [
  "user:Please cancel order W1.",
  `assistant:call lookup(${show({ id: "W1" })})`,
  "toolResult:lookup=W1: pending",
  `assistant:call cancel(${show({ id: "W1" })})`,
  "toolResult:cancel=W1: cancelled",
  "assistant:Order W1 is cancelled.",
];
const outputFor = (p: any) => (p.name === "lookup" ? "W1: pending" : "W1: cancelled");

let seq: Awaited<ReturnType<typeof apiTurn>>;
await check("a client-tool turn (2 calls in sequence, 3 model calls): 6 alarms = 3 answers + 1 message + 2 submissions (8 before #778)", async () => {
  seq = await apiTurn("seq", [...TWO_IN_SEQUENCE], (pending) => [pending.map((p) => ({ callId: p.call_id, output: outputFor(p) }))]);
  must(seq.submissions === 2, `submissions: ${seq.submissions}`);
  must(seq.o.asked.length === 3, `model calls: ${seq.o.asked.length}`);
  must(seq.o.state.alarms === 3 + 1 + 2, `alarms: ${seq.o.state.alarms}, want 6`);
});

await check("…and the turn's result is what it was: the same branch, the same three model inputs, idle, no alarm error", () => {
  must(show(seq.branch) === show(EXPECTED_BRANCH), `branch:\n${seq.branch.join("\n")}`);
  must(seq.status.status === "idle" && seq.status.pending.length === 0, show(seq.status));
  // Each model call was handed exactly the branch up to it, so the resumed run starts from the caller's results.
  must(show(seq.o.asked) === show([EXPECTED_BRANCH.slice(0, 1), EXPECTED_BRANCH.slice(0, 3), EXPECTED_BRANCH.slice(0, 5)]), show(seq.o.asked));
  must(seq.o.alarmErrors().length === 0, show(seq.o.alarmErrors()));
});

await check("the alarm a completing submission wakes sends the next model call itself, and asks to be woken for the call it sent", () => {
  for (const i of seq.woken) {
    const p = seq.o.passes[i]!;
    // The model call's redelivery net (src/runtime/pi-agent.ts REDELIVERY_MS), not a 0 ms wake for another pass.
    must(p.sent === 1 && !p.threw && p.armedInMs !== null && p.armedInMs > 60_000, `pass ${i}: ${show(p)} of ${show(seq.o.passes)}`);
  }
});

const BOTH_AT_ONCE: Reply[] = [
  { calls: [{ id: "c_lookup", name: "lookup", arguments: { id: "W1" } }, { id: "c_cancel", name: "cancel", arguments: { id: "W1" } }] },
  { text: "Order W1 is cancelled." },
];
const BOTH_BRANCH = [
  "user:Please cancel order W1.",
  `assistant:call lookup(${show({ id: "W1" })})call cancel(${show({ id: "W1" })})`,
  "toolResult:lookup=W1: pending",
  "toolResult:cancel=W1: cancelled",
  "assistant:Order W1 is cancelled.",
];

await check("two calls in one batch, answered in two submissions: 5 alarms = 2 answers + 1 message + 2 submissions; the first resumes nothing", async () => {
  const r = await apiTurn("split", [...BOTH_AT_ONCE], (pending) => pending.map((p) => [{ callId: p.call_id, output: outputFor(p) }]));
  must(r.submissions === 2 && r.o.state.alarms === 2 + 1 + 2, `submissions ${r.submissions}, alarms ${r.o.state.alarms}`);
  must(show(r.branch) === show(BOTH_BRANCH) && r.status.status === "idle", show([r.branch, r.status]));
  // A submission that leaves a call waiting: its pass sends nothing and asks for nothing, as before #778.
  const first = r.o.passes[r.woken[0]!]!;
  must(first.sent === 0 && first.armedInMs === null, show(r.o.passes));
  must(r.o.passes[r.woken[1]!]!.sent === 1, show(r.o.passes));
});

await check("two calls in one batch, answered in one submission: 4 alarms = 2 answers + 1 message + 1 submission", async () => {
  const r = await apiTurn("batch", [...BOTH_AT_ONCE], (pending) => [pending.map((p) => ({ callId: p.call_id, output: outputFor(p) }))]);
  must(r.submissions === 1 && r.o.state.alarms === 2 + 1 + 1, `submissions ${r.submissions}, alarms ${r.o.state.alarms}`);
  must(show(r.branch) === show(BOTH_BRANCH) && r.status.status === "idle", show([r.branch, r.status]));
});

// ---- paths that resume nothing keep their counts ------------------------------------------------------

await check("an API turn that calls no function: 2 alarms = 1 answer + 1 message", async () => {
  const r = await apiTurn("plain", [{ text: "Hello." }], () => []);
  must(r.submissions === 0 && r.o.state.alarms === 2, `alarms ${r.o.state.alarms}`);
  must(show(r.branch) === show(["user:Please cancel order W1.", "assistant:Hello."]), show(r.branch));
});

/** A τ² turn on the `/bench` object, whose tools run in the object: answers + messages, on either engine. */
for (const engine of ["pi085", "pd"] as const) {
  await check(`a /bench turn on ${engine} whose tool runs on the server: 3 alarms = 2 answers + 1 message`, async () => {
    const taskId = `t_${engine}`;
    const o = object(`bench-${engine}`);
    const started = await o.D.benchStart(taskId, "policy", true, engine === "pd" ? "pd" : undefined);
    must((started.engine ?? "pi085") === engine, show(started));
    await o.D.benchSay(taskId, "hello");
    await o.settle("bench", `b_${taskId}`, [
      { calls: [{ id: "c_get", name: "retail__get_order_details", arguments: { order_id: "#W1" } }] },
      { text: "It is pending." },
    ]);
    const poll = await o.D.benchPoll(taskId);
    must(poll.status === "idle" && poll.answer === "It is pending.", show(poll));
    must(o.asked.length === 2 && o.asked[1]!.some((m) => /^toolResult:retail__get_order_details=.*pending/.test(m)), show(o.asked));
    must(o.state.alarms === 2 + 1, `alarms ${o.state.alarms}: ${show(o.passes)}`);
  });
}

// ---- a failure in the step that drives the resumed run ------------------------------------------------

await check("the step after a resume throws: the pass fails as any step's throw does, its fallback alarm stays armed, and the turn ends as it would have", async () => {
  // Thrown by the first `step` after a `resumeClientCalls` that started a run, once: the second step of the
  // resuming pass (before #778 it was the first step of the 0 ms pass after it).
  const proto = PiAgent.prototype as any;
  const step = proto.step, resume = proto.resumeClientCalls;
  let armed = false, thrown = 0;
  proto.resumeClientCalls = async function (this: unknown) { const r = await resume.call(this); if (r && thrown === 0) armed = true; return r; };
  proto.step = async function (this: unknown) {
    if (armed) { armed = false; thrown++; throw new Error("injected: the step after a resume"); }
    return step.call(this);
  };
  let r: Awaited<ReturnType<typeof apiTurn>>;
  try {
    r = await apiTurn("fails", [...TWO_IN_SEQUENCE], (pending) => [pending.map((p) => ({ callId: p.call_id, output: outputFor(p) }))]);
  } finally { proto.step = step; proto.resumeClientCalls = resume; }
  must(thrown === 1, `thrown ${thrown}`);
  const failed = r.o.passes.findIndex((p) => p.threw);
  must(failed === r.woken[0], `the pass that threw is ${failed}, the first submission woke ${r.woken[0]}: ${show(r.o.passes)}`);
  // The handler arms 30 s before it works; a throw leaves that standing rather than an object with no alarm.
  const p = r.o.passes[failed]!;
  must(p.armedInMs !== null && p.armedInMs > 0 && p.armedInMs <= 30_000, show(p));
  must(show(r.o.alarmErrors()) === show(["injected: the step after a resume"]), show(r.o.alarmErrors()));
  // The next pass drives the run the failed pass started: one more alarm, and the same turn.
  must(r.o.passes[failed + 1]!.sent === 1, show(r.o.passes));
  must(r.o.state.alarms === 3 + 1 + 2 + 1, `alarms ${r.o.state.alarms}`);
  must(show(r.branch) === show(EXPECTED_BRANCH) && r.status.status === "idle", show([r.branch, r.status]));
  must(show(r.o.asked) === show(seq.o.asked), show(r.o.asked));
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n${r.error}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
