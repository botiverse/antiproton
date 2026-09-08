/**
 * AppWorld against this harness, through the ordinary machinery.
 *
 * The agent never sees a password, a token, or a line of Python: nine apps are
 * nine mounts, the gateway authenticates on its behalf, and 447 APIs reach it
 * as tools. Scoring is AppWorld's own — its database unit tests, via /evaluate.
 *
 * TOOLS controls the one variable worth arguing about at this scale: how much
 * of a 447-tool catalogue the model should be shown.
 *   all     every schema in the prompt, every turn (~46k tokens, 73% accuracy)
 *   narrow  offer <=32 and let search widen it     (~3k tokens, 93% accuracy)
 *
 *   N=3 TOOLS=narrow node --experimental-strip-types bench/appworld/run.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SqliteStore } from "../../src/store/sqlite.ts";
import { Kernel } from "../../src/runtime/kernel.ts";
import { CommandExecutor } from "../../src/runtime/commands.ts";
import { QuickJsExecutor } from "../../src/runtime/executor.ts";
import { HybridHarness, qualifyMountedTools, type MountedTool } from "../../src/harness/hybrid.ts";
import { ToolGateway, type SecretResolver } from "../../src/runtime/gateway.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import { appworldPlugins, type Catalogue } from "../../src/plugins/appworld.ts";
import type { Plugin } from "../../src/plugins/types.ts";
import type { ToolResult } from "../../src/core/tools.ts";

for (const l of readFileSync(`${homedir()}/.secrets/agent-harness.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

const ENV = process.env.AW_ENV_URL ?? "http://localhost:8799";
const API = process.env.AW_API_URL ?? "http://localhost:8800";
const SPLIT = process.env.SPLIT ?? "dev";
const N = Number(process.env.N ?? 3);
const OFFSET = Number(process.env.OFFSET ?? 0);
const MODE = (process.env.TOOLS ?? "narrow") as "all" | "narrow";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 40);
const verbose = !!process.env.VERBOSE;

const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!,
  model: process.env.HARNESS_MODEL ?? "deepseek-v4-pro",
});
const catalogue = JSON.parse(
  readFileSync(new URL("./catalogue.json", import.meta.url).pathname, "utf8"),
) as Catalogue;
const taskIds: string[] = JSON.parse(
  readFileSync(new URL(`./tasks-${SPLIT}.json`, import.meta.url).pathname, "utf8"),
);

const RUN = Math.random().toString(36).slice(2, 7);

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
const post = (url: string, body: unknown) =>
  api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const SYSTEM_EXTRA = `
You are acting on behalf of your supervisor, whose apps you are already logged
into. Never ask for a password or a token: you do not need one and cannot get
one. When the task is done, call supervisor.complete_task with the answer.
`.trim();

async function runTask(taskId: string) {
  const t0 = Date.now();
  // A fresh experiment name per run: re-initialising an existing one leaves the
  // API server serving the previous run's world.
  const init = await post(`${ENV}/initialize`, {
    task_id: taskId, experiment_name: `harness-${MODE}-${RUN}`, remote_apis_url: API,
  });
  const instruction: string = init.output?.instruction ?? init.instruction;
  const profile = await api(`${API}/supervisor/profile`);
  const passwords: Array<{ account_name: string; password: string }> =
    await api(`${API}/supervisor/account_passwords`);
  if (!Array.isArray(passwords)) {
    throw new Error(`supervisor/account_passwords returned ${JSON.stringify(passwords).slice(0, 200)}`);
  }

  const T = "aw", AGENT = `a_${taskId}`, TASK = `t_${taskId}`;
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(T, AGENT);

  const appPlugins = appworldPlugins(catalogue, { apiBaseUrl: API });
  const plugins: Plugin[] = [...appPlugins, builtinToolsPlugin(store, () => plugins)];
  for (const p of plugins) {
    await store.addMount({
      tenantId: T, agentId: AGENT, alias: p.id, plugin: p.id,
      installationId: `inst-${p.id}`, connectionId: null, toolVersion: "1.0.0",
      publicConfig: { account: profile.email }, secretRef: `aw:${p.id}`,
    });
  }
  // Configuration time, done by the operator — not by the agent.
  const secrets: SecretResolver = {
    async resolve(ref) {
      const app = ref.replace(/^aw:/, "");
      const pw = passwords.find((p) => p.account_name === app);
      if (!pw) return null;
      const username = app === "phone" ? profile.phone_number : profile.email;
      return JSON.stringify({ username, password: pw.password });
    },
  };
  const gw = new ToolGateway(store, plugins, secrets);
  const ctx = { tenantId: T, agentId: AGENT, taskId: TASK };
  const host = { invoke: (c: { tool: string; args: any }): Promise<ToolResult> => gw.invoke(ctx, c.tool, c.args) };

  const every: MountedTool[] = qualifyMountedTools(
    plugins.flatMap((p) =>
      p.tools.map((t) => ({
        name: t.name, description: t.summary, parameters: t.parameters,
        address: `${p.id}.${t.name}`,
      })),
    ),
  );
  // One mechanism, one knob. `all` disables narrowing; `narrow` applies the
  // measured threshold and lets discovery widen the offer as the agent works.
  const pinned = (t: MountedTool) =>
    t.name === "run_js" || t.address.startsWith("tools.") || t.address.startsWith("supervisor.");
  const maxOffered = MODE === "all" ? Number.MAX_SAFE_INTEGER : Number(process.env.MAX_OFFERED ?? 32);
  const catalogueNote = MODE === "all" ? "" :
    `\n\n# Finding tools\nYou are mounted on: ${appPlugins.map((p) => `${p.id} (${p.tools.length} APIs)`).join(", ")}.` +
    `\nOnly a few tools are offered directly. Use tools.search to find others by keyword;` +
    ` anything it returns becomes callable on your next turn.`;

  const harness = new HybridHarness({
    maxTurns: MAX_TURNS, catalogue: every, maxOffered, isPinned: pinned,
  });
  await store.createTask(T, AGENT, TASK, await harness.initialize({
    policy: SYSTEM_EXTRA + catalogueNote,
  }));
  // Split every prompt into its two parts. The narrowing arm spent 5x the
  // uncached tokens of the all-tools arm and I guessed twice at why; this
  // measures it instead: is the cost the tool block, or the transcript?
  const compose = { calls: 0, toolBytes: 0, msgBytes: 0 };
  const measured = {
    id: model.id,
    async complete(m: any, o: any) {
      compose.calls++;
      compose.msgBytes += JSON.stringify(m).length;
      compose.toolBytes += JSON.stringify(o?.tools ?? []).length;
      return model.complete(m, o);
    },
  } as any;
  const commands = new CommandExecutor(store, measured, host, new QuickJsExecutor());
  const kernel = new Kernel(store, harness, { holder: "aw", leaseTtlMs: 600_000 });

  await store.appendEvent({
    tenantId: T, agentId: AGENT, taskId: TASK, kind: "message", payload: { text: instruction },
  });
  let steps = 0, ended = "step_budget";
  for (; steps < 400; steps++) {
    const r = await kernel.step(T, TASK, null, (cmd) => commands.dispatch(ctx, cmd));
    if (r.outcome === "no_work") { ended = "no_work"; break; }
    const t = await store.loadTask(T, TASK);
    if (t && ["completed", "failed", "blocked"].includes(t.status)) { ended = t.status; break; }
  }

  const usage = commands.trace.filter((x) => x.kind === "model")
    .reduce((a: any, x: any) => ({
      calls: a.calls + 1,
      prompt: a.prompt + (x.detail.prompt ?? 0),
      cached: a.cached + (x.detail.cached ?? 0),
      out: a.out + (x.detail.completion ?? 0),
    }), { calls: 0, prompt: 0, cached: 0, out: 0 });
  const toolCalls = commands.trace.filter((x) => x.kind === "tool").length;
  const finalState = (await store.loadTask(T, TASK))?.checkpoint as any;
  const jsCalls = commands.trace.filter((x) => x.kind === "js").length;
  if (verbose) {
    for (const x of commands.trace.filter((t) => t.kind === "tool").slice(0, 40)) {
      console.log(`      ${(x.detail as any).tool} -> ${(x.detail as any).status}`);
    }
  }

  // Without `report`, /evaluate answers with structured fields. With it, the
  // same call returns a formatted text block — which silently defeated every
  // attempt to read a result out of it.
  const evalOut = await post(`${ENV}/evaluate`, { task_id: taskId, suppress_errors: true });
  const rep = evalOut.output ?? evalOut;
  if (process.env.DUMP_EVAL) console.log("      eval:", JSON.stringify(rep).slice(0, 400));
  if (typeof rep?.success !== "boolean") {
    throw new Error(`evaluate returned no success field: ${JSON.stringify(rep).slice(0, 200)}`);
  }
  const success: boolean = rep.success;
  // Deliberately not calling /close: in remote-apis mode AppWorld's close_all
  // raises (unset_remote_date_and_time missing an argument) and leaves the API
  // server with no database bound, so the next task sees "no such table".
  // Each /initialize rebinds the world, which is all we need.
  await store.close();

  return {
    taskId, success, ended, steps, toolCalls, jsCalls, ...usage,
    seconds: Math.round((Date.now() - t0) / 1000),
    promotions: harness.promotions,
    toolTok: Math.round(compose.toolBytes / 4),
    msgTok: Math.round(compose.msgBytes / 4),
    offeredEnd: (finalState?.offered ?? []).length,
    usedEnd: (finalState?.used ?? []).length,
    difficulty: rep.difficulty ?? null,
    numTests: rep.num_tests ?? 0,
    passedTests: (rep.passes ?? []).length,
    failures: (rep.failures ?? []).map((f: any) => String(f.requirement ?? "").slice(0, 110)).slice(0, 2),
  };
}

const selected = taskIds.slice(OFFSET, OFFSET + N);
console.log(`\n  AppWorld ${SPLIT} — ${selected.length} tasks, tools=${MODE}, ` +
  `model ${process.env.HARNESS_MODEL ?? "deepseek-v4-pro"}\n  ${"─".repeat(84)}`);
const rows: any[] = [];
for (const id of selected) {
  let r;
  try { r = await runTask(id); }
  catch (e) {
    r = { taskId: id, success: false, ended: `error: ${(e as Error).message.slice(0, 70)}`,
          steps: 0, toolCalls: 0, jsCalls: 0, calls: 0, prompt: 0, cached: 0, out: 0, seconds: 0,
          failures: [], numTests: 0, passedTests: 0, difficulty: null };
  }
  rows.push(r);
  console.log(`  ${r.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.taskId.padEnd(12)} ` +
    `${String(r.ended).padEnd(12)} ${String(r.toolCalls).padStart(3)} tools / ${String(r.jsCalls).padStart(2)} js / ` +
    `${String(r.calls).padStart(2)} model / ${String(r.prompt).padStart(7)} tok / ${r.seconds}s` +
    ` / offer ${r.offeredEnd ?? "-"} (+${r.promotions ?? 0}) used ${r.usedEnd ?? "-"}`);
  for (const f of r.failures ?? []) console.log(`      \x1b[31m${f}\x1b[0m`);
}
const pass = rows.filter((r) => r.success).length;
const sum = (k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
console.log(`  ${"─".repeat(84)}`);
console.log(`  TGC ${pass}/${rows.length}   tools=${MODE}   ` +
  `prompt ${sum("prompt")} (cached ${sum("cached")})   out ${sum("out")}   ` +
  `tool calls ${sum("toolCalls")}   js ${sum("jsCalls")}   ${sum("seconds")}s\n`);
