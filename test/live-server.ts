/** The whole thing over HTTP: start the server + scheduler with a real model and
 *  a real SaaS, post a message, follow the SSE stream, read the answer back. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SqliteStore } from "../src/store/sqlite.ts";
import { createApi } from "../src/api/server.ts";
import { Scheduler } from "../src/runtime/scheduler.ts";
import { Kernel } from "../src/runtime/kernel.ts";
import { CommandExecutor } from "../src/runtime/commands.ts";
import { CodegenHarness } from "../src/harness/codegen.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { R2Artifacts } from "../src/store/artifacts.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import { builtinToolsPlugin } from "../src/plugins/builtin.ts";
import { artifactsPlugin } from "../src/plugins/artifacts.ts";
import type { ToolResult } from "../src/core/tools.ts";

for (const line of readFileSync(`${homedir()}/.secrets/agent-harness.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]!] = m[2]!;
}
const KEY = "demo-key", TENANT = "tenant-a", BUCKET = "harness-p0-artifacts";

const store = new SqliteStore(":memory:");
await store.init();
const artifacts = new R2Artifacts({
  endpoint: process.env.R2_ENDPOINT!, accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!, bucket: BUCKET,
});
const plugins = [githubPlugin, artifactsPlugin(artifacts, BUCKET), builtinToolsPlugin(store, () => plugins)];
const gw = new ToolGateway(store, plugins);
const harness = new CodegenHarness({ maxTurns: 10 });
const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!,
  model: process.env.HARNESS_MODEL ?? "deepseek-v4-pro",
});

const makeHost = (ctx: { tenantId: string; agentId: string; taskId: string }) => ({
  async invoke(call: { tool: string; args: any }): Promise<ToolResult> {
    const res = await gw.invoke(ctx, call.tool, call.args);
    if (res.status !== "succeeded") return res;
    const b = JSON.stringify(res.result);
    if (b.length <= 32 * 1024) return res;
    const stored = await artifacts.put(`t/${ctx.tenantId}/${ctx.agentId}/${res.operationId}.json`, b, "application/json");
    await store.completeOperation(ctx.tenantId, res.operationId, "succeeded", stored.ref);
    const items = Array.isArray(res.result) ? (res.result as any[]) : [];
    return {
      status: "succeeded", operationId: res.operationId,
      result: {
        ref: stored.ref, bytes: stored.bytes, count: items.length,
        preview: items.slice(0, 5).map((i) => ({ number: i.number, title: i.title })),
        note: "parked; read with artifacts.read { ref, fields, offset, limit }",
      },
    };
  },
});

const scheduler = new Scheduler(store, async (tenantId, taskId) => {
  const task = await store.loadTask(tenantId, taskId);
  if (!task) return;
  const ctx = { tenantId, agentId: task.agentId, taskId };
  const commands = new CommandExecutor(store, model, makeHost(ctx));
  const kernel = new Kernel(store, harness, { holder: "api-worker", leaseTtlMs: 120_000 });
  return kernel.step(tenantId, taskId, null, (cmd) => commands.dispatch(ctx, cmd));
}, { intervalMs: 200 });

const server = createApi(store, {
  tokens: new Map([[KEY, TENANT]]),
  async onNewTask(tenantId, agentId, taskId) {
    await store.createTask(tenantId, agentId, taskId, await harness.initialize({
      mounts: (await store.listMounts(tenantId, agentId)).map((m) => ({
        alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
      })),
    }));
  },
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
scheduler.start();

const call = async (method: string, path: string, body?: unknown) =>
  (await fetch(base + path, {
    method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })).json();

console.log(`\n  server: ${base}`);
const { agentId } = await call("POST", "/agents", {});
for (const m of [
  { alias: "tools", plugin: "tools" }, { alias: "artifacts", plugin: "artifacts" },
  { alias: "gh_public", plugin: "github" },
]) {
  await store.addMount({
    tenantId: TENANT, agentId, alias: m.alias, plugin: m.plugin,
    installationId: `inst-${m.alias}`, connectionId: null, toolVersion: "1.0.0",
    publicConfig: { account: m.plugin === "github" ? "unauthenticated" : "builtin" }, secretRef: null,
  });
}
const { threadId } = await call("POST", `/agents/${agentId}/threads`, {});
const TEXT = process.argv[2] ?? "nodejs/node 最近 30 个 open issue 里，标题以 'test' 或 'test_runner' 开头的有几个？列出编号和标题。";
const msg = await call("POST", `/threads/${threadId}/messages`, { text: TEXT, requestId: "demo-1" });
console.log(`  POST /threads/${threadId}/messages -> ${msg.taskId}\n  task:   ${TEXT}\n  ${"─".repeat(70)}`);

// Follow the event stream exactly as a disconnected client would resume.
const res = await fetch(`${base}/agents/${agentId}/events?after=0`, { headers: { authorization: `Bearer ${KEY}` } });
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buf = "", answer: string | null = null, lastSeq = 0;
const deadline = Date.now() + 300_000;
outer: while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const frames = buf.split("\n\n");
  buf = frames.pop() ?? "";
  for (const f of frames) {
    const id = /^id: (\d+)$/m.exec(f);
    const data = /^data: (.*)$/m.exec(f);
    if (!data) continue;
    lastSeq = Number(id?.[1] ?? lastSeq);
    const e = JSON.parse(data[1]!);
    if (e.kind === "model.response") {
      const u = e.payload.usage;
      console.log(`  [${e.sequence}] model     prompt ${u.promptTokens} (cached ${u.cachedPromptTokens}) / out ${u.completionTokens}`);
    } else if (e.kind === "js.result") {
      console.log(`  [${e.sequence}] js        ${e.payload.status}, ops ${e.payload.acceptedOperationIds.join(",") || "-"}`);
    } else if (e.kind === "operation.completed") {
      console.log(`  [${e.sequence}] operation ${e.payload.operationId} ${e.payload.status}${e.payload.resultRef ? ` -> ${e.payload.resultRef}` : ""}`);
    } else {
      console.log(`  [${e.sequence}] ${e.kind}`);
    }
  }
  const tasks = await call("GET", `/agents/${agentId}/tasks`);
  const t = tasks.tasks.find((x: any) => x.taskId === msg.taskId);
  if (t && ["completed", "failed", "blocked"].includes(t.status)) {
    const task = await store.loadTask(TENANT, msg.taskId);
    answer = (task!.checkpoint as any).messages.at(-1).content;
    break outer;
  }
}
console.log(`  ${"─".repeat(70)}\n  ANSWER:\n${String(answer).split("\n").map((l) => "    " + l).join("\n")}`);
const tasks = await call("GET", `/agents/${agentId}/tasks`);
console.log(`\n  GET /agents/${agentId}/tasks -> ${JSON.stringify(tasks.tasks[0])}`);
console.log(`  resumable cursor: ${lastSeq}\n`);
scheduler.stop();
server.close();
await store.close();
process.exit(0);
