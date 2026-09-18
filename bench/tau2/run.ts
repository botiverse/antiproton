/**
 * τ²-bench (retail) against this harness.
 *
 * No shell anywhere: the domain is a mounted plugin, the customer is a second
 * model, and the score is the database — did the agent leave the world in the
 * state the annotated solution leaves it in. That is the thing SWE-bench cannot
 * measure: not whether the loop can grind at a machine, but whether it follows
 * a written policy while a person changes their mind at it.
 *
 * The conversation is one lane. Each customer turn is `say()`, which starts a
 * run if the agent is idle and steers the one in flight if it is not — the same
 * decision the deployment makes when a message arrives over HTTP.
 *
 *   N=5 node bench/tau2/run.ts
 */
import { readFileSync } from "node:fs";
import { failingRowsByEndingAndCause } from "./endings.ts";
import { passLines } from "./passk.ts";
import { homedir } from "node:os";
import { SqliteStore } from "../../src/store/sqlite.ts";
import { sqliteHost } from "../../src/store/sqlite-host.ts";
import { PiAgent } from "../../src/runtime/pi-agent.ts";
import { ToolGateway } from "../../src/runtime/gateway.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { contextWindowFor } from "../../src/model/context-windows.ts";
import { systemPrompt } from "../../src/runtime/pi-prompt.ts";
import type { MountedTool } from "../../src/runtime/pi-tools.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import type { Plugin } from "../../src/plugins/types.ts";
import { retailPlugin, applyRetailAction, WRITE_TOOLS, type RetailDB } from "./retail.ts";
import { nodeWorker, runToRest } from "../node-worker.ts";
import { readMeter, ratesFromEnv, meterLine } from "../meter.ts";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import type { ToolResult } from "../../src/core/tools.ts";

for (const l of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

const here = new URL("./data/", import.meta.url).pathname;
const BASE_DB: RetailDB = JSON.parse(readFileSync(here + "db.json", "utf8"));
const TASKS: any[] = JSON.parse(readFileSync(here + "tasks.json", "utf8"));
const POLICY = readFileSync(here + "policy.md", "utf8");
const GUIDELINES = readFileSync(here + "simulation_guidelines.md", "utf8");

const MODEL_ID = process.env.HARNESS_MODEL ?? "deepseek-flash";
const TRIALS = Number(process.env.TRIALS ?? 1);
const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!, model: MODEL_ID,
});

