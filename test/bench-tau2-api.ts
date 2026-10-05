/**
 * The Agents API τ² runner's pieces (bench/tau2/api-*.ts), each against fixtures the Worker's own functions
 * build: items and turns from `sessionTranscript`, events from `eventsBetween`, the session from
 * `toOpenAISession`. A fixture written by hand can have a shape the wire never carries, which is how the
 * `/bench` fallback went four days unable to fire (src/bench/poll-body.ts); built here, it cannot.
 *
 * What is pinned:
 *   - the retail functions run on the task's database under the names and with the texts the mounted tool had;
 *   - the stream's and the status read's decisions, and the wait that combines them (push, poll, drop,
 *     deafness, deadline, calls answered once);
 *   - the stall evidence at the deadline, named by the `/bench` runner's own criterion;
 *   - the row figures, the kinds from the operator's transcript, and the provider check;
 *   - the record: the `/bench` record's fields plus `runnerMethod` and `modelRequested`, and no record when the
 *     rows' providers disagree.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionTranscript } from "../cf/src/agents-api/transcript.ts";
import { eventsBetween, type Snapshot as WireSnapshot } from "../cf/src/agents-api/events.ts";
import { toOpenAISession, type StoredAgent, type StoredSession } from "../cf/src/agents-api/shapes.ts";
import { entriesToEvents } from "../cf/src/pi-view.ts";
import { CLIENT_PENDING } from "../src/runtime/client-calls.ts";
import { applyRetailAction, type RetailDB } from "../bench/tau2/retail.ts";
import { retailFunctions, runRetailCall, RETAIL_PREFIX } from "../bench/tau2/api-tools.ts";
import {
  apiPollBody, apiStallAtDeadline, decideFromEvent, decideFromSnapshot, waitForTurn,
  type Delivered, type SessionEvent, type Snapshot, type TurnWaitDeps,
} from "../bench/tau2/api-turn.ts";
import {
  apiRunRecord, exactFigures, kindsOf, ledgerModels, rowFigures, runnerMethodOf, runProvider, taskProvider, type ModelsList,
} from "../bench/tau2/api-record.ts";
import { beginRun, recordRun } from "../bench/record.ts";
import { MAX_TURNS, OPENING, SIM, simEnding, simSystem } from "../bench/tau2/episode.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

// ---- fixtures, built by the Worker's own projections -------------------------

const IDS = { sessionId: "sess_1", agentId: "agent_1" };
const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const user = (seq: number, text: string) => ({ type: "message", seq, timestamp: seq * 1000, message: { role: "user", content: text } });
const said = (seq: number, text: string, u = usage(10, 2)) => ({ type: "message", seq, timestamp: seq * 1000, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: u, model: "deepseek-flash" } });
const calls = (seq: number, ...cs: Array<[string, string, object]>) => ({ type: "message", seq, timestamp: seq * 1000, message: { role: "assistant", content: cs.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })), stopReason: "toolUse", usage: usage(30, 4), model: "deepseek-flash" } });
const result = (seq: number, id: string, name: string, text: string, isError = false) => ({ type: "message", seq, timestamp: seq * 1000, message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError } });
const failed = (seq: number) => ({ type: "message", seq, timestamp: seq * 1000, message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider said no", usage: usage(0, 0) } });

const AGENT: StoredAgent = { name: "", instructions: "policy", model: "deepseek-flash", metadata: {}, tools: [], createdAt: 0, updatedAt: 0 };
const STORED: StoredSession = { id: IDS.sessionId, agentId: IDS.agentId, environment: "none", metadata: {}, createdAt: 0, lastActiveAt: 0 };

/** The Worker's view of a transcript: what the stream diffs and what the runner's reads return. */
function wire(entries: unknown[], o: { running?: boolean; pending?: Array<{ call_id: string; name: string; arguments: string; turn_id: string }> } = {}): WireSnapshot {
  const running = !!o.running, pending = running ? [] : (o.pending ?? []);
  return { ...sessionTranscript({ entries, running, pending }, IDS), status: running ? "in_progress" : pending.length ? "requires_action" : "idle", pending };
}
/** The same state as the runner reads it: GET session, turns, items. */
function snap(w: WireSnapshot): Snapshot {
  return { session: toOpenAISession(STORED, AGENT, { status: w.status, pending: w.pending }) as any, turns: w.turns as any, items: w.items as any };
}
let n = 0;
const between = (a: WireSnapshot, b: WireSnapshot): SessionEvent[] =>
  eventsBetween(a, b, { sessionId: IDS.sessionId }, (status, pending) => toOpenAISession(STORED, AGENT, { status, pending }) as any, () => `evt_${++n}`) as any;

