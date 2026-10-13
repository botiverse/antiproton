/**
 * One `turn.timing` trace row per turn of a pi085 conversation (src/runtime/turn-timing.ts): its points in order, its
 * parts adding up to its wall time, and each summed part moved by what it claims to measure — a model that takes
 * longer moves `modelMs`, a caller that takes longer moves `clientWaitMs`, a tool that takes longer moves `toolMs`,
 * and nothing else.
 *
 * The whole `AgentDO` under node, as test/client-tool-alarms.ts runs it: a `cloudflare:workers` stand-in, a virtual
 * clock that jumps to the armed alarm, D1 as node:sqlite with every migration, and the model answered at the queue
 * (`takeJob` / `deliverAnswer`) from a script. The clock is the test's: the model's, the caller's and a tool's time are
 * jumps of it, so each part has a known size.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { BenchState } from "../cf/src/bench.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { timedTools, turnInbound } from "../src/runtime/turn-timing.ts";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { pendingClientCalls } from "../src/runtime/client-calls.ts";

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

// Every read of the clock moves it a millisecond, so two reads are never equal and order is strict; the jumps below
// are what a part is meant to measure, and SLACK bounds what the reads themselves add over a turn.
let clock = Date.now();
Date.now = () => ++clock;
const SLACK = 400;
/** How long the model takes to answer each call, the caller each submission, the slow tool each call. */
const MODEL_MS = 3_000, CALLER_MS = 20_000, TOOL_MS = 7_000;

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

const BASE_DB = JSON.stringify({
  users: {}, products: {},
  orders: { "#W1": { order_id: "#W1", user_id: "u", address: {}, status: "pending", fulfillments: [], items: [], payment_history: [] } },
});

const USAGE = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Reply = { calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> } | { text: string };
/** An answer as the queue consumer delivers it, carrying its job id (src/model/pi-bridge.ts), which its model.call row joins by. */
const answer = (r: Reply, jobId: string) => ({ jobId,
  role: "assistant",
  content: "text" in r ? [{ type: "text", text: r.text }] : r.calls.map((c) => ({ type: "toolCall", ...c })),
  api: "openai-completions", provider: "deepseek", model: "deepseek-flash", usage: USAGE,
  stopReason: "text" in r ? "stop" : "toolUse", timestamp: 0,
});

function object(name: string) {
  const raw = sqliteHost();
  const jobs: string[] = [];
  const state = { alarmAt: null as number | null, alarms: 0 };
  /** Trace rows the alarm passes exported (cf/src/trace-r2.ts), which the outbox then forgets. */
  const exported = new Map<number, any>();
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
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: {
      put: async (key: string, body: Uint8Array) => {
        if (key.startsWith("trace/")) {
          for (const line of new TextDecoder().decode(body).split("\n").filter(Boolean)) { const r = JSON.parse(line); exported.set(r.seq, r); }
        }
        return {};
      },
      head: async () => null, list: async () => ({ objects: [] }),
      get: async (key: string) => (key === "bench/tau2-db.json" ? { text: async () => BASE_DB } : null),
    },
    ARTIFACT_BUCKET: "b", CONTROL_DB: control, HARNESS_MODEL: "deepseek-flash",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk-test",
    SECRET_KEK: Buffer.alloc(32, 7).toString("base64"),
  };
  const D: any = new AgentDO(ctx as never, env as never);
  /** Run until quiet: each queued model call answered after MODEL_MS, each alarm fired when due. */
  /** Run once, before the next model answer is delivered: something else arriving while a call is out. */
  const hooks: { beforeAnswer?: () => Promise<void> } = {};
  const settle = async (tenantId: string, agentId: string, script: Reply[], max = 40) => {
    for (;;) {
      if (jobs.length) {
        const id = jobs.shift()!;
        const job = await D.takeJob(tenantId, agentId, id) as any;
        if (!job || job.unknownJob) continue;
        const next = script.shift();
        must(next, "a model call the script has no reply for");
        if (hooks.beforeAnswer) { const h = hooks.beforeAnswer; hooks.beforeAnswer = undefined; await h(); }
        clock += MODEL_MS;
        await D.deliverAnswer(tenantId, agentId, id, answer(next, id), MODEL_MS);
        continue;
      }
      if (state.alarmAt === null) return;
      must(state.alarms < max, `the object did not settle in ${max} alarms`);
      clock = Math.max(clock, state.alarmAt);
      state.alarmAt = null;
      state.alarms++;
      await D.alarm();
      clock += 5;
    }
  };
  /** Every trace row of `kind` written so far, exported or still in the outbox, in seq order. */
  const rows = (kind: string) => {
    const all = new Map(exported);
    for (const r of raw.sql.exec("SELECT seq, kind, span_id, status, verdict, ms, attrs FROM trace_outbox ORDER BY seq").toArray() as any[]) {
      all.set(Number(r.seq), { seq: Number(r.seq), kind: String(r.kind), spanId: String(r.span_id), status: String(r.status), verdict: String(r.verdict), ms: r.ms === null ? undefined : Number(r.ms), attrs: JSON.parse(String(r.attrs)) });
    }
    return [...all.values()].sort((a, b) => a.seq - b.seq).filter((r) => r.kind === kind)
      .map((r) => ({ spanId: String(r.spanId), status: String(r.status), verdict: String(r.verdict), ms: r.ms === undefined ? null : Number(r.ms), attrs: r.attrs as Record<string, any> }));
  };
  return { D, raw, state, jobs, settle, rows, hooks };
}

