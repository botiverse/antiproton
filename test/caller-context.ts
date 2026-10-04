/**
 * `PluginContext.caller.contextId` and `caller.fromProgram`: what a plugin is told about where a call came from.
 *
 * `contextId` (src/runtime/context-id.ts) names the model's current context window in a session: the same across the
 * turns of one session, different after a new session, a reset or a compaction, and the same again when a restarted
 * object recomputes it. `fromProgram` is true exactly for a run_js program's call (`InvokeOpts.fromProgram`).
 *
 * The runtime rows drive the real `AgentRuntime` (cf/src/runtime.ts) on both engines over node:sqlite, with the model
 * scripted through the queue as the worker answers it, run_js on the Dynamic Worker executor through the node stand-in
 * (test/spec/worker-stand-in.ts), and a plugin that records the `caller` it was handed. The QuickJS rows run the same
 * run_js tool (`runJsTool`) over a host that filters options as the production host does (`hostCallOpts`).
 */
import { AgentRuntime, hostCallOpts } from "../cf/src/runtime.ts";
import { fromResponse, toRequest } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import type { Plugin, PluginContext } from "../src/plugins/types.ts";
import { contextIdOf } from "../src/runtime/context-id.ts";
import { DurableAgent } from "../src/runtime/durable-agent.ts";
import { DynamicWorkerExecutor } from "../src/runtime/dynamic-worker-executor.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { ToolGateway, type CallContext } from "../src/runtime/gateway.ts";
import { bridgeTools, qualifyMountedTools, runJsTool } from "../src/runtime/pi-tools.ts";
import { durableTool } from "../src/runtime/durable-tools.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { ensurePiTables, piTables } from "../src/store/pi-storage.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import { standInLoader } from "./spec/worker-stand-in.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

type Caller = PluginContext["caller"];

/** A plugin that records the caller of every call it runs. */
function probe(seen: Array<{ tool: string; caller: Caller }>): Plugin {
  return {
    id: "probe", version: "1.0.0",
    tools: [
      { name: "see", description: "Read.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "none" },
      { name: "act", description: "Write.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" },
    ] as never,
    async invoke(tool, _args, context) { seen.push({ tool, caller: JSON.parse(JSON.stringify(context.caller)) }); return { ok: tool }; },
  };
}

// ---- the runtime, driven as the worker drives it ------------------------------------------------------------

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage });
const call = (id: string, name: string, args: unknown): ModelResponse =>
  ({ text: "", finishReason: "tool_calls", truncated: false, usage, toolCalls: [{ id, name, arguments: args as never }] });
const SUMMARIZER = "You are a context summarization assistant.";
/** About 27k estimated tokens: two of them give a manual compaction something to fold away past pi-durable's default keep-recent of 20000, and stay under its background threshold. */
const LONG = (tag: string) => `${tag} ${"lorem ipsum dolor sit amet ".repeat(4000)}`;

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
  const seen: Array<{ tool: string; caller: Caller }> = [];
  const plugin = probe(seen);
  const r = runtime(host, plugin);
  await r.rt.ready();
  await r.rt.store.createAgent("t", "a");
  await r.rt.store.setPluginChoice("t", "a", "probe", "enable");
  const added = await r.rt.addMount("t", "a", { alias: "probe", plugin: "probe", config: {} });
  must(added.ok, `the mount was refused: ${show(added)}`);
  await r.rt.bindOperatorModel("t", "a");
  return { host, seen, plugin, r };
}

/**
 * One user message on `session`, the model answered by `script` in order (a summary job, with a fixed summary).
 * Returns when the object has nothing left to wake for.
 */
