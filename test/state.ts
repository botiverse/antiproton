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
import { capOf, configOf, MEMORY_MAX, memoryBudgetOf, statePlugin, workingSet, WORKING_SET } from "../src/plugins/state.ts";
import { STATE_BYTES_MARKER } from "../src/store/state-lines.ts";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { READ_WHOLE_MAX } from "../src/plugins/artifacts.ts";
import { systemPrompt } from "../src/runtime/pi-prompt.ts";
import type { PluginContext } from "../src/plugins/types.ts";
import { importKek, seal } from "../src/runtime/secrets.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { StorageAdapter } from "../src/core/store.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { pendingTrace } from "../src/trace/outbox.ts";

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
    caller: { tenantId: "t", agentId, taskId: "k" }, alias: "state",
    ...over,
  }) as unknown as PluginContext;
  return { store, plugin, ctx };
}

await check("写下的东西会出现在下一个任务的系统提示里", async () => {
  const { store, plugin, ctx } = await fixture();
  await plugin.invoke("remember", { key: "memory", text: "部署窗口是周二 02:00 UTC" }, ctx());
  await plugin.invoke("remember", { key: "todo", text: "还要确认 web-02" }, ctx());

  const sys = systemPrompt({ contributions: [await workingSet(store, "t", "a")] });
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
  const r = await store.appendState("t", "a", "journal", "the newest line", 20, "drop");
  if (!r.dropped.length) throw new Error("an overfull document was not trimmed");
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

/**
 * The mount says its own paragraph now, instead of the runtime importing one.
 *
 * Two things have to hold and neither is visible from the prompt text alone:
 * an agent that has written nothing contributes *nothing* — a heading with no
 * body under it is a paragraph the model has to read past every turn — and two
 * mounts of this plugin contribute *once*, because what they read is keyed by
 * agent rather than by mount and the second would repeat the first word for
 * word.
 */
await check("挂载自己贡献那段提示词，写空时不贡献，挂两次也只贡献一次", async () => {
  const { store, plugin, ctx } = await fixture();
  if (typeof plugin.promptContribution !== "function") throw new Error("state no longer declares promptContribution");

  // Nothing written yet: no paragraph at all, not an empty one.
  const before = await plugin.promptContribution!(ctx());
  if (before !== null) throw new Error(`an agent with nothing written contributed ${JSON.stringify(before)}`);

  await plugin.invoke("remember", { key: "memory", text: "部署窗口是周二 02:00 UTC" }, ctx());
  const after = await plugin.promptContribution!(ctx());
  if (!after || !after.includes("部署窗口")) throw new Error(`the working set is not in the contribution: ${after}`);

  // Two mounts of the same plugin read the same documents, so exactly one of
  // them speaks; without this the prompt would carry the working set twice.
  // Which one is the gateway's own resolution order and not this test's
  // business — what matters is that the total is one.
  for (const alias of ["state", "memory2"]) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, installationId: "i", connectionId: null,
      plugin: "state", toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
    } as any);
  }
  const spoke = [];
  for (const alias of ["state", "memory2"]) {
    if (await plugin.promptContribution!(ctx({ alias } as any))) spoke.push(alias);
  }
  if (spoke.length !== 1) {
    throw new Error(`two mounts of one plugin contributed ${spoke.length} paragraphs (${spoke.join(", ")}), not 1`);
  }
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

await check("a memory over its budget, written before its cap was lowered to it, shows its first and its latest lines, and between them how much is left out and how to read it", async () => {
  const { store } = await fixture();
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "state", installationId: "i", connectionId: null,
    plugin: "state", toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  } as any);
  const budget = WORKING_SET.find((d) => d.key === "memory")!.budget;
  // A `memory` remembered under the old 64 KiB cap: no write may make one this long now, so it is stored as it was.
  const legacy = ["EARLIEST-NOTE: the owner is Ada",
    ...Array.from({ length: Math.ceil(budget / 40) * 2 }, (_, i) => `filler note ${i} ${"x".repeat(20)}`),
    "LATEST-NOTE: Ada prefers mornings"].join("\n");
  await store.putState("t", "a", "memory", { value: legacy, ref: null, bytes: JSON.stringify(legacy).length });
  const whole = String((await store.getState("t", "a", "memory"))!.value);
  if (whole.length <= budget) throw new Error(`control: memory is ${whole.length}, within its budget`);
  const mem = (await workingSet(store, "t", "a")).split("## memory (durable facts)\n")[1]!;
  for (const n of ["EARLIEST-NOTE", "LATEST-NOTE"]) if (!mem.includes(n)) throw new Error(`${n} is not shown: ${mem.slice(0, 200)} … ${mem.slice(-200)}`);
  const marker = /^… (\d+) of (\d+) characters left out here; get `memory` with the `get` tool on the `state` mount to read all of it\.$/m.exec(mem);
  if (!marker || Number(marker[2]) !== whole.length) throw new Error(`no marker: ${mem.slice(budget / 2 - 100, budget / 2 + 300)}`);
  if (mem.length - marker[0].length > budget + 2) throw new Error(`shown ${mem.length - marker[0].length} characters of a ${budget} budget`);
  // Whole lines on both sides of the marker.
  const [before, after] = mem.split(marker[0]);
  const lines = new Set(whole.split("\n"));
  const lastBefore = before!.replace(/\n$/, "").split("\n").at(-1)!, firstAfter = after!.replace(/^\n/, "").split("\n")[0]!;
  if (!lines.has(lastBefore) || !lines.has(firstAfter)) throw new Error(`cut inside a line: ${JSON.stringify(lastBefore)} | ${JSON.stringify(firstAfter)}`);
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

await check("注入的文字用挂载时的别名，不是写死的 state", async () => {
  const { store, plugin, ctx } = await fixture();
  await plugin.invoke("remember", { key: "memory", text: "部署窗口是周二" }, ctx());
  // An operator is free to mount this under any name, and the harness
  // dispatches on that name.
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "memo", plugin: "state",
    installationId: "inst-memo", connectionId: null, toolVersion: "1.0.0",
    publicConfig: { account: "agent memory" }, secretRef: null, policy: null,
  });
  const text = await workingSet(store, "t", "a");
  if (!text.includes("`memo` mount")) {
    throw new Error(`the prompt did not name the mounted alias: ${text.slice(0, 200)}`);
  }
  if (!text.includes("`revise`") || !text.includes("`remember`") || !text.includes("`forget`")) {
    throw new Error("the prompt did not say which tools maintain it");
  }
  // The dispatch address is not a name the model can call, so it must not be
  // handed one: neither the old literal nor a dotted form of the real alias.
  if (/state\.remember|memo\.remember/.test(text)) throw new Error("the prompt handed the model a dispatch address");
});

await check("没挂载时不会叫 agent 去调一个不存在的工具", async () => {
  const { store, plugin, ctx } = await fixture();
  await plugin.invoke("remember", { key: "memory", text: "部署窗口是周二" }, ctx());
  // Nothing mounts the plugin: the memory is still worth reading, but a
  // sentence telling the model to call `state.remember` would be an
  // instruction it cannot follow, competing with the ones it can.
  const text = await workingSet(store, "t", "a");
  if (!text.includes("部署窗口是周二")) throw new Error("memory was withheld along with the tool names");
  if (/remember|revise|forget/.test(text)) throw new Error("named a tool that is not mounted");
});

await check("装不下时给出的建议用的是这个挂载的名字", async () => {
  const { plugin, ctx } = await fixture();
  // Mounted as `memo`, so `state.forget` would be a tool the model cannot
  // call. The plugin learns its own name the way it learns a sibling's.
  const small = ctx({ alias: "memo", publicConfig: { account: "x", maxTotalBytes: 40 } } as any);
  await plugin.invoke("put", { key: "a", value: "x".repeat(20) }, small);
  let message = "";
  try { await plugin.invoke("put", { key: "b", value: "y".repeat(20) }, small); }
  catch (e) { message = String((e as Error).message); }
  if (!message) throw new Error("the store took more than it holds");
  // The tool and the mount it is on — not `memo.forget`, which is the dispatch
  // address and not a name the model is offered.
  if (!message.includes("`forget` tool on `memo`")) {
    throw new Error(`the advice names the wrong tool: ${message}`);
  }
});

await check("list 真的把键列出来,而不是只报个数", async () => {
  const { store, plugin, ctx } = await fixture();
  await plugin.invoke("remember", { key: "memory", text: "部署窗口是周二" }, ctx());
  await plugin.invoke("remember", { key: "todo", text: "确认 web-02" }, ctx());

  // `stateUsage` returns `{ keys: <count>, bytes }`, so `{ keys: rows, ...usage }`
  // silently replaced the listing with the number — the tool promised "what is
  // stored, with sizes" and answered with a tally.
  const out = await plugin.invoke("list", {}, ctx()) as any;
  if (!Array.isArray(out.keys)) throw new Error(`list did not return rows: ${JSON.stringify(out)}`);
  if (out.keys.map((r: any) => r.key).sort().join(",") !== "memory,todo") {
    throw new Error(`wrong keys: ${JSON.stringify(out.keys)}`);
  }
  if (out.total?.keys !== 2) throw new Error(`the totals were lost: ${JSON.stringify(out.total)}`);

  // The listing is what the prefix selected; the total is the whole store, and
  // the two must not be read as the same number.
  const filtered = await plugin.invoke("list", { prefix: "mem" }, ctx()) as any;
  if (filtered.keys.length !== 1) throw new Error(`prefix did not filter: ${JSON.stringify(filtered.keys)}`);
  if (filtered.total?.keys !== 2) throw new Error("the total followed the filter instead of the store");
});

await check("remember 与 put 是同一个命名空间,而描述现在说了这件事", async () => {
  // A fresh agent found this by experiment: it called `get` on the `journal`
  // document and got found:true, so the two share a store — but no description
  // said so, and it wrote that it had guessed (via Vera, 2026-09-13). The cost
  // of guessing is not curiosity: a `put` to `journal` replaces what has been
  // remembered, and nothing warns first.
  const { plugin, ctx } = await fixture();
  await plugin.invoke("remember", { key: "journal", text: "shipped the gate" }, ctx());
  const got = await plugin.invoke("get", { key: "journal" }, ctx()) as Record<string, unknown>;
  if (got.found !== true) throw new Error(`remember and get are not one namespace after all: ${JSON.stringify(got)}`);

  await plugin.invoke("put", { key: "journal", value: "replaced" }, ctx());
  const after = await plugin.invoke("get", { key: "journal" }, ctx()) as Record<string, unknown>;
  if (after.value !== "replaced") throw new Error(`put did not replace the document: ${JSON.stringify(after.value)}`);

  // The behaviour was always this; what was missing was saying it.
  const tools = Object.fromEntries(plugin.tools.map((t) => [t.name, t.summary]));
  if (!/same store|one store/.test(tools.remember!)) throw new Error(`remember does not say it shares a store: ${tools.remember}`);
  if (!/one store|remember/.test(tools.put!)) throw new Error(`put does not say it shares a store: ${tools.put}`);
});

await check("list 每行带 ref,而描述现在说了它是什么", async () => {
  // `list` returns `{key, bytes, ref, updatedAt}` per row and its summary named
  // only the first, second and fourth. The agent reported `ref` as a field "no
  // description mentions" — and it is the useful one: a parked value can be
  // opened from the artifacts mount without a `get` first.
  const { plugin, ctx } = await fixture();
  await plugin.invoke("put", { key: "small", value: "inline" }, ctx());
  const listed = await plugin.invoke("list", {}, ctx()) as { keys: Array<Record<string, unknown>> };
  const row = listed.keys.find((r) => r.key === "small");
  if (!row) throw new Error(`the key is not listed: ${JSON.stringify(listed)}`);
  if (!("ref" in row)) throw new Error(`the row has no ref column: ${JSON.stringify(row)}`);
  if (row.ref !== null) throw new Error(`an inline value should list ref: null, got ${JSON.stringify(row.ref)}`);

  const summary = plugin.tools.find((t) => t.name === "list")!.summary;
  if (!summary.includes("ref")) throw new Error(`the summary still does not name the ref column: ${summary}`);
});

await check("转存值的 note 就是那次调用本身,而且按大小给对形式", async () => {
  // The old note gave a shape — `read { ref, fields, offset, limit }` — with no
  // reference in it and no mention of `from`. So a 60 KB value's only
  // documented route was a whole read, which the reader parks again: the model
  // followed the instructions and stopped (Vera's fresh agent, 2026-09-13).
  const { store, plugin, ctx } = await fixture();
  const ref = "r2://b/t/t/a/big.json";

  const small = { bytes: READ_WHOLE_MAX - 1, ref, updatedAt: 1, value: null };
  const big = { bytes: READ_WHOLE_MAX + 1, ref, updatedAt: 1, value: null };
  const noteFor = async (row: typeof small) => {
    (store as any).getState = async () => row;
    const r = await plugin.invoke("get", { key: "k" }, ctx()) as Record<string, unknown>;
    return String(r.note ?? "");
  };

  // The reference the note carries is the one the agent may be shown:
  // `artifact://<path>`, with no bucket, tenant or agent in it (tygg,
  // 2026-09-14). Asserting the raw form is absent is the half that matters —
  // carrying the right string and also leaking the old one would pass a test
  // that only looked for the right one.
  const shown = "artifact://big.json";
  for (const [what, note] of [["under", await noteFor(small)], ["over", await noteFor(big)]] as const) {
    if (!note.includes(shown)) throw new Error(`the ${what} note does not carry the shown reference: ${note}`);
    if (note.includes("r2://") || note.includes("/t/")) throw new Error(`the ${what} note leaks the raw key: ${note}`);
  }
  const under = await noteFor(small);
  if (/from:/.test(under)) throw new Error(`a value that reads back whole should not be told to page: ${under}`);
  const over = await noteFor(big);
  if (!/from: 0/.test(over)) throw new Error(`a value past the read-back line must be paged, and the note must say so: ${over}`);
});