const TENANT = "t-api";
const FUNCS = [
  { name: "lookup", description: "Look an order up.", parameters: { type: "object", properties: { id: { type: "string" } } } },
  { name: "cancel", description: "Cancel an order.", parameters: { type: "object", properties: { id: { type: "string" } } } },
];
const AGENT = { name: "Clerk", instructions: "Help.", model: "default", metadata: {}, tools: FUNCS, createdAt: 1, updatedAt: 1 };
const outputFor = (p: any) => (p.name === "lookup" ? "W1: pending" : "W1: cancelled");

/**
 * Customer messages over the API, each a turn: the message, the model's replies from `script`, and whenever the
 * session waits on the caller, the caller's results after CALLER_MS. `cancelWhilePaused` cancels at the first pause.
 */
async function apiTurns(label: string, messages: Array<{ text: string; script: Reply[] }>, opts: {
  cancelWhilePaused?: boolean;
  /** At a pause the caller answers nothing and goes on to the next message. */
  abandon?: boolean;
  /** The caller's results land inside the step that paused, after its resume looked and found a call waiting. */
  answerInWindow?: boolean;
  /** At the first pause, a background job's completion is posted to the session (no `receivedAt`, as `step` posts it). */
  jobAtPause?: string;
  /** A steer into the first turn while its first model call is out. */
  steer?: string;
  /** Done to the object before the first message. */
  prepare?(o: ReturnType<typeof object>): void;
} = {}) {
  const agentId = `a-${label}`, session = `sess_${label}`;
  const o = object(`api:${TENANT}/${agentId}`);
  const agentJson = JSON.stringify(AGENT);
  await o.D.apiOpenSession(TENANT, agentId, agentJson, session);
  opts.prepare?.(o);
  const status = () => o.D.apiSessionStatus(TENANT, agentId, session);
  const turnOf = async (callId: string) => (await status()).pending.find((p: any) => p.call_id === callId)?.turn_id;
  const marks: Array<{ sent: number; read: number }> = [];
  let submissions = 0;
  let lastBatch: any[] = [], inWindow = 0, jobPosted = false;
  const answerAll = async () => {
    const s = await status();
    const batch = await Promise.all(s.pending.map(async (p: any) => ({ turnId: await turnOf(p.call_id) ?? "", callId: p.call_id, output: outputFor(p), isError: false })));
    lastBatch = batch;
    clock += CALLER_MS;
    const out = await o.D.apiToolResults(TENANT, agentId, session, batch);
    must(out.unknown.length === 0, `results refused: ${show(out)}`);
    submissions++;
  };
  const proto = PiAgent.prototype as any, resume = proto.resumeClientCalls;
  if (opts.answerInWindow) {
    proto.resumeClientCalls = async function (this: unknown) {
      const r = await resume.call(this);
      if (!r && pendingClientCalls(o.raw.sql as never, session).length) { inWindow++; await answerAll(); }
      return r;
    };
  }
  if (opts.steer) o.hooks.beforeAnswer = async () => { await o.D.runtime().postMessage(TENANT, agentId, opts.steer, "steer", session); };
  try {
  for (const m of messages) {
    const sent = Date.now();
    await o.D.apiPostInput(TENANT, agentId, agentJson, session, m.text);
    for (let round = 0; round < 10; round++) {
      await o.settle(TENANT, agentId, m.script);
      const s = await status();
      if (opts.answerInWindow && s.status !== "requires_action" && m.script.length && lastBatch.length) {
        // The test opens a gap that the API path does not have: results land inside the step, between its resume read
        // and the end of the step, and that step then marks its session idle (`AgentRuntime.step` markSession) over the
        // mark the results set, so no wake steps it. In the runtime the gap needs real I/O at that point, which only the
        // main session's overflow backstop has, when it rebuilds or posts a briefing. Sending the results again marks it.
        const again = await o.D.apiToolResults(TENANT, agentId, session, lastBatch);
        must(again.unknown.length === 0, show(again));
        lastBatch = [];
        continue;
      }
      if (s.status !== "requires_action") break;
      if (opts.cancelWhilePaused) { clock += CALLER_MS; await o.D.apiCancelSession(TENANT, agentId, session); await o.settle(TENANT, agentId, m.script); break; }
      if (opts.abandon) { clock += CALLER_MS; break; }
      if (opts.jobAtPause && !jobPosted) {
        jobPosted = true;
        clock += 1_000;
        await o.D.runtime().postMessage(TENANT, agentId, opts.jobAtPause, "prompt", session);
        await o.D.alarm();
        continue;
      }
      await answerAll();
    }
    marks.push({ sent, read: Date.now() });
    must(m.script.length === 0, `the script was not used up: ${show(m.script)}`);
  }
  } finally { proto.resumeClientCalls = resume; }
  // A turn that ended leaves no record behind: the next message opens its own.
  const left = o.raw.sql.exec("SELECT * FROM turn_timing").toArray();
  must(left.length === 0, `a turn record outlived its turn: ${show(left)}`);
  return { o, agentId, session, marks, submissions, inWindow, timing: o.rows("turn.timing") };
}