/** Stable serialisation so two databases compare by value, not key order. */
const canon = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v as object).sort()
    .map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(",")}}`;
};

function goldDb(task: any) {
  const db = structuredClone(BASE_DB);
  const applied: Array<{ name: string; args: any }> = [];
  for (const a of task.evaluation_criteria?.actions ?? []) {
    if (!WRITE_TOOLS.has(a.name)) continue;
    applyRetailAction(db, a.name, a.arguments);
    applied.push({ name: a.name, args: a.arguments });
  }
  return { db, expected: applied };
}

async function runTask(task: any, verbose: boolean) {
  const t0 = Date.now();
  const db = structuredClone(BASE_DB);
  const performed: Array<{ name: string; args: any }> = [];
  const T = "tenant-a", AGENT = `a_${task.id}`;

  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(T, AGENT);
  // Annotated because the tools plugin reads this list back through a closure:
  // a self-referencing initializer has no type to infer, so without this it is
  // `any`, and every use below was unchecked (six baseline entries, one cause).
  const plugins: Plugin[] = [retailPlugin(db, performed), builtinToolsPlugin(store, () => plugins)];
  for (const alias of ["retail", "tools"] as const) {
    await store.addMount({
      tenantId: T, agentId: AGENT, alias, plugin: alias, installationId: `inst-${alias}`,
      connectionId: null, toolVersion: "1.0.0",
      publicConfig: { account: "benchmark" }, secretRef: null, policy: null,
    });
  }
  const gw = new ToolGateway(store, plugins);
  const ctx = { tenantId: T, agentId: AGENT, taskId: "main" };
  const host = { invoke: (c: any): Promise<ToolResult> => gw.invoke(ctx, c.tool, c.args, c.opts) };

  const mounted = await store.listMounts(T, AGENT);
  const byId = new Map(plugins.map((pl) => [pl.id, pl]));
  const tools: MountedTool[] = mounted.flatMap((m) =>
    (byId.get(m.plugin)?.tools ?? []).map((t) => ({
      name: t.name, description: t.summary, parameters: t.parameters,
      address: `${m.alias}.${t.name}`,
      sideEffects: t.sideEffects, idempotency: t.idempotency,
      exclusive: byId.get(m.plugin)?.exclusive,
    })));

  const holder: { agent?: PiAgent } = {};
  const w = nodeWorker(model, () => holder.agent!, MODEL_ID);
  const agent = await PiAgent.open({
    host: sqliteHost(),
    sessionId: `${T}/${AGENT}`,
    systemPrompt: systemPrompt({ policy: POLICY }),
    model: { provider: "openai-compatible", id: MODEL_ID, contextWindow: contextWindowFor(MODEL_ID) },
    tools,
    toolHost: host,
    dispatch: async (jobId) => { w.dispatch(jobId); },
  });
  holder.agent = agent;

  const instr = task.user_scenario?.instructions ?? {};
  const scenario = [
    instr.task_instructions && `Style: ${instr.task_instructions}`,
    instr.reason_for_call && `Why you are contacting support: ${instr.reason_for_call}`,
    instr.known_info && `What you know: ${instr.known_info}`,
    instr.unknown_info && `What you do NOT know: ${instr.unknown_info}`,
  ].filter(Boolean).join("\n");
  const sim: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: `${GUIDELINES}\n\n# Your scenario\n${scenario}` },
  ];

  let agentSaid = "Hi! How can I help you today?";
  let turns = 0, simCalls = 0, ended = "max_turns", passes = 0;

  while (turns++ < 14) {
    sim.push({ role: "user", content: agentSaid });
    const u = await model.complete(sim, { maxTokens: 2000 });
    simCalls += 1;
    sim.push({ role: "assistant", content: u.text });
    const stop = /###(STOP|TRANSFER|OUT-OF-SCOPE)###/.exec(u.text);
    if (verbose) console.log(`    user  > ${u.text.replace(/\s+/g, " ").slice(0, 130)}`);
    if (stop) { ended = stop[1]!.toLowerCase(); break; }

    await agent.say(u.text);
    const r = await runToRest(agent, w, CTX);
    passes += r.passes;
    if (!r.answer) { ended = r.ended === "budget" ? "budget" : "agent_stalled"; break; }
    agentSaid = r.answer;
    if (verbose) console.log(`    agent > ${agentSaid.replace(/\s+/g, " ").slice(0, 130)}`);
  }

  const { db: expectedDb, expected } = goldDb(task);
  const writes = performed.filter((p) => WRITE_TOOLS.has(p.name));
  const dbMatch = canon(db) === canon(expectedDb);
  const actionMatch = expected.every((e) =>
    writes.some((x) => x.name === e.name && canon(x.args) === canon(e.args)));

  const entries = await agent.storage.scanEntries({ order: "asc" }, CTX);
  const usage = entries.reduce((a: any, e: any) => {
    const m = e.message;
    if (m?.role !== "assistant" || m.stopReason === "deferred") return a;
    a.calls += 1;
    a.prompt += m.usage?.input ?? 0;
    a.cached += m.usage?.cacheRead ?? 0;
    a.out += m.usage?.output ?? 0;
    return a;
  }, { calls: 0, prompt: 0, cached: 0, out: 0 });
  const byTool: Record<string, number> = {};
  for (const e of entries as any[]) {
    const n = e.message?.role === "toolResult" ? e.message.toolName : null;
    if (n) byTool[n] = (byTool[n] ?? 0) + 1;
  }

  // No container in this domain — which is the point of measuring it here too:
  // τ² costs tokens only, and a benchmark that reports one meter cannot say so.
  const meter = await readMeter(store, T, AGENT, ["retail", "tools"], Date.now() - t0, {
    promptTokens: usage.prompt, cachedTokens: usage.cached, outputTokens: usage.out,
  });
  // The whole transcript, when asked for. A pass rate says a task failed; only
  // the trajectory says whether the agent was wrong or the loop stopped early,
  // and those want completely different fixes.
  if (process.env.TRAJECTORY) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(String(process.env.TRAJECTORY), { recursive: true });
    writeFileSync(
      `${process.env.TRAJECTORY}/task-${task.id}-${Date.now()}.json`,
      JSON.stringify({
        id: task.id, ended, turns: turns - 1,
        expected: expected.map((e) => ({ name: e.name, args: e.args })),
        performed: writes,
        entries: entries.map((e: any) => ({
          seq: e.seq, type: e.type,
          role: e.message?.role, stopReason: e.message?.stopReason,
          toolName: e.message?.toolName,
          content: e.message?.content ?? e.message ?? null,
        })),
      }, null, 2),
    );
  }

  const release = await gw.releaseTask(ctx);
  for (const f of release.failed) console.log(`      \x1b[31mrelease failed: ${f.alias}: ${f.error}\x1b[0m`);
  await agent.close();
  await store.close();

  return {
    id: task.id, reward: dbMatch && actionMatch ? 1 : 0, dbMatch, actionMatch, ended,
    turns: turns - 1, simCalls, passes, byTool, meter, ...usage,
    seconds: Math.round((Date.now() - t0) / 1000),
    expectedWrites: expected.map((e) => e.name), performedWrites: writes.map((x) => x.name),
  };
}

