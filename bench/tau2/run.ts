/**
 * τ²-bench (retail) against this harness.
 *
 * No shell anywhere: the domain is a mounted plugin, the customer is a second
 * model, and the score is the database — did the agent leave the world in the
 * state the annotated solution leaves it in.
 */
import { readFileSync } from "node:fs";
import { SqliteStore } from "../../src/store/sqlite.ts";
import { Kernel } from "../../src/runtime/kernel.ts";
import { CommandExecutor } from "../../src/runtime/commands.ts";
import { QuickJsExecutor } from "../../src/runtime/executor.ts";
import { CodegenHarness } from "../../src/harness/codegen.ts";
import { ToolGateway } from "../../src/runtime/gateway.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import { retailPlugin, applyRetailAction, WRITE_TOOLS, type RetailDB } from "./retail.ts";
import { homedir } from "node:os";
import type { ToolResult } from "../../src/core/tools.ts";

for (const l of readFileSync(`${homedir()}/.secrets/agent-harness.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}
const here = new URL("./data/", import.meta.url).pathname;
const BASE_DB: RetailDB = JSON.parse(readFileSync(here + "db.json", "utf8"));
const TASKS: any[] = JSON.parse(readFileSync(here + "tasks.json", "utf8"));
const POLICY = readFileSync(here + "policy.md", "utf8");
const GUIDELINES = readFileSync(here + "simulation_guidelines.md", "utf8");

const MODEL = process.env.HARNESS_MODEL ?? "deepseek-v4-pro";
const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!, model: MODEL,
});

/** Stable serialisation so two databases compare by value, not key order. */
const canon = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(",")}}`;
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
  const db = structuredClone(BASE_DB);
  const performed: Array<{ name: string; args: any }> = [];
  const T = "tenant-a", AGENT = "agent-1", TASK = `t_${task.id}`;

  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(T, AGENT);
  const plugins = [retailPlugin(db, performed), builtinToolsPlugin(store, () => plugins)];
  for (const [alias, plugin] of [["retail", "retail"], ["tools", "tools"]] as const) {
    await store.addMount({
      tenantId: T, agentId: AGENT, alias, plugin, installationId: `inst-${alias}`,
      connectionId: null, toolVersion: "1.0.0", publicConfig: { account: "benchmark" }, secretRef: null,
    });
  }
  const gw = new ToolGateway(store, plugins);
  const ctx = { tenantId: T, agentId: AGENT, taskId: TASK };
  const host = {
    async invoke(call: { tool: string; args: any; opts?: any }): Promise<ToolResult> {
      return gw.invoke(ctx, call.tool, call.args, call.opts);
    },
  };
  const harness = new CodegenHarness({ maxTurns: 60 });
  await store.createTask(T, AGENT, TASK, await harness.initialize({
    mounts: (await store.listMounts(T, AGENT)).map((m) => ({
      alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
    })),
    policy: POLICY,
  }));
  const commands = new CommandExecutor(store, model, host, new QuickJsExecutor());
  const kernel = new Kernel(store, harness, { holder: "bench", leaseTtlMs: 300_000 });

  const instr = task.user_scenario?.instructions ?? {};
  const scenario = [
    instr.task_instructions && `Style: ${instr.task_instructions}`,
    instr.reason_for_call && `Why you are contacting support: ${instr.reason_for_call}`,
    instr.known_info && `What you know: ${instr.known_info}`,
    instr.unknown_info && `What you do NOT know: ${instr.unknown_info}`,
  ].filter(Boolean).join("\n");
  const simMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: `${GUIDELINES}\n\n# Your scenario\n${scenario}` },
  ];

  let agentSaid = "Hi! How can I help you today?";
  let turns = 0, modelCalls = 0, ended = "max_turns";
  const t0 = Date.now();

  while (turns++ < 14) {
    simMessages.push({ role: "user", content: agentSaid });
    const u = await model.complete(simMessages, { maxTokens: 2000 });
    modelCalls++;
    simMessages.push({ role: "assistant", content: u.text });
    const stop = /###(STOP|TRANSFER|OUT-OF-SCOPE)###/.exec(u.text);
    if (verbose) console.log(`    user  > ${u.text.replace(/\s+/g, " ").slice(0, 130)}`);
    if (stop) { ended = stop[1]!.toLowerCase(); break; }

    await store.appendEvent({ tenantId: T, agentId: AGENT, taskId: TASK, kind: "message", payload: { text: u.text } });
    let guard = 0, answered: string | null = null;
    while (guard++ < 90) {
      const r = await kernel.step(T, TASK, null, (cmd) => commands.dispatch(ctx, cmd));
      if (r.outcome === "no_work") break;
      const t = await store.loadTask(T, TASK);
      if (t && ["completed", "failed", "blocked"].includes(t.status)) {
        answered = (t.checkpoint as any).messages.at(-1).content;
        break;
      }
    }
    modelCalls += commands.trace.filter((x) => x.kind === "model").length;
    commands.trace.length = 0;
    if (!answered) { ended = guard >= 90 ? "step_budget" : "agent_stalled"; break; }
    agentSaid = answered;
    if (verbose) console.log(`    agent > ${answered.replace(/\s+/g, " ").slice(0, 130)}`);
  }

  const { db: expectedDb, expected } = goldDb(task);
  const writes = performed.filter((p) => WRITE_TOOLS.has(p.name));
  const dbMatch = canon(db) === canon(expectedDb);
  const actionMatch = expected.every((e) =>
    writes.some((w) => w.name === e.name && canon(w.args) === canon(e.args)));
  await store.close();
  return {
    id: task.id, reward: dbMatch && actionMatch ? 1 : 0, dbMatch, actionMatch,
    ended, turns: turns - 1, modelCalls, seconds: Math.round((Date.now() - t0) / 1000),
    expectedWrites: expected.map((e) => e.name), performedWrites: writes.map((w) => w.name),
  };
}

const N = Number(process.argv[2] ?? 5);
const OFFSET = Number(process.argv[3] ?? 0);
const verbose = !!process.env.VERBOSE;
const selected = TASKS.slice(OFFSET, OFFSET + N);
console.log(`\n  τ²-bench retail — ${selected.length} tasks, model ${MODEL}\n  ${"─".repeat(74)}`);
const results = [];
for (const task of selected) {
  if (verbose) console.log(`\n  task ${task.id}`);
  let r;
  try { r = await runTask(task, verbose); }
  catch (e) { r = { id: task.id, reward: 0, dbMatch: false, actionMatch: false, ended: `error: ${(e as Error).message.slice(0, 60)}`, turns: 0, modelCalls: 0, seconds: 0, expectedWrites: [], performedWrites: [] }; }
  results.push(r);
  const mark = r.reward ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} task ${String(r.id).padEnd(4)} db=${r.dbMatch ? "ok " : "NO "} act=${r.actionMatch ? "ok " : "NO "} ${String(r.ended).padEnd(13)} ${r.turns} turns / ${r.modelCalls} calls / ${r.seconds}s`);
  if (!r.reward && (r.expectedWrites.length || r.performedWrites.length)) {
    console.log(`      expected: [${r.expectedWrites.join(", ")}]  performed: [${r.performedWrites.join(", ")}]`);
  }
}
const pass = results.filter((r) => r.reward).length;
console.log(`  ${"─".repeat(74)}`);
console.log(`  pass^1 = ${pass}/${results.length} = ${(100 * pass / results.length).toFixed(1)}%   ` +
  `db-only ${results.filter((r) => r.dbMatch).length}   action-only ${results.filter((r) => r.actionMatch).length}\n`);
