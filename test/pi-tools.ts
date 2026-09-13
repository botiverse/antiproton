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
import type { Answered } from "../src/model/pi-offloaded.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { StorageBackedSession } from "@earendil-works/pi-agent-core/harness/session";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { PiSqliteStorage } from "../src/store/pi-storage.ts";
import { bridgeTools, offersPlugin, replayPolicy, qualifyMountedTools, withholdTools, runJsTool, type MountedTool } from "../src/runtime/pi-tools.ts";
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

/**
 * A tool that exists only to be named. The naming tests do not care what it
 * does, but `MountedTool` now insists that someone says — so they say the
 * strict thing, which is also what an adapter should say when a remote
 * descriptor does not tell it.
 */
const named = (name: string, address: string, extra: Partial<MountedTool> = {}): MountedTool =>
  ({ name, address, description: "", parameters: {}, sideEffects: "write", ...extra });

await check("重放策略来自我们已经记录、却一直没用的字段", async () => {
  const got = CATALOGUE.map((t) => `${t.address}=${replayPolicy(t)}`).join(" ");
  const want = "web.read_page=safe web.send=never pay.charge=safe";
  if (got !== want) throw new Error(`got ${got}`);
});

await check("供应商不接受的字符会被清洗,地址不受影响", async () => {
  const got = bridgeTools([
    named("repos.get", "gh.repos.get"),
    named("issues.list", "gh.issues.list"),
  ], { async invoke() { return { status: "succeeded" }; } });
  const names = got.map((t: any) => t.name);
  for (const n of names) {
    if (!/^[a-zA-Z0-9_-]+$/.test(n)) throw new Error(`a provider would refuse ${n}`);
  }
  if (names.join(",") !== "gh__repos_get,gh__issues_list") throw new Error(names.join(","));
});

await check("清洗造成的重名在同一个挂载里也会被分开", async () => {
  // Two mounts can no longer collide — the alias is in every name. What can
  // still meet is two tools of the SAME mount whose names sanitise to one
  // string, and that is the case the tie-break exists for.
  const inOneMount = qualifyMountedTools([
    named("a.b", "x.a.b"),
    named("a_b", "x.a_b"),
  ]);
  const names = inOneMount.map((t) => t.name).join(",");
  if (names !== "x__a_b,x__a_b2") throw new Error(`sanitising collapsed two tools into one name: ${names}`);
  // Across mounts there is nothing to resolve: the alias already separates them.
  const across = qualifyMountedTools([
    named("a.b", "x.a.b"),
    named("a_b", "y.a_b"),
  ]);
  if (across.map((t) => t.name).join(",") !== "x__a_b,y__a_b") throw new Error(across.map((t) => t.name).join(","));
});

await check("每个工具都带挂载名,哪怕它本来不重名", async () => {
  // The name a tool is offered under must not depend on what else is mounted.
  // `only` is unique here and still qualified, because the alternative is that
  // mounting something unrelated later renames it — and an agent that wrote the
  // old name down has no way to learn that it changed.
  const all = qualifyMountedTools([
    named("show", "a.show"),
    named("show", "b.show"),
    named("only", "c.only"),
  ]);
  if (all.map((t) => t.name).join(",") !== "a__show,b__show,c__only") {
    throw new Error(all.map((t) => t.name).join(","));
  }
  // The property, stated as the thing that used to fail: one tool's name is
  // the same whether or not the others are there.
  const alone = qualifyMountedTools([named("only", "c.only")]);
  if (alone[0]!.name !== all[2]!.name) {
    throw new Error(`a mount changed another mount's tool name: ${alone[0]!.name} vs ${all[2]!.name}`);
  }
});

