/**
 * Token efficiency: code-mode vs provider-native tool calling.
 *
 * Same tasks, same tools, same policy, same user simulator, same scoring. The
 * only thing that varies is how the agent reaches the tools:
 *   codegen  — the model writes JS; the tool tag is the only way out
 *   toolcall — the model emits provider-native tool_calls in a loop
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SqliteStore } from "../../src/store/sqlite.ts";
import { Kernel } from "../../src/runtime/kernel.ts";
import { CommandExecutor } from "../../src/runtime/commands.ts";
import { QuickJsExecutor } from "../../src/runtime/executor.ts";
import { CodegenHarness, NO_COMPACTION, DEFAULT_COMPACTION } from "../../src/harness/codegen.ts";
import { HybridHarness } from "../../src/harness/hybrid.ts";
import { ToolGateway } from "../../src/runtime/gateway.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import { retailPlugin, applyRetailAction, WRITE_TOOLS, type RetailDB } from "./retail.ts";
import type { ModelMessage, ToolDefinition } from "../../src/model/types.ts";
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

const canon = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(",")}}`;
};

interface Usage { calls: number; prompt: number; cached: number; completion: number; reasoning: number; perCall: number[] }
const zero = (): Usage => ({ calls: 0, prompt: 0, cached: 0, completion: 0, reasoning: 0, perCall: [] });
const add = (u: Usage, r: any) => {
  u.calls++; u.prompt += r.usage.promptTokens; u.cached += r.usage.cachedPromptTokens;
  u.completion += r.usage.completionTokens; u.reasoning += r.usage.reasoningTokens;
  u.perCall.push(r.usage.promptTokens);
};

/** An agent is anything that can answer a customer turn. */
interface Agent {
  say(userMessage: string): Promise<string | null>;
  usage: Usage;
}

async function codegenAgent(db: RetailDB, performed: any[]): Promise<Agent> {
  const T = "tenant-a", AGENT = "agent-1", TASK = "task-1";
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(T, AGENT);
  const plugins = [retailPlugin(db, performed), builtinToolsPlugin(store, () => plugins)];
  for (const alias of ["retail", "tools"]) {
    await store.addMount({
      tenantId: T, agentId: AGENT, alias, plugin: alias, installationId: `inst-${alias}`,
      connectionId: null, toolVersion: "1.0.0", publicConfig: { account: "benchmark" }, secretRef: null,
    });
  }
  const gw = new ToolGateway(store, plugins);
  const ctx = { tenantId: T, agentId: AGENT, taskId: TASK };
  const host = { invoke: (c: { tool: string; args: any }): Promise<ToolResult> => gw.invoke(ctx, c.tool, c.args) };
  const compaction = process.env.COMPACTION === "cycles"
    ? { ...DEFAULT_COMPACTION, triggerTokens: Number(process.env.TRIGGER ?? 24000), keepCycles: Number(process.env.KEEP ?? 3) }
    : NO_COMPACTION;
  const harness = new CodegenHarness({ maxTurns: 60, compaction });
  await store.createTask(T, AGENT, TASK, await harness.initialize({
    mounts: (await store.listMounts(T, AGENT)).map((m) => ({
      alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
    })),
    policy: POLICY,
  }));
  const usage = zero();
  const commands = new CommandExecutor(store, {
    id: model.id,
    async complete(m, o) { const r = await model.complete(m, o); add(usage, r); return r; },
  } as any, host, new QuickJsExecutor());
  const kernel = new Kernel(store, harness, { holder: "bench", leaseTtlMs: 300_000 });

  return {
    usage,
    async say(userMessage: string) {
      await store.appendEvent({ tenantId: T, agentId: AGENT, taskId: TASK, kind: "message", payload: { text: userMessage } });
      for (let g = 0; g < 90; g++) {
        const r = await kernel.step(T, TASK, null, (cmd) => commands.dispatch(ctx, cmd));
        if (r.outcome === "no_work") break;
        const t = await store.loadTask(T, TASK);
        if (t && ["completed", "failed", "blocked"].includes(t.status)) {
          return (t.checkpoint as any).messages.at(-1).content as string;
        }
      }
      return null;
    },
  };
}