type Row = ReturnType<ReturnType<typeof object>["rows"]>[number];
const POINTS = ["inboundAt", "saidAt", "turnStartAt", "firstJobAt", "lastAnswerAt", "replyAt"] as const;
const PARTS = ["inboundToStartMs", "startToFirstJobMs", "modelMs", "betweenJobsMs", "lastAnswerToReplyMs"] as const;

/** The checks every row with a model call answers: points in order, the parts adding up to `ms`, the gaps from the points. */
function wellFormed(r: Row, within?: { sent: number; read: number }) {
  const a = r.attrs;
  for (const p of POINTS) must(typeof a[p] === "number", `${p} missing: ${show(a)}`);
  for (let i = 1; i < POINTS.length; i++) {
    must(a[POINTS[i - 1]!] <= a[POINTS[i]!], `${POINTS[i - 1]} ${a[POINTS[i - 1]!]} after ${POINTS[i]} ${a[POINTS[i]!]}: ${show(a)}`);
  }
  if (within) must(within.sent <= a.inboundAt && a.replyAt <= within.read, `the turn's points are outside the caller's own: ${show(within)} ${show(a)}`);
  must(r.ms === a.replyAt - a.inboundAt, `ms ${r.ms} is not reply − inbound: ${show(a)}`);
  const sum = PARTS.reduce((s, k) => s + a[k], 0);
  must(sum === r.ms, `the parts add to ${sum}, not ${r.ms}: ${show(a)}`);
  must(a.inboundToStartMs === a.turnStartAt - a.inboundAt && a.startToFirstJobMs === a.firstJobAt - a.turnStartAt
    && a.lastAnswerToReplyMs === a.replyAt - a.lastAnswerAt && a.prepMs === a.saidAt - a.inboundAt, `a gap is not its points' difference: ${show(a)}`);
  must(a.betweenJobsMs >= a.toolMs + a.clientWaitMs, `the tools and the caller's waits are inside the time between jobs: ${show(a)}`);
  must(a.engine === "pi085" && r.spanId === `tt_${a.session}@${a.inboundAt}`, show(r));
  must(JSON.stringify(a).length < 1000, `attrs ${JSON.stringify(a).length} chars`);
}
const near = (v: number, want: number) => v >= want && v <= want + SLACK;