await check("限定两次等于限定一次", async () => {
  // Two call sites qualify the same catalogue: the runtime builds it, and
  // `bridgeTools` qualifies whatever it is handed so nobody can pass a provider
  // a name with a dot in it. Under the old collision-only rule the second pass
  // was a no-op; under always-qualify it re-prefixed, and a τ² run went out
  // with `retail__retail__get_order_details` in front of the model — the
  // measurement priced a name nobody intended.
  const t = named;
  const catalogue = [
    t("get_order_details", "retail.get_order_details"),
    t("a.b", "x.a.b"),   // sanitises into
    t("a_b", "x.a_b"),   // the one before it, so this pair exercises the tie-break
  ];
  const once = qualifyMountedTools(catalogue).map((x) => x.name);
  const twice = qualifyMountedTools(qualifyMountedTools(catalogue)).map((x) => x.name);
  if (once.join(",") !== twice.join(",")) {
    throw new Error(`qualifying twice changed the names: ${once.join(",")} vs ${twice.join(",")}`);
  }
  // Stated separately from the round trip, because that is the name the run
  // actually shipped and it should fail by sight.
  if (twice.some((n) => /^(\w+)__\1__/.test(n))) throw new Error(`double prefix: ${twice.join(",")}`);
  // And the bridge is one of those two call sites, so it must be safe on an
  // already-qualified list as well.
  const bridged = bridgeTools(qualifyMountedTools(catalogue) as MountedTool[],
    { async invoke() { return { status: "succeeded" }; } }).map((x: any) => x.name);
  if (bridged.join(",") !== once.join(",")) {
    throw new Error(`the bridge re-qualified names it was handed: ${bridged.join(",")}`);
  }
});