await check("键是名字不是路径: 含 `..` 段的键写不进去,而 `a/b` 与 `notes..old` 照旧", async () => {
  // A key becomes part of the object's path, so a key that moves through the
  // path names somewhere else: one written this way produced a reference that
  // left the agent's own subtree while still beginning with it (Vera). `/`
  // stays legal — `list { prefix }` exists so keys can be hierarchical — and
  // two dots inside a name are a name.
  const { plugin, ctx } = await fixture();
  const big = "z".repeat(200_000);

  let refused = "";
  try { await plugin.invoke("put", { key: "aa/../../../../othertenant/u/pwn", value: big }, ctx()); }
  catch (e) { refused = String((e as Error).message); }
  if (!/names a value, not a path/.test(refused)) throw new Error(`a key that moves through the path was accepted: ${refused || "(no error)"}`);

  // and the two shapes that must stay legal
  for (const key of ["notes/2026/march", "notes..old"]) {
    const r = await plugin.invoke("put", { key, value: "small" }, ctx()) as Record<string, unknown>;
    if (r.key !== key) throw new Error(`a legal key was refused: ${key}`);
  }
});

await check("旧行的 ref 读不回来时,get 不再递给模型一个打不通的调用", async () => {
  // A row written before the reader refused these segments: the value is there
  // and cannot be fetched. Handing back the read call anyway gives the model an
  // instruction that fails, and nothing in the answer says the value is
  // unreachable — it reads like one it merely has not opened yet (Vera on
  // 2d3de80). The one move that helps is `forget`, so that is the call given.
  const { store, plugin, ctx } = await fixture();
  (store as any).getState = async () => ({
    bytes: 99_999, updatedAt: 1, value: null,
    ref: "r2://b/t/t/a/state/aa/../../../other/pwn.json",
  });
  const r = await plugin.invoke("get", { key: "k" }, ctx()) as Record<string, unknown>;
  const note = String(r.note ?? "");
  if (/read \{/.test(note)) throw new Error(`a call that the reader refuses was offered anyway: ${note}`);
  if (!/forget \{ key: "k" \}/.test(note)) throw new Error(`the one call that helps is not given: ${note}`);
  if (r.found !== true) throw new Error("the row is there; saying otherwise hides what forget has to remove");
  if (r.ref !== undefined) throw new Error(`the unusable reference was handed back anyway: ${JSON.stringify(r.ref)}`);

  // and a readable ref is untouched
  (store as any).getState = async () => ({ bytes: 99_999, updatedAt: 1, value: null, ref: "r2://b/t/t/a/state/ok.json" });
  const good = await plugin.invoke("get", { key: "k" }, ctx()) as Record<string, unknown>;
  if (!/read \{ ref:/.test(String(good.note))) throw new Error(`a readable value stopped offering its call: ${good.note}`);
});

// ---- whole lines: what a full document gives up, and revising one line -------

/** Both stores, each with the agent made, and the plugin over it. */
async function backends(): Promise<Array<{ name: string; store: StorageAdapter; plugin: ReturnType<typeof statePlugin> }>> {
  const sqlite = new SqliteStore(":memory:");
  await sqlite.init();
  const host = sqliteHost();
  const durable = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  await durable.init();
  const out = [];
  for (const [name, store] of [["sqlite", sqlite], ["durable-object", durable]] as const) {
    await store.createAgent("t", "a");
    out.push({ name, store: store as StorageAdapter, plugin: statePlugin(store as StorageAdapter, null, "local") });
  }
  return out;
}
const capped = (maxDocumentBytes: number) => ({
  publicConfig: { account: "agent memory", maxDocumentBytes }, credential: null,
  caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "state",
}) as unknown as PluginContext;
const attempt = async (fn: () => Promise<unknown>) => {
  try { return { ok: await fn() }; } catch (e) { return { threw: String((e as Error).message) }; }
};
const A = "alpha 0123456789", B = "bravo 0123456789", C = "charlie 0123456789 0123456789";

await check("a full document drops whole oldest lines, never part of one, and remember's reply quotes what it dropped", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(40);
    await plugin.invoke("remember", { key: "journal", text: A }, ctx);
    await plugin.invoke("remember", { key: "journal", text: B }, ctx);
    // 16 + 1 + 16 + 1 + 29 is 63: one dropped line would leave 46, still over 40, so both go.
    const r = await plugin.invoke("remember", { key: "journal", text: C }, ctx) as any;
    const value = (await store.getState("t", "a", "journal"))?.value;
    if (value !== C) throw new Error(`${name}: kept ${JSON.stringify(value)}, not the newest line whole`);
    if (r.dropped?.lines !== 2 || r.dropped.text !== `${A}\n${B}` || r.dropped.characters !== 33) {
      throw new Error(`${name}: the receipt does not name the dropped lines: ${JSON.stringify(r)}`);
    }
    if (!/2 oldest lines were dropped/.test(r.note) || !/`dropped\.text` quotes them/.test(r.note)) {
      throw new Error(`${name}: the note does not say what was dropped: ${r.note}`);
    }
    // Room for one more line: nothing dropped, and the reply says nothing about dropping.
    const quiet = await plugin.invoke("remember", { key: "journal", text: "delta" }, ctx) as any;
    if ("dropped" in quiet || "note" in quiet) throw new Error(`${name}: a write that fit reported a drop: ${JSON.stringify(quiet)}`);
  }
});

await check("the drop receipt and remember's description say to free up space with revise or forget before remembering again", async () => {
  // Remembering a dropped line straight back into a full document drops the next oldest one, so advice that says only
  // "remember again" turns one loss into a chain of them.
  const { plugin } = (await backends())[0]!;
  const ctx = capped(40);
  await plugin.invoke("remember", { key: "journal", text: A }, ctx);
  await plugin.invoke("remember", { key: "journal", text: B }, ctx);
  const r = await plugin.invoke("remember", { key: "journal", text: C }, ctx) as any;
  const summary = plugin.tools.find((t) => t.name === "remember")!.summary;
  for (const [what, text] of [["the receipt", String(r.note)], ["remember's description", summary]] as const) {
    if (/(remember|save) again/i.test(text)) throw new Error(`${what} still says to remember again: ${text}`);
    const free = text.indexOf("free up space first");
    // Delete or shorten: a longer replacement past the cap is itself refused, so it frees nothing.
    if (free === -1 || !/(delete or shorten|deleting or shortening) a line [^.]*`revise`/.test(text) || !text.includes("`forget`")) {
      throw new Error(`${what} does not say to free up space with revise or forget: ${text}`);
    }
    const then = text.indexOf("then remember what you still need");
    if (then < free) throw new Error(`${what} does not put freeing space before remembering: ${text}`);
  }
});

/** A state mount behind the real gateway, with every trace row it writes kept: the gateway fills in the agent and the
 * mount and refuses a kind a plugin may not write, so a row seen here is the row the outbox gets. */
async function traced(maxDocumentBytes: number) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  const plugin = statePlugin(store, null, "local");
  await store.addMount({ tenantId: "t", agentId: "a", alias: "notes", plugin: "state", installationId: "i", connectionId: null,
    toolVersion: plugin.version, publicConfig: { maxDocumentBytes }, secretRef: null, policy: null });
  const rows: any[] = [];
  const record = store.recordTrace.bind(store);
  store.recordTrace = async (r) => { rows.push(...r); return record(r); };
  // Why each failed call failed, as the store is told it: the tool.call trace row is written from this (src/trace/seams.ts).
  const failures: any[] = [];
  const complete = store.completeOperation.bind(store);
  store.completeOperation = async (...args: Parameters<typeof complete>) => {
    if (args[5]?.failure) failures.push(args[5].failure);
    return complete(...args);
  };
  const gw = new ToolGateway(store, [plugin], new Set(["state"]), { async resolve() { return null; } });
  const call = { tenantId: "t", agentId: "a", taskId: "k" };
  const remember = async (key: string, text: string) => {
    const out = await gw.invoke(call, "notes.remember", { key, text });
    if (out.status !== "succeeded") throw new Error(`remember: ${JSON.stringify(out)}`);
    return out.result as any;
  };
  const raw = (tool: string, args: Record<string, unknown>) => gw.invoke(call, `notes.${tool}`, args);
  return { store, rows, failures, remember, raw, dropped: () => rows.filter((r) => r.kind === "state.dropped") };
}

await check("a remember that drops lines writes one state.dropped row with the key (or other) and the counts; one that fits writes none", async () => {
  const { remember, dropped } = await traced(40);
  await remember("journal", A);
  await remember("journal", B);
  if (dropped().length !== 0) throw new Error(`a write that fit was traced: ${JSON.stringify(dropped())}`);
  const r = await remember("journal", C);
  const rows = dropped();
  if (rows.length !== 1) throw new Error(`${rows.length} rows for one overflow: ${JSON.stringify(rows)}`);
  const [row] = rows;
  if (row.tenantId !== "t" || row.agentId !== "a" || row.status !== "dropped" || row.verdict !== "ok") {
    throw new Error(`the row's envelope: ${JSON.stringify(row)}`);
  }
  // The same counts the reply gives the agent, and nothing else but the mount the gateway adds.
  const want = { mount: "notes", key: "journal", lines: 2, characters: 33 };
  if (JSON.stringify(row.attrs) !== JSON.stringify(want) || r.dropped.lines !== 2 || r.dropped.characters !== 33) {
    throw new Error(`attrs ${JSON.stringify(row.attrs)}, reply ${JSON.stringify(r.dropped)}`);
  }
  await remember("journal", "delta");
  if (dropped().length !== 1) throw new Error(`a later write that fit was traced: ${JSON.stringify(dropped())}`);
  // Any key is traced, but a name the agent chose is recorded only as "other": it may itself be note text.
  await remember("owner-said-call-me-sam", A);
  await remember("owner-said-call-me-sam", C);
  const other = dropped().slice(1);
  if (other.length !== 1 || other[0].attrs.key !== "other" || other[0].attrs.lines !== 1 || other[0].attrs.characters !== A.length) {
    throw new Error(`another key's drop: ${JSON.stringify(other)}`);
  }
});

await check("a state.dropped row carries none of the dropped lines and none of the document", async () => {
  const { store, rows, remember, dropped } = await traced(60);
  const LOST = "SENTINEL-LOST-7f3a owner said call the dentist";
  const KEPT = "SENTINEL-KEPT-91c2";
  await remember("journal", LOST);
  const r = await remember("journal", `${KEPT} ${"k".repeat(30)}`);
  if (r.dropped?.lines !== 1 || !r.dropped.text.includes(LOST)) throw new Error(`the overflow did not happen: ${JSON.stringify(r)}`);
  if (!(await store.getState("t", "a", "journal"))?.value?.includes(KEPT)) throw new Error("the document does not hold the kept line");
  if (dropped().length !== 1) throw new Error(`${dropped().length} rows`);
  // Every row the call wrote, not only the one asked for: no row of the call may carry either.
  const text = JSON.stringify(rows);
  for (const s of ["SENTINEL-LOST", "dentist", "SENTINEL-KEPT", "kkkkkkkk"]) {
    if (text.includes(s)) throw new Error(`a trace row carries ${s}: ${text}`);
  }
});

/** A call's refusal, with the code the store gave it, or what it answered instead. */
const refusal = async (fn: () => Promise<unknown>) => {
  try { return { ok: await fn() }; } catch (e) { return { threw: String((e as Error).message), code: (e as { code?: unknown }).code }; }
};

await check("remember on a full memory or todo is refused on both stores, writes nothing, and says how much to free with revise or forget", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(50);
    for (const key of ["memory", "todo"]) {
      await plugin.invoke("remember", { key, text: A }, ctx);
      await plugin.invoke("remember", { key, text: B }, ctx);
      const before = await store.getState("t", "a", key);
      // 33 characters now; C and its newline add 30, to 63, past 50 by 13. Without B, 46 would fit.
      const r = await refusal(() => plugin.invoke("remember", { key, text: C }, ctx));
      if (r.code !== `${key}_full`) throw new Error(`${name}: ${key}: not refused as ${key}_full: ${JSON.stringify(r)}`);
      const said = r.threw ?? "";
      // The code opens the sentence: the gateway shows the model every plugin error as `tool_error`.
      if (!said.startsWith(`${key}_full: `)) throw new Error(`${name}: ${key}: the refusal does not open with its code: ${said}`);
      const budget = WORKING_SET.find((d) => d.key === key)!.budget;
      for (const want of [`\`${key}\` is full: it is 33 characters, this line adds 30 to make it 63, and it holds at most 50`,
        "nothing was written", "free at least 13 characters first", "`revise`", "`forget`", "then remember this again",
        // No number for `put`: what binds a put is its JSON length, not this cap.
        "blank lines or layout, `put` the document again, shorter, instead"]) {
        if (!said.includes(want)) throw new Error(`${name}: ${key}: the refusal does not say ${JSON.stringify(want)}: ${said}`);
      }
      // 33 characters is under the budget, shown whole, so no cut is claimed.
      if (said.includes("The prompt shows only")) throw new Error(`${name}: ${key}: a cut claimed of a document shown whole: ${said}`);
      // Past the budget it is, with the working set's own budget.
      const big = capped(budget * 2);
      await store.putState("t", "a", key, { value: Array.from({ length: Math.ceil((budget + 1) / 100) }, (_, i) => `${i}`.padEnd(99, "q")).join("\n"), ref: null, bytes: 0 });
      const cut = await refusal(() => plugin.invoke("remember", { key, text: "z".repeat(budget) }, big));
      // `memory`'s cap is its budget, so a `memory` past its budget was already past its cap: refused as over it.
      if (cut.code !== `${key}_${key === "memory" ? "over_cap" : "full"}` || !String(cut.threw).includes(`. The prompt shows only the first and last part of \`${key}\` past ${budget} characters, saying how much is left out between them; \`get\` reads all of it`)) {
        throw new Error(`${name}: ${key}: past the budget: ${JSON.stringify(cut).slice(-300)}`);
      }
      await store.putState("t", "a", key, { value: before!.value, ref: null, bytes: before!.bytes });
      const after = await store.getState("t", "a", key);
      if (after?.value !== `${A}\n${B}` || after.value !== before?.value || after.bytes !== before.bytes) {
        throw new Error(`${name}: ${key}: a refused remember changed the document: ${JSON.stringify(after)}`);
      }
      // Freeing space is the agent's decision, and once it is made the same line goes in.
      await plugin.invoke("revise", { key, old: A }, ctx);
      const ok = await plugin.invoke("remember", { key, text: C }, ctx) as any;
      if ("dropped" in ok || ok.characters !== B.length + 1 + C.length || ok.cap !== 50) throw new Error(`${name}: ${key}: after freeing space: ${JSON.stringify(ok)}`);
      if ((await store.getState("t", "a", key))?.value !== `${B}\n${C}`) throw new Error(`${name}: ${key}: ${(await store.getState("t", "a", key))?.value}`);
    }
    // `journal` and a key of the agent's own still drop the oldest lines and quote them.
    for (const key of ["journal", "notes/plan"]) {
      await plugin.invoke("remember", { key, text: A }, capped(40));
      await plugin.invoke("remember", { key, text: B }, capped(40));
      const r = await plugin.invoke("remember", { key, text: C }, capped(40)) as any;
      if (r.dropped?.lines !== 2 || r.dropped.text !== `${A}\n${B}` || (await store.getState("t", "a", key))?.value !== C) {
        throw new Error(`${name}: ${key} no longer drops with a receipt: ${JSON.stringify(r)}`);
      }
    }
  }
});