// Turn 1: one call, its result, an answer. Turn 2: a call that failed, an answer.
const T1 = [user(1, "hi"), calls(2, ["c1", "retail__get_user_details", { user_id: "u" }]), result(3, "c1", "retail__get_user_details", "{}"), said(4, "Hello")];
const T2 = [user(5, "cancel"), calls(6, ["c2", "retail__cancel_pending_order", { order_id: "#W1", reason: "no longer needed" }]), result(7, "c2", "retail__cancel_pending_order", "retail__cancel_pending_order: Order not found", true), said(8, "Could not")];

// ---- the retail functions -------------------------------------------------------

/**
 * A database of one user, one pending order and its product, in the domain's shape. The real one is 2.8 MB
 * and gitignored (the runners read it beside bench/tau2/data/tasks.json), so no suite may need it.
 */
const BASE_DB: RetailDB = {
  users: { sofia_1: { user_id: "sofia_1", name: { first_name: "Sofia", last_name: "Rossi" }, address: { zip: "78784" }, email: "sofia@example.com",
    payment_methods: { credit_card_1: { source: "credit_card", id: "credit_card_1" } }, orders: ["#W1"] } },
  orders: { "#W1": { order_id: "#W1", user_id: "sofia_1", address: {}, status: "pending", fulfillments: [],
    items: [{ name: "Lamp", product_id: "p1", item_id: "i1", price: 10, options: {} }],
    payment_history: [{ transaction_type: "payment", amount: 10, payment_method_id: "credit_card_1" }] } },
  products: { p1: { name: "Lamp", product_id: "p1", variants: { i1: { item_id: "i1", options: {}, available: true, price: 10 } } } },
};
const TASKS: any[] = [{ id: "fx", evaluation_criteria: { actions: [
  { name: "get_order_details", arguments: { order_id: "#W1" } },
  { name: "cancel_pending_order", arguments: { order_id: "#W1", reason: "no longer needed" } },
] } }];

await check("the functions are the retail tools under `retail__`, each with its summary and its parameters", () => {
  const fns = retailFunctions();
  must(fns.length === 16 && fns.every((f) => f.type === "function" && f.name.startsWith(RETAIL_PREFIX) && /^[A-Za-z0-9_-]{1,64}$/.test(f.name)), show(fns.map((f) => f.name)));
  const order = fns.find((f) => f.name === "retail__get_order_details")!;
  must(order.description === "Get the status and details of an order. A result over 32 KB comes back as a summary (preview); the rest is discarded."
    && /'#' symbol/.test(show(order.parameters)), show(order));
});

await check("a read runs on the task's database and answers the plugin's value as JSON; a write changes that database and is logged", async () => {
  const task = TASKS.find((t) => (t.evaluation_criteria?.actions ?? []).some((a: any) => a.name === "cancel_pending_order"))!;
  const cancel = task.evaluation_criteria.actions.find((a: any) => a.name === "cancel_pending_order");
  const db = structuredClone(BASE_DB), performed: Array<{ name: string; args: any }> = [];
  const read = await runRetailCall({ name: "retail__get_order_details", arguments: JSON.stringify({ order_id: cancel.arguments.order_id }) }, db, performed);
  must(read.success && read.output === JSON.stringify(applyRetailAction(structuredClone(BASE_DB), "get_order_details", { order_id: cancel.arguments.order_id })), show(read).slice(0, 200));
  must(db.orders[cancel.arguments.order_id].status === "pending", "the order is not pending before the write");
  const write = await runRetailCall({ name: "retail__cancel_pending_order", arguments: JSON.stringify(cancel.arguments) }, db, performed);
  must(write.success, show(write));
  must(db.orders[cancel.arguments.order_id].status === "cancelled", `the write did not reach the task's database: ${db.orders[cancel.arguments.order_id].status}`);
  must(BASE_DB.orders[cancel.arguments.order_id].status === "pending", "the base database was written");
  must(show(performed.map((p) => p.name)) === show(["get_order_details", "cancel_pending_order"]) && show(performed[1]!.args) === show(cancel.arguments), show(performed));
});