const SEQ: Reply[] = [
  { calls: [{ id: "c_lookup", name: "lookup", arguments: { id: "W1" } }] },
  { calls: [{ id: "c_cancel", name: "cancel", arguments: { id: "W1" } }] },
  { text: "Order W1 is cancelled." },
];

let seq: Awaited<ReturnType<typeof apiTurns>>;
await check("an API turn with two caller functions in sequence: one row, ok, 3 jobs, 2 pauses, and the parts add up", async () => {
  seq = await apiTurns("seq", [{ text: "Please cancel order W1.", script: [...SEQ] }]);
  must(seq.submissions === 2, `submissions ${seq.submissions}`);
  must(seq.timing.length === 1, `rows: ${show(seq.timing)}`);
  const r = seq.timing[0]!;
  must(r.status === "completed" && r.verdict === "ok", show(r));
  wellFormed(r, seq.marks[0]);
  const a = r.attrs;
  must(a.session === "sess_seq" && a.modelJobs === 3 && a.clientPauses === 2 && a.messages === 1, show(a));
});

await check("…each part holds what moved it: the model's time in modelMs, the caller's in clientWaitMs, no tool time", () => {
  const a = seq.timing[0]!.attrs;
  must(near(a.modelMs, 3 * MODEL_MS), `modelMs ${a.modelMs}, want 3 × ${MODEL_MS}: ${show(a)}`);
  must(near(a.clientWaitMs, 2 * CALLER_MS), `clientWaitMs ${a.clientWaitMs}, want 2 × ${CALLER_MS}: ${show(a)}`);
  // The caller's functions are the pause, not tools that ran here.
  must(a.toolMs === 0 && a.tools === 0, `the caller's functions were timed as tools: ${show(a)}`);
  // Between the jobs is the caller's time and the passes around it, nothing the size of a model call.
  must(near(a.betweenJobsMs, 2 * CALLER_MS), `betweenJobsMs ${a.betweenJobsMs}: ${show(a)}`);
  for (const k of ["inboundToStartMs", "startToFirstJobMs", "lastAnswerToReplyMs", "prepMs"] as const) {
    must(a[k] >= 0 && a[k] < SLACK, `${k} ${a[k]} holds a jump: ${show(a)}`);
  }
});

await check("…and the model.call rows are as they were: one per job, their ms the job's own", () => {
  const calls = seq.o.rows("model.call");
  must(calls.length === 3 && calls.every((c) => near(c.ms ?? -1, MODEL_MS)), show(calls));
  must(calls.reduce((s, c) => s + (c.ms ?? 0), 0) === seq.timing[0]!.attrs.modelMs, "modelMs is not the model.call rows' sum");
});

await check("two customer messages: two turns, two rows with their own span ids, each well formed", async () => {
  const r = await apiTurns("two", [
    { text: "Hello.", script: [{ text: "Hi." }] },
    { text: "Please cancel order W1.", script: [...SEQ] },
  ]);
  must(r.timing.length === 2, `rows: ${show(r.timing)}`);
  must(r.timing[0]!.spanId !== r.timing[1]!.spanId, show(r.timing));
  wellFormed(r.timing[0]!, r.marks[0]); wellFormed(r.timing[1]!, r.marks[1]);
  must(r.timing[0]!.attrs.modelJobs === 1 && r.timing[0]!.attrs.betweenJobsMs === 0 && r.timing[0]!.attrs.clientPauses === 0, show(r.timing[0]));
  must(r.timing[1]!.attrs.modelJobs === 3 && r.timing[1]!.attrs.clientPauses === 2, show(r.timing[1]));
  must(r.timing[0]!.attrs.replyAt < r.timing[1]!.attrs.inboundAt, "the second turn began before the first ended");
});