await check("a remember refusal lists the document's lines, numbered, to the model, and none of them reaches the record or the trace", async () => {
  // The Durable Object store, behind the real gateway, so the trace rows read here are the outbox's own.
  const host = sqliteHost();
  const store = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  await store.init();
  await store.createAgent("t", "a");
  const plugin = statePlugin(store as StorageAdapter, null, "local");
  await store.addMount({ tenantId: "t", agentId: "a", alias: "notes", plugin: "state", installationId: "i", connectionId: null,
    toolVersion: plugin.version, publicConfig: { maxDocumentBytes: 120 }, secretRef: null, policy: null });
  const failures: any[] = [];
  const complete = store.completeOperation.bind(store);
  store.completeOperation = async (...args: Parameters<typeof complete>) => {
    if (args[5]?.failure) failures.push(args[5].failure);
    return complete(...args);
  };
  const gw = new ToolGateway(store as StorageAdapter, [plugin], new Set(["state"]), { async resolve() { return null; } });
  const call = { tenantId: "t", agentId: "a", taskId: "k" };
  const SENTINEL = "SENTINEL-MEM-4b1e the owner's daughter is Ilse";
  await store.putState("t", "a", "memory", { value: `${SENTINEL}\n\nsecond fact 0123456789`, ref: null, bytes: 0 });
  const out = await gw.invoke(call, "notes.remember", { key: "memory", text: "z".repeat(60) }) as any;
  const shown = String(out.error?.message);
  if (out.status !== "failed" || !shown.startsWith("memory_full: ")) throw new Error(`not refused: ${JSON.stringify(out)}`);
  // Numbered as `revise` counts them: the blank line 2 is left out, and line 3 keeps its number.
  if (!shown.includes(`\`memory\` now, by line number:\n1: ${SENTINEL}\n3: second fact 0123456789`)) throw new Error(`the model is not shown the lines: ${shown}`);
  // The record is written from the message alone, before any cut, so this is not the 200-character trace limit's doing.
  if (failures.length !== 1 || !String(failures[0].message).startsWith("memory_full: ") || JSON.stringify(failures).includes("SENTINEL")) {
    throw new Error(`the record: ${JSON.stringify(failures)}`);
  }
  const rows = pendingTrace(host.sql as any, 0).rows;
  const failed = rows.filter((r) => r.kind === "tool.call" && r.status === "failed");
  if (failed.length !== 1 || failed[0]!.attrs.errorCode !== "memory_full" || !String(failed[0]!.attrs.error).startsWith("memory_full: ")) {
    throw new Error(`the tool.call row: ${JSON.stringify(failed)}`);
  }
  for (const s of ["SENTINEL", "Ilse", "second fact"]) {
    if (JSON.stringify(rows).includes(s)) throw new Error(`a trace row carries ${s}: ${JSON.stringify(rows)}`);
  }
});

await check("a text too long for any document says to shorten or split it, never to free space; memory lists its lines to the model only, an empty one and journal list none", async () => {
  const host = sqliteHost();
  const store = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  await store.init();
  await store.createAgent("t", "a");
  const plugin = statePlugin(store as StorageAdapter, null, "local");
  await store.addMount({ tenantId: "t", agentId: "a", alias: "notes", plugin: "state", installationId: "i", connectionId: null,
    toolVersion: plugin.version, publicConfig: { maxDocumentBytes: 120 }, secretRef: null, policy: null });
  const failures: any[] = [];
  const complete = store.completeOperation.bind(store);
  store.completeOperation = async (...args: Parameters<typeof complete>) => {
    if (args[5]?.failure) failures.push(args[5].failure);
    return complete(...args);
  };
  const gw = new ToolGateway(store as StorageAdapter, [plugin], new Set(["state"]), { async resolve() { return null; } });
  const call = { tenantId: "t", agentId: "a", taskId: "k" };
  const SENTINEL = "SENTINEL-LONG-77c0 the owner banks with Fjord";
  const tooLong = (key: string) => gw.invoke(call, "notes.remember", { key, text: "z".repeat(121) }) as Promise<any>;

  // Empty: nothing to list, and the refusal still says what to do.
  const empty = String((await tooLong("memory")).error?.message);
  if (!empty.startsWith("memory_full: that line is 121 characters; a document holds at most 120, so nothing was written. "
    + "Shorten this, or add it in several smaller pieces, one `remember` per line") || empty.includes("by line number")) throw new Error(`empty memory: ${empty}`);

  await store.putState("t", "a", "memory", { value: `${SENTINEL}\nsecond fact\n`, ref: null, bytes: 0 });
  const shown = String((await tooLong("memory")).error?.message);
  if (!shown.includes("Shorten this, or add it in several smaller pieces") || !shown.includes(`\`memory\` now, by line number:\n1: ${SENTINEL}\n2: second fact`)) {
    throw new Error(`the model is not shown the lines: ${shown}`);
  }
  if (failures.length !== 2 || JSON.stringify(failures).includes("SENTINEL") || !failures.every((f) => f.code === "memory_full")) {
    throw new Error(`the record: ${JSON.stringify(failures)}`);
  }
  if (JSON.stringify(pendingTrace(host.sql as any, 0).rows).includes("SENTINEL")) throw new Error("a trace row carries the sentinel");
  // A document that drops lists nothing and gives no next step: it is the agent's own, and nothing changed there.
  await store.putState("t", "a", "journal", { value: SENTINEL, ref: null, bytes: 0 });
  const journal = String((await tooLong("journal")).error?.message);
  if (journal !== "that line is 121 characters; a document holds at most 120, so nothing was written: it is too long; shorten it, or add it in smaller pieces") {
    throw new Error(`journal: ${journal}`);
  }
  // Freeing space cannot make a text past the whole cap fit, so no form of this refusal suggests it.
  for (const [what, said] of [["empty memory", empty], ["memory", shown.split("\n\n")[0]!], ["journal", journal]]) {
    if (/revise|forget/.test(said!)) throw new Error(`${what}: the too-long refusal suggests freeing space: ${said}`);
  }
});

await check("the listing stops at 50 lines and 200 characters a line, and says how many more there are", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(20_000);
    const lines = Array.from({ length: 60 }, (_, i) => i === 0 ? `L0 ${"w".repeat(300)}` : `L${i} ${"v".repeat(200)}`);
    await store.putState("t", "a", "todo", { value: lines.join("\n"), ref: null, bytes: 0 });
    const r = await (async () => { try { await plugin.invoke("remember", { key: "todo", text: "y".repeat(8000) }, ctx); return null; } catch (e) { return e as any; } })();
    const listed = String(r?.modelOnlyText ?? "");
    const rows = listed.split("\n");
    if (r?.code !== "todo_full" || rows[0] !== "`todo` now, by line number (a line ending in … is cut; a part of it without the … still works as `revise`'s `old`):" || rows.length !== 52) throw new Error(`${name}: ${rows.length} rows: ${listed.slice(0, 300)}`);
    if (rows[1] !== `1: L0 ${"w".repeat(197)}…` || rows[50] !== `50: ${lines[49]!.slice(0, 200)}…`) throw new Error(`${name}: ${rows[1]} / ${rows[50]}`);
    if (rows[51] !== "… and 10 more lines; `get` reads all of it") throw new Error(`${name}: ${rows[51]}`);
    if (String(r.message).includes("L0 ") || String(r.message).includes("vvvv")) throw new Error(`${name}: the message carries the lines`);
  }
});

await check("a line the agent wrote ending in … is listed whole, and the header does not call it cut", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(30);
    await store.putState("t", "a", "memory", { value: "xxxxxxxxxx…\nsecond", ref: null, bytes: 0 });
    const r = await (async () => { try { await plugin.invoke("remember", { key: "memory", text: "a third line here" }, ctx); return null; } catch (e) { return e as any; } })();
    const listed = String(r?.modelOnlyText ?? "");
    if (r?.code !== "memory_full" || listed !== "`memory` now, by line number:\n1: xxxxxxxxxx…\n2: second") {
      throw new Error(`${name}: ${JSON.stringify(listed)}`);
    }
  }
});

await check("a full memory whose head is blank lines gives them up for a remember, and refuses only when content would go", async () => {
  // `revise` cannot remove a blank line (its match cannot be empty or span lines), so refusing over one would ask for
  // something the agent cannot do; and a blank line is no loss.
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(50);
    const head = "\n\n\n\n\n\n\n\n\n\n";
    for (const key of ["memory", "todo"]) {
      await store.putState("t", "a", key, { value: `${head}${A}\n${B}`, ref: null, bytes: 0 });
      // 43 characters; C adds 30, to 73: the ten blank lines cover 10 of the 23 over, so 13 of content would still go.
      const r = await refusal(() => plugin.invoke("remember", { key, text: C }, ctx));
      if (r.code !== `${key}_full` || !(r.threw ?? "").includes("free at least 13 characters first")) throw new Error(`${name}: ${key}: ${JSON.stringify(r)}`);
      if ((await store.getState("t", "a", key))?.value !== `${head}${A}\n${B}`) throw new Error(`${name}: ${key}: a refusal changed the document`);
      // A shorter line fits once the blank head goes: written, nothing with text on it lost, no receipt.
      const ok = await plugin.invoke("remember", { key, text: "x".repeat(10) }, ctx) as any;
      const value = (await store.getState("t", "a", key))?.value;
      if ("dropped" in ok || "note" in ok || value !== `${A}\n${B}\n${"x".repeat(10)}`) throw new Error(`${name}: ${key}: ${JSON.stringify(ok)} / ${JSON.stringify(value)}`);
    }
  }
  const { remember, store, dropped } = await traced(50);
  await store.putState("t", "a", "memory", { value: `\n\n\n\n\n\n\n\n\n\n${A}\n${B}`, ref: null, bytes: 0 });
  await remember("memory", "x".repeat(10));
  if (dropped().length !== 0) throw new Error(`giving up blank lines was traced as a drop: ${JSON.stringify(dropped())}`);
});

await check("a refused remember writes no state.dropped row, and the failed call is recorded with the code", async () => {
  const { failures, remember, raw, dropped } = await traced(40);
  await remember("memory", A);
  await remember("memory", B);
  const out = await raw("remember", { key: "memory", text: C });
  if (out.status !== "failed" || !/nothing was written/.test(String((out as any).error?.message))) throw new Error(`not refused: ${JSON.stringify(out)}`);
  if (dropped().length !== 0) throw new Error(`a refusal was traced as a drop: ${JSON.stringify(dropped())}`);
  if (failures.length !== 1 || failures[0].code !== "memory_full") throw new Error(`the failed call's record: ${JSON.stringify(failures)}`);
});

await check("put of text past the cap to memory or todo is refused with the same code; other values and other keys are stored as before", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(40);
    for (const key of ["memory", "todo"]) {
      await plugin.invoke("remember", { key, text: A }, ctx);
      const r = await refusal(() => plugin.invoke("put", { key, value: "p".repeat(41) }, ctx));
      if (r.code !== `${key}_full` || !(r.threw ?? "").startsWith(`${key}_full: \`${key}\` holds at most 40 characters, and this put is 41, so nothing was written. Put a shorter`)) {
        throw new Error(`${name}: ${key}: ${JSON.stringify(r)}`);
      }
      if ((await store.getState("t", "a", key))?.value !== A) throw new Error(`${name}: ${key}: a refused put changed the document`);
      // At the cap is not past it.
      await plugin.invoke("put", { key, value: "p".repeat(40) }, ctx);
      if ((await store.getState("t", "a", key))?.value !== "p".repeat(40)) throw new Error(`${name}: ${key}: a put at the cap was refused`);
      // A value that is not text has no lines to keep or lose: stored as before, whatever its size.
      const list = Array.from({ length: 20 }, (_, i) => `item ${i}`);
      await plugin.invoke("put", { key, value: list }, ctx);
      if (JSON.stringify((await store.getState("t", "a", key))?.value) !== JSON.stringify(list)) throw new Error(`${name}: ${key}: a list was not stored`);
    }
    await plugin.invoke("put", { key: "journal", value: "j".repeat(41) }, ctx);
    if ((await store.getState("t", "a", "journal"))?.value !== "j".repeat(41)) throw new Error(`${name}: a long journal put was refused`);
  }
});

await check("remember, revise, insert and get of a text document give its length and the cap in characters, never beside the stored bytes", async () => {
  for (const { name, plugin } of await backends()) {
    const ctx = capped(4000);
    const r = await plugin.invoke("remember", { key: "memory", text: "line é \"quoted\"" }, ctx) as any;
    const v = await plugin.invoke("revise", { key: "memory", old: "\"quoted\"", new: "\"quoted\" 2" }, ctx) as any;
    const i = await plugin.invoke("insert", { key: "memory", after_line: 1, text: "two" }, ctx) as any;
    const g = await plugin.invoke("get", { key: "memory" }, ctx) as any;
    const len = 'line é "quoted" 2'.length;
    if (r.cap !== 4000 || r.characters !== len - 2 || v.cap !== 4000 || v.characters !== len || i.cap !== 4000 || i.characters !== len + 4
      || g.cap !== 4000 || g.characters !== len + 4) {
      throw new Error(`${name}: ${JSON.stringify({ r, v, i, g })}`);
    }
    // The stored size is in another unit, so no reply that gives the cap gives it.
    for (const x of [r, v, i]) if ("bytes" in x) throw new Error(`${name}: a reply pairs bytes with the cap: ${JSON.stringify(x)}`);
    if (g.bytes !== JSON.stringify(g.value).length) throw new Error(`${name}: get's bytes is not the stored size: ${JSON.stringify(g)}`);
    // Text `put` wrote is stored with its JSON size; `characters` is still the length the cap counts.
    await plugin.invoke("put", { key: "memory", value: 'a "b"' }, ctx);
    const p = await plugin.invoke("get", { key: "memory" }, ctx) as any;
    if (p.characters !== 5 || p.cap !== 4000) throw new Error(`${name}: after put: ${JSON.stringify(p)}`);
    const o = await plugin.invoke("put", { key: "o", value: { a: 1 } }, ctx).then(() => plugin.invoke("get", { key: "o" }, ctx)) as any;
    if ("cap" in o || "characters" in o) throw new Error(`${name}: a value that is not text was given a cap: ${JSON.stringify(o)}`);
  }
});