await check("a refused call is answered with the mounted tool's wording, `<name>: <message>`, and still logged as attempted", async () => {
  const db = structuredClone(BASE_DB), performed: Array<{ name: string; args: any }> = [];
  const r = await runRetailCall({ name: "retail__get_order_details", arguments: '{"order_id":"W0000000"}' }, db, performed);
  must(!r.success && r.error === "retail__get_order_details: Order not found", show(r));
  must(performed.length === 1, show(performed));
  const other = await runRetailCall({ name: "tools__search", arguments: "{}" }, db, performed);
  must(!other.success && /unavailable/.test(other.error) && performed.length === 1, show(other));
});

await check("the customer both runners simulate: guidelines then scenario, and the endings its reply can name", () => {
  const task = { user_scenario: { instructions: { task_instructions: "terse", reason_for_call: "cancel", known_info: "email", unknown_info: "id" } } };
  must(simSystem(task, "G") === "G\n\n# Your scenario\nStyle: terse\nWhy you are contacting support: cancel\nWhat you know: email\nWhat you do NOT know: id", show(simSystem(task, "G")));
  must(simEnding({ text: "ok ###TRANSFER###" }) === "transfer" && simEnding({ text: " ", finishReason: "length" }) === "sim_empty (length)" && simEnding({ text: "hi" }) === null, "endings");
  must(show(SIM) === '{"maxTokens":8192,"reasoning":"low"}', show(SIM));
});

await check("the series' constants, as the `/bench` runner has always run them: 14 customer turns, the opening line, the three stop tags", () => {
  must(MAX_TURNS === 14, `MAX_TURNS is ${MAX_TURNS}`);
  must(OPENING === "Hi! How can I help you today?", show(OPENING));
  for (const [tag, ended] of [["###STOP###", "stop"], ["###TRANSFER###", "transfer"], ["###OUT-OF-SCOPE###", "out-of-scope"]]) {
    must(simEnding({ text: `Bye. ${tag}` }) === ended, `${tag}: ${simEnding({ text: `Bye. ${tag}` })}`);
  }
  for (const other of ["###DONE###", "###END###", "STOP", "###stop###"]) must(simEnding({ text: `Bye. ${other}` }) === null, `${other} ended the conversation`);
});

// ---- decisions ------------------------------------------------------------------

await check("stream: a final answer's item, then its turn's completion, is the answer; a turn at or before `seen` is not", () => {
  const before = wire([]), during = wire([user(1, "hi")], { running: true }), after = wire(T1);
  const events = [...between(before, during), ...between(during, after)];
  const finals = new Map();
  const decided = events.map((e) => decideFromEvent(e, -1, finals)).filter(Boolean);
  must(decided.length === 1 && decided[0]!.kind === "answer" && (decided[0] as any).text === "Hello" && (decided[0] as any).seen === 4, show(decided));
  // The same stream after that answer was taken: nothing.
  const again = events.map((e) => decideFromEvent(e, 4, new Map())).filter(Boolean);
  must(again.length === 0, show(again));
});