await check("a turn cancelled while it waits on the caller: one row, cancelled, its pause counted up to the cancel", async () => {
  const r = await apiTurns("cancel", [{ text: "Please cancel order W1.", script: [SEQ[0]!] }], { cancelWhilePaused: true });
  must(r.timing.length === 1, `rows: ${show(r.timing)}`);
  const t = r.timing[0]!;
  must(t.status === "cancelled" && t.verdict === "cancelled", show(t));
  must(t.attrs.clientPauses === 1 && near(t.attrs.clientWaitMs, CALLER_MS), show(t.attrs));
  must(t.attrs.modelJobs === 1 && t.ms === t.attrs.replyAt - t.attrs.inboundAt, show(t));
});

await check("results that land after the pausing step's resume looked: the turn is not closed early, and stays one row", async () => {
  const r = await apiTurns("window", [{ text: "Please cancel order W1.", script: [...SEQ] }], { answerInWindow: true });
  must(r.inWindow === 2, `control: both submissions landed in the window, not ${r.inWindow}`);
  must(r.timing.length === 1, `rows: ${show(r.timing)}`);
  const t = r.timing[0]!;
  must(t.status === "completed" && t.attrs.modelJobs === 3, `closed early: ${show(t)}`);
  wellFormed(t, r.marks[0]);
});

await check("a cancel with nothing running and nothing waiting writes no row, and forgets a record left there", async () => {
  const r = await apiTurns("idlecancel", [{ text: "Hello.", script: [{ text: "Hi." }] }]);
  must(r.timing.length === 1, show(r.timing));
  // A record no turn owns, as one left by a message whose run was never seen ending.
  turnInbound(r.o.raw.sql as never, r.session, Date.now(), { stale: false });
  await r.o.D.apiCancelSession(TENANT, r.agentId, r.session);
  await r.o.settle(TENANT, r.agentId, []);
  must(r.o.rows("turn.timing").length === 1, `the cancel wrote a row: ${show(r.o.rows("turn.timing"))}`);
  must(r.o.raw.sql.exec("SELECT * FROM turn_timing").toArray().length === 0, "the record was kept");
});

await check("new input to a turn the caller left waiting: that turn closes abandoned at the input, and the new one is its own", async () => {
  const r = await apiTurns("abandon", [
    { text: "Please cancel order W1.", script: [SEQ[0]!] },
    { text: "Never mind.", script: [{ text: "OK." }] },
  ], { abandon: true });
  must(r.timing.length === 2, `rows: ${show(r.timing)}`);
  const [old, next] = r.timing as [Row, Row];
  must(old.status === "abandoned" && old.verdict === "failed", show(old));
  must(old.attrs.clientPauses === 1 && near(old.attrs.clientWaitMs, CALLER_MS) && old.attrs.replyAt === next.attrs.inboundAt, show([old, next]));
  must(next.status === "completed" && next.attrs.modelJobs === 1 && next.attrs.clientPauses === 0 && next.attrs.messages === 1, show(next));
  wellFormed(next, r.marks[1]);
});

await check("new input while a turn's calls are all answered but not yet resumed joins that turn rather than replacing it", async () => {
  const r = await apiTurns("answered", [{ text: "Hello.", script: [{ text: "Hi." }] }]);
  // The state results leave between landing and the step that resumes them: the lane idle, the turn open, its call
  // answered and not yet used.
  const sql = r.o.raw.sql as never as { exec(q: string, ...b: unknown[]): { toArray(): any[] } };
  const inboundAt = Date.now();
  turnInbound(sql as never, r.session, inboundAt, { stale: false });
  sql.exec("INSERT INTO api_client_calls(session, call_id, name, arguments, state, output, created_at) VALUES (?, 'c_x', 'lookup', '{}', 'answered', 'W1: pending', ?)", r.session, Date.now());
  await r.o.D.runtime().postMessage(TENANT, r.agentId, "And W2?", "prompt", r.session);
  const rec = sql.exec("SELECT inbound_at, messages FROM turn_timing WHERE session = ?", r.session).toArray()[0];
  must(rec && Number(rec.inbound_at) === inboundAt && Number(rec.messages) === 2, `the turn was replaced: ${show(rec)}`);
});

