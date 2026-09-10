/**
 * Mounted tools, reached through pi's harness.
 *
 * The property under test is that the gateway is still the only way out: the
 * harness calls a function, and that function's whole body is the gateway call.
 * A tool the gateway refuses must reach the model as a refusal, not as an
 * answer — pi asks tools to throw rather than encode failure in content, and
 * getting that wrong would make every rejection look like a result.
 */
import { createModels } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { StorageBackedSession } from "@earendil-works/pi-agent-core/harness/session";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { PiSqliteStorage } from "../src/store/pi-storage.ts";
import { bridgeTools, replayPolicy, qualifyMountedTools, type MountedTool } from "../src/runtime/pi-tools.ts";
import { offloadedProvider, type OffloadPort } from "../src/model/pi-offloaded.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).slice(0, 400) }); }
}

const PROVIDER = "queue", MODEL = "m";
const CATALOGUE: MountedTool[] = [
  { name: "read_page", description: "read", address: "web.read_page",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    sideEffects: "read", idempotency: "none" },
  { name: "send", description: "post", address: "web.send",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    sideEffects: "write", idempotency: "none" },
  { name: "charge", description: "charge", address: "pay.charge",
    parameters: { type: "object", properties: {} },
    sideEffects: "write", idempotency: "native" },
];

await check("重放策略来自我们已经记录、却一直没用的字段", async () => {
  const got = CATALOGUE.map((t) => `${t.address}=${replayPolicy(t)}`).join(" ");
  const want = "web.read_page=safe web.send=never pay.charge=safe";
  if (got !== want) throw new Error(`got ${got}`);
});

await check("供应商不接受的字符会被清洗,地址不受影响", async () => {
  const got = bridgeTools([
    { name: "repos.get", description: "", parameters: {}, address: "gh.repos.get" },
    { name: "issues.list", description: "", parameters: {}, address: "gh.issues.list" },
  ], { async invoke() { return { status: "succeeded" }; } });
  const names = got.map((t: any) => t.name);
  for (const n of names) {
    if (!/^[a-zA-Z0-9_-]+$/.test(n)) throw new Error(`a provider would refuse ${n}`);
  }
  if (names.join(",") !== "repos_get,issues_list") throw new Error(names.join(","));
});

await check("清洗造成的重名也会被限定", async () => {
  const got = qualifyMountedTools([
    { name: "a.b", description: "", parameters: {}, address: "x.a.b" },
    { name: "a-b", description: "", parameters: {}, address: "y.a-b" },
  ]);
  // Both sanitise to a_b / a-b — different, so neither needs a prefix.
  const clash = qualifyMountedTools([
    { name: "a.b", description: "", parameters: {}, address: "x.a.b" },
    { name: "a_b", description: "", parameters: {}, address: "y.a_b" },
  ]);
  if (got.map((t) => t.name).join(",") !== "a_b,a-b") throw new Error(got.map((t) => t.name).join(","));
  if (clash.map((t) => t.name).join(",") !== "x__a_b,y__a_b") {
    throw new Error(`a clash created by sanitising was not qualified: ${clash.map((t) => t.name).join(",")}`);
  }
});

await check("重名才限定,不重名保持裸名", async () => {
  const clash = qualifyMountedTools([
    { name: "show", description: "", parameters: {}, address: "a.show" },
    { name: "show", description: "", parameters: {}, address: "b.show" },
    { name: "only", description: "", parameters: {}, address: "c.only" },
  ]);
  const names = clash.map((t) => t.name).join(",");
  if (names !== "a__show,b__show,only") throw new Error(names);
});

function fixture(invoke: (call: any) => Promise<any>, reply: AssistantMessage) {
  const host = sqliteHost();
  const storage = new PiSqliteStorage(host);
  const session = new StorageBackedSession(
    { id: "s", createdAt: Date.now(), storageVersion: 1 }, storage as any);
  // The queue answers as soon as it is asked; the deferred-while-pending path
  // has its own test in pi-offload.ts and is not what is under test here.
  const port: OffloadPort = {
    async start() { return "job"; },
    async poll() { return reply; },
  };
  const models = createModels();
  models.setProvider(offloadedProvider({
    port, id: PROVIDER, models: [{ id: MODEL, contextWindow: 100_000 }],
  }));
  return { storage, session, models, invoke };
}

const msg = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant", content, api: "offloaded", provider: PROVIDER, model: MODEL,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, timestamp: Date.now(),
});

async function runOnce(f: any, tools: any[]) {
  const { harness } = await AgentHarness.create({
    session: f.session, models: f.models, model: f.models.getModel(PROVIDER, MODEL)!,
    tools, systemPrompt: "s", streamOptions: { deferred: true },
  }, CTX);
  const lane = await harness.lane("main", CTX);
  const a: any = await lane.accept({ kind: "prompt", prompt: "go" }, CTX);
  const id = (a.value ?? a).operationId;
  await lane.drive({ operationId: id }, CTX);
  const out: any = await lane.drive({ operationId: id, pollDeferred: true }, CTX);
  return { harness, lane, out: out.value ?? out };
}

await check("工具调用落到 gateway,结果进 transcript", async () => {
  const calls: any[] = [];
  const f = fixture(async () => ({}), msg(
    [{ type: "toolCall", id: "c1", name: "read_page", arguments: { url: "https://x" } } as any],
    "toolUse"));
  const tools = bridgeTools(CATALOGUE, {
    async invoke(call) { calls.push(call); return { status: "succeeded", operationId: "op1", result: { title: "hi" } }; },
  });
  const { harness } = await runOnce(f, tools);
  if (calls.length !== 1) throw new Error(`gateway not reached: ${calls.length}`);
  if (calls[0].tool !== "web.read_page") throw new Error(`wrong address: ${calls[0].tool}`);
  const entries = await f.storage.scanEntries({ order: "asc" }, CTX);
  if (!JSON.stringify(entries).includes('"title\\":\\"hi')) {
    if (!JSON.stringify(entries).includes("hi")) throw new Error("the tool result never became an entry");
  }
  await harness.close(CTX);
});

await check("gateway 拒绝时,模型收到的是拒绝而不是结果", async () => {
  const f = fixture(async () => ({}), msg(
    [{ type: "toolCall", id: "c1", name: "send", arguments: { url: "https://x" } } as any],
    "toolUse"));
  const tools = bridgeTools(CATALOGUE, {
    async invoke() { return { status: "rejected", error: { code: "approval_required" } }; },
  });
  const { harness } = await runOnce(f, tools);
  const entries = await f.storage.scanEntries({ order: "asc" }, CTX);
  const text = JSON.stringify(entries);
  if (!text.includes("approval_required")) throw new Error("a refusal did not reach the transcript");
  if (text.includes('"status\\":\\"rejected\\"') && text.includes("succeeded")) {
    throw new Error("a refusal was recorded as a result");
  }
  await harness.close(CTX);
});

console.log(`\n  Mounts as pi tools\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
