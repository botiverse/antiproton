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
        "blank lines or layout, `put` the document again, shorter, instead",
        `The prompt shows only the first and last part of \`${key}\` past ${budget} characters`, "`get` reads all of it"]) {
        if (!said.includes(want)) throw new Error(`${name}: ${key}: the refusal does not say ${JSON.stringify(want)}: ${said}`);
      }
      const after = await store.getState("t", "a", key);
      if (after?.value !== `${A}\n${B}` || after.value !== before?.value || after.bytes !== before.bytes) {
        throw new Error(`${name}: ${key}: a refused remember changed the document: ${JSON.stringify(after)}`);
      }
      // Freeing space is the agent's decision, and once it is made the same line goes in.
      await plugin.invoke("revise", { key, match: "alpha" }, ctx);
      const ok = await plugin.invoke("remember", { key, text: C }, ctx) as any;
      if ("dropped" in ok || ok.bytes !== B.length + 1 + C.length || ok.cap !== 50) throw new Error(`${name}: ${key}: after freeing space: ${JSON.stringify(ok)}`);
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

await check("the listing stops at 50 lines and 200 characters a line, and says how many more there are", async () => {
  for (const { name, store, plugin } of await backends()) {
    const ctx = capped(20_000);
    const lines = Array.from({ length: 60 }, (_, i) => i === 0 ? `L0 ${"w".repeat(300)}` : `L${i} ${"v".repeat(200)}`);
    await store.putState("t", "a", "todo", { value: lines.join("\n"), ref: null, bytes: 0 });
    const r = await (async () => { try { await plugin.invoke("remember", { key: "todo", text: "y".repeat(8000) }, ctx); return null; } catch (e) { return e as any; } })();
    const listed = String(r?.modelOnly ?? "");
    const rows = listed.split("\n");
    if (r?.code !== "todo_full" || rows[0] !== "`todo` now, by line number:" || rows.length !== 52) throw new Error(`${name}: ${rows.length} rows: ${listed.slice(0, 300)}`);
    if (rows[1] !== `1: L0 ${"w".repeat(197)}…` || rows[50] !== `50: ${lines[49]!.slice(0, 200)}…`) throw new Error(`${name}: ${rows[1]} / ${rows[50]}`);
    if (rows[51] !== "… and 10 more lines; `get` reads all of it") throw new Error(`${name}: ${rows[51]}`);
    if (String(r.message).includes("L0 ") || String(r.message).includes("vvvv")) throw new Error(`${name}: the message carries the lines`);
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

await check("remember, revise and get of a text document give its length and the cap in characters", async () => {
  for (const { name, plugin } of await backends()) {
    const ctx = capped(4000);
    const r = await plugin.invoke("remember", { key: "memory", text: "line é \"quoted\"" }, ctx) as any;
    const v = await plugin.invoke("revise", { key: "memory", match: "line", replace: "line é \"quoted\" 2" }, ctx) as any;
    const g = await plugin.invoke("get", { key: "memory" }, ctx) as any;
    const len = 'line é "quoted" 2'.length;
    if (r.cap !== 4000 || r.bytes !== len - 2 || v.cap !== 4000 || v.bytes !== len || g.cap !== 4000 || g.characters !== len) {
      throw new Error(`${name}: ${JSON.stringify({ r, v, g })}`);
    }
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
await check("a text put to memory or todo that put would move to object storage is refused by its JSON length, never its character count", async () => {
  // Moved there, the document could no longer be appended to or revised, and the 64 KiB character cap does not stop it:
  // the move is decided on the JSON, past 32 KiB. Two shapes, since they prove different things.
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
        if (r.code !== `${key}_full` || !said.startsWith(`${key}_full: a \`put\` is kept where it can still be appended to and revised only up to 32768 of its JSON encoding, and this one encodes to ${encoded}, so nothing was written.`)
          || !said.includes("the encoded length, not the character count `remember` uses")) {
          throw new Error(`${name}: ${key}: ${shape}: ${JSON.stringify(r).slice(0, 400)}`);
        }
        // No character count beside the encoded limit: not the value's, not the cap, not the prompt's budget.
        for (const n of [value.length, 64 * 1024, ...WORKING_SET.map((d) => d.budget)]) {
          if (said.includes(String(n))) throw new Error(`${name}: ${key}: ${shape}: the refusal shows ${n}, a character count: ${said}`);
        }
        if ((await store.getState("t", "a", key))?.value !== A) throw new Error(`${name}: ${key}: ${shape}: a refused put changed the document`);
      }
      // A value that is not text is held to the same inline limit: moved, the document could not be appended to either.
      const big = { notes: "n".repeat(33_000) };
      const obj = await refusal(() => plugin.invoke("put", { key, value: big }, ctx));
      const objSaid = obj.threw ?? "";
      if (obj.code !== `${key}_full` || !objSaid.includes(`its JSON encodes to ${JSON.stringify(big).length}`)
        || objSaid.includes("appended to") || objSaid.includes("lines") || !objSaid.includes("Put a smaller value")) {
        throw new Error(`${name}: ${key}: object: ${JSON.stringify(obj).slice(0, 400)}`);
      }
      if ((await store.getState("t", "a", key))?.value !== A) throw new Error(`${name}: ${key}: a refused object put changed the document`);
      // Just inside the row: stored inline, and it can still be remembered into and revised.
      const fits = "m\n".repeat(10_000);
      const ok = await plugin.invoke("put", { key, value: fits }, ctx) as any;
      if (ok.stored !== "inline") throw new Error(`${name}: ${key}: ${JSON.stringify(ok)}`);
      await plugin.invoke("remember", { key, text: "after the put" }, ctx);
      await plugin.invoke("revise", { key, match: "after the" }, ctx);
    }
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
    if (past.code !== "todo_full" || !(past.threw ?? "").includes("it is 60 characters, this line adds 2 to make it 62, and it holds at most 50")
      || !(past.threw ?? "").includes("free at least 12 characters first")) throw new Error(`${name}: past the cap: ${JSON.stringify(past)}`);
    if ((await store.getState("t", "a", "todo"))?.value !== over) throw new Error(`${name}: past the cap changed`);
    // Several lines are text, not a line.
    const many = await refusal(() => plugin.invoke("remember", { key: "memory", text: "first line here\nsecond line" }, ctx));
    if (!(many.threw ?? "").includes("this text adds 27 to make it 61")) throw new Error(`${name}: several lines: ${JSON.stringify(many)}`);
    // Too long for any document: on memory and todo it carries the code; on journal it does not.
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
      ["revise", { key: "journal", match: "charlie", replace: "c" }], ["revise", { key: "journal", match: "c" }],
      ["remember", { key: "journal", text: "z".repeat(51) }], ["put", { key: "o", value: [1] }],
      ["remember", { key: "o", text: "x" }], ["revise", { key: "journal", match: "0123" }],
      ["remember", { key: "memory", text: A }], ["remember", { key: "memory", text: B }],
      ["remember", { key: "memory", text: C }], ["revise", { key: "memory", match: "alpha" }],
      ["remember", { key: "memory", text: C }], ["put", { key: "todo", value: "t".repeat(51) }],
      ["remember", { key: "todo", text: "u".repeat(51) }], ["remember", { key: "memory", text: "v\nw".repeat(10) }],
      ["put", { key: "memory", value: "m\n".repeat(11_000) }, capped(64 * 1024)],
    ];
    for (const [tool, args, own] of steps) {
      // The code too, not only the sentence: a store that refused with another code would still say the same words.
      log.push(await refusal(() => plugin.invoke(tool, args, own ?? ctx)));
      log.push((await store.getState("t", "a", String(args.key)))?.value ?? null);
    }
    runs.push(JSON.stringify(log));
  }
  if (runs[0] !== runs[1]) throw new Error(`the stores differ:\nsqlite ${runs[0]}\ndurable ${runs[1]}`);
  if (!runs[0]!.includes('"code":"memory_full"') || !runs[0]!.includes('"code":"todo_full"')) throw new Error(`no code was compared: ${runs[0]}`);
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
