/**
 * Full agent loop against a real model and a real SaaS.
 * user message -> model -> JS in QuickJS -> gateway -> GitHub -> back into context -> answer.
 * Every hop goes through the kernel: events, checkpoint, outbox, operations.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { Kernel } from "../src/runtime/kernel.ts";
import { CommandExecutor } from "../src/runtime/commands.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { CodegenHarness } from "../src/harness/codegen.ts";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { R2Artifacts } from "../src/store/artifacts.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import { builtinToolsPlugin } from "../src/plugins/builtin.ts";
import { artifactsPlugin } from "../src/plugins/artifacts.ts";
import type { ToolResult } from "../src/core/tools.ts";

for (const line of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

const TASK_TEXT =
  process.argv[2] ??
  "查一下 nodejs/node 仓库当前 open 的 issue，把标题里含 'deps' 或 'test' 的挑出来，" +
  "告诉我各自的编号和标题。你需要先自己发现有哪些可用工具。";
const MODEL = process.env.HARNESS_MODEL ?? "deepseek-v4-pro";

const T = "tenant-a", AGENT = "agent-1", TASK = "task-1";
const store = new SqliteStore(":memory:");
await store.init();
await store.createAgent(T, AGENT);
for (const m of [
  { alias: "tools", plugin: "tools", account: "builtin" },
  { alias: "artifacts", plugin: "artifacts", account: "builtin" },
  { alias: "gh_public", plugin: "github", account: "unauthenticated" },
]) {
  await store.addMount({
    tenantId: T, agentId: AGENT, alias: m.alias, plugin: m.plugin,
    installationId: `inst-${m.alias}`, connectionId: null, toolVersion: "1.0.0",
    publicConfig: { account: m.account }, secretRef: null,
  });
}

const ctx = { tenantId: T, agentId: AGENT, taskId: TASK };

const BUCKET = "antiproton-artifacts";
const artifacts = new R2Artifacts({
  endpoint: process.env.R2_ENDPOINT!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  bucket: BUCKET,
});
const OFFLOAD = 32 * 1024;

const plugins = [
  githubPlugin,
  artifactsPlugin(artifacts, BUCKET),
  builtinToolsPlugin(store, () => plugins),
];
const gw = new ToolGateway(store, plugins);

const host = {
  async invoke(call: { tool: string; args: any }): Promise<ToolResult> {
    const res = await gw.invoke(ctx, call.tool, call.args);
    if (res.status !== "succeeded") return res;
    const body = JSON.stringify(res.result);
    if (body.length <= OFFLOAD) return res;
    const stored = await artifacts.put(`t/${T}/${AGENT}/${res.operationId}.json`, body, "application/json");
    await store.completeOperation(T, res.operationId, "succeeded", stored.ref);
    const items = Array.isArray(res.result) ? (res.result as any[]) : [];
    return {
      status: "succeeded", operationId: res.operationId,
      result: {
        ref: stored.ref, bytes: stored.bytes, count: items.length,
        preview: items.slice(0, 5).map((i) => ({ number: i.number, title: i.title })),
        note: `full result parked; read it with tool\`artifacts.read \${ { ref, fields: [...], offset, limit } }\``,
      },
    };
  },
};

const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!,
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: MODEL,
});
const harness = new CodegenHarness({ maxTurns: 12 });
const init = await harness.initialize({
  mounts: (await store.listMounts(T, AGENT)).map((m) => ({
    alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
  })),
});
await store.createTask(T, AGENT, TASK, init);
await store.appendEvent({ tenantId: T, agentId: AGENT, taskId: TASK, kind: "message", payload: { text: TASK_TEXT } });

const commands = new CommandExecutor(store, model, host, new QuickJsExecutor());
const kernel = new Kernel(store, harness, { holder: "worker-1", leaseTtlMs: 120_000 });

console.log(`\n  model: ${model.id}\n  task:  ${TASK_TEXT}\n  ${"─".repeat(72)}`);
const t0 = Date.now();
let steps = 0;
while (steps++ < 24) {
  const before = commands.trace.length;
  const r = await kernel.step(T, TASK, null, (cmd) => commands.dispatch(ctx, cmd));
  for (const tr of commands.trace.slice(before)) {
    if (tr.kind === "model") {
      const d = tr.detail as any;
      console.log(`  → model    prompt ${d.prompt} (cached ${d.cached}) / out ${d.completion} (reasoning ${d.reasoning}) / ${d.finish}`);
    } else if (tr.kind === "js") {
      const d = tr.detail as any;
      console.log(`  → js       ${d.status}, ${d.hostCalls} host call(s)${d.operations.length ? `, ops ${d.operations.join(",")}` : ""}`);
      if (process.env.HARNESS_VERBOSE) {
        console.log(String(d.source).split("\n").map((l: string) => "      | " + l).join("\n"));
        console.log("      => " + JSON.stringify(d.outputs).slice(0, 700));
        if (d.error) console.log("      !! " + JSON.stringify(d.error));
      }
    } else {
      console.log(`  ${"─".repeat(72)}\n  ANSWER:\n${String(tr.detail).split("\n").map((l) => "    " + l).join("\n")}`);
    }
  }
  if (r.outcome === "no_work") break;
  const task = await store.loadTask(T, TASK);
  if (task && ["completed", "failed", "blocked"].includes(task.status)) break;
}

const task = await store.loadTask(T, TASK);
const usage = commands.trace.filter((t) => t.kind === "model").map((t) => t.detail as any);
console.log(`\n  ${"─".repeat(72)}`);
console.log(`  task status:     ${task!.status}   checkpoint v${task!.checkpointVersion}   ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`  model calls:     ${usage.length}   prompt ${usage.reduce((a, b) => a + b.prompt, 0)} (cached ${usage.reduce((a, b) => a + b.cached, 0)}) / completion ${usage.reduce((a, b) => a + b.completion, 0)}`);
console.log(`  js executions:   ${commands.trace.filter((t) => t.kind === "js").length}`);
console.log(`  operations:      ${(await store.pendingEvents(T, TASK, "nobody")).filter((e) => e.kind === "operation.completed").length} completed\n`);
await store.close();
