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
import { bridgeTools, offersPlugin, replayPolicy, qualifyMountedTools, withholdTools, runJsTool, type MountedTool, closestNames } from "../src/runtime/pi-tools.ts";
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

await check("runJsTool 的换名表: 模型看到的名字查到地址,地址原样通过", async () => {
  // What this proves is narrow: the table in runJsTool maps an offered name to
  // its address and passes an address through. The sandbox here is a stub that
  // calls invoke directly, so it never meets the parser both executors run
  // first — and on 2026-09-13 that parser refused every offered name before
  // this table could see it, while this case stayed green under a title that
  // claimed the sandbox accepted them (Piper, Rex, Dora). The claim that a
  // script can use the offered names is made by the real-executor case below.
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
  // An unknown dotted name is the gateway's to refuse, with its own message.
  // (An unknown name in the model's own form is refused by runJsTool itself,
  // with candidates — the real-executor case below covers that.)
  await (tool as any).execute("c2", { source: "nonsense.tool" });
  if (calls[2] !== "nonsense.tool") throw new Error(`a lookup swallowed an unknown dotted name: ${calls[2]}`);
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

await check("run_js 里写错模型自己那套名字,答'没有这个工具'并给出候选,而不是'名字不合法'", async () => {
  // #255 made `alias__tool` the shape a script uses; a typo in it then reached
  // the gateway and came back as "not a tool name", contradicting that rule
  // (Piper, 2026-09-13). Through the real executor, as the model hits it.
  const { QuickJsExecutor } = await import("../src/runtime/executor.ts");
  const seen: string[] = [];
  const host = { async invoke(call: any) { seen.push(call.tool); return { status: "succeeded", operationId: "op", result: {} }; } };
  const tool: any = runJsTool(new QuickJsExecutor() as any, host as any, {
    tools: qualifyMountedTools([named("get", "state.get"), named("put", "state.put"), named("get", "web.get")]),
  });
  const run = async (name: string) => {
    seen.length = 0;
    const out = await tool.execute(`u-${name}`, { source: `const r = await tool\`${name} \${{}}\`; output([r.status, r.error?.code ?? null, r.error?.candidates ?? null, r.error?.message ?? null]);` });
    const [[status, code, candidates, message]] = JSON.parse(out.content[0].text);
    return { seen: [...seen], status, code, candidates, message };
  };
  // "gte", not "gett": a typo that already contains the right name would pass a
  // check on the message whether or not the message named anything.
  const typo = await run("state__gte");
  if (typo.seen.length !== 0) throw new Error(`an unknown offered-form name reached the host: ${typo.seen}`);
  if (typo.code !== "unknown_tool") throw new Error(`a typo was answered with ${typo.code}, not unknown_tool`);
  // Checked before the ranking below, so a switch to the address table is caught
  // here by name rather than by whichever ranking check happens to throw first
  // (Piper, 2026-09-13).
  // Names offered to the model only, never a dispatch address: candidates come
  // from the offered-name table, and that is the whole reason this message may
  // name tools at all (the refusal rule pinned in test/plugin-enable.ts). A
  // refactor that ranked the address table instead would leak `state.get` here.
  if ((typo.candidates ?? []).some((c: string) => c.includes("."))) {
    throw new Error(`a candidate is a dispatch address: ${JSON.stringify(typo.candidates)}`);
  }
  if (/state\.(get|put)/.test(String(typo.message))) throw new Error(`the message names a dispatch address: ${typo.message}`);
  if (typo.candidates?.[0] !== "state__get") throw new Error(`the likely name was not offered first: ${JSON.stringify(typo.candidates)}`);
  // The message itself names it, since that is what reaches the model even when
  // a script does not print the candidates field.
  if (!String(typo.message).includes("state__get")) throw new Error(`the message does not name the likely tool: ${typo.message}`);
  const alias = await run("stat__get");
  if (alias.code !== "unknown_tool" || !String(alias.candidates?.[0]).startsWith("state__")) {
    throw new Error(`a mistyped alias did not point at the near names: ${JSON.stringify(alias)}`);
  }
  // A dotted name is still the gateway's to answer, in its own words.
  const dotted = await run("state.gett");
  if (dotted.seen.join() !== "state.gett") throw new Error(`a dotted name was intercepted: ${JSON.stringify(dotted)}`);
});

await check("工具列表为空时,run_js 说'列表是空的',而不是暗示拼错了", async () => {
  // Every plugin switched off still leaves a working run_js with nothing to
  // call. "No tool named X" would read as a typo and invite another name, which
  // fails again; the refusal must not be satisfiable by trying a different name.
  const { QuickJsExecutor } = await import("../src/runtime/executor.ts");
  const seen: string[] = [];
  const host = { async invoke(call: any) { seen.push(call.tool); return { status: "succeeded", operationId: "op", result: {} }; } };
  const tool: any = runJsTool(new QuickJsExecutor() as any, host as any, { tools: [] });
  const out = await tool.execute("empty-1", { source: "const r = await tool`state__get ${{}}`; output([r.status, r.error?.code ?? null, r.error?.message ?? null]);" });
  const [[status, code, message]] = JSON.parse(out.content[0].text);
  if (seen.length !== 0) throw new Error(`a call reached the host with no tools offered: ${seen}`);
  if (status !== "rejected" || code !== "no_tools") throw new Error(`an empty list was answered with ${status}/${code}`);
  if (!String(message).includes("empty") || String(message).includes("state__get")) {
    throw new Error(`the refusal does not say the list is empty, or still reads as a typo: ${message}`);
  }
});

await check("closestNames 直接测: 同别名优先 · 最长共同前缀排前 · 至多 limit 个", async () => {
  // Exported so the ranking can be tested without an executor, and until now no
  // test imported it: its contract was covered only inside executor cases, where
  // an earlier assertion can throw first and skip it (Dora, 2026-09-13).
  const names = ["state__get", "state__put", "state__list", "web__get", "web__post"];
  const first = closestNames("state__gte", names);
  if (first[0] !== "state__get") throw new Error(`closestNames ranked ${JSON.stringify(first)} for state__gte`);
  if (first.some((n) => !n.startsWith("state__"))) throw new Error(`a same-alias typo was offered another alias: ${JSON.stringify(first)}`);
  const alias = closestNames("stat__get", names);
  if (!alias[0]!.startsWith("state__")) throw new Error(`a mistyped alias did not fall back to the nearest names: ${JSON.stringify(alias)}`);
  if (closestNames("state__gte", names, 2).length !== 2) throw new Error("the limit was not applied");
  if (closestNames("anything", []).length !== 0) throw new Error("names were invented from an empty list");
  // An alias containing "__": the group is found by comparison, not by the part
  // before the first "__". Two mounts share that part here (my__gh, my__gl), so a
  // split would group them together and offer my__gl's names for a typo on
  // my__gh; comparison keeps only the mount the typed name belongs to.
  const nested = closestNames("my__gh__isue", ["my__gh__issues", "my__gl__issues", "web__get"]);
  if (nested[0] !== "my__gh__issues" || nested.some((n) => !n.startsWith("my__gh__"))) {
    throw new Error(`a typo under the alias my__gh was offered other mounts' names: ${JSON.stringify(nested)}`);
  }
});

await check("关掉的挂载: run_js 里用它的名字,回'被关了、要人去开',不给无关候选", async () => {
  // A session older than the switch still holds gh__issues_list. Before, that
  // name missed the offered table and got "no tool named …; closest: web__get",
  // so the model tried an unrelated tool. The gateway already had the true
  // sentence, reachable only by a dispatch address (Piper, 2026-09-13).
  const { QuickJsExecutor } = await import("../src/runtime/executor.ts");
  const { switchedOffMessage } = await import("../src/runtime/gateway.ts");
  const seen: string[] = [];
  const host = { async invoke(call: any) { seen.push(call.tool); return { status: "succeeded", operationId: "op", result: {} }; } };
  const { pluginUnavailableMessage } = await import("../src/runtime/gateway.ts");
  const make = (tools: any[], off: string[], unavailable: Array<[string, string]> = []) => runJsTool(new QuickJsExecutor() as any, host as any, {
    tools,
    unoffered: [
      ...off.map((alias) => ({ alias, plugin: "github", reason: "switched_off" as const })),
      ...unavailable.map(([alias, plugin]) => ({ alias, plugin, reason: "plugin_unavailable" as const })),
    ],
  }) as any;
  const run = async (tool: any, name: string) => {
    seen.length = 0;
    const out = await tool.execute(`off-${name}`, { source: `const r = await tool\`${name} \${{}}\`; output([r.status, r.error?.code ?? null, r.error?.message ?? null, r.error?.candidates ?? null]);` });
    const [[status, code, message, candidates]] = JSON.parse(out.content[0].text);
    return { seen: [...seen], status, code, message, candidates };
  };
  const withTools = make(qualifyMountedTools([named("get", "web.get")]), ["gh"], [["box", "run9"]]);
  const off = await run(withTools, "gh__issues_list");
  if (off.seen.length !== 0) throw new Error(`a switched-off mount's name reached the host: ${off.seen}`);
  if (off.code !== "plugin_disabled") throw new Error(`a switched-off mount was answered as ${off.code}: ${off.message}`);
  if (off.message !== switchedOffMessage("gh")) throw new Error(`the answer is not the gateway's sentence: ${off.message}`);
  if (off.candidates !== null) throw new Error(`a switched-off mount was offered neighbours: ${JSON.stringify(off.candidates)}`);
  // A mount whose plugin is not installed (or was renamed): its own sentence,
  // naming the plugin, not "switched off" and not neighbours.
  const gone = await run(withTools, "box__run");
  if (gone.code !== "plugin_unavailable") throw new Error(`an unavailable plugin's mount was answered as ${gone.code}: ${gone.message}`);
  if (gone.message !== pluginUnavailableMessage("box", "run9")) throw new Error(`not the gateway's sentence: ${gone.message}`);
  if (gone.candidates !== null) throw new Error(`an unavailable plugin's mount was offered neighbours: ${JSON.stringify(gone.candidates)}`);
  // A typo against an offered tool is still a typo.
  const typo = await run(withTools, "web__gte");
  if (typo.code !== "unknown_tool") throw new Error(`a typo stopped being unknown_tool: ${typo.code}`);
  // Nothing offered at all, but that one mount is off: say it is off, not that the list is empty.
  const empty = make([], ["gh"]);
  const emptyOff = await run(empty, "gh__issues_list");
  if (emptyOff.code !== "plugin_disabled") throw new Error(`with an empty list a switched-off name got ${emptyOff.code}`);
  const emptyOther = await run(empty, "zz__x");
  if (emptyOther.code !== "no_tools") throw new Error(`with an empty list an unrelated name got ${emptyOther.code}`);
});

await check("提供不出来的挂载按【最长别名前缀】正向匹配: 别名里带 __ 也认得", async () => {
  // Splitting at the first "__" gave my__gh__issues_list to an alias "my", so
  // a switched-off mount renamed to my__gh got the typo answer again (Piper,
  // 2026-09-13). And a typo on an offered mount whose alias is longer than a
  // switched-off one must stay a typo.
  const { QuickJsExecutor } = await import("../src/runtime/executor.ts");
  const { switchedOffMessage } = await import("../src/runtime/gateway.ts");
  const host = { async invoke() { return { status: "succeeded", operationId: "op", result: {} }; } };
  const tool: any = runJsTool(new QuickJsExecutor() as any, host as any, {
    tools: qualifyMountedTools([named("list", "gh__eu.list")]),
    unoffered: [
      { alias: "my__gh", plugin: "github", reason: "switched_off" },
      { alias: "gh", plugin: "github", reason: "switched_off" },
    ],
  });
  const run = async (name: string) => {
    const out = await tool.execute(`pfx-${name}`, { source: `const r = await tool\`${name} \${{}}\`; output([r.status, r.error?.code ?? null, r.error?.message ?? null]);` });
    const [[status, code, message]] = JSON.parse(out.content[0].text);
    return { status, code, message };
  };
  const nested = await run("my__gh__issues_list");
  if (nested.code !== "plugin_disabled" || nested.message !== switchedOffMessage("my__gh")) {
    throw new Error(`an alias containing __ was not recognised as switched off: ${nested.code} ${nested.message}`);
  }
  const typoOnOffered = await run("gh__eu__lst");
  if (typoOnOffered.code !== "unknown_tool") {
    throw new Error(`a typo on the offered gh__eu mount was attributed to the switched-off gh: ${typoOnOffered.code} ${typoOnOffered.message}`);
  }
  const plain = await run("gh__issues_list");
  if (plain.code !== "plugin_disabled" || plain.message !== switchedOffMessage("gh")) {
    throw new Error(`the plain switched-off alias stopped matching: ${plain.code} ${plain.message}`);
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

await check("模型给这次调用的 id 跟着请求走,原样交给 host", async () => {
  // pi hands `execute` the id it put on `model.response.toolCalls[]`, and the
  // console pairs a `tool.result` with that same id. Passing it on is what lets
  // the operation the call starts be lined up with the card the person is
  // looking at, instead of being matched by wording.
  const seen: any[] = [];
  const [tool] = bridgeTools([named("get", "web.get")],
    { async invoke(call: any) { seen.push(call); return { status: "succeeded", operationId: "op" }; } });
  await (tool as any).execute("toolu_abc", {});
  if (seen.length !== 1) throw new Error(`the host was called ${seen.length} times`);
  if (seen[0].callId !== "toolu_abc") throw new Error(`the host was handed callId ${JSON.stringify(seen[0].callId)}`);
  // And it is written down, not acted on: nothing about how the call runs changed.
  if (seen[0].opts?.callId !== undefined) throw new Error("the id leaked into the options that decide how the call runs");
});

await check("一次 run_js 里的每个 host 调用同属一个 callId,而幂等键各不相同", async () => {
  // The distinction the two fields exist for: `idempotencyKey` has to DIFFER
  // per request or the second call would be refused as a repeat of the first,
  // and `callId` has to be the SAME or the operations a script starts cannot be
  // attributed to the one call the model made. Collapsing them loses one or the
  // other, and the script case is where they visibly come apart.
  const seen: any[] = [];
  const host = { async invoke(call: any) { seen.push(call); return { status: "succeeded", operationId: "op" }; } };
  const sandbox = {
    async execute(_source: string, h: any) {
      await h.invoke({ tool: "web.get", args: {} });
      await h.invoke({ tool: "web.get", args: {} });
      return { status: "completed", outputs: [], hostCalls: 2 };
    },
  };
  const tool: any = runJsTool(sandbox as any, host as any, { tools: qualifyMountedTools([named("get", "web.get")]) });
  await tool.execute("toolu_js", { source: "x" });
  if (seen.length !== 2) throw new Error(`expected two host calls, got ${seen.length}`);
  if (!seen.every((c) => c.callId === "toolu_js")) {
    throw new Error(`the two calls name ${JSON.stringify(seen.map((c) => c.callId))}`);
  }
  const keys = seen.map((c) => c.opts?.idempotencyKey);
  if (new Set(keys).size !== 2) throw new Error(`the idempotency keys did not differ: ${JSON.stringify(keys)}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
