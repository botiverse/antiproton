/**
 * The kernel's hooks for code that runs after a model turn and when a plugin asked to be woken (`Plugin.afterTurn`,
 * `Plugin.wake`, src/plugins/types.ts; src/runtime/plugin-wakes.ts; `#runPluginHooks`, cf/src/runtime.ts), through
 * the real runtime with the model answered by hand, as in test/turn-stop.ts. Nothing here is RaftBench's: the
 * plugins are this file's own.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { setLogSink } from "../src/core/log.ts";
import type { Plugin, PluginNext, TurnEnd } from "../src/plugins/types.ts";
import { turnEndOf } from "../src/runtime/plugin-wakes.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
/** An end without its id, which is the run's and differs every time. */
const told = (end: TurnEnd) => { const { turnId: _id, ...rest } = end; return rest; };
const logs: any[] = [];
setLogSink((line) => logs.push(JSON.parse(line)));

/** A plugin that declares both hooks and answers each from a script the case sets. */
function watcher(id: string) {
  const seen: Array<{ alias: string; end: TurnEnd }> = [];
  const woken: string[] = [];
  const script: { afterTurn: Array<PluginNext | "throw" | void>; wake: Array<PluginNext | void> } = { afterTurn: [], wake: [] };
  const plugin: Plugin = {
    id, version: "1.0.0", tools: [],
    async invoke() { throw new Error("no tools"); },
    async afterTurn(ctx, end) {
      seen.push({ alias: ctx.alias, end });
      const next = script.afterTurn.shift();
      if (next === "throw") throw new Error("the hook broke");
      return next;
    },
    async wake(ctx) { woken.push(ctx.alias); return script.wake.shift(); },
  };
  return { plugin, seen, woken, script };
}
/** A plugin with neither hook, mounted beside it. */
const quiet: Plugin = { id: "quiet", version: "1.0.0", tools: [], async invoke() { throw new Error("no tools"); } };