async function turn(r: Rt, text: string, script: ModelResponse[], session = "main") {
  let at = 0;
  await r.rt.postMessage("t", "a", text, "prompt", session);
  for (let guard = 0; guard < 200; guard++) {
    const out = await r.rt.step("t", "a") as { wakeInMs?: number | null };
    const pending = r.sent.filter((id) => !r.answered.has(id));
    for (const id of pending) {
      r.answered.add(id);
      const job = await r.rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] } | null;
      if (!job) continue;
      const req = toRequest(job.context);
      const isSummary = req.messages.some((m) => m.role === "system" && String(m.content).includes(SUMMARIZER));
      const res = isSummary ? say("the summary") : script[at++];
      must(res, `the model was called more often than scripted (${at}); last: ${show(req.messages.slice(-1)).slice(0, 300)}`);
      await r.rt.deliverAnswer("t", "a", id, fromResponse(res, { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
    }
    if (pending.length) continue;
    if (at >= script.length && (out?.wakeInMs === null || out?.wakeInMs === undefined)) return;
    await sleep(Math.min(out?.wakeInMs ?? 20, 50));
  }
  throw new Error(`the turn did not settle; ${at} of ${script.length} answered`);
}

/** Step until the object is idle, answering whatever summary job is out. */
async function settle(r: Rt) {
  for (let guard = 0; guard < 200; guard++) {
    const out = await r.rt.step("t", "a") as { wakeInMs?: number | null };
    const pending = r.sent.filter((id) => !r.answered.has(id));
    for (const id of pending) {
      r.answered.add(id);
      const job = await r.rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string } } | null;
      if (!job) continue;
      await r.rt.deliverAnswer("t", "a", id, fromResponse(say("the summary"), { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
    }
    if (pending.length) continue;
    if (out?.wakeInMs === null || out?.wakeInMs === undefined) return;
    await sleep(Math.min(out.wakeInMs, 50));
  }
  throw new Error("did not settle");
}

/** One model turn whose single tool call is `probe__see`; returns the caller the plugin saw. */
async function seeOnce(w: Awaited<ReturnType<typeof world>>, label: string, session = "main", text = "look") {
  const before = w.seen.length;
  await turn(w.r, text, [call(`c_${label}`, "probe__see", {}), say("done")], session);
  must(w.seen.length === before + 1, `${label}: the plugin ran ${w.seen.length - before} times`);
  return w.seen.at(-1)!.caller;
}

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: the model's own calls carry one contextId across several turns, and no fromProgram`, async () => {
    const w = await world(engine);
    try {
      const ids: Array<string | undefined> = [];
      for (let i = 0; i < 3; i++) {
        const c = await seeOnce(w, `t${i}`);
        must(!("fromProgram" in c), `turn ${i}: a direct call carried fromProgram: ${show(c)}`);
        ids.push(c.contextId);
      }
      must(typeof ids[0] === "string" && ids[0]!.length > 0, `no contextId: ${show(ids)}`);
      must(ids.every((x) => x === ids[0]), `the id moved between turns: ${show(ids)}`);
      must(w.seen.every((s) => s.caller.tenantId === "t" && s.caller.agentId === "a"), `identity: ${show(w.seen[0])}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: another session has another contextId, and another agent's differs too`, async () => {
    const w = await world(engine);
    try {
      const main = (await seeOnce(w, "m")).contextId;
      const other = (await seeOnce(w, "s", "s2")).contextId;
      must(main && other && main !== other, `sessions: main ${main}, s2 ${other}`);
      const again = (await seeOnce(w, "m2")).contextId;
      must(again === main, `main moved after s2 was spoken to: ${main} → ${again}`);
      // The same transcript read for another agent: the scope is part of the id.
      const sql = w.host.sql;
      const mine = contextIdOf(sql, { tenantId: "t", agentId: "a", engine });
      const theirs = contextIdOf(sql, { tenantId: "t", agentId: "b", engine });
      must(mine === main && theirs !== mine, `agent scope: mine ${mine}, theirs ${theirs}, seen ${main}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a restarted runtime on the same storage computes the same contextId`, async () => {
    const w = await world(engine);
    try {
      const before = (await seeOnce(w, "b")).contextId;
      const r2 = runtime(w.host, w.plugin);
      const w2 = { ...w, r: r2 };
      await r2.rt.ready();
      const after = (await seeOnce(w2, "a")).contextId;
      must(before && after === before, `restart moved it: ${before} → ${after}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a run_js program's calls carry fromProgram: true and the turn's contextId; a program cannot clear the one or forge the other`, async () => {
    const w = await world(engine);
    try {
      const direct = (await seeOnce(w, "d")).contextId;
      const before = w.seen.length;
      const source = [
        "await tool`probe__see ${{}}`;",
        "await tool`probe__see ${{ contextId: 'forged' }} ${{ fromProgram: false, contextId: 'forged', approved: true }}`;",
        "output('ran');",
      ].join("\n");
      await turn(w.r, "program", [call("c_js", "run_js", { source }), say("done")]);
      const ran = w.seen.slice(before);
      must(ran.length === 2, `the program's calls: ${show(ran)}`);
      for (const s of ran) {
        must(s.caller.fromProgram === true, `fromProgram: ${show(s.caller)}`);
        must(s.caller.contextId === direct, `contextId ${s.caller.contextId}, the model's ${direct}`);
      }
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: an approved call's replay carries neither contextId nor fromProgram`, async () => {
    const w = await world(engine);
    try {
      const before = w.seen.length;
      await turn(w.r, "act", [call("c_act", "probe__act", { confirm: true }), say("held")]);
      must(w.seen.length === before, `the held call ran: ${show(w.seen.slice(before))}`);
      const [card] = await w.r.rt.store.listApprovals("t", "pending");
      must(card, "no card");
      const ok = await w.r.rt.gateway().applyApproval("t", card!.operationId, "approved", "tygg");
      must(ok.ok && ok.executed, `approval: ${show(ok)}`);
      const replay = w.seen.at(-1)!;
      must(replay.tool === "act" && !("contextId" in replay.caller) && !("fromProgram" in replay.caller), `replay caller: ${show(replay.caller)}`);
    } finally { w.host.dispose(); }
  });
}

await check("pd: a compaction changes the contextId; it then holds across turns", async () => {
  const w = await world("pd");
  try {
    const first = (await seeOnce(w, "a", "main", LONG("first"))).contextId;
    await seeOnce(w, "b", "main", LONG("second"));
    const op = await w.r.rt.requestCompaction("t", "a") as { operationId: string };
    must(op?.operationId, `no compaction: ${show(op)}`);
    await settle(w.r);
    const heads = w.host.sql.exec("SELECT COUNT(*) AS n FROM pd_entries WHERE head IS NOT NULL").toArray()[0] as { n: number };
    must(Number(heads.n) === 1, `control: the compaction placed ${heads.n} head markers; ${show(w.host.sql.exec("SELECT record FROM pd_tasks WHERE json_extract(record, '$.kind') = 'pi.compaction'").toArray().map((r) => JSON.parse(String((r as { record: unknown }).record)).state))}`);
    const after = (await seeOnce(w, "c")).contextId;
    const later = (await seeOnce(w, "d")).contextId;
    must(first && after && after !== first, `compaction did not move it: ${first} → ${after}`);
    must(later === after, `it moved again with no compaction: ${after} → ${later}`);
  } finally { w.host.dispose(); }
});

await check("pd: a reset changes the contextId", async () => {
  const w = await world("pd");
  try {
    const first = (await seeOnce(w, "a")).contextId;
    const agent = await w.r.rt.agent("t", "a") as DurableAgent;
    must(agent instanceof DurableAgent, "control: not a pd agent");
    const host = agent.host;
    await host.withHarness(async (h) => (await host.handle(h, await host.conversation("main"))).reset("handoff", bg));
    await settle(w.r);
    const resets = w.host.sql.exec("SELECT COUNT(*) AS n FROM pd_entries WHERE json_extract(record, '$.kind') = 'pi.reset'").toArray()[0] as { n: number };
    must(Number(resets.n) === 1, `control: ${resets.n} reset entries`);
    const after = (await seeOnce(w, "b")).contextId;
    must(first && after && after !== first, `reset did not move it: ${first} → ${after}`);
  } finally { w.host.dispose(); }
});

await check("pi085: a context boundary entry in the transcript changes the contextId, and is found through the partial index", async () => {
  // pi085 declines every compaction (src/runtime/pi-agent.ts), so the boundary is written as pi would write one.
  const host = sqliteHost();
  try {
    ensurePiTables(host.sql);
    const t = piTables();
    const add = (seq: number, type: string, custom: string | null = null) => host.sql.exec(
      `INSERT INTO ${t.entries}(id, parent_id, seq, timestamp, type, custom_type, body) VALUES (?,?,?,?,?,?,?)`,
      `e${seq}`, seq === 1 ? null : `e${seq - 1}`, seq, seq, type, custom, "{}");
    const id = () => contextIdOf(host.sql, { tenantId: "t", agentId: "a", engine: "pi085" });
    must(id() === undefined, "an empty transcript has a contextId");
    add(1, "message"); add(2, "message");
    const a = id();
    add(3, "message"); add(4, "custom", "agents_api.turn_cancelled");
    must(a && id() === a, `ordinary entries moved it: ${a} → ${id()}`);
    add(5, "compaction");
    const b = id();
    must(b && b !== a, `a compaction did not move it: ${a} → ${b}`);
    add(6, "message");
    must(id() === b, "a message after the compaction moved it");
    add(7, "custom", "pi.reset");
    must(id() !== b, "a pi.reset did not move it");
    const plan = host.sql.exec(`EXPLAIN QUERY PLAN SELECT MAX(seq) AS b FROM ${t.entries} WHERE type IN ('compaction', 'branch_summary') OR custom_type = 'pi.reset'`)
      .toArray().map((r) => String((r as { detail: unknown }).detail)).join("; ");
    must(plan.includes(`${t.entries}_boundary`), `the boundary read does not use its index: ${plan}`);
  } finally { host.dispose(); }
});

await check("pd: the head-marker read goes through pi-durable's partial index", async () => {
  const w = await world("pd");
  try {
    await seeOnce(w, "a");
    const plan = w.host.sql.exec("EXPLAIN QUERY PLAN SELECT MAX(id) AS h FROM pd_entries WHERE conversation_id = 0 AND head IS NOT NULL")
      .toArray().map((r) => String((r as { detail: unknown }).detail)).join("; ");
    must(plan.includes("entry_heads_by_conversation"), `the head read does not use its index: ${plan}`);
  } finally { w.host.dispose(); }
});

// ---- run_js on both executors, over the gateway with the production host's filter ------------------------------

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
  const seen: Array<{ tool: string; caller: Caller }> = [];
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "probe", plugin: "probe", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: { write: "approval" },
  });
  const gw = new ToolGateway(store, [probe(seen)], new Set(["probe"]), { async resolve() { return null; } });
  const ctx: CallContext = { tenantId: "t", agentId: "a", taskId: "k", contextId: "ctx_host" };
  // The production host's shape: the call's options through `hostCallOpts`, the context id from the host alone.
  const host = { async invoke(c: any) { return gw.invoke(ctx, c.tool, c.args, hostCallOpts(c)); } };
  const tools = qualifyMountedTools([
    { name: "see", address: "probe.see", description: "", parameters: { type: "object" }, sideEffects: "read" } as any,
    { name: "act", address: "probe.act", description: "", parameters: { type: "object" }, sideEffects: "write" } as any,
  ]);
  return { store, gw, seen, host, tools };
}

for (const [exLabel, exec] of EXECUTORS) {
  for (const [enLabel, wrap] of ENGINES) {
    await check(`${enLabel}/${exLabel}: a program's call carries fromProgram: true whatever its options say, and the host's contextId`, async () => {
      const w = await gatewayWorld();
      const run = wrap(runJsTool(exec, w.host as any, { tools: w.tools }));
      await run("p1", [
        "await tool`probe__see ${{}}`;",
        "await tool`probe__see ${{}} ${{ fromProgram: false, contextId: 'forged' }}`;",
      ].join("\n"));
      must(w.seen.length === 2, `ran ${show(w.seen)}`);
      for (const s of w.seen) must(s.caller.fromProgram === true && s.caller.contextId === "ctx_host", `caller ${show(s.caller)}`);
    });
  }
}

await check("a direct model call carries no fromProgram; its approval's replay carries neither field", async () => {
  const w = await gatewayWorld();
  const [see, act] = bridgeTools(w.tools, w.host as any);
  await (see as any).execute("d1", {});
  must(w.seen.length === 1 && !("fromProgram" in w.seen[0]!.caller) && w.seen[0]!.caller.contextId === "ctx_host", `direct ${show(w.seen)}`);
  await (act as any).execute("d2", {}).catch(() => {});
  const [card] = await w.store.listApprovals("t", "pending");
  must(card, "no card");
  const ok = await w.gw.applyApproval("t", card!.operationId, "approved", "tygg");
  must(ok.ok && ok.executed && w.seen.length === 2, `approval ${show(ok)}`);
  must(!("fromProgram" in w.seen[1]!.caller) && !("contextId" in w.seen[1]!.caller), `replay ${show(w.seen[1])}`);
});

await check("a program's call held for approval replays with neither field", async () => {
  const w = await gatewayWorld();
  const run = runJsTool(EXECUTORS[0]![1], w.host as any, { tools: w.tools });
  await (run as any).execute("p", { source: "await tool`probe__act ${{}}`;" });
  must(w.seen.length === 0, `ran before approval: ${show(w.seen)}`);
  const [card] = await w.store.listApprovals("t", "pending");
  must(card, "no card");
  const ok = await w.gw.applyApproval("t", card!.operationId, "approved", "tygg");
  must(ok.ok && ok.executed && w.seen.length === 1, `approval ${show(ok)}`);
  must(!("fromProgram" in w.seen[0]!.caller) && !("contextId" in w.seen[0]!.caller), `replay ${show(w.seen[0])}`);
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