await check("the receipt is quoted up to its limit, and a line too long for any document is refused rather than cut", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(4000);
    const lines = Array.from({ length: 150 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(16)}`);
    await store.putState("t", "a", "journal", { value: lines.join("\n"), ref: null, bytes: 0 });
    const r = await plugin.invoke("remember", { key: "journal", text: "n".repeat(3990) }, ctx) as any;
    const all = lines.join("\n");
    if (r.dropped.lines !== 150 || r.dropped.characters !== all.length) throw new Error(`${name}: ${JSON.stringify(r.dropped).slice(0, 200)}`);
    if (r.dropped.text !== all.slice(0, 1500)) throw new Error(`${name}: quoted ${r.dropped.text.length} characters, not the first 1500`);
    if (!r.note.includes(`the first 1500 of their ${all.length} characters`)) throw new Error(`${name}: the note does not say the quote is cut: ${r.note}`);

    const before = (await store.getState("t", "a", "journal"))?.value;
    const long = await attempt(() => plugin.invoke("remember", { key: "journal", text: "y".repeat(4001) }, ctx));
    if (!/4001 characters; a document holds at most 4000, so nothing was written/.test(long.threw ?? "")) {
      throw new Error(`${name}: an over-long line: ${JSON.stringify(long).slice(0, 200)}`);
    }
    if ((await store.getState("t", "a", "journal"))?.value !== before) throw new Error(`${name}: a refused line changed the document`);
  }
});

await check("remember on a key holding a value that is not text refuses, and the value is kept", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    for (const [key, value] of [["memory", { deploy: "Tuesday" }], ["todo", [1, 2]], ["journal", 42], ["n", null]] as const) {
      await plugin.invoke("put", { key, value }, ctx);
      const r = await attempt(() => plugin.invoke("remember", { key, text: "a line" }, ctx));
      if (!/not a text document, so it has no lines to append to; it is unchanged/.test(r.threw ?? "")) {
        throw new Error(`${name}: remember on ${key}: ${JSON.stringify(r)}`);
      }
      const got = await store.getState("t", "a", key);
      if (JSON.stringify(got?.value) !== JSON.stringify(value)) throw new Error(`${name}: ${key} became ${JSON.stringify(got?.value)}`);
    }
  }
});

await check("revise replaces exactly the text given, within a line or across lines, and deletes it without new", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    for (const text of ["deploy window: Tuesday 02:00 UTC", "web-02 owner: Ana", "prefers short replies"]) {
      await plugin.invoke("remember", { key: "memory", text }, ctx);
    }
    const value = () => store.getState("t", "a", "memory").then((g) => g?.value);
    // Only the matched text: the rest of its line is kept, which a whole-line replacement would have dropped.
    const r = await plugin.invoke("revise", { key: "memory", old: "Tuesday 02:00", new: "Thursday 03:00" }, ctx) as any;
    if (await value() !== "deploy window: Thursday 03:00 UTC\nweb-02 owner: Ana\nprefers short replies") throw new Error(`${name}: replace: ${await value()}`);
    if (r.line !== 1 || r.was !== "Tuesday 02:00" || r.now !== "Thursday 03:00" || r.note !== "the text at line 1 was replaced") {
      throw new Error(`${name}: the replace reply: ${JSON.stringify(r)}`);
    }
    // Deleting part of a line removes only that part, spaces included as given.
    const part = await plugin.invoke("revise", { key: "memory", old: " UTC" }, ctx) as any;
    if (await value() !== "deploy window: Thursday 03:00\nweb-02 owner: Ana\nprefers short replies" || part.deleted !== " UTC") {
      throw new Error(`${name}: part delete: ${JSON.stringify(await value())} / ${JSON.stringify(part)}`);
    }
    // A whole line deleted takes its line break with it, so no blank line is left.
    const d = await plugin.invoke("revise", { key: "memory", old: "web-02 owner: Ana" }, ctx) as any;
    if (await value() !== "deploy window: Thursday 03:00\nprefers short replies") throw new Error(`${name}: delete: ${await value()}`);
    if (d.line !== 2 || d.deleted !== "web-02 owner: Ana" || d.note !== "the text at line 2 was deleted" || d.characters !== String(await value()).length) {
      throw new Error(`${name}: the delete reply: ${JSON.stringify(d)}`);
    }
    // Across lines: the text from the middle of one line to the middle of the next becomes one piece.
    const x = await plugin.invoke("revise", { key: "memory", old: "03:00\nprefers", new: "03:00, and the owner prefers" }, ctx) as any;
    if (await value() !== "deploy window: Thursday 03:00, and the owner prefers short replies") throw new Error(`${name}: across: ${await value()}`);
    if (x.line !== 1 || x.was !== "03:00\nprefers" || x.note !== "the text at lines 1–2 was replaced") throw new Error(`${name}: the across reply: ${JSON.stringify(x)}`);
    // Into several lines, and an empty `new` deletes as a missing one does.
    await plugin.invoke("revise", { key: "memory", old: ", and the owner prefers", new: "\nthe owner prefers" }, ctx);
    await plugin.invoke("revise", { key: "memory", old: "deploy window: Thursday 03:00\n", new: "" }, ctx);
    if (await value() !== "the owner prefers short replies") throw new Error(`${name}: into lines, then deleted: ${JSON.stringify(await value())}`);
  }
});

await check("revise refuses old text that occurs nowhere or more than once, gives the count and the lines matches start on, and changes nothing", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    await store.putState("t", "a", "todo", { value: "confirm web-02\nconfirm web-03\nbook aaa\n- deploy\n  done: no\n- deploy\n  done: no", ref: null, bytes: 0 });
    const before = (await store.getState("t", "a", "todo"))?.value;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ old: "web-04" }, /^`old` occurs nowhere in `todo` \(0 matches\), so nothing was changed\. It must be the text exactly as it is now/],
      // Text across lines that is not there is no match either: a line break in `old` is matched as a line break.
      [{ old: "web-02\nconfirm web-04" }, /occurs nowhere in `todo` \(0 matches\)/],
      [{ old: "confirm", new: "x" }, /^`old` occurs 2 times in `todo`, starting on lines 1, 2; nothing was changed\. Give more of the text around/],
      // Two occurrences in one line are two: the count does not depend on what the line is.
      [{ old: "aa" }, /occurs 2 times in `todo`, starting on line 3;/],
      // Several lines that occur twice are counted where each starts.
      [{ old: "- deploy\n  done: no" }, /occurs 2 times in `todo`, starting on lines 4, 6;/],
      [{ old: "" }, /`old` is empty/],
      [{ old: 5 }, /`old` must be a string/],
      [{ old: "web-02", new: 7 }, /`new` must be a string, or left out to delete the text/],
    ];
    for (const [args, want] of cases) {
      const r = await attempt(() => plugin.invoke("revise", { key: "todo", ...args }, ctx));
      if (!want.test(r.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(args)}: ${JSON.stringify(r)}`);
    }
    if ((await store.getState("t", "a", "todo"))?.value !== before) throw new Error(`${name}: a refused revise changed the document`);
    // With more of the text around it, the same piece is unique and goes through.
    await plugin.invoke("revise", { key: "todo", old: "- deploy\n  done: no\n- deploy\n  done: no", new: "- deploy\n  done: yes" }, ctx);
    if (!String((await store.getState("t", "a", "todo"))?.value).endsWith("book aaa\n- deploy\n  done: yes")) throw new Error(`${name}: ${(await store.getState("t", "a", "todo"))?.value}`);
  }
});

await check("revise refuses the old match and replace with revise_renamed, through the gateway, and changes nothing", async () => {
  // The old shape was a piece of a line and the whole new line. Read as `old` and `new`, it would splice the new line
  // into the middle of the old one without a word.
  const { store, failures, raw } = await traced(64 * 1024);
  await store.putState("t", "a", "memory", { value: "deploy window: Tuesday 02:00 UTC\nprefers short replies", ref: null, bytes: 0 });
  const before = await store.getState("t", "a", "memory");
  const want = "revise_renamed: `revise` now takes `old` and `new`: `old` is the exact text to change (it may span lines), and only "
    + "that text is replaced by `new`; to replace a whole line, pass the whole line as `old`. Nothing was changed";
  for (const args of [{ match: "Tuesday", replace: "deploy window: Thursday 03:00 UTC" }, { match: "Tuesday" },
    { old: "Tuesday", replace: "Thursday" }, { match: "Tuesday", new: "Thursday" }]) {
    const out = await raw("revise", { key: "memory", ...args }) as any;
    if (out.status !== "failed" || out.error?.message !== want) throw new Error(`${JSON.stringify(args)}: ${JSON.stringify(out)}`);
    const after = await store.getState("t", "a", "memory");
    if (after?.value !== before?.value || after?.bytes !== before?.bytes) throw new Error(`${JSON.stringify(args)} changed the document: ${JSON.stringify(after)}`);
  }
  if (failures.length !== 4 || !failures.every((f) => f.code === "revise_renamed")) throw new Error(`the record: ${JSON.stringify(failures)}`);
  const ok = await raw("revise", { key: "memory", old: "Tuesday 02:00", new: "Thursday 03:00" }) as any;
  if (ok.status !== "succeeded" || (await store.getState("t", "a", "memory"))?.value !== "deploy window: Thursday 03:00 UTC\nprefers short replies") {
    throw new Error(`the new names: ${JSON.stringify(ok)}`);
  }
});

await check("revise refuses a value that is not text, one kept in object storage, an absent key, and a result past the cap", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(40);
    await plugin.invoke("put", { key: "data", value: { line: "x" } }, ctx);
    await store.putState("t", "a", "big", { value: null, ref: "r2://b/t/t/a/state/big.json", bytes: 99_999 });
    await plugin.invoke("remember", { key: "memory", text: "short line" }, ctx);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ key: "data", old: "x" }, /`data` holds an object, not a text document, so it has no lines to revise; it is unchanged/],
      [{ key: "big", old: "x" }, /`big` is too large to revise; read it and put a new one/],
      [{ key: "nothing", old: "x" }, /there is no `nothing` to revise/],
      [{ key: "memory", old: "short line", new: "z".repeat(41) }, /make `memory` 41 characters; a document holds at most 40, so nothing was changed/],
    ];
    for (const [args, want] of cases) {
      const r = await attempt(() => plugin.invoke("revise", args as any, ctx));
      if (!want.test(r.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(args)}: ${JSON.stringify(r)}`);
    }
    if (JSON.stringify((await store.getState("t", "a", "data"))?.value) !== '{"line":"x"}') throw new Error(`${name}: data changed`);
    if ((await store.getState("t", "a", "memory"))?.value !== "short line") throw new Error(`${name}: memory changed past the cap`);
    // At the cap exactly is allowed: the cap is the most a document holds.
    await plugin.invoke("revise", { key: "memory", old: "short line", new: "z".repeat(40) }, ctx);
    if ((await store.getState("t", "a", "memory"))?.value !== "z".repeat(40)) throw new Error(`${name}: a revise at the cap was refused`);
  }
});

await check("insert puts text at the top, in the middle and at the end, keeps a trailing line break and CRLF, and refuses a line out of range", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    const value = (key: string) => store.getState("t", "a", key).then((g) => g?.value);
    await store.putState("t", "a", "todo", { value: "one\ntwo\nthree", ref: null, bytes: 0 });
    const top = await plugin.invoke("insert", { key: "todo", after_line: 0, text: "zero" }, ctx) as any;
    if (await value("todo") !== "zero\none\ntwo\nthree" || top.line !== 1 || top.note !== "inserted at line 1") throw new Error(`${name}: top: ${JSON.stringify(top)}`);
    // In the middle, several lines at once, with a nested item's leading spaces kept.
    const mid = await plugin.invoke("insert", { key: "todo", after_line: 2, text: "  - one.a\n  - one.b\n" }, ctx) as any;
    if (await value("todo") !== "zero\none\n  - one.a\n  - one.b\ntwo\nthree" || mid.line !== 3) throw new Error(`${name}: middle: ${JSON.stringify(await value("todo"))}`);
    const end = await plugin.invoke("insert", { key: "todo", after_line: 6, text: "four" }, ctx) as any;
    if (await value("todo") !== "zero\none\n  - one.a\n  - one.b\ntwo\nthree\nfour" || end.line !== 7) throw new Error(`${name}: end: ${JSON.stringify(await value("todo"))}`);
    const before = await value("todo");
    for (const [after_line, want] of [[8, /`after_line` is 8, and `todo` has 7 lines, so it must be a whole number from 0 \(the top\) to 7 \(the end\); nothing was written/],
      [-1, /`after_line` is -1/], [1.5, /`after_line` must be a whole number/], ["2", /`after_line` must be a whole number/]] as const) {
      const r = await attempt(() => plugin.invoke("insert", { key: "todo", after_line, text: "x" }, ctx));
      if (!want.test(r.threw ?? "")) throw new Error(`${name}: after_line ${after_line}: ${JSON.stringify(r)}`);
    }
    if (await value("todo") !== before) throw new Error(`${name}: a refused insert changed the document`);
    // A document ending with a line break has no empty last line, and keeps the break.
    await store.putState("t", "a", "plan.md", { value: "1. Learn\n2. Ship\n", ref: null, bytes: 0 });
    await plugin.invoke("insert", { key: "plan.md", after_line: 2, text: "3. Rest" }, ctx);
    if (await value("plan.md") !== "1. Learn\n2. Ship\n3. Rest\n") throw new Error(`${name}: trailing: ${JSON.stringify(await value("plan.md"))}`);
    const past = await attempt(() => plugin.invoke("insert", { key: "plan.md", after_line: 4, text: "x" }, ctx));
    if (!/has 3 lines, so it must be a whole number from 0 \(the top\) to 3/.test(past.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(past)}`);
    // CRLF stays CRLF, text written with \n included.
    await store.putState("t", "a", "notes.md", { value: "a\r\nc", ref: null, bytes: 0 });
    await plugin.invoke("insert", { key: "notes.md", after_line: 1, text: "b1\nb2" }, ctx);
    if (await value("notes.md") !== "a\r\nb1\r\nb2\r\nc") throw new Error(`${name}: CRLF: ${JSON.stringify(await value("notes.md"))}`);
    // An absent document is started, at 0 only; a value that is not text is refused and kept.
    const fresh = await attempt(() => plugin.invoke("insert", { key: "fresh", after_line: 1, text: "x" }, ctx));
    if (!/`fresh` has 0 lines, so it must be a whole number from 0 \(the top\) to 0/.test(fresh.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(fresh)}`);
    await plugin.invoke("insert", { key: "fresh", after_line: 0, text: "first" }, ctx);
    if (await value("fresh") !== "first") throw new Error(`${name}: fresh: ${await value("fresh")}`);
    await plugin.invoke("put", { key: "data", value: [1] }, ctx);
    const data = await attempt(() => plugin.invoke("insert", { key: "data", after_line: 0, text: "x" }, ctx));
    if (!/`data` holds a list, not a text document, so it has no lines to insert into; it is unchanged/.test(data.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(data)}`);
    for (const text of ["", "  \n", 5]) {
      const r = await attempt(() => plugin.invoke("insert", { key: "todo", after_line: 0, text }, ctx));
      if (!/nothing to insert|`text` must be a string/.test(r.threw ?? "")) throw new Error(`${name}: text ${JSON.stringify(text)}: ${JSON.stringify(r)}`);
    }
  }
});

