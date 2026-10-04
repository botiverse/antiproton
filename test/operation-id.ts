/**
 * `PluginContext.operationId` (#728): the gateway's id for the operation a plugin's context serves.
 *
 * The same id for every step of one operation — its invoke, the invoke an approval runs, the resume and the cancel
 * of a question it asked (and of the questions after it), the poll and the cancel of work it backgrounded — and a
 * different one for every new model call. A run_js program's calls get ids derived from `${toolCallId}:${n}`. Nothing a
 * model or a program writes reaches it.
 *
 * The runtime rows drive the real `AgentRuntime` (cf/src/runtime.ts) on both engines over node:sqlite, with the model
 * scripted through the queue as the worker answers it, and a plugin that records the id it was handed — the harness
 * test/caller-context.ts uses. The run_js rows run `runJsTool` on both executors and through both engines' tool
 * wrappers over a host that filters options as the production host does (`hostCallOpts`).
 */
import { AgentRuntime, hostCallOpts } from "../cf/src/runtime.ts";
import { fromResponse, toRequest } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { backgrounded, interrupt, type Plugin } from "../src/plugins/types.ts";
import { DynamicWorkerExecutor } from "../src/runtime/dynamic-worker-executor.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { ToolGateway, type CallContext } from "../src/runtime/gateway.ts";
import { bridgeTools, qualifyMountedTools, runJsTool } from "../src/runtime/pi-tools.ts";
import { durableTool } from "../src/runtime/durable-tools.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { createHash } from "node:crypto";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

type Seen = { step: string; op: string | undefined; args?: unknown };

/** A plugin that records the operation id every step of it was handed. */
function probe(seen: Seen[]): Plugin {
  const at = (step: string, context: { operationId?: string }, args?: unknown) =>
    seen.push({ step, op: context.operationId, ...(args === undefined ? {} : { args }) });
  return {
    id: "probe", version: "1.0.0",
    tools: [
      { name: "see", description: "Read.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "none" },
      { name: "act", description: "Write.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" },
      { name: "ask", description: "Asks first.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" },
      { name: "twice", description: "Asks twice.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" },
      { name: "long", description: "Backgrounds.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" },
      { name: "garbled", description: "Asks in a shape nobody can answer.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" },
    ] as never,
    async invoke(tool, args, context) {
      at(tool, context, args);
      if (tool === "ask" || tool === "twice") return interrupt({ question: "go on?", answer: { choices: ["yes", "no"] }, state: { round: 1 } });
      if (tool === "long") return backgrounded({ job: seen.length }, "still going");
      // An answer spec no answer can meet: the gateway cancels the question at once (`#run`) and fails the call.
      if (tool === "garbled") return interrupt({ question: "which?", answer: { kind: "bogus" } as never, state: { round: 1 } });
      return { ok: tool };
    },
    interrupts: {
      async resume(tool, state, answer, context) {
        const round = (state as { round: number }).round;
        at(`${tool}:resume${round}`, context);
        if (tool === "twice" && round === 1) return interrupt({ question: "really?", answer: { choices: ["yes", "no"] }, state: { round: 2 } });
        return { answered: answer };
      },
      async cancel(tool, _state, context) { at(`${tool}:cancel`, context); },
    },
    background: {
      async poll(_handle, context) { at("long:poll", context); return { done: false as const }; },
      async cancel(_handle, context) { at("long:cancel", context); },
    },
  };
}

const isOpId = (x: unknown) => typeof x === "string" && /^op_[0-9a-f]{20}$/.test(x);
/** The gateway's derivation for a keyed call (src/runtime/gateway.ts `#invoke`), restated: the test pins it. */
const keyed = (tenantId: string, taskId: string, key: string) =>
  `op_${createHash("sha256").update(`${tenantId}|${taskId}|${key}`).digest("hex").slice(0, 20)}`;

// ---- the runtime, driven as the worker drives it ------------------------------------------------------------

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage });
const call = (id: string, name: string, args: unknown): ModelResponse =>
  ({ text: "", finishReason: "tool_calls", truncated: false, usage, toolCalls: [{ id, name, arguments: args as never }] });

type Rt = { rt: AgentRuntime; sent: string[]; answered: Set<string> };