function fixture(invoke: (call: any) => Promise<any>, reply: Answered) {
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

// Builds a message that FINISHED. The offload port cannot produce an aborted
// one — that belongs to a live stream someone cancelled — so a helper feeding
// this fake should not be able to build one either.
const msg = (content: AssistantMessage["content"], stopReason: Answered["stopReason"]): Answered => ({
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

await check("共享资源的插件,其工具不允许并行", async () => {
  // pi runs a turn's tool calls in parallel unless a tool says otherwise. run9
  // keeps one container per mount and creates it if absent, so two calls
  // arriving together both find nothing and both create one — and only the
  // last write to the connection state survives. Fifteen containers
  // accumulated that way before the meter made it visible.
  const [shared, plain] = bridgeTools([
    named("shell", "node.shell", { exclusive: true }),
    named("get", "web.get"),
  ], { async invoke() { return { status: "succeeded" }; } }) as any[];
  if (shared.executionMode !== "sequential") {
    throw new Error(`a shared-resource tool was left parallel: ${shared.executionMode}`);
  }
  if ("executionMode" in plain) {
    throw new Error("an ordinary tool was needlessly serialised");
  }
});

await check("工具调用落到 gateway,结果进 transcript", async () => {
  const calls: any[] = [];
  const f = fixture(async () => ({}), msg(
    [{ type: "toolCall", id: "c1", name: "web__read_page", arguments: { url: "https://x" } } as any],
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
    [{ type: "toolCall", id: "c1", name: "web__send", arguments: { url: "https://x" } } as any],
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

await check("扣住的工具不会被提供,其余原样", async () => {
  const cat = [
    named("shell", "node.shell"),
    named("release", "node.release"),
    named("get", "web.get"),
  ];
  const left = withholdTools(cat, ["node.release"]);
  if (left.length !== 2) throw new Error(`expected 2 tools left, got ${left.length}`);
  if (left.some((t) => t.address === "node.release")) throw new Error("the withheld tool was still offered");
  if (!left.some((t) => t.address === "node.shell") || !left.some((t) => t.address === "web.get")) {
    throw new Error("a tool that was not withheld went missing");
  }
  // Nothing withheld means nothing changes — the common case must be a no-op.
  if (withholdTools(cat, []).length !== 3) throw new Error("withholding nothing removed something");
});

await check("沙箱里用的是模型看到的名字,地址也仍然接受", async () => {
  // The prompt tells the model the sandbox reaches "the same tools", so the
  // string that works outside has to work inside. Before this, outside was the
  // registered name and inside was the gateway's address, and nothing said so.
  const calls: any[] = [];
  const host = { async invoke(call: any) { calls.push(call.tool); return { status: "succeeded" }; } };
  const sandbox = {
    async execute(source: string, h: any) {
      for (const name of source.split(",")) await h.invoke({ tool: name, args: {} });
      return { status: "completed", outputs: ["ran"], hostCalls: 2 };
    },
  };
  const tool = runJsTool(sandbox as any, host as any, {
    tools: qualifyMountedTools([named("get", "web.get")]),
  });
  // What the model is handed back. The executor's success status is
  // "completed"; a tool that tests for any other word turns every script that
  // ran into a thrown failure, which is what production did (tygg,
  // 2026-09-12: run_js 返回 "run_js completed: null").
  const done: any = await (tool as any).execute("c1", { source: "web__get,web.get" });
  if (JSON.parse(done.content[0].text)[0] !== "ran") {
    throw new Error(`a completed execution must hand its outputs back: ${JSON.stringify(done)}`);
  }
  if (calls.join(",") !== "web.get,web.get") {
    throw new Error(`the sandbox did not reach the same tool both ways: ${calls.join(",")}`);
  }
  // An unknown name is the gateway's to refuse, with its own message.
  await (tool as any).execute("c2", { source: "nonsense" });
  if (calls[2] !== "nonsense") throw new Error(`a lookup swallowed an unknown name: ${calls[2]}`);
});

await check("run_js 里写模型看到的名字,在真实执行器里也能调到工具", async () => {
  // The case above hands names straight to invoke through a fake sandbox, so it
  // never met the parser both executors run first — which only accepted dotted
  // addresses and refused `web__get` before the mapping could see it. This goes
  // through the real in-process executor: the template tag, the parser, the
  // mapping, the host (tygg's agent, 2026-09-13).
  const { QuickJsExecutor } = await import("../src/runtime/executor.ts");
  const seen: string[] = [];
  const host = { async invoke(call: any) { seen.push(call.tool); return { status: "succeeded", operationId: "op", result: { ok: true } }; } };
  const tool: any = runJsTool(new QuickJsExecutor() as any, host as any, {
    tools: qualifyMountedTools([named("get", "web.get")]),
  });
  const run = async (name: string) => {
    seen.length = 0;
    const out = await tool.execute(`c-${name}`, { source: `const r = await tool\`${name} \${{}}\`; output([r.status, r.error?.code ?? null]);` });
    // output() takes one value; the script reports [status, error code].
    const [[status, code]] = JSON.parse(out.content[0].text);
    return { seen: [...seen], status, code };
  };
  const offered = await run("web__get");
  if (offered.seen.join() !== "web.get" || offered.status !== "succeeded") {
    throw new Error(`the offered name did not reach the tool: ${JSON.stringify(offered)}`);
  }
  const address = await run("web.get");
  if (address.seen.join() !== "web.get") throw new Error(`the address stopped working: ${JSON.stringify(address)}`);
  const bad = await run("web get!");
  if (bad.seen.length !== 0 || bad.code !== "bad_tool_name") {
    throw new Error(`a malformed name was not refused before the host: ${JSON.stringify(bad)}`);
  }
});

await check("Worker 执行器把脚本写的名字原样交给 host", async () => {
  // Production runs run_js in a Dynamic Worker; its calls land in
  // handleSandboxCall, which used to rebuild the name from a parsed address.
  const { executions, handleSandboxCall } = await import("../src/runtime/dynamic-worker-executor.ts");
  const { DEFAULT_LIMITS } = await import("../src/core/execution.ts");
  const seen: string[] = [];
  executions.set("exec-names", {
    host: { async invoke(call: any) { seen.push(call.tool); return { status: "succeeded", operationId: "op", result: {} }; } },
    limits: DEFAULT_LIMITS, hostCalls: 0, inFlight: 0, accepted: [], aborted: false, pending: new Set(),
  } as any);
  try {
    const r = await handleSandboxCall("exec-names", ["web__get ", ""], [{}]);
    if (r.status !== "succeeded" || seen.join() !== "web__get") {
      throw new Error(`the Worker path did not pass the offered name on: ${JSON.stringify({ r, seen })}`);
    }
  } finally {
    executions.delete("exec-names");
  }
});

console.log(`\n  Mounts as pi tools\n  ${"─".repeat(56)}`);
await check("a plugin's presence is asked by plugin and answered from the offered tools", async () => {
  const tool = (alias: string) => [{ name: "put", description: "", parameters: {}, address: `${alias}.put` }] as MountedTool[];
  const rec = (alias: string, plugin: string) => [{ alias, plugin }];
  // The alias is the person's word for the mount, so it cannot be the question.
  if (!offersPlugin(rec("files", "artifacts"), tool("files"), "artifacts")) {
    throw new Error("artifacts under another alias must still count");
  }
  if (offersPlugin(rec("artifacts", "state"), tool("artifacts"), "artifacts")) {
    throw new Error("another plugin under the artifacts alias must not count");
  }
  // Withheld: the mount is there, the tool was not offered.
  if (offersPlugin(rec("files", "artifacts"), [], "artifacts")) {
    throw new Error("a withheld tool must not count as offered");
  }
  if (!offersPlugin(rec("artifacts", "artifacts"), tool("artifacts"), "artifacts")) {
    throw new Error("the ordinary case must still be true");
  }
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
