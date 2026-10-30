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
import { READ_WHOLE_MAX } from "../src/plugins/artifacts.ts";
import { systemPrompt } from "../src/runtime/pi-prompt.ts";
import type { PluginContext } from "../src/plugins/types.ts";
import { importKek, seal } from "../src/runtime/secrets.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { StorageAdapter } from "../src/core/store.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";

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
  const r = await store.appendState("t", "a", "journal", "the newest line", 20);
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

await check("a memory over its budget shows its first and its latest lines, and between them how much is left out and how to read it", async () => {
  const { store, plugin, ctx } = await fixture();
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "state", installationId: "i", connectionId: null,
    plugin: "state", toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  } as any);
  const budget = WORKING_SET.find((d) => d.key === "memory")!.budget;
  await plugin.invoke("remember", { key: "memory", text: "EARLIEST-NOTE: the owner is Ada" }, ctx());
  for (let i = 0; i < Math.ceil(budget / 40) * 2; i++) await plugin.invoke("remember", { key: "memory", text: `filler note ${i} ${"x".repeat(20)}` }, ctx());
  await plugin.invoke("remember", { key: "memory", text: "LATEST-NOTE: Ada prefers mornings" }, ctx());
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

await check("revise replaces or deletes the one line its match is in, and says what changed", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    for (const text of ["deploy window: Tuesday 02:00 UTC", "web-02 owner: Ana", "prefers short replies"]) {
      await plugin.invoke("remember", { key: "memory", text }, ctx);
    }
    const r = await plugin.invoke("revise", { key: "memory", match: "Tuesday", replace: "deploy window: Thursday 03:00 UTC" }, ctx) as any;
    const value = () => store.getState("t", "a", "memory").then((g) => g?.value);
    if (await value() !== "deploy window: Thursday 03:00 UTC\nweb-02 owner: Ana\nprefers short replies") throw new Error(`${name}: replace: ${await value()}`);
    if (r.line !== 1 || r.was !== "deploy window: Tuesday 02:00 UTC" || r.now !== "deploy window: Thursday 03:00 UTC" || r.note !== "line 1 was replaced") {
      throw new Error(`${name}: the replace reply: ${JSON.stringify(r)}`);
    }
    const d = await plugin.invoke("revise", { key: "memory", match: "owner: Ana" }, ctx) as any;
    if (await value() !== "deploy window: Thursday 03:00 UTC\nprefers short replies") throw new Error(`${name}: delete: ${await value()}`);
    if (d.line !== 2 || d.deleted !== "web-02 owner: Ana" || d.note !== "line 2 was deleted" || d.bytes !== String(await value()).length) {
      throw new Error(`${name}: the delete reply: ${JSON.stringify(d)}`);
    }
  }
});

