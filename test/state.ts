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
    connection: { get: async () => null, set: async () => {} },
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
  if (!text.includes("`remember`") || !text.includes("`forget`")) {
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
  if (/remember|forget/.test(text)) throw new Error("named a tool that is not mounted");
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

console.log(`\n  Agent state\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