await check("a background job's completion during an unanswered pause joins the turn: nothing is abandoned", async () => {
  const r = await apiTurns("job", [{ text: "Please cancel order W1.", script: [SEQ[0]!, { text: "The job is done." }, { text: "Order W1: pending." }] }],
    { jobAtPause: "[background job finished]" });
  const rows = r.timing;
  must(!rows.some((t) => t.status === "abandoned"), `abandoned by a job completion: ${show(rows)}`);
  must(rows.length === 1 && rows[0]!.status === "completed" && rows[0]!.attrs.messages === 2 && rows[0]!.attrs.modelJobs === 3, show(rows));
});

await check("a steer into a turn in flight joins it: one row, two messages", async () => {
  const r = await apiTurns("steer", [{ text: "Hello.", script: [{ text: "Hi." }, { text: "Noted." }] }], { steer: "Also, order W2." });
  must(r.timing.length === 1, `rows: ${show(r.timing)}`);
  const t = r.timing[0]!;
  must(t.attrs.messages === 2 && t.status === "completed", show(t));
  wellFormed(t, r.marks[0]);
});

await check("a timing store that throws on every write fails nothing: the turn runs as it would, and writes no row", async () => {
  // A table of the name with none of the columns: every read and write of the timing throws (and is logged).
  const r = await apiTurns("broken", [{ text: "Please cancel order W1.", script: [...SEQ] }],
    { prepare: (o) => o.raw.sql.exec("CREATE TABLE turn_timing(x)") });
  must(r.submissions === 2 && r.timing.length === 0, show(r.timing));
  const s = await r.o.D.apiSessionStatus(TENANT, r.agentId, r.session);
  must(s.status === "idle", show(s));
  const t = JSON.parse(await r.o.D.apiTranscript(TENANT, r.agentId, r.session));
  const last = t.entries.filter((e: any) => e.type === "message").at(-1)?.message;
  must(last?.role === "assistant" && JSON.stringify(last.content).includes("Order W1 is cancelled."), show(last));
  const errs = r.o.raw.sql.exec("SELECT name FROM sqlite_master WHERE name = 'alarm_errors'").toArray().length
    ? r.o.raw.sql.exec("SELECT message FROM alarm_errors").toArray() : [];
  must(errs.length === 0, show(errs));
});

/** A τ² turn on the `/bench` object, whose tool runs in the object, with that tool taking TOOL_MS when `slow`. */
async function benchTurn(engine: "pi085" | "pd", slow: boolean) {
  const taskId = `t_${engine}_${slow ? "slow" : "fast"}`;
  const o = object(`bench-${taskId}`);
  const started = await o.D.benchStart(taskId, "policy", true, engine === "pd" ? "pd" : undefined);
  must((started.engine ?? "pi085") === engine, show(started));
  // The retail tool reads its task's state first: the slow tool's time is spent there, inside the call.
  const proto = BenchState.prototype as any, state = proto.state;
  if (slow) proto.state = async function (this: unknown, id: string) { clock += TOOL_MS; return state.call(this, id); };
  try {
    await o.D.benchSay(taskId, "hello");
    await o.settle("bench", `b_${taskId}`, [
      { calls: [{ id: "c_get", name: "retail__get_order_details", arguments: { order_id: "#W1" } }] },
      { text: "It is pending." },
    ]);
  } finally { proto.state = state; }
  const poll = await o.D.benchPoll(taskId);
  must(poll.status === "idle" && poll.answer === "It is pending.", show(poll));
  return { rows: o.rows("turn.timing"), tables: o.raw.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r: any) => String(r.name)) };
}