async function world(opts: { mountWatcher?: boolean } = {}) {
  const host = sqliteHost();
  const sent: string[] = [];
  const w = watcher("watcher");
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null }, autoRelease: false,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "m1" } as never),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
    extraPlugins: [w.plugin, quiet],
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a", { name: "Ada" } as never);
  await rt.bindOperatorModel("t", "a");
  for (const p of opts.mountWatcher === false ? [quiet] : [w.plugin, quiet]) {
    await rt.store.setPluginChoice("t", "a", p.id, "enable");
    must((await rt.addMount("t", "a", { alias: `${p.id}-m`, plugin: p.id, config: {} })).ok, `mount ${p.id}`);
  }
  return { host, rt, sent, answered: new Set<string>(), ...w };
}
type World = Awaited<ReturnType<typeof world>>;

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
async function steps(w: World) {
  let out = await w.rt.step("t", "a");
  for (let i = 0; i < 5 && out.wakeInMs === 0; i++) out = await w.rt.step("t", "a");
  return out;
}
async function reply(w: World, text: string) {
  await steps(w);
  const id = w.sent.find((x) => !w.answered.has(x));
  must(id, "no model call is out");
  w.answered.add(id);
  const job = await w.rt.takeJob("t", "a", id) as any;
  await w.rt.deliverAnswer("t", "a", id, fromResponse({ text, finishReason: "stop", truncated: false, usage, toolCalls: [] } as ModelResponse,
    { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
  await steps(w);
  return job;
}
const lastUser = (job: any) => {
  const users = (job.context.messages as any[]).filter((m) => m.role === "user");
  const c = users[users.length - 1]?.content;
  return typeof c === "string" ? c : (c as any[]).filter((p) => p.type === "text").map((p) => p.text).join("");
};

await check("a plugin that declares afterTurn is told how the turn ended and the text it ended with, once", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "hello", "prompt", "main");
  await reply(w, "the answer");
  must(show(w.seen.map((s) => ({ alias: s.alias, end: told(s.end) }))) === show([{ alias: "watcher-m", end: { finalText: "the answer", outcome: "completed", turnKey: null } }]), show(w.seen));
  must(typeof w.seen[0]!.end.turnId === "string" && w.seen[0]!.end.turnId.length > 0, "no turn id");
  for (let i = 0; i < 3; i++) await steps(w);
  must(w.seen.length === 1, `told ${w.seen.length} times`);
});

await check("an agent with no mount that declares afterTurn writes nothing down and is asked nothing", async () => {
  const w = await world({ mountWatcher: false });
  await w.rt.postMessage("t", "a", "hello", "prompt", "main");
  await reply(w, "the answer");
  const tables = w.host.sql.exec("SELECT name FROM sqlite_master WHERE name = 'plugin_turn_ends'").toArray();
  const rows = tables.length ? w.host.sql.exec("SELECT COUNT(*) AS n FROM plugin_turn_ends").toArray()[0]!.n : 0;
  must(Number(rows) === 0 && w.seen.length === 0, `rows ${rows}, told ${w.seen.length}`);
});

await check("a turn the hook asks for is posted once, as the next turn's input; its end is told too", async () => {
  const w = await world();
  w.script.afterTurn.push({ turn: "one more, please" });
  await w.rt.postMessage("t", "a", "hello", "prompt", "main");
  await reply(w, "first");
  const job = await reply(w, "second");
  must(lastUser(job) === "one more, please", `the follow-up was ${JSON.stringify(lastUser(job))}`);
  must(show(w.seen.map((s) => s.end.finalText)) === show(["first", "second"]), show(w.seen));
  must(w.host.sql.exec("SELECT COUNT(*) AS n FROM plugin_answers").toArray()[0]!.n === 0, "an answer was left behind");
});

await check("a turn a mount asked for is told to it with its key; a turn it did not ask for has none", async () => {
  const w = await world();
  w.script.afterTurn.push({ turn: "mine", turnKey: "k-1" });
  await w.rt.postMessage("t", "a", "hello", "prompt", "main");
  await reply(w, "first");
  await reply(w, "second");
  const second = w.seen[1]!.end;
  must(second.finalText === "second" && second.turnKey === "k-1" && w.seen[0]!.end.turnKey === null, show(w.seen));
});

await check("a fresh turn starts a conversation of its own: the model is sent none of the one before", async () => {
  const w = await world();
  w.script.afterTurn.push({ turn: "on its own", fresh: true });
  await w.rt.postMessage("t", "a", "remember the word avocado", "prompt", "main");
  await reply(w, "noted");
  const job = await reply(w, "done");
  const sent = show(job.context.messages);
  must(sent.includes("on its own") && !sent.includes("avocado") && !sent.includes("noted"), sent.slice(0, 400));
});

await check("a cancelled turn is told as cancelled, once, though the cancel and the step that follows both see it end", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "hello", "prompt", "main");
  await steps(w);
  const r = await w.rt.stopTurn("t", "a", "provider_stop");
  must(r.result === "interrupted", show(r));
  for (let i = 0; i < 3; i++) await steps(w);
  must(show(w.seen.map((s) => told(s.end))) === show([{ finalText: null, outcome: "cancelled", turnKey: null }]), show(w.seen));
});

await check("cancelTurn ends the running turn through the runtime's own cancel", async () => {
  const w = await world();
  w.script.wake.push({ cancelTurn: true });
  await w.rt.postMessage("t", "a", "hello", "prompt", "main");
  await steps(w);
  must(await (await w.rt.agent("t", "a")).running(), "no turn is running");
  // Asked for through an earlier answer's wakeAt, the way a plugin keeps a deadline.
  const { askWake } = await import("../src/runtime/plugin-wakes.ts");
  askWake(w.host.sql as any, "watcher-m", Date.now());
  await steps(w);
  must(!(await (await w.rt.agent("t", "a")).running()), "the turn still runs");
  must(show(w.woken) === show(["watcher-m"]) && w.seen.some((s) => s.end.outcome === "cancelled"), show({ woken: w.woken, seen: w.seen }));
});