function runtime(host: ReturnType<typeof sqliteHost>, plugin: Plugin): Rt {
  const sent: string[] = [];
  const standIn = standInLoader();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, extraPlugins: [plugin],
    loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "operator-key", model: "m1" },
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  return { rt, sent, answered: new Set() };
}

async function world(engine: "pi085" | "pd") {
  const host = sqliteHost();
  if (engine === "pd") {
    const ap = new ApStore(host, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const seen: Seen[] = [];
  const plugin = probe(seen);
  const r = runtime(host, plugin);
  await r.rt.ready();
  await r.rt.store.createAgent("t", "a");
  await r.rt.store.setPluginChoice("t", "a", "probe", "enable");
  const added = await r.rt.addMount("t", "a", { alias: "probe", plugin: "probe", config: {} });
  must(added.ok, `the mount was refused: ${show(added)}`);
  await r.rt.bindOperatorModel("t", "a");
  return { host, seen, r };
}

type Reply = ModelResponse | ((req: ReturnType<typeof toRequest>) => ModelResponse);
/** One user message, the model answered by `script` in order; returns when idle, or with `leaveHeld` once the script is used up. */
async function turn(r: Rt, text: string, script: Reply[], o: { leaveHeld?: boolean } = {}) {
  let at = 0;
  await r.rt.postMessage("t", "a", text, "prompt", "main");
  for (let guard = 0; guard < 200; guard++) {
    const out = await r.rt.step("t", "a") as { wakeInMs?: number | null };
    const pending = r.sent.filter((id) => !r.answered.has(id));
    for (const id of pending) {
      r.answered.add(id);
      const job = await r.rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] } | null;
      if (!job) continue;
      const req = toRequest(job.context);
      const next = script[at++];
      const res = typeof next === "function" ? next(req) : next;
      must(res, `the model was called more often than scripted (${at}); last: ${show(req.messages.slice(-1)).slice(0, 300)}`);
      await r.rt.deliverAnswer("t", "a", id, fromResponse(res!, { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
    }
    if (pending.length) continue;
    if (at >= script.length && (o.leaveHeld || out?.wakeInMs === null || out?.wakeInMs === undefined)) return;
    await sleep(Math.min(out?.wakeInMs ?? 20, 50));
  }
  throw new Error(`the turn did not settle; ${at} of ${script.length} answered`);
}

const lastToolJson = (req: ReturnType<typeof toRequest>): Record<string, any> => {
  const m = [...req.messages].reverse().find((x) => x.role === "tool");
  must(m, "no tool result");
  return JSON.parse(String(m!.content));
};
const resume = (id: string) => (req: ReturnType<typeof toRequest>) => call(id, "resume", { token: lastToolJson(req).token, answer: "yes" });
const stepsOf = (seen: Seen[], step: string) => seen.filter((s) => s.step === step);

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: two model calls get two ids, each the operation the gateway recorded; arguments cannot name one`, async () => {
    const w = await world(engine);
    try {
      await turn(w.r, "look", [call("c1", "probe__see", {}), say("done")]);
      await turn(w.r, "look again", [call("c2", "probe__see", { operationId: "op_forged000000000000" }), say("done")]);
      const ops = stepsOf(w.seen, "see").map((s) => s.op);
      must(ops.length === 2 && ops.every(isOpId), `ids: ${show(w.seen)}`);
      must(ops[0] !== ops[1], `two model calls shared an id: ${show(ops)}`);
      for (const op of ops) {
        const row = await w.r.rt.store.getOperation("t", op!);
        must(row?.tool === "probe.see" && row.status === "succeeded", `${op} is not the call's operation: ${show(row)}`);
      }
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: an approved call runs under the id it was held under`, async () => {
    const w = await world(engine);
    try {
      await turn(w.r, "act", [call("c_act", "probe__act", { confirm: true }), say("held")]);
      must(stepsOf(w.seen, "act").length === 0, `the held call ran: ${show(w.seen)}`);
      const [card] = await w.r.rt.store.listApprovals("t", "pending");
      must(card && isOpId(card.operationId), `no card: ${show(card)}`);
      const ok = await w.r.rt.gateway().applyApproval("t", card!.operationId, "approved", "tygg");
      must(ok.ok && ok.executed, `approval: ${show(ok)}`);
      const ran = stepsOf(w.seen, "act");
      must(ran.length === 1 && ran[0]!.op === card!.operationId, `the replay ran under ${show(ran)}, held under ${card!.operationId}`);
      // An approved call that asks a question has nobody to ask, so the gateway cancels it: under the same id.
      await turn(w.r, "ask", [call("c_ask", "probe__ask", { confirm: true }), say("held")]);
      const [card2] = await w.r.rt.store.listApprovals("t", "pending");
      must(card2 && card2.operationId !== card!.operationId, `the second card: ${show(card2)}`);
      const ok2 = await w.r.rt.gateway().applyApproval("t", card2!.operationId, "approved", "tygg");
      must(ok2.ok && ok2.executed, `approval: ${show(ok2)}`);
      const asked = stepsOf(w.seen, "ask").map((s) => s.op), dropped = stepsOf(w.seen, "ask:cancel").map((s) => s.op);
      must(show(asked) === show([card2!.operationId]) && show(dropped) === show([card2!.operationId]), `ask ${show(asked)}, cancel ${show(dropped)}, held under ${card2!.operationId}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a question's resume, the next question's resume, and a dropped question's cancel carry the asking call's id`, async () => {
    const w = await world(engine);
    try {
      await turn(w.r, "twice", [call("c_tw", "probe__twice", {}), resume("c_r1"), resume("c_r2"), say("done")]);
      const asked = stepsOf(w.seen, "twice")[0]?.op;
      const r1 = stepsOf(w.seen, "twice:resume1")[0]?.op;
      const r2 = stepsOf(w.seen, "twice:resume2")[0]?.op;
      must(isOpId(asked) && r1 === asked && r2 === asked, `call ${asked}, resume ${r1}, second resume ${r2}`);
      // Each resume is still recorded as a step of its own: its row is not the asking call's.
      const rows = w.host.sql.exec("SELECT operation_id FROM operations WHERE tool = 'probe.twice'").toArray().map((x) => String(x.operation_id));
      must(rows.length === 3 && new Set(rows).size === 3 && rows.includes(asked!), `the rows: ${show(rows)}`);

      // Asked and never answered: the hold is dropped and the plugin's cancel told the asking call's id.
      await turn(w.r, "ask", [call("c_ask", "probe__ask", {}), say("later")], { leaveHeld: true });
      must(w.r.rt.runJsContinuations.discardAll() === 1, "control: no question was held");
      for (let i = 0; i < 100 && stepsOf(w.seen, "ask:cancel").length === 0; i++) await sleep(5);
      const ask = stepsOf(w.seen, "ask")[0]?.op;
      const cancelled = stepsOf(w.seen, "ask:cancel")[0]?.op;
      must(isOpId(ask) && cancelled === ask, `call ${ask}, cancel ${cancelled}`);
      must(ask !== asked, `two model calls shared an id: ${ask}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: the model cancelling a question with resume tells the plugin the asking call's id`, async () => {
    const w = await world(engine);
    try {
      await turn(w.r, "ask", [
        call("c_ask", "probe__ask", {}),
        (req) => call("c_x", "resume", { token: lastToolJson(req).token, cancel: true }),
        say("dropped"),
      ]);
      const ask = stepsOf(w.seen, "ask")[0]?.op;
      const cancelled = stepsOf(w.seen, "ask:cancel")[0]?.op;
      must(isOpId(ask) && cancelled === ask, `call ${ask}, cancel ${cancelled}: ${show(w.seen)}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a background job's poll and both of its cancels (the jobs tool, a session cancel) carry the starting call's id`, async () => {
    const w = await world(engine);
    try {
      await turn(w.r, "start", [call("c_l1", "probe__long", {}), say("started")], { leaveHeld: true });
      const started = stepsOf(w.seen, "long")[0]?.op;
      must(isOpId(started), `started: ${show(w.seen)}`);
      w.host.sql.exec("UPDATE background_jobs SET next_poll_at = 0");
      await w.r.rt.step("t", "a");
      const polled = stepsOf(w.seen, "long:poll").map((s) => s.op);
      must(polled.length >= 1 && polled.every((op) => op === started), `polls ${show(polled)}, started ${started}`);
      await turn(w.r, "stop it", [call("c_j", "jobs", { action: "cancel", job: started }), say("stopped")], { leaveHeld: true });
      const viaTool = stepsOf(w.seen, "long:cancel").map((s) => s.op);
      must(viaTool.length === 1 && viaTool[0] === started, `jobs cancel ${show(viaTool)}, started ${started}`);

      await turn(w.r, "start another", [call("c_l2", "probe__long", {}), say("started")], { leaveHeld: true });
      const second = stepsOf(w.seen, "long")[1]?.op;
      must(isOpId(second) && second !== started, `second ${second}, first ${started}`);
      await w.r.rt.cancelSession("t", "a");
      const all = stepsOf(w.seen, "long:cancel").map((s) => s.op);
      must(all.length === 2 && all[1] === second, `session cancel ${show(all)}, second ${second}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a job refused over the cap is cancelled under its own call's id`, async () => {
    const w = await world(engine);
    try {
      await turn(w.r, "start four", [
        call("c_l1", "probe__long", {}), call("c_l2", "probe__long", {}), call("c_l3", "probe__long", {}), call("c_l4", "probe__long", {}),
        say("started"),
      ], { leaveHeld: true });
      const started = stepsOf(w.seen, "long").map((s) => s.op);
      must(started.length === 4 && new Set(started).size === 4 && started.every(isOpId), `started: ${show(started)}`);
      const cancelled = stepsOf(w.seen, "long:cancel").map((s) => s.op);
      must(show(cancelled) === show([started[3]]), `the over-cap cancel ${show(cancelled)}, the fourth call ${started[3]}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a job past the time ceiling is cancelled under the starting call's id`, async () => {
    const w = await world(engine);
    try {
      await turn(w.r, "start", [call("c_l1", "probe__long", {}), say("started")], { leaveHeld: true });
      const started = stepsOf(w.seen, "long")[0]?.op;
      must(isOpId(started), `started: ${show(w.seen)}`);
      w.host.sql.exec("UPDATE background_jobs SET created_at = 0, next_poll_at = 0");
      await w.r.rt.step("t", "a");
      const cancelled = stepsOf(w.seen, "long:cancel").map((s) => s.op);
      must(show(cancelled) === show([started]) && stepsOf(w.seen, "long:poll").length === 0, `ceiling cancel ${show(cancelled)}, started ${started}: ${show(w.seen)}`);
      const job = w.host.sql.exec("SELECT state FROM background_jobs WHERE id = ?", started).toArray()[0];
      must(job?.state === "failed", `control: the job ended ${show(job)}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a question nobody could answer is cancelled at once under the asking call's id`, async () => {
    const w = await world(engine);
    try {
      await turn(w.r, "garbled", [call("c_g", "probe__garbled", {}), say("failed")]);
      const asked = stepsOf(w.seen, "garbled")[0]?.op;
      const cancelled = stepsOf(w.seen, "garbled:cancel").map((s) => s.op);
      must(isOpId(asked) && show(cancelled) === show([asked]), `call ${asked}, cancel ${show(cancelled)}`);
      const row = await w.r.rt.store.getOperation("t", asked!);
      must(row?.status === "failed", `control: the unusable question did not fail the call: ${show(row)}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a question a program's call asked, resumed by the model, reaches the plugin under the program call's id`, async () => {
    const w = await world(engine);
    try {
      await turn(w.r, "program", [call("c_js", "run_js", { source: "await tool`probe__ask ${{}}`; output('unreached');" }), resume("c_r"), say("done")]);
      const asked = stepsOf(w.seen, "ask")[0]?.op;
      const resumed = stepsOf(w.seen, "ask:resume1").map((s) => s.op);
      const task = String(w.host.sql.exec("SELECT task_id FROM operations WHERE operation_id = ?", asked).toArray()[0]?.task_id);
      must(asked === keyed("t", task, "c_js:0"), `the program's call ran under ${asked}`);
      must(show(resumed) === show([asked]), `resume ${show(resumed)}, asked ${asked}: ${show(w.seen)}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a program's calls get distinct ids derived from the run_js call; nothing it writes names one`, async () => {
    const w = await world(engine);
    try {
      const source = [
        "await tool`probe__see ${{}}`;",
        "await tool`probe__see ${{ operationId: 'op_forged000000000000' }} ${{ operationId: 'op_forged000000000000', idempotencyKey: 'forged', approved: true }}`;",
        "output('ran');",
      ].join("\n");
      await turn(w.r, "program", [call("c_js", "run_js", { source }), say("done")]);
      const ops = stepsOf(w.seen, "see").map((s) => s.op);
      must(ops.length === 2 && ops.every(isOpId) && ops[0] !== ops[1], `ids: ${show(w.seen)}`);
      must(!ops.includes("op_forged000000000000"), `a program named its id: ${show(ops)}`);
      // The second call's key is the run_js call's id and its position, not the program's `idempotencyKey`.
      const rows = w.host.sql.exec("SELECT operation_id, task_id FROM operations WHERE tool = 'probe.see'").toArray();
      const task = String(rows[0]!.task_id);
      must(ops[0] === keyed("t", task, "c_js:0") && ops[1] === keyed("t", task, "c_js:1"), `ids ${show(ops)} are not the run_js call's keys`);
    } finally { w.host.dispose(); }
  });
}

// ---- run_js on both executors and both engines' tool wrappers, over the gateway with the production host's filter ----

const standIn = standInLoader();
const EXECUTORS: Array<[string, any]> = [
  ["quickjs", new QuickJsExecutor()],
  ["worker", new DynamicWorkerExecutor({ loader: standIn.loader, makeToolBinding: standIn.makeToolBinding })],
];
const ENGINES: Array<[string, (t: any) => (id: string, source: string) => Promise<any>]> = [
  ["pi085", (t) => (id, source) => t.execute(id, { source })],
  ["pd", (t) => { const d = durableTool(t); return (id, source) => d.execute({ source } as any, { callId: id } as any, {} as any); }],
];

async function gatewayWorld() {
  const seen: Seen[] = [];
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "probe", plugin: "probe", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  const gw = new ToolGateway(store, [probe(seen)], new Set(["probe"]), { async resolve() { return null; } });
  const ctx: CallContext = { tenantId: "t", agentId: "a", taskId: "k" };
  const returned: any[] = [];
  const host = { async invoke(c: any) { const r = await gw.invoke(ctx, c.tool, c.args, hostCallOpts(c)); returned.push(r); return r; } };
  const tools = qualifyMountedTools([
    { name: "see", address: "probe.see", description: "", parameters: { type: "object" }, sideEffects: "read" } as any,
    { name: "act", address: "probe.act", description: "", parameters: { type: "object" }, sideEffects: "write" } as any,
  ]);
  return { store, gw, seen, host, tools, returned };
}

for (const [exLabel, exec] of EXECUTORS) {
  for (const [enLabel, wrap] of ENGINES) {
    await check(`${enLabel}/${exLabel}: a program's ids are \`\${toolCallId}:\${n}\`'s, distinct per call, the same when the same run_js call runs again, and unforgeable`, async () => {
      const w = await gatewayWorld();
      const run = wrap(runJsTool(exec, w.host as any, { tools: w.tools }));
      const source = [
        "await tool`probe__see ${{}}`;",
        "await tool`probe__act ${{ operationId: 'op_forged000000000000' }} ${{ operationId: 'op_forged000000000000', idempotencyKey: 'forged' }}`;",
      ].join("\n");
      await run("p1", source);
      const first = w.seen.map((s) => s.op);
      must(show(first) === show([keyed("t", "k", "p1:0"), keyed("t", "k", "p1:1")]), `p1's ids: ${show(w.seen)}`);
      // The same run_js call again: the same ids, found already begun, so the plugin is not reached a second time.
      await run("p1", source);
      must(w.seen.length === 2, `the repeat reached the plugin: ${show(w.seen)}`);
      const again = w.returned.slice(2).map((r) => r.operationId);
      must(show(again) === show(first), `the repeat's ids ${show(again)}, the first's ${show(first)}`);
      must(w.returned.slice(2).every((r) => r.error?.code === "already_attempted"), `the repeat: ${show(w.returned.slice(2))}`);
      // Another run_js call: other ids.
      await run("p2", source);
      const second = w.seen.slice(2).map((s) => s.op);
      must(second.length === 2 && second.every((op) => !first.includes(op)) && second[0] !== second[1], `p2's ids ${show(second)}, p1's ${show(first)}`);
    });
  }
}

await check("a model call through the bridge: a fresh id each call, never one the arguments carry", async () => {
  const w = await gatewayWorld();
  const [see] = bridgeTools(w.tools, w.host as any);
  await (see as any).execute("d1", { operationId: "op_forged000000000000" });
  await (see as any).execute("d1", {});
  const ops = w.seen.map((s) => s.op);
  must(ops.length === 2 && ops.every(isOpId) && ops[0] !== ops[1] && !ops.includes("op_forged000000000000"), `ids ${show(ops)}`);
});

// ---- contexts that serve no operation carry no id ---------------------------------------------------------------

await check("a context that serves no operation has no operationId: prompt, holding, release, files, receive, activity report, tool snapshot, a poll by handle alone", async () => {
  const got: Array<{ where: string; has: boolean; op: unknown }> = [];
  const note = (where: string, c: { operationId?: string }) => { got.push({ where, has: "operationId" in c, op: c.operationId }); };
  const one = { name: "x", description: "", parameters: { type: "object" }, sideEffects: "read", idempotency: "none" } as never;
  const keeper: Plugin = {
    id: "keeper", version: "1.0.0", tools: [one],
    async invoke() { return null; },
    async promptContribution(c) { note("promptContribution", c); return "keeper"; },
    holds: {
      tools: { release: "x" },
      async activity(c) { note("activity", c); return { live: null }; },
      async activities(c) { note("activities", c); return [{ live: null }]; },
      async usage(c) { note("usage", c); return []; },
      async release(c) { note("release", c); },
      files: {
        async list(c) { note("files.list", c); return { running: false }; },
        async read(c) { note("files.read", c); return { running: false }; },
      },
    },
    background: {
      async poll(_h, c) { note("poll", c); return { done: false as const }; },
      async cancel(_h, c) { note("cancel", c); },
    },
    async receive(_e, _s, c) { note("receive", c); return { deliver: false } as never; },
    async reportActivity(_e, c) { note("reportActivity", c); return { sent: 0 }; },
  };
  const lister: Plugin = {
    id: "lister", version: "1.0.0", tools: [],
    async invoke() { return null; },
    mountTools() { return []; },
    async snapshotTools(c) { note("snapshotTools", c); return { tools: [] }; },
  };
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const [alias, plugin] of [["keep", "keeper"], ["list", "lister"]] as const) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, plugin, installationId: "i", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
    });
  }
  const gw = new ToolGateway(store, [keeper, lister], new Set(["keeper", "lister"]), { async resolve() { return null; } });
  const ctx = { tenantId: "t", agentId: "a", taskId: "k" };
  await gw.promptContributions(ctx);
  await gw.mountActivity(ctx, "keep");
  await gw.mountActivities(ctx, "keep");
  await gw.mountUsage(ctx, "keep");
  await gw.heldFiles(ctx, { op: "list", path: "" });
  await gw.heldFiles(ctx, { op: "read", path: "f", maxBytes: 10 });
  await gw.releaseTask(ctx, { alias: "keep" });
  await gw.receive("t", "a", "keep", { headers: {}, body: new Uint8Array(1) } as never, "s");
  await gw.reportActivity("t", "a", []);
  await gw.refreshMountTools("t", "a", "list");
  // The bench runner's poll and a cancel with no operation named (cf/src/index.ts `benchSweJob`).
  await gw.pollBackground(ctx, "keep", { h: 1 });
  await gw.cancelBackground(ctx, "keep", { h: 1 });
  const where = ["promptContribution", "activity", "activities", "usage", "files.list", "files.read", "release", "receive", "reportActivity", "snapshotTools", "poll", "cancel"];
  must(show(got.map((g) => g.where).sort()) === show([...where].sort()), `control: reached ${show(got.map((g) => g.where))}`);
  const named = got.filter((g) => g.has);
  must(named.length === 0, `contexts that serve no operation carried one: ${show(named)}`);
  // Control: the same poll, naming the operation, carries it.
  got.length = 0;
  await gw.pollBackground(ctx, "keep", { h: 1 }, "op_0123456789abcdef0123");
  must(got[0]?.op === "op_0123456789abcdef0123", `a named poll: ${show(got)}`);
});

await check("hostCallOpts forwards no operationId and no approval, whatever a call's options carry", async () => {
  const o = hostCallOpts({ opts: { operationId: "op_forged000000000000", approved: true, idempotencyKey: "k", confirm: true }, callId: "c" });
  must(!("operationId" in o) && !("approved" in o), `forwarded: ${show(o)}`);
  must(o.idempotencyKey === "k" && o.confirm === true && o.callId === "c", `dropped what it forwards: ${show(o)}`);
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