const N = Number(process.env.N ?? process.argv[2] ?? 5);
const OFFSET = Number(process.env.OFFSET ?? process.argv[3] ?? 0);
const verbose = !!process.env.VERBOSE;
const selected = TASKS.slice(OFFSET, OFFSET + N);

console.log(`\n  τ²-bench retail — ${selected.length} task(s) × ${TRIALS} trial(s), ` +
  `model ${MODEL_ID}, harness pi\n  ${"─".repeat(84)}`);

const results: any[] = [];
for (let trial = 1; trial <= TRIALS; trial++) {
  for (const task of selected) {
    if (verbose) console.log(`\n  task ${task.id} (trial ${trial})`);
    let r;
    try { r = await runTask(task, verbose); }
    catch (e) {
      r = { id: task.id, reward: 0, dbMatch: false, actionMatch: false,
            ended: `error: ${(e as Error).message.slice(0, 60)}`, turns: 0, simCalls: 0,
            calls: 0, prompt: 0, cached: 0, byTool: {}, seconds: 0,
            expectedWrites: [], performedWrites: [] };
    }
    results.push({ ...r, trial });
    const mark = r.reward ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const cache = r.prompt ? `${Math.round((r.cached / r.prompt) * 100)}% cached` : "—";
    const tools = Object.entries(r.byTool ?? {}).sort((a: any, b: any) => b[1] - a[1])
      .map(([n, c]) => `${n}×${c}`).join(" ");
    console.log(`  ${mark} task ${String(r.id).padEnd(4)} db=${r.dbMatch ? "ok " : "NO "}` +
      `act=${r.actionMatch ? "ok " : "NO "} ${String(r.ended).padEnd(13)} ` +
      `${r.turns} turns / ${r.calls} calls / ${r.prompt} tok (${cache}) / ${r.seconds}s`);
    if (tools) console.log(`      [${tools}]`);
    if (r.meter) console.log(`      ${meterLine(r.meter, ratesFromEnv())}`);
    if (!r.reward && (r.expectedWrites.length || r.performedWrites.length)) {
      console.log(`      expected: [${r.expectedWrites.join(", ")}]  performed: [${r.performedWrites.join(", ")}]`);
    }
  }
}

const prompt = results.reduce((a, r) => a + (r.prompt ?? 0), 0);
const cached = results.reduce((a, r) => a + (r.cached ?? 0), 0);
const allTools: Record<string, number> = {};
for (const r of results) for (const [n, c] of Object.entries(r.byTool ?? {})) {
  allTools[n] = (allTools[n] ?? 0) + (c as number);
}
console.log(`  ${"─".repeat(84)}`);
for (const line of passLines(results, TRIALS)) console.log(line);
console.log(`  db-only ${results.filter((r) => r.dbMatch).length}   ` +
  `action-only ${results.filter((r) => r.actionMatch).length}   ` +
  `${results.reduce((a, r) => a + r.seconds, 0)}s`);
/**
 * Why the runs that failed ended.
 *
 * A pass rate alone cannot tell an agent that got the task wrong from a
 * conversation that never happened. The customer here is a second model, and it
 * can emit its stop token on the first turn — one task in this set carries a
 * `task_instructions` of "." and the simulator gave up in six seconds, before
 * the agent had done anything. Counting those against the loop would be
 * measuring the benchmark's user simulator and calling it a harness score.
 */
const failEndings = failingRowsByEndingAndCause(results);
if (Object.keys(failEndings).length) {
  console.log(`  failures by ending: ${Object.entries(failEndings)
    .sort((a: any, b: any) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  ")}`);
}
console.log(`  ${prompt} prompt tokens (${prompt ? Math.round((cached / prompt) * 100) : 0}% cached)   ` +
  `tools: ${Object.entries(allTools).sort((a: any, b: any) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`).join("  ") || "(none)"}\n`);