await check("revise refuses a match that occurs in no line or more than once, says how many, and changes nothing", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    await store.putState("t", "a", "todo", { value: "confirm web-02\nconfirm web-03\nbook aaa", ref: null, bytes: 0 });
    const before = (await store.getState("t", "a", "todo"))?.value;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ match: "web-04" }, /occurs in no line of `todo` \(0 matches\)/],
      [{ match: "confirm", replace: "x" }, /occurs 2 times in `todo` \(lines 1, 2\); nothing was changed/],
      // Two occurrences in one line are two: the count does not depend on what the line is.
      [{ match: "aa" }, /occurs 2 times in `todo` \(line 3\)/],
      [{ match: "web-02\nconfirm" }, /within one line/],
      [{ match: "" }, /`match` is empty/],
      [{ match: "web-02", replace: "two\nlines" }, /`replace` is one line/],
      [{ match: "web-02", replace: "  " }, /`replace` is empty; leave it out to delete the line/],
    ];
    for (const [args, want] of cases) {
      const r = await attempt(() => plugin.invoke("revise", { key: "todo", ...args }, ctx));
      if (!want.test(r.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(args)}: ${JSON.stringify(r)}`);
    }
    if ((await store.getState("t", "a", "todo"))?.value !== before) throw new Error(`${name}: a refused revise changed the document`);
  }
});

await check("revise refuses a value that is not text, one kept in object storage, an absent key, and a result past the cap", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(40);
    await plugin.invoke("put", { key: "data", value: { line: "x" } }, ctx);
    await store.putState("t", "a", "big", { value: null, ref: "r2://b/t/t/a/state/big.json", bytes: 99_999 });
    await plugin.invoke("remember", { key: "memory", text: "short line" }, ctx);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ key: "data", match: "x" }, /`data` holds an object, not a text document, so it has no lines to revise; it is unchanged/],
      [{ key: "big", match: "x" }, /`big` is too large to revise; read it and put a new one/],
      [{ key: "nothing", match: "x" }, /there is no `nothing` to revise/],
      [{ key: "memory", match: "short", replace: "z".repeat(41) }, /make `memory` 41 characters; a document holds at most 40, so nothing was changed/],
      [{ key: "memory", match: 5 }, /`match` must be a string/],
    ];
    for (const [args, want] of cases) {
      const r = await attempt(() => plugin.invoke("revise", args as any, ctx));
      if (!want.test(r.threw ?? "")) throw new Error(`${name}: ${JSON.stringify(args)}: ${JSON.stringify(r)}`);
    }
    if (JSON.stringify((await store.getState("t", "a", "data"))?.value) !== '{"line":"x"}') throw new Error(`${name}: data changed`);
    if ((await store.getState("t", "a", "memory"))?.value !== "short line") throw new Error(`${name}: memory changed past the cap`);
    // At the cap exactly is allowed: the cap is the most a document holds.
    await plugin.invoke("revise", { key: "memory", match: "short", replace: "z".repeat(40) }, ctx);
    if ((await store.getState("t", "a", "memory"))?.value !== "z".repeat(40)) throw new Error(`${name}: a revise at the cap was refused`);
  }
});

/** One sequence on both stores: every reply, refusal and value the same, character for character. Both call the rules in
 *  state-lines.ts, so this catches a store that stops calling them; the concurrency check is the one that tells the
 *  stores' own reads and writes apart. */
await check("the sqlite store and the Durable Object store answer the same sequence identically", async () => {
  const runs: string[] = [];
  for (const { store, plugin } of await backends()) {
    const ctx = capped(50);
    const log: unknown[] = [];
    const steps: Array<[string, Record<string, unknown>]> = [
      ["remember", { key: "journal", text: "第一行 é😀" }], ["remember", { key: "journal", text: A }],
      ["remember", { key: "journal", text: B }], ["remember", { key: "journal", text: C }],
      ["revise", { key: "journal", match: "charlie", replace: "c" }], ["revise", { key: "journal", match: "c" }],
      ["remember", { key: "journal", text: "z".repeat(51) }], ["put", { key: "o", value: [1] }],
      ["remember", { key: "o", text: "x" }], ["revise", { key: "journal", match: "0123" }],
    ];
    for (const [tool, args] of steps) {
      log.push(await attempt(() => plugin.invoke(tool, args, ctx)));
      log.push((await store.getState("t", "a", String(args.key)))?.value ?? null);
    }
    runs.push(JSON.stringify(log));
  }
  if (runs[0] !== runs[1]) throw new Error(`the stores differ:\nsqlite ${runs[0]}\ndurable ${runs[1]}`);
});

await check("concurrent remember and revise calls on one key lose no write, and each revise reply is true of the final document", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    const seeded = Array.from({ length: 8 }, (_, i) => `seeded ${i}`);
    await store.putState("t", "a", "memory", { value: seeded.join("\n"), ref: null, bytes: 0 });
    // One turn's tool calls run in parallel, and run_js runs several at once: every call below is in flight together.
    const calls = [
      ...Array.from({ length: 8 }, (_, i) => plugin.invoke("remember", { key: "memory", text: `added ${i}` }, ctx)),
      ...[0, 2, 4, 6].map((i) => plugin.invoke("revise", { key: "memory", match: `seeded ${i}`, replace: `revised ${i}` }, ctx)),
      ...[1, 3, 5, 7].map((i) => plugin.invoke("revise", { key: "memory", match: `seeded ${i}` }, ctx)),
    ];
    const replies = await Promise.all(calls) as any[];
    const final = String((await store.getState("t", "a", "memory"))?.value).split("\n");
    for (let i = 0; i < 8; i++) {
      if (!final.includes(`added ${i}`)) throw new Error(`${name}: remember of "added ${i}" was lost: ${JSON.stringify(final)}`);
    }
    for (const r of replies.slice(8)) {
      if ("now" in r && (!final.includes(r.now) || final.includes(r.was))) throw new Error(`${name}: a replace the document does not show: ${JSON.stringify(r)} / ${JSON.stringify(final)}`);
      if ("deleted" in r && final.includes(r.deleted)) throw new Error(`${name}: a deletion the document does not show: ${JSON.stringify(r)} / ${JSON.stringify(final)}`);
    }
    if (final.length !== 12) throw new Error(`${name}: ${final.length} lines, not 4 revised and 8 added: ${JSON.stringify(final)}`);
    // The last call to finish wrote the document; its byte count is the final one.
    if (!replies.some((r) => r.bytes === final.join("\n").length)) throw new Error(`${name}: no reply's size is the final document's`);
  }
});

await check("revise keeps a replacement's leading spaces, so a nested list item can be restored, and trims only its end", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    await store.putState("t", "a", "todo", { value: "- deploy\n  - web-01\n  - web-02", ref: null, bytes: 0 });
    const r = await plugin.invoke("revise", { key: "todo", match: "web-02", replace: "  - web-02 (done)  \n" }, ctx) as any;
    const value = (await store.getState("t", "a", "todo"))?.value;
    if (value !== "- deploy\n  - web-01\n  - web-02 (done)") throw new Error(`${name}: ${JSON.stringify(value)}`);
    if (r.now !== "  - web-02 (done)" || r.was !== "  - web-02") throw new Error(`${name}: the reply: ${JSON.stringify(r)}`);
  }
});

await check("a document already past the cap can lose or shorten a line, and only growth past it is refused", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(20);
    const over = "first line is long\nsecond line is long\nthird";
    await store.putState("t", "a", "memory", { value: over, ref: null, bytes: 0 });
    const grow = await attempt(() => plugin.invoke("revise", { key: "memory", match: "third", replace: "third, and longer" }, ctx));
    if (!/a document holds at most 20, so nothing was changed/.test(grow.threw ?? "")) throw new Error(`${name}: growth: ${JSON.stringify(grow)}`);
    // The same length is not growth.
    await plugin.invoke("revise", { key: "memory", match: "third", replace: "THIRD" }, ctx);
    await plugin.invoke("revise", { key: "memory", match: "second", replace: "second" }, ctx);
    await plugin.invoke("revise", { key: "memory", match: "first" }, ctx);
    const value = (await store.getState("t", "a", "memory"))?.value;
    if (value !== "second\nTHIRD") throw new Error(`${name}: ${JSON.stringify(value)}`);
  }
});

await check("deleting the only line leaves an empty document, and the next remember starts it again", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(64 * 1024);
    await plugin.invoke("remember", { key: "todo", text: "the only item" }, ctx);
    const r = await plugin.invoke("revise", { key: "todo", match: "only" }, ctx) as any;
    if (r.bytes !== 0 || r.line !== 1 || r.deleted !== "the only item") throw new Error(`${name}: ${JSON.stringify(r)}`);
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
    const r = await plugin.invoke("revise", { key: "notes.md", match: "two", replace: "TWO" }, ctx) as any;
    if (r.was !== "two 0123456789" || r.now !== "TWO") throw new Error(`${name}: revise reply: ${JSON.stringify(r)}`);
    const value = () => store.getState("t", "a", "notes.md").then((g) => g?.value);
    if (await value() !== "one 0123456789\r\nTWO\r\nthree") throw new Error(`${name}: after revise ${JSON.stringify(await value())}`);
    const a = await plugin.invoke("remember", { key: "notes.md", text: "four 0123456789 01234" }, ctx) as any;
    if (await value() !== "TWO\r\nthree\r\nfour 0123456789 01234") throw new Error(`${name}: after remember ${JSON.stringify(await value())}`);
    if (a.dropped.text !== "one 0123456789" || a.dropped.lines !== 1) throw new Error(`${name}: remember reply: ${JSON.stringify(a)}`);
    await plugin.invoke("revise", { key: "notes.md", match: "three" }, ctx);
    if (await value() !== "TWO\r\nfour 0123456789 01234") throw new Error(`${name}: after delete ${JSON.stringify(await value())}`);
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
    const r = await plugin.invoke("revise", { key: "k", match: "old", replace: "n".repeat(900) }, capped(64 * 1024)) as any;
    if (r.now !== "n".repeat(500)) throw new Error(`${name}: now is ${r.now.length} characters`);
    if ((await store.getState("t", "a", "k"))?.value !== "n".repeat(900)) throw new Error(`${name}: the stored line was cut`);
  }
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