await check("a wake asked for is run when it is due, not before, and once", async () => {
  const w = await world();
  w.script.afterTurn.push({ wakeAt: Date.now() + 60_000 });
  await w.rt.postMessage("t", "a", "hello", "prompt", "main");
  await reply(w, "done");
  const out = await steps(w);
  must(w.woken.length === 0 && out.wakeInMs !== null && out.wakeInMs > 50_000, `woken ${w.woken.length}, wake in ${out.wakeInMs}`);
  const real = Date.now;
  Date.now = () => real() + 61_000;
  try { await steps(w); await steps(w); } finally { Date.now = real; }
  must(show(w.woken) === show(["watcher-m"]), show(w.woken));
});

await check("a hook that throws is logged and its end dropped, not asked again", async () => {
  const w = await world();
  w.script.afterTurn.push("throw");
  await w.rt.postMessage("t", "a", "hello", "prompt", "main");
  logs.length = 0;
  await reply(w, "x");
  for (let i = 0; i < 2; i++) await steps(w);
  must(w.seen.length === 1 && logs.some((l) => l.evt === "plugin.hook" && l.hook === "afterTurn" && l.failed === "the hook broke"), show(logs.filter((l) => l.evt === "plugin.hook")));
});

await check("a switched-off plugin is not asked; the skip is logged", async () => {
  const w = await world();
  await w.rt.store.setPluginChoice("t", "a", "watcher", "disable");
  await w.rt.postMessage("t", "a", "hello", "prompt", "main");
  logs.length = 0;
  await reply(w, "x");
  must(w.seen.length === 0 && logs.some((l) => l.evt === "plugin.hook" && /switched off/.test(l.skipped ?? "")), show(logs.filter((l) => l.evt === "plugin.hook")));
});

await check("a turn whose post was cut off mid-way is not posted again", async () => {
  const w = await world();
  // An answer marked as being posted by a pass that died: the next pass drops it.
  const { keepAnswer, markAnswerPosting, pendingAnswers } = await import("../src/runtime/plugin-wakes.ts");
  keepAnswer(w.host.sql as any, "watcher-m", { turn: "twice?" });
  markAnswerPosting(w.host.sql as any, pendingAnswers(w.host.sql as any)[0]!.seq);
  logs.length = 0;
  await steps(w);
  must(w.sent.length === 0 && pendingAnswers(w.host.sql as any).length === 0, `calls ${w.sent.length}`);
  must(logs.some((l) => l.evt === "plugin.hook" && /not posted again/.test(l.dropped ?? "")), show(logs.filter((l) => l.evt === "plugin.hook")));
});

await check("a turn's end recorded twice, before or after it was handled, is told once", async () => {
  const w = await world();
  const { recordTurnEnd } = await import("../src/runtime/plugin-wakes.ts");
  recordTurnEnd(w.host.sql as any, "op-1", { finalText: null, outcome: "cancelled" }, Date.now());
  recordTurnEnd(w.host.sql as any, "op-1", { finalText: "late", outcome: "completed" }, Date.now());
  await steps(w);
  recordTurnEnd(w.host.sql as any, "op-1", { finalText: "later", outcome: "completed" }, Date.now());
  await steps(w);
  must(show(w.seen.map((s) => s.end)) === show([{ finalText: null, outcome: "cancelled", turnId: "op-1", turnKey: null }]), show(w.seen));
});

await check("turnEndOf: the model's text, a cancel, and a failure with the model's own error", async () => {
  const text = { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }], stopReason: "stop" };
  must(show(turnEndOf("completed", text)) === show({ finalText: "ab", outcome: "completed" }), "completed");
  must(show(turnEndOf("aborted", text)) === show({ finalText: "ab", outcome: "cancelled" }), "aborted");
  must(show(turnEndOf("completed", { role: "assistant", content: [], stopReason: "error", errorMessage: "provider 500" })) === show({ finalText: null, outcome: "failed", error: "provider 500" }), "error");
  must(show(turnEndOf("completed", { role: "user", content: [{ type: "text", text: "not the model's" }] })) === show({ finalText: null, outcome: "completed" }), "user tip");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