await check("stream: requires_action asks for the calls not yet answered; a failed turn is its error", () => {
  const pending = [{ call_id: "c1", name: "retail__get_user_details", arguments: '{"user_id":"u"}', turn_id: "turn_1" }];
  const asked = between(wire([user(1, "hi")], { running: true }), wire(T1.slice(0, 2), { pending }));
  const d = asked.map((e) => decideFromEvent(e, -1, new Map())).filter(Boolean);
  must(d.length === 1 && d[0]!.kind === "actions" && show((d[0] as any).calls.map((c: any) => c.call_id)) === '["c1"]', show(d));
  must(asked.map((e) => decideFromEvent(e, -1, new Map(), new Set(["c1"]))).filter(Boolean).length === 0, "an answered call was asked for again");
  const f = between(wire([user(1, "hi")], { running: true }), wire([user(1, "hi"), failed(2)])).map((e) => decideFromEvent(e, -1, new Map())).filter(Boolean);
  must(f.length === 1 && f[0]!.kind === "failed" && /provider said no/.test((f[0] as any).message), show(f));
});

await check("status read: the latest turn's answer once, the calls asked for, a failure — never the previous turn's answer", () => {
  must(show(decideFromSnapshot(snap(wire(T1)), -1)) === show({ kind: "answer", text: "Hello", seen: 4 }), show(decideFromSnapshot(snap(wire(T1)), -1)));
  // A new message is in, the turn has not run: the previous answer is still there and must not come back.
  must(decideFromSnapshot(snap(wire([...T1, user(5, "cancel")])), 4) === null, "the previous turn's answer was taken again");
  must(decideFromSnapshot(snap(wire(T1)), 4) === null, "an answer at the cursor was taken again");
  const pending = [{ call_id: "c2", name: "retail__cancel_pending_order", arguments: "{}", turn_id: "turn_5" }];
  const d = decideFromSnapshot(snap(wire([...T1, ...T2.slice(0, 2)], { pending })), 4);
  must(d?.kind === "actions" && d.calls[0]!.call_id === "c2", show(d));
  must(decideFromSnapshot(snap(wire([...T1, ...T2.slice(0, 2)], { pending })), 4, new Set(["c2"])) === null, "an answered call was asked for again");
  const f = decideFromSnapshot(snap(wire([...T1, user(5, "x"), failed(6)])), 4);
  must(f?.kind === "failed" && f.seen > 5, show(f));
  // Completed with no text is not an answer, as on the `/bench` socket.
  must(decideFromSnapshot(snap(wire([user(1, "hi"), { ...said(2, ""), message: { ...said(2, "").message, content: [] } }])), -1) === null, "an empty reply was an answer");
});

// ---- the wait ---------------------------------------------------------------------

/** A stream of `events`, then (when `endAfter`) its end; `close` ends it too. */
function stream(events: SessionEvent[], endAfter = false) {
  let closed = false;
  return {
    closed: () => closed,
    open: async () => ({
      close: () => { closed = true; },
      events: (async function* () {
        for (const e of events) { await new Promise((r) => setTimeout(r, 5)); if (closed) return; yield e; }
        if (endAfter) return;
        while (!closed) await new Promise((r) => setTimeout(r, 5));
      })(),
    }),
  };
}
function waitDeps(open: TurnWaitDeps["open"], snapshot: TurnWaitDeps["snapshot"], extra: Partial<TurnWaitDeps> = {}) {
  const delivered: Delivered = { push: 0, poll: 0, pollAnswered: 0, pollFailed: 0, dropped: 0 };
  const deps: TurnWaitDeps = { open, snapshot, count: (w) => { delivered[w] += 1; }, deaf: () => false, lookEveryMs: 30, ...extra };
  return { deps, delivered };
}
const answerEvents = between(wire([user(1, "hi")], { running: true }), wire(T1));

await check("wait: the stream is open before the input is sent, and its answer is a push", async () => {
  const order: string[] = [];
  const s = stream(answerEvents);
  const { deps, delivered } = waitDeps(async () => { order.push("open"); return s.open(); }, async () => snap(wire([user(1, "hi")], { running: true })), { lookEveryMs: 10_000 });
  const d = await waitForTurn(-1, Date.now() + 5_000, async () => { order.push("start"); }, deps);
  must(d?.kind === "answer" && d.text === "Hello", show(d));
  must(show(order) === '["open","start"]', show(order));
  must(delivered.push === 1 && delivered.poll === 0 && delivered.dropped === 0 && s.closed(), show(delivered));
});