await check("insert on a document whose lines end differently lands where the listing numbers it, and keeps every existing line end", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    const value = () => store.getState("t", "a", "mixed").then((g) => g?.value);
    // Three lines as the listing counts them, on `\n`; the CRLF on one line makes the document's own line end CRLF.
    const mixed = "alpha\nbeta\r\ngamma";
    await store.putState("t", "a", "mixed", { value: mixed, ref: null, bytes: 0 });
    // The listing's numbers, from a refused remember on a small cap: the same split insert must use.
    const listed = await refusal(() => plugin.invoke("insert", { key: "mixed", after_line: 0, text: "z".repeat(10) }, capped(20))) as any;
    const rows = String((await (async () => { try { await plugin.invoke("insert", { key: "mixed", after_line: 0, text: "z".repeat(10) }, capped(20)); return null; } catch (e) { return e as any; } })())?.modelOnlyText);
    if (listed.code !== "mixed_full" || rows !== "`mixed` now, by line number:\n1: alpha\n2: beta\n3: gamma") throw new Error(`${name}: the listing: ${JSON.stringify(rows)}`);
    const one = await plugin.invoke("insert", { key: "mixed", after_line: 1, text: "after alpha" }, ctx) as any;
    if (await value() !== "alpha\nafter alpha\r\nbeta\r\ngamma" || one.line !== 2) throw new Error(`${name}: after line 1: ${JSON.stringify(await value())}`);
    await store.putState("t", "a", "mixed", { value: mixed, ref: null, bytes: 0 });
    const three = await plugin.invoke("insert", { key: "mixed", after_line: 3, text: "after gamma" }, ctx) as any;
    if (await value() !== "alpha\nbeta\r\ngamma\r\nafter gamma" || three.line !== 4) throw new Error(`${name}: after line 3: ${JSON.stringify(await value())}`);
    await store.putState("t", "a", "mixed", { value: mixed, ref: null, bytes: 0 });
    const two = await plugin.invoke("insert", { key: "mixed", after_line: 2, text: "after beta" }, ctx) as any;
    if (await value() !== "alpha\nbeta\r\nafter beta\r\ngamma" || two.line !== 3) throw new Error(`${name}: after line 2: ${JSON.stringify(await value())}`);
    const past = await attempt(() => plugin.invoke("insert", { key: "mixed", after_line: 5, text: "x" }, ctx));
    if (!/`mixed` has 4 lines/.test(past.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(past)}`);
  }
});

await check("insert past the cap is refused as <key>_full with the listing, on memory, todo and journal alike, and drops nothing", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(50);
    for (const key of ["memory", "todo", "journal"]) {
      await store.putState("t", "a", key, { value: `${A}\n${B}`, ref: null, bytes: 0 });
      // 33 characters; C and its newline add 30, to 63, past 50 by 13.
      const r = await refusal(() => plugin.invoke("insert", { key, after_line: 1, text: C }, ctx)) as any;
      const said = r.threw ?? "";
      if (r.code !== `${key}_full` || !said.startsWith(`${key}_full: \`${key}\` is full: it is 33 characters, this line adds 30 to make it 63, and it holds at most 50, so nothing was written. An insert never drops lines to make room: free at least 13 characters first`)
        || !said.includes("then insert this again")) {
        throw new Error(`${name}: ${key}: ${JSON.stringify(r)}`);
      }
      // 33 characters is under every budget, shown whole, so no cut is claimed (the cut sentence's own test is below).
      if (said.includes("The prompt shows only")) throw new Error(`${name}: ${key}: a cut claimed of a document shown whole: ${said}`);
      if ((await store.getState("t", "a", key))?.value !== `${A}\n${B}`) throw new Error(`${name}: ${key}: a refused insert changed the document`);
      // Too long for any document: the same refusal as remember's, with the code.
      const long = await refusal(() => plugin.invoke("insert", { key, after_line: 0, text: "y".repeat(51) }, ctx));
      if (long.code !== `${key}_full` || !(long.threw ?? "").startsWith(`${key}_full: that line is 51 characters; a document holds at most 50, so nothing was written. Shorten this, or add it in several smaller pieces, one \`insert\` per piece`)) {
        throw new Error(`${name}: ${key}: too long: ${JSON.stringify(long)}`);
      }
    }
  }
  // Past its budget, journal's refusal says the prompt shows only its end, the part a tail-kept document shows.
  for (const { name, store, plugin } of await backends()) {
    const budget = WORKING_SET.find((d) => d.key === "journal")!.budget;
    await store.putState("t", "a", "journal", { value: Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(79, "j")).join("\n"), ref: null, bytes: 0 });
    const r = await refusal(() => plugin.invoke("insert", { key: "journal", after_line: 0, text: "x".repeat(150) }, capped(budget + 300)));
    if (r.code !== "journal_full" || !String(r.threw).endsWith(`. The prompt shows only the last ${budget} characters of \`journal\`; \`get\` reads all of it`)) {
      throw new Error(`${name}: journal past its budget: ${JSON.stringify(r).slice(-300)}`);
    }
  }
  // The listing goes to the model only, as remember's does.
  const { store, failures, raw } = await traced(50);
  const SENTINEL = "SENTINEL-INS-5d2a owner flies Tuesday";
  await store.putState("t", "a", "memory", { value: `${SENTINEL}\nsecond`, ref: null, bytes: 0 });
  const out = await raw("insert", { key: "memory", after_line: 0, text: "z".repeat(20) }) as any;
  const message = String(out.error?.message);
  if (out.status !== "failed" || !message.startsWith("memory_full: ") || !message.includes(`\`memory\` now, by line number:\n1: ${SENTINEL}\n2: second`)) {
    throw new Error(`the listing: ${JSON.stringify(out)}`);
  }
  if (failures.length !== 1 || failures[0].code !== "memory_full" || JSON.stringify(failures).includes("SENTINEL")) throw new Error(`the record: ${JSON.stringify(failures)}`);
});

await check("memory's cap is MEMORY_MAX, 8000, the same number as its prompt budget; other keys keep maxDocumentBytes", async () => {
  if (MEMORY_MAX !== 8000 || WORKING_SET.find((d) => d.key === "memory")!.budget !== MEMORY_MAX) throw new Error(`cap ${MEMORY_MAX}, budget ${WORKING_SET.find((d) => d.key === "memory")!.budget}`);
  if (capOf("memory", configOf({})) !== MEMORY_MAX || capOf("memory", configOf({ maxDocumentBytes: 100 })) !== 100
    || capOf("todo", configOf({})) !== 64 * 1024) throw new Error("capOf");
  for (const { name, store, plugin } of await backends()) {
    // The deployment's default config: no maxDocumentBytes.
    const ctx = { ...capped(0), publicConfig: { account: "agent memory" } } as unknown as PluginContext;
    const r = await plugin.invoke("remember", { key: "memory", text: "a fact" }, ctx) as any;
    const t = await plugin.invoke("remember", { key: "todo", text: "an item" }, ctx) as any;
    const g = await plugin.invoke("get", { key: "memory" }, ctx) as any;
    if (r.cap !== 8000 || g.cap !== 8000 || t.cap !== 64 * 1024) throw new Error(`${name}: ${JSON.stringify({ r, t, g })}`);
    // Up to the cap, in characters, and not one more, whichever tool writes.
    const fill = `a fact\n${"f".repeat(8000 - 7)}`;
    await plugin.invoke("revise", { key: "memory", old: "a fact", new: fill }, ctx);
    if ((await store.getState("t", "a", "memory"))?.value !== fill) throw new Error(`${name}: a revise to exactly 8000 was refused`);
    for (const [tool, args] of [["remember", { text: "x" }], ["insert", { after_line: 0, text: "x" }], ["revise", { old: "a fact", new: "a fact!" }],
      ["put", { value: `${fill}!` }]] as const) {
      const out = await refusal(() => plugin.invoke(tool, { key: "memory", ...args }, ctx));
      if (!("threw" in out) || !/8000|holds at most 8000/.test(out.threw!)) throw new Error(`${name}: ${tool} past 8000: ${JSON.stringify(out)}`);
    }
    // A memory at its cap is shown whole: the copy in front of the agent is the document it edits.
    const shown = (await workingSet(store, "t", "a")).split("## memory (durable facts)\n")[1]!.split("\n\n## ")[0]!;
    if (shown !== fill) throw new Error(`${name}: a memory at its cap is not shown whole: ${shown.length}`);
  }
});

await check("a memory already past its cap is still shown, refuses every write that grows it as memory_over_cap with the move-details hint, and takes any that shrinks it: put, revise and forget", async () => {
  const HINT = ". To keep what you know, move details rather than deleting them: `put` them into a document of their own, such as `notes/<topic>`, "
    + "which is not shown to you automatically, so `get` reads it when you need it; keep only the key points in `memory`, and say there where the details are";
  const SHOWN = ". The prompt shows only the first and last part of `memory` past 8000 characters, saying how much is left out between them; `get` reads all of it";
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    // Escape-heavy, so its stored size is far more than its characters: what is smaller is judged in characters.
    const line = 'she said "call me Sam"\n';
    const legacy = `FIRST fact\n${line.repeat(500)}LAST fact`;
    await store.putState("t", "a", "memory", { value: legacy, ref: null, bytes: JSON.stringify(legacy).length });
    const over = legacy.length;
    if (over <= MEMORY_MAX) throw new Error(`control: ${over}`);
    const shown = (await workingSet(store, "t", "a")).split("## memory (durable facts)\n")[1]!;
    if (!shown.includes("FIRST fact") || !shown.includes("LAST fact") || !/characters left out here/.test(shown)) throw new Error(`${name}: not shown by head and tail`);
    const value = () => store.getState("t", "a", "memory").then((g) => g?.value);
    const head = `memory_over_cap: \`memory\` is ${over} characters; its cap is 8000, and it was already over before this write, so nothing was written. `
      + "What still works: `revise` and `forget` can shrink it (on a document over its cap, a `revise` is refused only if it makes it longer), and so can a `put` of a shorter one";
    for (const [tool, args] of [["remember", { text: "one more" }], ["insert", { after_line: 0, text: "one more" }],
      ["revise", { old: "LAST fact", new: "LAST fact, longer" }], ["put", { value: `${legacy}!` }]] as const) {
      const r = await refusal(() => plugin.invoke(tool, { key: "memory", ...args }, ctx)) as any;
      if (r.code !== "memory_over_cap" || r.threw !== head + SHOWN + HINT) throw new Error(`${name}: ${tool}: ${JSON.stringify(r).slice(0, 600)}`);
      if (await value() !== legacy) throw new Error(`${name}: a refused ${tool} changed it`);
    }
    // The listing too, to the model only, so it can choose what to move.
    const listed = await (async () => { try { await plugin.invoke("remember", { key: "memory", text: "x" }, ctx); return null; } catch (e) { return e as any; } })();
    if (!String(listed?.modelOnlyText).startsWith("`memory` now, by line number:\n1: FIRST fact\n2: she said") || String(listed?.message).includes("FIRST fact")) {
      throw new Error(`${name}: the listing: ${String(listed?.modelOnlyText).slice(0, 100)}`);
    }
    // Shrinking is allowed though still past the cap: by revise, and by one put with fewer characters, even though
    // the row it replaces is stored larger and this put encodes to more than its own length.
    await plugin.invoke("revise", { key: "memory", old: "FIRST fact\n" }, ctx);
    const shorter = legacy.slice("FIRST fact\n".length, -line.length);
    if (shorter.length <= MEMORY_MAX) throw new Error(`control: ${shorter.length}`);
    const p = await plugin.invoke("put", { key: "memory", value: shorter }, ctx) as any;
    if (p.stored !== "inline" || await value() !== shorter) throw new Error(`${name}: a shorter put was refused: ${JSON.stringify(p)}`);
    // The move the hint describes: details out with put, then the key points back in, under the cap.
    await plugin.invoke("put", { key: "notes/sam", value: shorter }, ctx);
    await plugin.invoke("put", { key: "memory", value: "Sam: how they like to be addressed; details in notes/sam" }, ctx);
    await plugin.invoke("remember", { key: "memory", text: "a new fact fits again" }, ctx);
    if (!String(await value()).endsWith("a new fact fits again") || (await store.getState("t", "a", "notes/sam"))?.value !== shorter) throw new Error(`${name}: the move`);
    // And forget always works.
    await store.putState("t", "a", "memory", { value: legacy, ref: null, bytes: JSON.stringify(legacy).length });
    const f = await plugin.invoke("forget", { key: "memory" }, ctx) as any;
    if (f.deleted !== true || await value() !== undefined) throw new Error(`${name}: forget: ${JSON.stringify(f)}`);
    // A put that would move it to object storage is refused however short it is beside a document kept there.
    await store.putState("t", "a", "memory", { value: null, ref: "r2://b/t/t/a/state/memory.json", bytes: 90_000 });
    const spill = await refusal(() => plugin.invoke("put", { key: "memory", value: "x".repeat(33_000) }, ctx));
    if (spill.code !== "memory_full" || !/^memory_full: a `put` is kept where it can still be appended to and revised only up to 32768/.test(spill.threw ?? "")) throw new Error(`${name}: spill: ${JSON.stringify(spill).slice(0, 300)}`);
    // Any inline value is smaller than one kept in object storage, so it may be past the cap and still go in.
    await plugin.invoke("put", { key: "memory", value: "y".repeat(9000) }, ctx);
    if (await value() !== "y".repeat(9000)) throw new Error(`${name}: a put over a spilled memory was refused`);
    // A value that is not text is never "smaller": over a text past the cap it is held to the inline limit only.
    await plugin.invoke("put", { key: "memory", value: ["a"] }, ctx);
    const text = await refusal(() => plugin.invoke("put", { key: "memory", value: "z".repeat(8001) }, ctx));
    if (text.code !== "memory_full") throw new Error(`${name}: text past the cap over a list: ${JSON.stringify(text)}`);
  }
});