async function hybridAgent(db: RetailDB, performed: any[]): Promise<Agent> {
  const T = "tenant-a", AGENT = "agent-1", TASK = "task-1";
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(T, AGENT);
  const retail = retailPlugin(db, performed);
  const plugins = [retail, builtinToolsPlugin(store, () => plugins)];
  for (const alias of ["retail", "tools"]) {
    await store.addMount({
      tenantId: T, agentId: AGENT, alias, plugin: alias, installationId: `inst-${alias}`,
      connectionId: null, toolVersion: "1.0.0", publicConfig: { account: "benchmark" }, secretRef: null,
    });
  }
  const gw = new ToolGateway(store, plugins);
  const ctx = { tenantId: T, agentId: AGENT, taskId: TASK };
  const host = { invoke: (c: { tool: string; args: any }): Promise<ToolResult> => gw.invoke(ctx, c.tool, c.args) };
  const harness = new HybridHarness({ maxTurns: 40 });
  await store.createTask(T, AGENT, TASK, await harness.initialize({
    tools: retail.tools.map((x) => ({
      name: x.name, description: x.summary, parameters: x.parameters, address: `retail.${x.name}`,
    })),
    policy: POLICY,
  }));
  const usage = zero();
  const commands = new CommandExecutor(store, {
    id: model.id,
    async complete(m: any, o: any) { const r = await model.complete(m, o); add(usage, r); return r; },
  } as any, host, new QuickJsExecutor());
  const kernel = new Kernel(store, harness, { holder: "bench", leaseTtlMs: 300_000 });
  return {
    usage,
    async say(userMessage: string) {
      await store.appendEvent({ tenantId: T, agentId: AGENT, taskId: TASK, kind: "message", payload: { text: userMessage } });
      for (let g = 0; g < 120; g++) {
        const r = await kernel.step(T, TASK, null, (cmd) => commands.dispatch(ctx, cmd));
        if (r.outcome === "no_work") break;
        const t2 = await store.loadTask(T, TASK);
        if (t2 && ["completed", "failed", "blocked"].includes(t2.status)) {
          return (t2.checkpoint as any).messages.at(-1).content as string;
        }
      }
      return null;
    },
  };
}

const BASELINE_SYSTEM = `You are a customer service agent for an online retail store.
Use the provided tools to look things up and to make changes. Follow the policy below
exactly. Reply to the customer in plain text; use tools when you need data or need to
act. Do not invent information you have not looked up.`;

async function toolcallAgent(db: RetailDB, performed: any[]): Promise<Agent> {
  const plugin = retailPlugin(db, performed);
  const tools: ToolDefinition[] = plugin.tools.map((t) => ({
    name: t.name, description: t.summary, parameters: t.parameters,
  }));
  const messages: ModelMessage[] = [{ role: "system", content: `${BASELINE_SYSTEM}\n\n# Policy\n${POLICY}` }];
  const usage = zero();
  return {
    usage,
    async say(userMessage: string) {
      messages.push({ role: "user", content: userMessage });
      for (let g = 0; g < 40; g++) {
        const r = await model.complete(messages, { maxTokens: 4096, tools });
        add(usage, r);
        if (r.toolCalls?.length) {
          messages.push({
            role: "assistant", content: r.text ?? "",
            tool_calls: r.toolCalls.map((c) => ({
              id: c.id, type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            })),
          });
          for (const c of r.toolCalls) {
            let out: string;
            try { out = JSON.stringify(applyRetailAction(db, c.name, c.arguments)); }
            catch (e) { out = JSON.stringify({ error: (e as Error).message }); }
            performed.push({ name: c.name, args: c.arguments });
            messages.push({ role: "tool", tool_call_id: c.id, content: out });
          }
          continue;
        }
        messages.push({ role: "assistant", content: r.text });
        return r.text;
      }
      return null;
    },
  };
}