await check("wait: a stream that ends early is a drop, and the answer it missed is found by the status read", async () => {
  let opened = 0;
  const { deps, delivered } = waitDeps(async () => { opened += 1; return stream([], true).open(); }, async () => snap(wire(T1)));
  const d = await waitForTurn(-1, Date.now() + 5_000, async () => {}, deps);
  must(d?.kind === "answer" && d.text === "Hello", show(d));
  must(delivered.dropped >= 1 && delivered.poll === 1 && delivered.push === 0 && opened >= 2, show({ delivered, opened }));
});

await check("wait: deaf to the stream, the stream's answer is dropped and the status read brings it; deaf to both, the deadline comes", async () => {
  const one = waitDeps(stream(answerEvents).open, async () => snap(wire(T1)), { deaf: (to) => to === "socket" });
  const d = await waitForTurn(-1, Date.now() + 5_000, null, one.deps);
  must(d?.kind === "answer" && one.delivered.push === 0 && one.delivered.poll === 1, show({ d, delivered: one.delivered }));
  const both = waitDeps(stream(answerEvents).open, async () => snap(wire(T1)), { deaf: () => true });
  const t = Date.now();
  must(await waitForTurn(-1, t + 200, null, both.deps) === null && Date.now() - t >= 190, "a deaf wait did not run to its deadline");
  must(both.delivered.push === 0 && both.delivered.poll === 0 && both.delivered.pollAnswered > 0, show(both.delivered));
});

await check("wait: a status read that fails counts as failed and decides nothing", async () => {
  const { deps, delivered } = waitDeps(stream([]).open, async () => { throw new Error("502"); });
  must(await waitForTurn(-1, Date.now() + 150, null, deps) === null, "decided without evidence");
  must(delivered.pollFailed > 0 && delivered.pollAnswered === 0, show(delivered));
});

// ---- the stall evidence -------------------------------------------------------------

await check("deadline: each state of the session is named by the `/bench` runner's criterion", async () => {
  const at = async (w: WireSnapshot | null, seen: number) => (await apiStallAtDeadline(async () => { if (!w) throw new Error("x"); return snap(w); }, seen)).stall;
  must(await at(wire(T1), -1) === "answer_undelivered", "an answer nobody delivered");
  must(await at(wire([...T1, user(5, "x")], { running: true }), 4) === "still_running", "a running turn");
  // The session reads idle before the lane picks the input up; the turn says it has not ended.
  must(await at(wire([...T1, user(5, "x")]), 4) === "still_running", "a queued turn read as idle");
  must(await at(wire([...T1, user(5, "x"), failed(6)]), 4) === "model_failed", "a failed model call");
  must(await at(wire([...T1, user(5, "x"), { ...said(6, ""), message: { ...said(6, "").message, content: [] } }]), 4) === "idle_without_answer", "idle with no answer");
  must(await at(null, 4) === "unknown", "a failed read");
  const body = apiPollBody(snap(wire([...T1, ...T2])));
  must(show(body.last) === show({ message: 5, response: 8, failed: -1 }) && body.answer === "Could not" && body.status === "idle", show(body));
  must(show(body.tail) === show([4, 5, 6, 7, 8].map((seq) => ({ seq, kind: seq === 5 ? "message" : seq === 7 ? "tool.result" : "model.response" }))), show(body.tail));
});

// ---- row figures ----------------------------------------------------------------------

await check("row: usage from the turns, calls as assistant entries, byTool and toolErrors from the results — the same as `/bench/result` over the entries", () => {
  const w = wire([...T1, ...T2]);
  const f = rowFigures(w.items as any, w.turns as any);
  must(show(f.usage) === show({ prompt: 80, completion: 12, calls: 4 }), show(f.usage));
  must(show(f.byTool) === show({ retail__get_user_details: 1, retail__cancel_pending_order: 1 }) && f.toolErrors === 1, show(f));
  const exact = exactFigures(entriesToEvents([...T1, ...T2] as any) as any);
  must(show(exact.usage) === show(f.usage) && show(exact.byTool) === show(f.byTool) && exact.toolErrors === f.toolErrors, show({ exact, f }));
});