await check("memoryMaxCharacters sets memory's cap and its prompt budget as one number: the longest write allowed, the budget shown and the number refused all agree", async () => {
  for (const [given, want] of [[12_000, 12_000], [undefined, 8000], ["12000", 8000], [-5, 8000], [0, 8000], [Number.NaN, 8000]] as const) {
    const store = new SqliteStore(":memory:");
    await store.init();
    await store.createAgent("t", "a");
    const plugin = statePlugin(store, null, "local");
    const publicConfig = given === undefined ? {} : { memoryMaxCharacters: given };
    await store.addMount({ tenantId: "t", agentId: "a", alias: "state", plugin: "state", installationId: "i", connectionId: null,
      toolVersion: plugin.version, publicConfig, secretRef: null, policy: null });
    if (memoryBudgetOf(configOf(publicConfig)) !== want) throw new Error(`${String(given)}: ${memoryBudgetOf(configOf(publicConfig))}`);
    const ctx = { ...capped(64 * 1024), publicConfig } as unknown as PluginContext;
    const doc = (n: number) => Array.from({ length: Math.ceil(n / 100) }, (_, i) => `${i}`.padEnd(99, "m")).join("\n").slice(0, n);
    // The longest write allowed.
    await plugin.invoke("put", { key: "memory", value: doc(want) }, ctx);
    const past = await refusal(() => plugin.invoke("put", { key: "memory", value: doc(want + 1) }, ctx));
    if (past.code !== "memory_full" || !String(past.threw).includes(`holds at most ${want} characters`)) throw new Error(`${String(given)}: put past: ${JSON.stringify(past).slice(0, 200)}`);
    const filled = await refusal(() => plugin.invoke("remember", { key: "memory", text: "x" }, ctx));
    if (filled.code !== "memory_full" || !String(filled.threw).includes(`it holds at most ${want}`)) throw new Error(`${String(given)}: remember: ${JSON.stringify(filled).slice(0, 200)}`);
    if ((await plugin.invoke("get", { key: "memory" }, ctx) as any).cap !== want) throw new Error(`${String(given)}: get's cap`);
    // The budget shown: a memory at the cap is shown whole, one character more is cut.
    const shown = async () => (await workingSet(store, "t", "a")).split("## memory (durable facts)\n")[1]!.split("\n\n## ")[0]!;
    if (await shown() !== doc(want)) throw new Error(`${String(given)}: at the cap it is not shown whole`);
    await store.putState("t", "a", "memory", { value: doc(want + 1), ref: null, bytes: 0 });
    if (!/characters left out here/.test(await shown())) throw new Error(`${String(given)}: past the cap it is shown whole`);
    // The number the refusal states.
    const over = await refusal(() => plugin.invoke("remember", { key: "memory", text: "x" }, ctx));
    if (over.code !== "memory_over_cap" || !String(over.threw).includes(`its cap is ${want}`) || !String(over.threw).includes(`past ${want} characters`)) {
      throw new Error(`${String(given)}: over: ${JSON.stringify(over).slice(0, 300)}`);
    }
  }
});

await check("with two state mounts, memory's cap and prompt budget are the smaller memoryMaxCharacters, whichever mount writes and whichever comes first", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  const plugin = statePlugin(store, null, "local");
  // The larger first, so reading the first mount's alone would show it.
  for (const [alias, memoryMaxCharacters] of [["big", 20_000], ["small", 8000]] as const) {
    await store.addMount({ tenantId: "t", agentId: "a", alias, plugin: "state", installationId: alias, connectionId: null,
      toolVersion: plugin.version, publicConfig: { memoryMaxCharacters }, secretRef: null, policy: null });
  }
  if ((await store.findMountsByPlugin("t", "a", "state"))[0]?.alias !== "big") throw new Error("control: the larger mount is not first");
  const doc = Array.from({ length: 151 }, (_, i) => `${i}`.padEnd(99, "m")).join("\n").slice(0, 15_000);
  await store.putState("t", "a", "memory", { value: doc, ref: null, bytes: JSON.stringify(doc).length });
  const gw = new ToolGateway(store, [plugin], new Set(["state"]), { async resolve() { return null; } });
  const call = { tenantId: "t", agentId: "a", taskId: "k" };
  for (const alias of ["big", "small"]) {
    for (const [tool, args] of [["remember", { key: "memory", text: "x" }], ["insert", { key: "memory", after_line: 0, text: "x" }],
      ["put", { key: "memory", value: `${doc}x` }], ["revise", { key: "memory", old: "\n149m", new: "\n149mm" }]] as const) {
      const out = await gw.invoke(call, `${alias}.${tool}`, args) as any;
      const said = String(out.error?.message);
      if (out.status !== "failed" || !said.startsWith("memory_over_cap: `memory` is 15000 characters; its cap is 8000")
        || !said.includes("The prompt shows only the first and last part of `memory` past 8000 characters")) {
        throw new Error(`${alias}.${tool}: ${said.slice(0, 300)}`);
      }
    }
    const got = await gw.invoke(call, `${alias}.get`, { key: "memory" }) as any;
    if (got.result?.cap !== 8000) throw new Error(`${alias}.get cap: ${JSON.stringify(got.result?.cap)}`);
  }
  const shown = (await workingSet(store, "t", "a")).split("## memory (durable facts)\n")[1]!;
  if (!/^… \d+ of 15000 characters left out here;/m.test(shown)) throw new Error(`the prompt does not cut it at 8000: ${shown.slice(3900, 4200)}`);
  // Under the smaller cap, a write through the larger mount is held to it too.
  await store.putState("t", "a", "memory", { value: "short", ref: null, bytes: 0 });
  const past = await gw.invoke(call, "big.put", { key: "memory", value: "p".repeat(8001) }) as any;
  if (past.status !== "failed" || !String(past.error?.message).includes("holds at most 8000 characters")) throw new Error(`big.put past 8000: ${JSON.stringify(past).slice(0, 300)}`);
});

await check("configOf takes a limit only as a finite number of at least 1, floored; 0, a negative or a fraction under 1 is the default", async () => {
  const d = configOf({});
  for (const bad of [0, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "100", null]) {
    const c = configOf({ maxDocumentBytes: bad, maxTotalBytes: bad, maxValueBytes: bad, memoryMaxCharacters: bad });
    if (JSON.stringify(c) !== JSON.stringify(d)) throw new Error(`${String(bad)}: ${JSON.stringify(c)}`);
  }
  const c = configOf({ maxDocumentBytes: 100.7, maxTotalBytes: 1, maxValueBytes: 2000.2, memoryMaxCharacters: 12_000.9 });
  if (c.maxDocumentBytes !== 100 || c.maxTotalBytes !== 1 || c.maxValueBytes !== 2000 || c.memoryMaxCharacters !== 12_000) throw new Error(JSON.stringify(c));
  // And the plugin is held to it: a 0 maxDocumentBytes does not refuse every remember.
  const { plugin } = (await backends())[0]!;
  const r = await plugin.invoke("remember", { key: "notes", text: "fits" }, capped(0)) as any;
  if (r.cap !== 64 * 1024) throw new Error(`capped(0): ${JSON.stringify(r)}`);
});

await check("memory_over_cap on a 65,536-character memory says the prompt shows only part of it, and reaches the record as its code", async () => {
  const { store, failures, raw } = await traced(64 * 1024);
  const big = Array.from({ length: 656 }, (_, i) => `fact ${i} `.padEnd(99, "f")).join("\n").slice(0, 65_536);
  if (big.length !== 65_536) throw new Error(`control: ${big.length}`);
  await store.putState("t", "a", "memory", { value: big, ref: null, bytes: JSON.stringify(big).length });
  const out = await raw("remember", { key: "memory", text: "one more" }) as any;
  const said = String(out.error?.message);
  if (out.status !== "failed" || !said.startsWith("memory_over_cap: `memory` is 65536 characters; its cap is 8000")
    || !said.includes(". The prompt shows only the first and last part of `memory` past 8000 characters")) throw new Error(`refusal: ${said.slice(0, 400)}`);
  if (failures.length !== 1 || failures[0].code !== "memory_over_cap") throw new Error(`the record: ${JSON.stringify(failures).slice(0, 300)}`);
});

await check("text too long for any document, on a document past its prompt budget, says the prompt shows only part of it", async () => {
  // `size` rides on the too-long refusal as on the full one, so the sentence is decided the same way for both.
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(4000);
    const doc = Array.from({ length: 31 }, (_, i) => `${i}`.padEnd(99, "t")).join("\n");
    for (const [key, tool, args, sentence] of [
      ["todo", "remember", { text: "y".repeat(4001) }, ". The prompt shows only the first and last part of `todo` past 2000 characters"],
      ["journal", "insert", { after_line: 0, text: "y".repeat(4001) }, ". The prompt shows only the last 3000 characters of `journal`"],
    ] as const) {
      await store.putState("t", "a", key, { value: doc, ref: null, bytes: 0 });
      const r = await refusal(() => plugin.invoke(tool, { key, ...args }, ctx));
      if (r.code !== `${key}_full` || !String(r.threw).includes("that line is 4001 characters") || !String(r.threw).includes(sentence)) {
        throw new Error(`${name}: ${key}: ${JSON.stringify(r).slice(0, 400)}`);
      }
    }
  }
});

await check("a memory filling up is refused as memory_full with the move-details hint; todo's refusal has no hint", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(50);
    for (const key of ["memory", "todo"]) {
      await store.putState("t", "a", key, { value: `${A}\n${B}`, ref: null, bytes: 0 });
      for (const [tool, args] of [["remember", { text: C }], ["insert", { after_line: 0, text: C }], ["revise", { old: A, new: C + C }], ["put", { value: "p".repeat(51) }]] as const) {
        const r = await refusal(() => plugin.invoke(tool, { key, ...args }, ctx)) as any;
        const hinted = (r.threw ?? "").endsWith("keep only the key points in `memory`, and say there where the details are");
        if (!r.threw || (key === "memory") !== hinted || (r.code !== undefined && r.code !== `${key}_full`)) throw new Error(`${name}: ${key}: ${tool}: ${JSON.stringify(r)}`);
      }
    }
  }
});
await check("a text put to todo that put would move to object storage is refused by its JSON length, never its character count; to memory, its cap comes first", async () => {
  // Moved there, the document could no longer be appended to or revised, and the 64 KiB character cap does not stop it:
  // the move is decided on the JSON, past 32 KiB. Two shapes, since they prove different things. `memory`'s cap is
  // 8000 characters, under any text that encodes past 32 KiB, so for it the character refusal is the one that fires.
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    for (const key of ["memory", "todo"]) {
      await plugin.invoke("remember", { key, text: A }, ctx);
      // (a) 22,000 characters, under both 32 KiB and the cap; its newlines encode to two each, so its JSON is 33,002.
      // (b) one 33,000-character line: no escapes, the JSON is only its quotes longer.
      for (const [shape, value] of [["newlines", "m\n".repeat(11_000)], ["one line", "x".repeat(33_000)]] as const) {
        const encoded = JSON.stringify(value).length;
        const r = await refusal(() => plugin.invoke("put", { key, value }, ctx));
        const said = r.threw ?? "";
        if (key === "memory") {
          if (r.code !== "memory_full" || !said.startsWith(`memory_full: \`memory\` holds at most 8000 characters, and this put is ${value.length}, so nothing was written.`)) {
            throw new Error(`${name}: ${key}: ${shape}: ${JSON.stringify(r).slice(0, 400)}`);
          }
        } else {
          if (r.code !== `${key}_full` || !said.startsWith(`${key}_full: a \`put\` is kept where it can still be appended to and revised only up to 32768 of its JSON encoding, and this one encodes to ${encoded}, so nothing was written.`)
            || !said.includes("the encoded length, not the character count `remember` uses")) {
            throw new Error(`${name}: ${key}: ${shape}: ${JSON.stringify(r).slice(0, 400)}`);
          }
          // No character count beside the encoded limit: not the value's, not the cap, not the prompt's budget.
          for (const n of [value.length, 64 * 1024, ...WORKING_SET.map((d) => d.budget)]) {
            if (said.includes(String(n))) throw new Error(`${name}: ${key}: ${shape}: the refusal shows ${n}, a character count: ${said}`);
          }
        }
        if ((await store.getState("t", "a", key))?.value !== A) throw new Error(`${name}: ${key}: ${shape}: a refused put changed the document`);
      }
      // A value that is not text is held to the same inline limit: moved, the document could not be appended to either.
      const big = { notes: "n".repeat(33_000) };
      const obj = await refusal(() => plugin.invoke("put", { key, value: big }, ctx));
      const objSaid = obj.threw ?? "";
      if (obj.code !== `${key}_full` || !objSaid.includes(`its JSON encodes to ${JSON.stringify(big).length}`)
        || objSaid.includes("appended to") || objSaid.includes("lines") || objSaid.includes("`revise`") || !objSaid.includes("Put a smaller value")) {
        throw new Error(`${name}: ${key}: object: ${JSON.stringify(obj).slice(0, 400)}`);
      }
      if ((await store.getState("t", "a", key))?.value !== A) throw new Error(`${name}: ${key}: a refused object put changed the document`);
      // Just inside the row: stored inline, and it can still be remembered into and revised.
      const fits = key === "memory" ? "m\n".repeat(3_000) : "m\n".repeat(10_000);
      const ok = await plugin.invoke("put", { key, value: fits }, ctx) as any;
      if (ok.stored !== "inline") throw new Error(`${name}: ${key}: ${JSON.stringify(ok)}`);
      await plugin.invoke("remember", { key, text: "after the put" }, ctx);
      await plugin.invoke("revise", { key, old: "after the put" }, ctx);
    }
  }
});

