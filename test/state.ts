/**
 * The agent's own store, and the memory convention on top of it.
 *
 * The point of memory is continuity across tasks, so that is what these check:
 * something written on one task is in the system prompt of the next, without
 * the agent going to look for it. pi and Codex both landed on pushing the
 * working set in rather than trusting recall, and both keep it as text a person
 * can read and correct.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { statePlugin, workingSet, WORKING_SET } from "../src/plugins/state.ts";
import { systemPrompt } from "../src/runtime/pi-prompt.ts";
import type { PluginContext } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

async function fixture(agentId = "a") {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", agentId);
  const plugin = statePlugin(store, null, "local");
  const ctx = (over: Partial<PluginContext> = {}) => ({
    publicConfig: { account: "agent memory" }, credential: null,
    caller: { tenantId: "t", agentId, taskId: "k" },
    connection: { get: async () => null, set: async () => {} },
    ...over,
  }) as unknown as PluginContext;
  return { store, plugin, ctx };
}

await check("写下的东西会出现在下一个任务的系统提示里", async () => {
  const { store, plugin, ctx } = await fixture();
  await plugin.invoke("remember", { key: "memory", text: "部署窗口是周二 02:00 UTC" }, ctx());
  await plugin.invoke("remember", { key: "todo", text: "还要确认 web-02" }, ctx());

  const sys = systemPrompt({ workingSet: await workingSet(store, "t", "a") });
  if (!sys.includes("部署窗口是周二 02:00 UTC")) throw new Error("a durable fact did not reach the next task");
  if (!sys.includes("还要确认 web-02")) throw new Error("an open item did not reach the next task");
});

await check("追加是一次调用，且保留末尾", async () => {
  const { store, plugin, ctx } = await fixture();
  for (let i = 0; i < 5; i++) {
    await plugin.invoke("remember", { key: "journal", text: `line ${i}` }, ctx());
  }
  const got = await store.getState("t", "a", "journal");
  if (got?.value !== "line 0\nline 1\nline 2\nline 3\nline 4") throw new Error(`appended wrong: ${got?.value}`);

  // A full document drops its head, not its tail: the recent end is the part
  // worth having.
  const r = await store.appendState("t", "a", "journal", "the newest line", 20);
  if (!r.truncated) throw new Error("an overfull document was not trimmed");
  const after = await store.getState("t", "a", "journal");
  if (!String(after?.value).endsWith("the newest line")) throw new Error("trimming lost the tail");
});

await check("memory 按租户和 agent 隔离", async () => {
  const a = await fixture("a");
  await a.plugin.invoke("remember", { key: "memory", text: "只属于 a" }, a.ctx());
  // Same store, different agent: the plugin scopes by caller, not by argument.
  const asB = a.ctx({ caller: { tenantId: "t", agentId: "b", taskId: "k" } } as any);
  const seen = await a.plugin.invoke("get", { key: "memory" }, asB);
  if ((seen as any).found) throw new Error("one agent read another agent's memory");
  if (!(await workingSet(a.store, "t", "b")).trim() === false) throw new Error("b inherited a's working set");
});

await check("工作集有字节预算，日志最先被裁", async () => {
  const { store } = await fixture();
  await store.putState("t", "a", "memory", { value: "M".repeat(9000), ref: null, bytes: 9000 });
  await store.putState("t", "a", "journal", { value: "J".repeat(9000), ref: null, bytes: 9000 });
  const text = await workingSet(store, "t", "a");
  const budget = Object.fromEntries(WORKING_SET.map((d) => [d.key, d.budget]));
  const mem = text.split("## memory")[1]!.split("## journal")[0]!;
  const jrn = text.split("## journal")[1]!;
  if (mem.replace(/[^M]/g, "").length > budget.memory!) throw new Error("memory blew its budget");
  if (jrn.replace(/[^J]/g, "").length > budget.journal!) throw new Error("journal blew its budget");
  // The log keeps its end; curated facts keep their beginning.
  if (!jrn.includes("…")) throw new Error("a trimmed document did not say it was trimmed");
});

await check("错的记忆可以删掉", async () => {
  const { plugin, ctx } = await fixture();
  await plugin.invoke("remember", { key: "memory", text: "错的" }, ctx());
  const gone = await plugin.invoke("forget", { key: "memory" }, ctx());
  if (!(gone as any).deleted) throw new Error("forget did not delete");
  if ((await plugin.invoke("get", { key: "memory" }, ctx()) as any).found) throw new Error("still there");
});

await check("大的值不会撑爆一行，也不会悄悄丢", async () => {
  const { plugin, ctx } = await fixture();
  // No object storage mounted here, so an oversized value must be refused
  // loudly rather than silently truncated.
  let refused = false;
  try {
    await plugin.invoke("put", { key: "big", value: "x".repeat(40_000) }, ctx());
  } catch (e) {
    refused = /object storage/.test(String((e as Error).message));
  }
  if (!refused) throw new Error("an unspillable value was accepted anyway");

  // And a value past the hard cap is refused whatever is mounted.
  let capped = false;
  try {
    await plugin.invoke("put", { key: "huge", value: "x".repeat(200) },
      ctx({ publicConfig: { account: "x", maxValueBytes: 100 } } as any));
  } catch { capped = true; }
  if (!capped) throw new Error("the per-value cap did not apply");
});

await check("键名受限，且不是通往别人数据的路径", async () => {
  const { plugin, ctx } = await fixture();
  for (const bad of ["../other", "a b", "", "/abs"]) {
    let threw = false;
    try { await plugin.invoke("get", { key: bad }, ctx()); } catch { threw = true; }
    if (!threw) throw new Error(`accepted a bad key: ${JSON.stringify(bad)}`);
  }
});

console.log(`\n  Agent state\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