await check("kinds: from the operator's transcript, with each paused call's placeholder off the branch and runs that never called the model left out", () => {
  // A paused call leaves its placeholder; the resumed branch carries the real result (src/runtime/client-calls.ts).
  const entries = [user(1, "hi"), calls(2, ["c1", "retail__get_user_details", {}]), result(3, "c1", "retail__get_user_details", CLIENT_PENDING, true),
    result(4, "c1", "retail__get_user_details", "{}"), said(5, "Hello")];
  const events = [...entriesToEvents(entries as any), { sequence: 6, kind: "model.failed", payload: { error: "x", operationId: "op1", at: 6 } }];
  must(show(kindsOf(events as any)) === show({ message: 1, "model.response": 2, "tool.result": 1 }), show(kindsOf(events as any)));
  must(exactFigures(events as any).toolErrors === 0, "the placeholder counted as a tool error");
});

// ---- the provider -----------------------------------------------------------------------

const MODELS: ModelsList = {
  providers: [{ id: "deepseek", endpoint: "api.deepseek.com" }, { id: "cloudflare", endpoint: "gateway.ai.cloudflare.com" }],
  options: [{ id: "deepseek-flash", provider: "deepseek", model: "deepseek-flash" }, { id: "gpt-5.6-luna", provider: "cloudflare", model: "openai/gpt-5.6-luna" }],
};
const ledger = (...models: string[]) => ({ rows: [...models.map((m) => ({ resource: "model.tokens", dimensions: { model: m, kind: "input" } })), { resource: "tool.call", dimensions: { tool: "x", outcome: "succeeded" } }] });

await check("provider: the ledger's model, at the endpoint of the provider the agent's model names", () => {
  must(show(ledgerModels(ledger("openai/gpt-5.6-luna", "openai/gpt-5.6-luna"))) === '["openai/gpt-5.6-luna"]', "ledger models");
  must(show(taskProvider("gpt-5.6-luna", ["openai/gpt-5.6-luna"], MODELS)) === show({ ok: true, provider: { name: "openai/gpt-5.6-luna", endpoint: "gateway.ai.cloudflare.com" } }), "luna");
  must(show(taskProvider("deepseek-flash", ["deepseek-flash"], MODELS)) === show({ ok: true, provider: { name: "deepseek-flash", endpoint: "api.deepseek.com" } }), "flash");
  // An admin's model reads as <provider>/<model> (cf/src/agents-api/model.ts modelName).
  must(show(taskProvider("deepseek/deepseek-v4-pro", ["deepseek-v4-pro"], MODELS)) === show({ ok: true, provider: { name: "deepseek-v4-pro", endpoint: "api.deepseek.com" } }), "admin's");
  must(show(taskProvider("gpt-5.6-luna", [], MODELS, 0)) === show({ ok: true, provider: null }), "no model call");
});

await check("provider: refused when the ledger disagrees with the agent, holds two models, is empty after model calls, or the agent's model names nothing listed", () => {
  const luna = taskProvider("gpt-5.6-luna", ["deepseek-flash"], MODELS);
  must(!luna.ok && /gpt-5.6-luna.*deepseek-flash/.test(luna.why), show(luna));
  const two = taskProvider("deepseek-flash", ["deepseek-flash", "openai/gpt-5.6-luna"], MODELS);
  must(!two.ok && /2 models/.test(two.why), show(two));
  // Calls made and nothing in the ledger: usage not arrived or lost, never "no model".
  const empty = taskProvider("gpt-5.6-luna", [], MODELS, 3);
  must(!empty.ok && /3 model call/.test(empty.why), show(empty));
  const unknown = taskProvider("gpt-6", ["gpt-6"], MODELS);
  must(!unknown.ok, show(unknown));
  must(!taskProvider("gpt-5.6-luna", ["openai/gpt-5.6-luna"], { providers: MODELS.providers }).ok, "an option id resolved with no options listed");
});

// ---- the record --------------------------------------------------------------------------