await check("a put refused for its encoding over a todo kept inline past 32 KiB says to shrink it with revise or forget, and never to put a shorter document", async () => {
  // A todo grown by remember is inline at up to 64 KiB of text, which no put of it whole can be: the advice a put
  // refusal gives has to be one the agent can follow.
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    const items = Array.from({ length: 1_000 }, (_, i) => `item ${String(i).padStart(4, "0")} ${"t".repeat(30)}`);
    for (const i of items) await plugin.invoke("remember", { key: "todo", text: i }, ctx);
    const grown = String((await store.getState("t", "a", "todo"))?.value);
    if (JSON.stringify(grown).length <= 32_768 || (await store.getState("t", "a", "todo"))?.ref) throw new Error(`control: ${grown.length}`);
    // The document whole again, and a value with fewer characters than it that encodes longer by its quotes.
    for (const [shape, value] of [["the same text", grown], ["fewer characters, more escapes", '"'.repeat(20_000)]] as const) {
      if (shape !== "the same text" && value.length >= grown.length) throw new Error(`control: ${value.length}`);
      const r = await refusal(() => plugin.invoke("put", { key: "todo", value }, ctx));
      const said = r.threw ?? "";
      if (r.code !== "todo_full" || !said.includes(`this one encodes to ${JSON.stringify(value).length}, so nothing was written`)
        || !said.endsWith("To shrink the `todo` kept now where it is, delete or shorten text in it with `revise`, or drop it with `forget`.")
        || !said.includes("A `put` of text fits only if it encodes to that or less") || said.includes("Put a shorter document")) {
        throw new Error(`${name}: ${shape}: ${said}`);
      }
      if ((await store.getState("t", "a", "todo"))?.value !== grown) throw new Error(`${name}: ${shape}: a refused put changed it`);
    }
    // And the advice works: revise shrinks it in place.
    await plugin.invoke("revise", { key: "todo", old: `${items[0]}\n` }, ctx);
    if ((await store.getState("t", "a", "todo"))?.value !== grown.slice(items[0]!.length + 1)) throw new Error(`${name}: revise did not shrink it`);
    // With nothing kept inline there is nothing to shrink in place, and the sentence is not said.
    await plugin.invoke("forget", { key: "todo" }, ctx);
    const none = await refusal(() => plugin.invoke("put", { key: "todo", value: grown }, ctx));
    if (none.code !== "todo_full" || (none.threw ?? "").includes("To shrink")) throw new Error(`${name}: absent: ${JSON.stringify(none).slice(0, 300)}`);
  }
});

await check("refusals on a document ending with a newline, on one already past the cap, of several lines, and of text too long for any document", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(50);
    // The seeded shape: the trailing newline is in the size, and the line adds only itself.
    await store.putState("t", "a", "memory", { value: `${A}\n${B}\n`, ref: null, bytes: 0 });
    const seeded = await refusal(() => plugin.invoke("remember", { key: "memory", text: C }, ctx));
    if (seeded.code !== "memory_full" || !(seeded.threw ?? "").includes("it is 34 characters, this line adds 29 to make it 63, and it holds at most 50")
      || !(seeded.threw ?? "").includes("free at least 13 characters first")) throw new Error(`${name}: seeded shape: ${JSON.stringify(seeded)}`);
    if ((await store.getState("t", "a", "memory"))?.value !== `${A}\n${B}\n`) throw new Error(`${name}: seeded shape changed`);
    // Already past the cap, as a `put` under a larger cap leaves it: any line is refused, and the shortfall says how far.
    const over = `${"o".repeat(30)}\n${"p".repeat(29)}`;
    await store.putState("t", "a", "todo", { value: over, ref: null, bytes: 0 });
    const past = await refusal(() => plugin.invoke("remember", { key: "todo", text: "q" }, ctx));
    // Over its cap before this write, it is refused as that, a code of its own, saying what still works.
    if (past.code !== "todo_over_cap" || !(past.threw ?? "").startsWith("todo_over_cap: `todo` is 60 characters; its cap is 50, and it was already over before this write, so nothing was written. What still works: `revise` and `forget` can shrink it")
      || (past.threw ?? "").includes("notes/<topic>")) throw new Error(`${name}: past the cap: ${JSON.stringify(past)}`);
    if ((await store.getState("t", "a", "todo"))?.value !== over) throw new Error(`${name}: past the cap changed`);
    // Several lines are text, not a line.
    const many = await refusal(() => plugin.invoke("remember", { key: "memory", text: "first line here\nsecond line" }, ctx));
    if (!(many.threw ?? "").includes("this text adds 27 to make it 61")) throw new Error(`${name}: several lines: ${JSON.stringify(many)}`);
    // Too long for any document: on memory and todo it carries the code; on journal it does not. (`todo` is put back
    // under its cap first: over it, the over-cap refusal comes first.)
    await store.putState("t", "a", "todo", { value: "short", ref: null, bytes: 0 });
    for (const key of ["memory", "todo", "journal"]) {
      const long = await refusal(() => plugin.invoke("remember", { key, text: "y".repeat(51) }, ctx));
      const want = key === "journal" ? undefined : `${key}_full`;
      if (long.code !== want || !(long.threw ?? "").startsWith(`${want ? `${want}: ` : ""}that line is 51 characters; a document holds at most 50, so nothing was written`)) {
        throw new Error(`${name}: ${key}: too long: ${JSON.stringify(long)}`);
      }
    }
  }
});

await check("the sqlite store and the Durable Object store answer the same sequence identically", async () => {
  const runs: string[] = [];
  for (const { store, plugin } of await backends()) {
    const ctx = capped(50);
    const log: unknown[] = [];
    const steps: Array<[string, Record<string, unknown>, PluginContext?]> = [
      ["remember", { key: "journal", text: "第一行 é😀" }], ["remember", { key: "journal", text: A }],
      ["remember", { key: "journal", text: B }], ["remember", { key: "journal", text: C }],
      ["revise", { key: "journal", old: "charlie", new: "c" }], ["revise", { key: "journal", old: "c" }],
      ["remember", { key: "journal", text: "z".repeat(51) }], ["put", { key: "o", value: [1] }],
      ["remember", { key: "o", text: "x" }], ["revise", { key: "journal", old: "0123" }],
      ["revise", { key: "journal", match: "c", replace: "d" }], ["insert", { key: "journal", after_line: 0, text: "top 😀" }],
      ["insert", { key: "journal", after_line: 9, text: "x" }], ["insert", { key: "journal", after_line: 1, text: "y".repeat(40) }],
      ["remember", { key: "memory", text: A }], ["remember", { key: "memory", text: B }],
      ["remember", { key: "memory", text: C }], ["revise", { key: "memory", old: A }],
      ["insert", { key: "memory", after_line: 0, text: "w".repeat(30) }],
      ["remember", { key: "memory", text: C }], ["put", { key: "todo", value: "t".repeat(51) }],
      ["remember", { key: "todo", text: "u".repeat(51) }], ["remember", { key: "memory", text: "v\nw".repeat(10) }],
      ["put", { key: "memory", value: "m\n".repeat(11_000) }, capped(64 * 1024)],
    ];
    for (const [tool, args, own] of steps) {
      // The code too, not only the sentence: a store that refused with another code would still say the same words.
      log.push(await refusal(() => plugin.invoke(tool, args, own ?? ctx)));
      const row = await store.getState("t", "a", String(args.key));
      log.push(row?.value ?? null, row?.bytes ?? null);
    }
    log.push(await store.stateUsage("t", "a"));
    runs.push(JSON.stringify(log));
  }
  if (runs[0] !== runs[1]) throw new Error(`the stores differ:\nsqlite ${runs[0]}\ndurable ${runs[1]}`);
  for (const code of ["memory_full", "todo_full", "journal_full", "revise_renamed"]) {
    if (!runs[0]!.includes(`"code":"${code}"`)) throw new Error(`${code} was not compared: ${runs[0]}`);
  }
});

await check("concurrent remember and revise calls on one key lose no write, and each revise reply is true of the final document", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    const seeded = Array.from({ length: 8 }, (_, i) => `seeded ${i}`);
    await store.putState("t", "a", "memory", { value: seeded.join("\n"), ref: null, bytes: 0 });
    // One turn's tool calls run in parallel, and run_js runs several at once: every call below is in flight together.
    const calls = [
      ...Array.from({ length: 8 }, (_, i) => plugin.invoke("remember", { key: "memory", text: `added ${i}` }, ctx)),
      ...[0, 2, 4, 6].map((i) => plugin.invoke("revise", { key: "memory", old: `seeded ${i}`, new: `revised ${i}` }, ctx)),
      ...[1, 3, 5, 7].map((i) => plugin.invoke("revise", { key: "memory", old: `seeded ${i}` }, ctx)),
      ...[0, 1].map((i) => plugin.invoke("insert", { key: "memory", after_line: 0, text: `inserted ${i}` }, ctx)),
    ];
    const replies = await Promise.all(calls) as any[];
    const final = String((await store.getState("t", "a", "memory"))?.value).split("\n");
    for (let i = 0; i < 8; i++) {
      if (!final.includes(`added ${i}`)) throw new Error(`${name}: remember of "added ${i}" was lost: ${JSON.stringify(final)}`);
    }
    for (let i = 0; i < 2; i++) {
      if (!final.includes(`inserted ${i}`)) throw new Error(`${name}: insert of "inserted ${i}" was lost: ${JSON.stringify(final)}`);
    }
    for (const r of replies.slice(8, 16)) {
      if ("now" in r && (!final.includes(r.now) || final.includes(r.was))) throw new Error(`${name}: a replace the document does not show: ${JSON.stringify(r)} / ${JSON.stringify(final)}`);
      if ("deleted" in r && final.includes(r.deleted)) throw new Error(`${name}: a deletion the document does not show: ${JSON.stringify(r)} / ${JSON.stringify(final)}`);
    }
    if (final.length !== 14) throw new Error(`${name}: ${final.length} lines, not 4 revised, 8 added and 2 inserted: ${JSON.stringify(final)}`);
    // The last call to finish wrote the document; its length is the final one.
    if (!replies.some((r) => r.characters === final.join("\n").length)) throw new Error(`${name}: no reply's length is the final document's`);
  }
});

await check("revise replaces exactly the text given, spaces at either end included, so a nested list item keeps its indent", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    await store.putState("t", "a", "todo", { value: "- deploy\n  - web-01\n  - web-02", ref: null, bytes: 0 });
    const r = await plugin.invoke("revise", { key: "todo", old: "web-02", new: "web-02 (done)" }, ctx) as any;
    if ((await store.getState("t", "a", "todo"))?.value !== "- deploy\n  - web-01\n  - web-02 (done)") throw new Error(`${name}: ${JSON.stringify(await store.getState("t", "a", "todo"))}`);
    if (r.now !== "web-02 (done)" || r.was !== "web-02") throw new Error(`${name}: the reply: ${JSON.stringify(r)}`);
    // Nothing is trimmed: a space in `new` is part of what replaces `old`.
    await plugin.invoke("revise", { key: "todo", old: "  - web-01", new: "    - web-01  " }, ctx);
    if ((await store.getState("t", "a", "todo"))?.value !== "- deploy\n    - web-01  \n  - web-02 (done)") throw new Error(`${name}: ${JSON.stringify(await store.getState("t", "a", "todo"))}`);
  }
});

await check("a document already past the cap can lose or shorten a line, and only growth past it is refused", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(20);
    const over = "first line is long\nsecond line is long\nthird";
    await store.putState("t", "a", "memory", { value: over, ref: null, bytes: 0 });
    const grow = await attempt(() => plugin.invoke("revise", { key: "memory", old: "third", new: "third, and longer" }, ctx));
    if (!/^memory_over_cap: `memory` is 44 characters; its cap is 20, and it was already over before this write/.test(grow.threw ?? "")) throw new Error(`${name}: growth: ${JSON.stringify(grow)}`);
    // The same length is not growth.
    await plugin.invoke("revise", { key: "memory", old: "third", new: "THIRD" }, ctx);
    await plugin.invoke("revise", { key: "memory", old: "second line is long", new: "second" }, ctx);
    await plugin.invoke("revise", { key: "memory", old: "first line is long" }, ctx);
    const value = (await store.getState("t", "a", "memory"))?.value;
    if (value !== "second\nTHIRD") throw new Error(`${name}: ${JSON.stringify(value)}`);
  }
});

await check("deleting the only line leaves an empty document, and the next remember starts it again", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    await plugin.invoke("remember", { key: "todo", text: "the only item" }, ctx);
    const r = await plugin.invoke("revise", { key: "todo", old: "the only item" }, ctx) as any;
    if (r.characters !== 0 || r.line !== 1 || r.deleted !== "the only item") throw new Error(`${name}: ${JSON.stringify(r)}`);
    if ((await store.getState("t", "a", "todo"))?.value !== "") throw new Error(`${name}: not empty`);
    await plugin.invoke("remember", { key: "todo", text: "a new item" }, ctx);
    if ((await store.getState("t", "a", "todo"))?.value !== "a new item") throw new Error(`${name}: ${(await store.getState("t", "a", "todo"))?.value}`);
  }
});

await check("dropping from a document that ends with a newline leaves no blank first line, and blank lines are not counted as dropped", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(30);
    // Without a drop: the text follows the last line, not a blank one after it.
    await store.putState("t", "a", "plan.md", { value: "1. Learn the repo\n", ref: null, bytes: 0 });
    await plugin.invoke("remember", { key: "plan.md", text: "2. Ship" }, ctx);
    if ((await store.getState("t", "a", "plan.md"))?.value !== "1. Learn the repo\n2. Ship") throw new Error(`${name}: ${(await store.getState("t", "a", "plan.md"))?.value}`);
    // Dropping `alpha` alone makes room; the blank line after it would then open the document, so it goes too, uncounted.
    await store.putState("t", "a", "journal", { value: "alpha 0123456789\n\nbravo\n", ref: null, bytes: 0 });
    const r = await plugin.invoke("remember", { key: "journal", text: "charlie 0123456789 0123" }, ctx) as any;
    const value = (await store.getState("t", "a", "journal"))?.value;
    if (value !== "bravo\ncharlie 0123456789 0123") throw new Error(`${name}: kept ${JSON.stringify(value)}`);
    if (r.dropped.lines !== 1 || r.dropped.text !== "alpha 0123456789" || !/1 oldest line was dropped/.test(r.note)) {
      throw new Error(`${name}: ${JSON.stringify(r)}`);
    }
  }
});