let COMPACTIONS = 0;
async function runTask(task: any, mode: "codegen" | "toolcall" | "hybrid") {
  COMPACTIONS = 0;
  const db = structuredClone(BASE_DB);
  const performed: Array<{ name: string; args: any }> = [];
  const agent = mode === "codegen" ? await codegenAgent(db, performed)
    : mode === "hybrid" ? await hybridAgent(db, performed)
    : await toolcallAgent(db, performed);

  const instr = task.user_scenario?.instructions ?? {};
  const scenario = [
    instr.task_instructions && `Style: ${instr.task_instructions}`,
    instr.reason_for_call && `Why you are contacting support: ${instr.reason_for_call}`,
    instr.known_info && `What you know: ${instr.known_info}`,
    instr.unknown_info && `What you do NOT know: ${instr.unknown_info}`,
  ].filter(Boolean).join("\n");
  const sim: ModelMessage[] = [{ role: "system", content: `${GUIDELINES}\n\n# Your scenario\n${scenario}` }];
  const simUsage = zero();

  let agentSaid = "Hi! How can I help you today?";
  let turns = 0, ended = "max_turns";
  const t0 = Date.now();
  while (turns++ < 14) {
    sim.push({ role: "user", content: agentSaid });
    const u = await model.complete(sim, { maxTokens: 2000 });
    add(simUsage, u);
    sim.push({ role: "assistant", content: u.text });
    const stop = /###(STOP|TRANSFER|OUT-OF-SCOPE)###/.exec(u.text);
    if (stop) { ended = stop[1]!.toLowerCase(); break; }
    const said = await agent.say(u.text);
    if (!said) { ended = "agent_stalled"; break; }
    agentSaid = said;
  }

  const expectedDb = structuredClone(BASE_DB);
  const expected: any[] = [];
  for (const a of task.evaluation_criteria?.actions ?? []) {
    if (!WRITE_TOOLS.has(a.name)) continue;
    applyRetailAction(expectedDb, a.name, a.arguments);
    expected.push(a);
  }
  const writes = performed.filter((p) => WRITE_TOOLS.has(p.name));
  const dbMatch = canon(db) === canon(expectedDb);
  const actionMatch = expected.every((e) =>
    writes.some((w) => w.name === e.name && canon(w.args) === canon(e.arguments)));

  return {
    id: task.id, mode, reward: dbMatch && actionMatch ? 1 : 0, ended, turns: turns - 1,
    seconds: Math.round((Date.now() - t0) / 1000), agent: agent.usage, sim: simUsage,
    toolCalls: performed.length,
  };
}

const N = Number(process.argv[2] ?? 6);
const OFFSET = Number(process.argv[3] ?? 0);
const MODES = (process.env.MODES ?? "codegen,toolcall").split(",") as Array<"codegen" | "toolcall" | "hybrid">;
const selected = TASKS.slice(OFFSET, OFFSET + N);
console.log(`\n  token efficiency — ${selected.length} tasks × ${MODES.join(" / ")}, model ${MODEL}\n  ${"─".repeat(88)}`);
console.log(`  ${"mode".padEnd(9)}${"task".padEnd(6)}${"ok".padEnd(4)}${"turns".padEnd(7)}${"tool".padEnd(6)}${"calls".padEnd(7)}${"prompt".padEnd(9)}${"cached".padEnd(9)}${"out".padEnd(8)}${"reason".padEnd(8)}sec`);
const all: any[] = [];
for (const task of selected) {
  for (const mode of MODES) {
    let r;
    try { r = await runTask(task, mode); }
    catch (e) { r = { id: task.id, mode, reward: 0, ended: `error: ${(e as Error).message.slice(0, 40)}`, turns: 0, seconds: 0, agent: zero(), sim: zero(), toolCalls: 0 }; }
    all.push(r);
    const mark = r.reward ? "\x1b[32m✓\x1b[0m " : "\x1b[31m✗\x1b[0m ";
    if (process.env.CURVE) console.log(`      prompt curve: ${r.agent.perCall.join(" → ")}`);
    console.log(`  ${r.mode.padEnd(9)}${String(r.id).padEnd(6)}${mark}  ${String(r.turns).padEnd(7)}${String(r.toolCalls).padEnd(6)}${String(r.agent.calls).padEnd(7)}${String(r.agent.prompt).padEnd(9)}${String(r.agent.cached).padEnd(9)}${String(r.agent.completion).padEnd(8)}${String(r.agent.reasoning).padEnd(8)}${r.seconds}`);
  }
}
console.log(`  ${"─".repeat(88)}`);
for (const mode of MODES) {
  const rs = all.filter((r) => r.mode === mode);
  const sum = (f: (r: any) => number) => rs.reduce((a, r) => a + f(r), 0);
  const n = rs.length;
  console.log(`  ${mode.padEnd(9)} pass ${rs.filter((r) => r.reward).length}/${n}   ` +
    `agent tokens/task: prompt ${(sum((r) => r.agent.prompt) / n).toFixed(0)} (cached ${(sum((r) => r.agent.cached) / n).toFixed(0)}) ` +
    `+ out ${(sum((r) => r.agent.completion) / n).toFixed(0)} (reasoning ${(sum((r) => r.agent.reasoning) / n).toFixed(0)})   ` +
    `= ${(sum((r) => r.agent.prompt + r.agent.completion) / n).toFixed(0)} total   ` +
    `${(sum((r) => r.agent.calls) / n).toFixed(1)} calls   ${(sum((r) => r.seconds) / n).toFixed(0)}s`);
}
console.log();