/** The `/bench` record's run-level fields (bench/tau2/cf.ts `recordRun`), in its order, and `written` from recordRun. */
const BENCH_FIELDS = ["bench", "base", "build", "driver", "object", "engine", "objects", "model", "wait", "sim", "provider",
  "tasks", "trials", "order", "startedAt", "results", "passAllKTrials", "passFirstKTrials", "tools", "endingsAllRows",
  "failingRowsByEndingAndCause", "activity", "written"];
const BENCH_ROW = ["id", "taskId", "engine", "object", "activity", "reward", "dbMatch", "actionMatch", "ended", "stall", "stallWhy",
  "simLast", "delivered", "turns", "simCalls", "usage", "kinds", "byTool", "toolErrors", "seconds", "expectedWrites", "performedWrites",
  "expectedArgs", "performedArgs", "trial"];
const act = (ms: number) => ({ activeMs: ms, summedMs: ms, pollMs: 0, invocations: 1, spanMs: ms, byKind: [{ kind: "step", n: 1, ms }] });
const row = (id: number, trial: number, reward: number, provider: unknown) => ({
  id, taskId: `sess_${id}`, agentId: `agent_${id}`, sessionId: `sess_${id}`, engine: "pi085", object: `api:bench/agent_${id}`,
  activity: act(100), provider, reward, dbMatch: !!reward, actionMatch: !!reward, ended: reward ? "stop" : "transfer",
  stall: undefined, stallWhy: undefined, simLast: "Thanks ###STOP###", delivered: { push: 1, poll: 0, pollAnswered: 0, pollFailed: 0, dropped: 0 },
  turns: 2, simCalls: 3, usage: { prompt: 1, completion: 1, calls: 1 }, kinds: { message: 1 }, byTool: { retail__x: 1 }, toolErrors: 0,
  seconds: 5, expectedWrites: [], performedWrites: [], expectedArgs: [], performedArgs: [], trial,
});
const LUNA = { name: "openai/gpt-5.6-luna", endpoint: "gateway.ai.cloudflare.com" };
const input = (rows: any[]) => ({
  base: "http://w", build: "abc1234", driver: { commit: "def5678", dirty: false }, tenantId: "bench", owner: "tau2-api",
  modelRequested: "gpt-5.6-luna", sim: { maxTokens: 8192, reasoning: "low" }, simId: "api.deepseek.com/deepseek-flash", tasks: [0, 1], trials: 2, order: "trial-major",
  startedAt: "2026-10-05T00:00:00.000Z", results: rows,
});

await check("record: the `/bench` record's fields, plus runnerMethod and modelRequested; model is what ran, from the rows' provider", () => {
  const built = apiRunRecord(input([row(0, 1, 1, LUNA), row(1, 1, 0, LUNA), row(0, 2, 1, null), row(1, 2, 1, LUNA)]));
  must(built.ok, show(built));
  const tree = mkdtempSync(join(tmpdir(), "bench-tau2-api-"));
  try {
    const run = beginRun("tau2", "api-gpt-5.6-luna", join(tree, "report/runs/"));
    recordRun(run, built.body);
    const rec = JSON.parse(readFileSync(run.json, "utf8"));
    const added = Object.keys(rec).filter((k) => !BENCH_FIELDS.includes(k));
    const missing = BENCH_FIELDS.filter((k) => !(k in rec));
    must(show(added) === '["runnerMethod","modelRequested"]' && missing.length === 0, `added ${show(added)}, missing ${show(missing)}`);
    must(rec.runnerMethod === "agents-api" && runnerMethodOf(rec) === "agents-api", rec.runnerMethod);
    must(rec.model === LUNA.name && rec.modelRequested === "gpt-5.6-luna" && show(rec.provider) === show(LUNA), show([rec.model, rec.modelRequested, rec.provider]));
    must(rec.wait === "sse" && rec.objects === "per-task" && rec.object === "api:bench/tau2-api" && rec.engine === "pi085", show([rec.wait, rec.objects, rec.object, rec.engine]));
    must(rec.activity.objects === 4 && rec.activity.activeMs === 400 && rec.activity.pollMs === 0, show(rec.activity));
    must(rec.passAllKTrials && rec.passFirstKTrials && rec.endingsAllRows.stop === 3 && rec.tools.retail__x === 4, show(rec).slice(0, 300));
    // Each row: the `/bench` row's fields, plus the agent, the session and the provider it ran on.
    const rowAdded = Object.keys(rec.results[0]).filter((k) => !BENCH_ROW.includes(k));
    must(show(rowAdded.sort()) === '["agentId","provider","sessionId"]' && BENCH_ROW.filter((k) => k !== "stall" && k !== "stallWhy").every((k) => k in rec.results[0]), show(rowAdded));
  } finally { rmSync(tree, { recursive: true, force: true }); }
});