await check("a CRLF document stays CRLF: append and revise keep its line ends, and the replies quote lines without the \\r", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(40);
    await store.putState("t", "a", "notes.md", { value: "one 0123456789\r\ntwo 0123456789\r\nthree", ref: null, bytes: 0 });
    const r = await plugin.invoke("revise", { key: "notes.md", old: "two 0123456789", new: "TWO" }, ctx) as any;
    if (r.was !== "two 0123456789" || r.now !== "TWO") throw new Error(`${name}: revise reply: ${JSON.stringify(r)}`);
    const value = () => store.getState("t", "a", "notes.md").then((g) => g?.value);
    if (await value() !== "one 0123456789\r\nTWO\r\nthree") throw new Error(`${name}: after revise ${JSON.stringify(await value())}`);
    const a = await plugin.invoke("remember", { key: "notes.md", text: "four 0123456789 01234" }, ctx) as any;
    if (await value() !== "TWO\r\nthree\r\nfour 0123456789 01234") throw new Error(`${name}: after remember ${JSON.stringify(await value())}`);
    if (a.dropped.text !== "one 0123456789" || a.dropped.lines !== 1) throw new Error(`${name}: remember reply: ${JSON.stringify(a)}`);
    await plugin.invoke("revise", { key: "notes.md", old: "three" }, ctx);
    if (await value() !== "TWO\r\nfour 0123456789 01234") throw new Error(`${name}: after delete ${JSON.stringify(await value())}`);
    // Text across lines given with \n matches the CRLF document, and lands in it as CRLF; the reply quotes it with \n.
    const x = await plugin.invoke("revise", { key: "notes.md", old: "TWO\nfour", new: "2\n4" }, ctx) as any;
    if (await value() !== "2\r\n4 0123456789 01234" || x.was !== "TWO\nfour" || x.now !== "2\n4") throw new Error(`${name}: across CRLF ${JSON.stringify(await value())} / ${JSON.stringify(x)}`);
  }
});

await check("the refusal of over-long text says text when it spans lines, and revise quotes a long replacement up to its limit", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(10);
    const multi = await attempt(() => plugin.invoke("remember", { key: "j", text: "line one\nline two" }, ctx));
    if (!/^that text is 17 characters/.test(multi.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(multi)}`);
    const one = await attempt(() => plugin.invoke("remember", { key: "j", text: "a single long line" }, ctx));
    if (!/^that line is 18 characters/.test(one.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(one)}`);
    await store.putState("t", "a", "k", { value: "old", ref: null, bytes: 0 });
    const r = await plugin.invoke("revise", { key: "k", old: "old", new: "n".repeat(900) }, capped(64 * 1024)) as any;
    if (r.now !== "n".repeat(500)) throw new Error(`${name}: now is ${r.now.length} characters`);
    if ((await store.getState("t", "a", "k"))?.value !== "n".repeat(900)) throw new Error(`${name}: the stored line was cut`);
  }
});

await check("every write stores bytes as the JSON's length, emoji, newlines and quotes included, so the store's total adds up one unit", async () => {
  // A text document used to store its length in characters there and `put` its JSON's, and the total summed both.
  const astral = 'the owner said "😀 call me 𝒮am" \\ \t done';
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    const row = async (key: string) => {
      const r = (await store.getState("t", "a", key))!;
      if (r.bytes !== JSON.stringify(r.value).length) throw new Error(`${name}: ${key}: bytes ${r.bytes}, its JSON is ${JSON.stringify(r.value).length}`);
      return r;
    };
    await plugin.invoke("remember", { key: "memory", text: astral }, ctx);
    await plugin.invoke("remember", { key: "memory", text: `two\nlines "${astral}"` }, ctx);
    const m = await row("memory");
    if (m.bytes === String(m.value).length) throw new Error(`${name}: control: no escape or astral character made the units differ`);
    await plugin.invoke("revise", { key: "memory", old: "two\nlines", new: "😀\n\"two\"" }, ctx);
    await row("memory");
    await plugin.invoke("insert", { key: "memory", after_line: 0, text: "🎉 \"top\"" }, ctx);
    await plugin.invoke("insert", { key: "journal", after_line: 0, text: astral }, ctx);
    await plugin.invoke("put", { key: "data", value: { x: astral } }, ctx);
    let sum = 0;
    for (const key of ["memory", "journal", "data"]) sum += (await row(key)).bytes;
    const usage = await store.stateUsage("t", "a");
    const listed = await plugin.invoke("list", {}, ctx) as any;
    if (usage.bytes !== sum || usage.keys !== 3 || listed.total.bytes !== sum) throw new Error(`${name}: usage ${JSON.stringify(usage)}, rows sum to ${sum}`);
    for (const r of listed.keys) if (r.bytes !== JSON.stringify((await store.getState("t", "a", r.key))!.value).length) throw new Error(`${name}: list row ${JSON.stringify(r)}`);
  }
});

await check("remember, insert and revise that grow the store past maxTotalBytes are refused with forget on this mount; shrinking is not", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = { ...capped(64 * 1024), alias: "memo", publicConfig: { account: "x", maxDocumentBytes: 64 * 1024, maxTotalBytes: 200 } } as unknown as PluginContext;
    await plugin.invoke("put", { key: "data", value: "d".repeat(150) }, ctx);
    await plugin.invoke("remember", { key: "notes", text: "abcdefghij0123456789" }, ctx);
    const before = await store.stateUsage("t", "a");
    for (const [tool, args] of [["remember", { text: "m".repeat(30) }], ["insert", { after_line: 0, text: "m".repeat(30) }],
      ["revise", { old: "0123456789", new: "m".repeat(40) }]] as const) {
      const r = await refusal(() => plugin.invoke(tool, { key: "notes", ...args }, ctx));
      if (r.code !== "store_full" || r.threw !== `this would take the store past 200 bytes (currently ${before.bytes}); delete something with the \`forget\` tool on \`memo\``) {
        throw new Error(`${name}: ${tool}: ${JSON.stringify(r)}`);
      }
    }
    if (JSON.stringify(await store.stateUsage("t", "a")) !== JSON.stringify(before)) throw new Error(`${name}: a refused write changed the store`);
    // A full store can still be tidied: a revise that shrinks a document goes through.
    await plugin.invoke("revise", { key: "notes", old: "0123456789" }, ctx);
    if ((await store.getState("t", "a", "notes"))?.value !== "abcdefghij") throw new Error(`${name}: a shrinking revise was refused`);
  }
});

await check("a put to a store already past maxTotalBytes may shrink a value, and one that grows a value is refused", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = { ...capped(64 * 1024), alias: "memo", publicConfig: { account: "x", maxDocumentBytes: 64 * 1024, maxTotalBytes: 100 } } as unknown as PluginContext;
    // Past the limit as the bytes backfill can leave a store: written under no limit, then held to one.
    await plugin.invoke("put", { key: "data", value: "d".repeat(150) }, capped(64 * 1024));
    const usage = (await store.stateUsage("t", "a")).bytes;
    if (usage <= 100) throw new Error(`control: ${usage}`);
    const grow = await refusal(() => plugin.invoke("put", { key: "data", value: "d".repeat(151) }, ctx));
    if (grow.code !== "store_full" || grow.threw !== `this would take the store past 100 bytes (currently ${usage}); delete something with the \`forget\` tool on \`memo\``) {
      throw new Error(`${name}: growth: ${JSON.stringify(grow)}`);
    }
    const other = await refusal(() => plugin.invoke("put", { key: "new", value: 1 }, ctx));
    if (other.code !== "store_full") throw new Error(`${name}: a new key: ${JSON.stringify(other)}`);
    // Smaller, though the store is still past the limit after it.
    const p = await plugin.invoke("put", { key: "data", value: "d".repeat(120) }, ctx) as any;
    if (p.stored !== "inline" || (await store.getState("t", "a", "data"))?.value !== "d".repeat(120)) throw new Error(`${name}: a shrinking put: ${JSON.stringify(p)}`);
  }
});

await check("the bytes backfill makes an old row's character count its JSON's length, emoji included, on both stores, and runs once", async () => {
  const astral = 'old "row" 😀😀😀\nsecond 𝒮';
  const chars = astral.length, encoded = JSON.stringify(astral).length;
  if (chars === encoded) throw new Error("control: the two units agree");
  // sqlite, over a file, so a second store opens the same rows.
  const path = `${process.env.TMPDIR ?? "/tmp"}/state-backfill-${process.pid}-${Date.now()}.db`;
  const raw = (q: string, ...b: unknown[]) => { const db = new DatabaseSync(path); try { return db.prepare(q).all(...(b as any[])); } finally { db.close(); } };
  const sqliteOpen = async () => { const s = new SqliteStore(path); await s.init(); return s; };
  const host = sqliteHost();
  const durableOpen = async () => { const s = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any); await s.init(); return s; };
  const durableRaw = (q: string, ...b: unknown[]) => host.sql.exec(q, ...b).toArray();
  for (const [name, open, sql] of [["sqlite", sqliteOpen, raw], ["durable-object", durableOpen, durableRaw]] as const) {
    const first = await open();
    await first.createAgent("t", "a");
    // Rows as they were written before: a text document's length in characters, a spilled row's JSON length.
    await first.putState("t", "a", "memory", { value: astral, ref: null, bytes: chars });
    await first.putState("t", "a", "big", { value: null, ref: "r2://b/t/t/a/state/big.json", bytes: 99_999 });
    sql("DELETE FROM counters WHERE name=?", STATE_BYTES_MARKER);
    await (await open()).init();
    const bytes = (key: string) => Number((sql("SELECT bytes FROM agent_state WHERE key=?", key)[0] as any).bytes);
    if (bytes("memory") !== encoded || bytes("big") !== 99_999) throw new Error(`${name}: after the backfill: ${bytes("memory")}, ${bytes("big")}`);
    if ((await first.stateUsage("t", "a")).bytes !== encoded + 99_999) throw new Error(`${name}: usage ${JSON.stringify(await first.stateUsage("t", "a"))}`);
    // Once: with the marker there, a row left in characters is not looked at again.
    sql("UPDATE agent_state SET bytes=? WHERE key=?", chars, "memory");
    await (await open()).init();
    if (bytes("memory") !== chars) throw new Error(`${name}: the backfill ran a second time`);
  }
  rmSync(path, { force: true });
});

console.log(`\n  Agent state\n  ${"─".repeat(56)}`);
const KEK = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

await check("the agent keeps a secret by name: sealed at rest, listed by name only, read back, deleted", async () => {
  const { store, ctx } = await fixture();
  const key = await importKek(KEK);
  const plugin = statePlugin(store, null, "local", async () => key);
  await plugin.invoke("secret_put", { name: "openai", value: "sk-test-9f8e7d" }, ctx());
  const rows = (store as any).dumpTables().secrets as any[];
  if (rows.length !== 1 || JSON.stringify(rows).includes("sk-test-9f8e7d")) throw new Error(`stored in the clear: ${JSON.stringify(rows)}`);
  const listed: any = await plugin.invoke("secret_list", {}, ctx());
  if (listed.secrets.length !== 1 || listed.secrets[0].name !== "openai" || JSON.stringify(listed).includes("sk-test")) {
    throw new Error(`list: ${JSON.stringify(listed)}`);
  }
  const got: any = await plugin.invoke("secret_get", { name: "openai" }, ctx());
  if (got.value !== "sk-test-9f8e7d") throw new Error(`get: ${JSON.stringify(got)}`);
  const del: any = await plugin.invoke("secret_delete", { name: "openai" }, ctx());
  if (del.deleted !== true) throw new Error(`delete: ${JSON.stringify(del)}`);
  let threw = "";
  try { await plugin.invoke("secret_get", { name: "openai" }, ctx()); } catch (e) { threw = String((e as Error).message); }
  if (!/no secret named openai/.test(threw)) throw new Error(`after delete: ${threw}`);
});

await check("secret_get cannot read a mount's credential or a hook's secret, even by guessing its name", async () => {
  const { store, ctx } = await fixture();
  const key = await importKek(KEK);
  const plugin = statePlugin(store, null, "local", async () => key);
  await store.putSecret("t", "a", "gh", await seal(key, "ghp_mount_credential"));
  await store.putSecret("t", "a", "hook:abc", await seal(key, "hook-secret"));
  for (const name of ["gh", "hook:abc", "../gh", "kept:gh"]) {
    let out = ""; try { out = JSON.stringify(await plugin.invoke("secret_get", { name }, ctx())); } catch (e) { out = String((e as Error).message); }
    if (/ghp_mount_credential|hook-secret/.test(out)) throw new Error(`${name} reached a credential: ${out}`);
  }
  const listed: any = await plugin.invoke("secret_list", {}, ctx());
  if (listed.secrets.length !== 0) throw new Error(`list showed rows that are not the agent's: ${JSON.stringify(listed)}`);
});

await check("a deployment with no sealing key says so instead of keeping a secret in the clear", async () => {
  const { plugin, ctx } = await fixture();
  let threw = "";
  try { await plugin.invoke("secret_put", { name: "x", value: "v" }, ctx()); } catch (e) { threw = String((e as Error).message); }
  if (!/no key for sealing secrets/.test(threw)) throw new Error(threw || "kept without a key");
});

await check("code in run_js reads a secret kept with secret_put, through the same gateway call", async () => {
  const { store } = await fixture();
  const key = await importKek(KEK);
  const plugin = statePlugin(store, null, "local", async () => key);
  await store.addMount({ tenantId: "t", agentId: "a", alias: "state", plugin: "state", installationId: "i", connectionId: null,
    toolVersion: plugin.version, publicConfig: {}, secretRef: null, policy: null });
  const gw = new ToolGateway(store, [plugin], new Set(["state"]), { async resolve() { return null; } });
  const call = { tenantId: "t", agentId: "a", taskId: "k" };
  const put = await gw.invoke(call, "state.secret_put", { name: "api", value: "tok-123" });
  if (put.status !== "succeeded") throw new Error(`put: ${JSON.stringify(put)}`);
  const run = await new QuickJsExecutor().execute(
    "const r = await tool`state.secret_get ${ { name: \"api\" } }`; output(r.status === \"succeeded\" && r.result.value.length);",
    { invoke: ({ tool, args }) => gw.invoke(call, tool, args) },
  );
  if (run.status !== "completed" || JSON.stringify(run.outputs) !== "[7]") throw new Error(`run_js: ${JSON.stringify(run)}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