let fast: Row[];
await check("a /bench turn whose tool runs in the object: one row, 2 jobs, 1 tool, no pause", async () => {
  fast = (await benchTurn("pi085", false)).rows;
  must(fast.length === 1, `rows: ${show(fast)}`);
  wellFormed(fast[0]!);
  const a = fast[0]!.attrs;
  must(a.modelJobs === 2 && a.tools === 1 && a.clientPauses === 0 && a.clientWaitMs === 0 && a.toolMs < SLACK, show(a));
});

await check("…the same turn with the tool taking 7 s: toolMs moves by 7 s, and betweenJobsMs with it; modelMs does not", async () => {
  const slow = (await benchTurn("pi085", true)).rows;
  must(slow.length === 1, `rows: ${show(slow)}`);
  wellFormed(slow[0]!);
  const a = slow[0]!.attrs, b = fast[0]!.attrs;
  must(near(a.toolMs, TOOL_MS) && a.tools === 1, `toolMs ${a.toolMs}, want ${TOOL_MS}: ${show(a)}`);
  must(b.betweenJobsMs < SLACK && near(a.betweenJobsMs, TOOL_MS), `betweenJobsMs ${a.betweenJobsMs}, without the delay ${b.betweenJobsMs}`);
  must(Math.abs(a.modelMs - b.modelMs) < SLACK, `modelMs moved: ${a.modelMs} vs ${b.modelMs}`);
});

await check("pd writes no turn.timing row, and is not given pi085's tables for it: its turn ends inside the harness", async () => {
  const { rows, tables } = await benchTurn("pd", false);
  must(rows.length === 0, show(rows));
  must(!tables.includes("turn_timing") && !tables.includes("api_client_calls"), `pd object tables: ${show(tables)}`);
});

await check("inboundAt is when the API handler took the message: the agent's provisioning before the write is in prepMs", async () => {
  // Provisioning is the API path's own work between taking the message and writing it (AgentDO.apiPostInput).
  const proto = AgentRuntime.prototype as any, provision = proto.provision;
  proto.provision = async function (this: unknown, ...args: unknown[]) { clock += 5_000; return provision.apply(this, args); };
  let r: Awaited<ReturnType<typeof apiTurns>>;
  try { r = await apiTurns("prep", [{ text: "Hello.", script: [{ text: "Hi." }] }]); }
  finally { proto.provision = provision; }
  must(r.timing.length === 1, show(r.timing));
  wellFormed(r.timing[0]!, r.marks[0]);
  const a = r.timing[0]!.attrs;
  must(near(a.prepMs, 5_000) && near(a.inboundToStartMs, 5_000), `prepMs ${a.prepMs}, inboundToStartMs ${a.inboundToStartMs}: ${show(a)}`);
});

await check("a timed tool is the same tool to the model: every field but execute is the original's, and a skipped one is untouched", async () => {
  class Tool { name: string; constructor(name: string) { this.name = name; } label = "L"; description = "D"; parameters = { type: "object" }; async execute(x: number) { return { n: x, self: this.name }; } }
  const a = new Tool("a"), b = new Tool("b");
  const ran: number[] = [];
  const [ta, tb] = timedTools([a, b], { skip: (t) => t === b, ran: (ms) => ran.push(ms), now: Date.now });
  must(tb === b && ta !== a && Object.getPrototypeOf(ta) === Tool.prototype, "the copy or the skip");
  for (const k of ["name", "label", "description", "parameters"] as const) must(ta![k] === a[k], `${k} differs`);
  // A class's execute is on its prototype; the copy carries its own, and nothing else is added or lost.
  must(show(Object.keys(ta!).filter((k) => k !== "execute")) === show(Object.keys(a)), show(Object.keys(ta!)));
  const out = await ta!.execute(3);
  must(show(out) === show({ n: 3, self: "a" }) && ran.length === 1, show([out, ran]));
  const thrower = timedTools([{ name: "t", async execute() { throw new Error("no"); } }], { skip: () => false, ran: (ms) => ran.push(ms), now: Date.now })[0]!;
  const err = await thrower.execute!().then(() => null, (e: Error) => e.message);
  must(err === "no" && (ran.length as number) === 2, `a throwing tool: ${err}, timed ${ran.length}`);
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n${r.error}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