await check("record: none when two rows ran on different providers, or when rows reached the agent and none has a provider; a record without the field reads as the `/bench` method", () => {
  const DS = { name: "deepseek-flash", endpoint: "api.deepseek.com" };
  const built = apiRunRecord(input([row(0, 1, 1, LUNA), row(1, 1, 1, DS)]));
  must(!built.ok && /2 providers/.test(built.why), show(built));
  must(!runProvider([{ provider: LUNA }, { provider: { ...LUNA, endpoint: "elsewhere" } }]).ok, "the same model at two endpoints agreed");
  // Rows that reached the agent and no provider anywhere: the model never answered, and that is no round.
  const failed = (id: number) => ({ ...row(id, 1, 0, null), ended: "model: 401: the gateway refused the token", turns: 0, usage: { prompt: 0, completion: 0, calls: 0 } });
  const none = apiRunRecord(input([failed(0), failed(1)]));
  must(!none.ok && /none has a provider/.test(none.why), show(none));
  must(!apiRunRecord(input([{ ...row(0, 1, 0, null), ended: "transfer", turns: 2 }])).ok, "a row with turns and no provider was recorded");
  // A run whose customer ended every task before the agent spoke has no provider to give, and is recorded.
  must(apiRunRecord(input([{ ...row(0, 1, 0, null), ended: "stop", turns: 0 }])).ok, "a run that never reached the agent was refused");
  must(runnerMethodOf({}) === "bench" && runnerMethodOf({ runnerMethod: "agents-api" }) === "agents-api", "runnerMethodOf");
});

await check("record: none when the run never got going (a simulator that failed every row), yet a customer that ends before the agent speaks is recorded", () => {
  // The simulator speaks first, so an empty or refused simulator key fails each row at its first call:
  // `error: …`, 0 turns, 0 simulator calls, no provider. That is no round of the agent.
  const simFailed = (id: number) => ({ ...row(id, 1, 0, null), ended: "error: 401 Unauthorized", turns: 0, simCalls: 0,
    usage: {}, kinds: {}, byTool: {}, activity: undefined });
  const none = apiRunRecord(input([simFailed(0), simFailed(1)]));
  must(!none.ok && /got going/.test(none.why), show(none));
  // Either half alone is enough: 0 simulator calls without an error, or an error after a simulator call.
  must(!apiRunRecord(input([{ ...simFailed(0), ended: "max_turns" }, { ...simFailed(1), simCalls: 1 }])).ok, "a run with no simulator answer was recorded");
  // The customer ended every task at its first line: it called the simulator, so the run did get going.
  const early = apiRunRecord(input([{ ...row(0, 1, 0, null), ended: "stop", turns: 0, simCalls: 1 }, { ...row(1, 1, 0, null), ended: "stop", turns: 0, simCalls: 1 }]));
  must(early.ok, show(early));
  // One row that ran is enough for the round to stand beside rows the simulator failed.
  must(apiRunRecord(input([simFailed(0), row(1, 1, 1, LUNA)])).ok, "a run with one good row was refused");
});

await check("record: `sim` carries the simulator's id beside its settings", () => {
  const built = apiRunRecord(input([row(0, 1, 1, LUNA)]));
  must(built.ok, show(built));
  const sim = (built.body as any).sim;
  must(show(sim) === show({ maxTokens: 8192, reasoning: "low", id: "api.deepseek.com/deepseek-flash" }), show(sim));
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
