/**
 * A waiting task must never be unreachable.
 *
 * `waiting` is a promise that something outstanding will wake the task. Two
 * bugs broke that promise at once and stranded a real task for two hours while
 * the page still read "working":
 *
 *   - the sweeper gave up on a model request that never came back, setting the
 *     outbox row to `abandoned` and appending nothing, so the alarm stopped and
 *     no event was left for the harness to react to;
 *   - `reopenTask` refused any status but `completed`/`blocked`, so the user
 *     typing again could not rescue it either.
 *
 * Runs the Durable Object store over node:sqlite, because both methods live on
 * that backend alone and the contract suite only covers StorageAdapter.
 */
import { DatabaseSync } from "node:sqlite";
import { DurableObjectStore } from "../src/store/durable-object.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

function newStore() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    // Eagerly, not on toArray(): the store runs its schema through exec() and
    // never reads the result, so a lazy shim silently creates no tables.
    exec(q: string, ...b: unknown[]) {
      // node:sqlite refuses booleans and undefined; the real binding takes both.
      const args = b.map((v) =>
        typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v) as any[];
      const st = db.prepare(q);
      const rows = /^\s*(select|with)/i.test(q) ? st.all(...args) : (st.run(...args), []);
      return { toArray: () => rows as any[] };
    },
  };
  // A movable clock, so "old enough to give up on" is a fact the test states
  // rather than a race against the millisecond the row was written in.
  const clock = { t: 1_000_000 };
  const store = new DurableObjectStore(
    { storage: { sql, transactionSync: <T>(cb: () => T) => cb() } },
    { now: () => clock.t },
  );
  return { store, clock };
}

/** A task parked on a dispatched command, exactly as the harness leaves it. */
async function stranded(store: DurableObjectStore, taskId: string) {
  await store.createAgent("t", "a");
  await store.createTask("t", "a", taskId, {});
  const lease = (await store.acquireLease("t", taskId, "w1", 60_000))!;
  await store.commitAdvance({
    tenantId: "t", taskId, generation: 0, fencingToken: lease.fencingToken,
    expectedCheckpointVersion: 0, checkpoint: {}, stateVersion: 1,
    status: "waiting", consumedThrough: null, waits: [],
    // The kernel derives this; here the test states it, because the point of
    // the case is what happens to the row afterwards.
    commands: [{ commandId: `cmd-${taskId}`, kind: "model.request", payload: { messages: [] } }],
  } as any);
  const claimed = await store.claimOutbox(5);
  for (const c of claimed) await store.markDispatched(c.commandId);
  return claimed;
}

/** End a command the way a reply from the queue's consumer does. */
async function answer(store: DurableObjectStore, taskId: string, commandId: string) {
  await store.appendEvent({
    tenantId: "t", agentId: "a", taskId, kind: "model.failed",
    payload: { error: "gave up" }, dedupKey: `cmd:${commandId}:response`,
  });
  await (store as any).settleAnswered();
}

await check("已答复的命令不再算在途", async () => {
  const { store } = newStore();
  await store.init();
  const claimed = await stranded(store, "k1");
  if ((await (store as any).outstandingCommands()) !== 1) throw new Error("a dispatched command was not counted");
  await answer(store, "k1", claimed[0]!.commandId);
  if ((await (store as any).outstandingCommands()) !== 0) {
    throw new Error("an answered command still counts as in flight");
  }
});

await check("搁浅的任务可被消息救活", async () => {
  const { store } = newStore();
  await store.init();
  const c2 = await stranded(store, "k2");
  // While the command is still out, a message must NOT restart the task: the
  // reply is coming and restarting would double the work.
  if (await store.reopenTask("t", "k2")) throw new Error("reopened while a command was in flight");
  await answer(store, "k2", c2[0]!.commandId);
  if (!(await store.reopenTask("t", "k2"))) throw new Error("a stranded task stayed unreachable");
  const t = await store.loadTask("t", "k2");
  if (t?.status !== "runnable") throw new Error(`expected runnable, got ${t?.status}`);
});

await check("等待审批的任务不会被消息绕过", async () => {
  const { store } = newStore();
  await store.init();
  const c3 = await stranded(store, "k3");
  await answer(store, "k3", c3[0]!.commandId);
  await store.requireApproval({
    tenantId: "t", agentId: "a", taskId: "k3", operationId: "op1",
    mountAlias: "ops", tool: "restart", request: {},
  });
  if (await store.reopenTask("t", "k3")) throw new Error("a pending approval was bypassed by a message");
  await store.decideApproval("t", "op1", "approved", "someone");
  if (!(await store.reopenTask("t", "k3"))) throw new Error("decided approval still blocked the reopen");
});

// ── The other way a task stops answering: it runs out of turns and never gets
// them back, so every later message is met with "answer now, no code".
const { CodegenHarness, finalText } = await import("../src/harness/codegen.ts");

await check("新的用户消息会补满执行预算", async () => {
  const h = new CodegenHarness({ maxTurns: 2 });
  let state: any = await h.initialize({ tenantId: "t", agentId: "a", taskId: "k", prompt: "go" } as any);
  const step = (events: any[]) => h.advance({ state, events } as any);
  // Spend the budget.
  for (let i = 0; i < 2; i++) {
    const r = await step([{ kind: "model.response", payload: { text: "```js\noutput(1);\n```" } }]);
    state = r.state;
  }
  const spent = await step([{ kind: "model.response", payload: { text: "```js\noutput(1);\n```" } }]);
  if (!spent.state.finalizing) throw new Error("the cap should have engaged");
  // A new request must restore it.
  state = spent.state;
  const after = await step([{ kind: "message", payload: { text: "再试试" } }]);
  if (after.state.finalizing) throw new Error("a new request did not clear finalizing");
  if (after.state.turns !== 0) throw new Error(`turns not refilled: ${after.state.turns}`);
});

await check("预算耗尽时不会把代码当答案抛出", async () => {
  const two = "<pre><code>\n```js\na();\n```\n</code></pre>\n<pre><code>\n```js\nb();\n```\n</code></pre>";
  const out = finalText(two);
  if (/```/.test(out) || /a\(\)|b\(\)/.test(out)) throw new Error(`code survived: ${out}`);
  if (!finalText("```js\na();\n```").trim()) throw new Error("an all-code reply produced an empty answer");
});

await check("XML 工具调用被翻译成真正的调用", async () => {
  const { codeFromToolAttempt, looksLikeToolAttempt } = await import("../src/harness/codegen.ts");
  const xml = '<tool_calls>\n<invoke name="web.get">\n<parameter name="url">https://example.com</parameter>\n</invoke>\n</tool_calls>';
  const code = codeFromToolAttempt(xml);
  if (!code || !code.includes("web.get") || !code.includes("https://example.com")) {
    throw new Error(`not translated: ${code}`);
  }
  if (codeFromToolAttempt("这个项目是一个 Rust 哈希库。")) throw new Error("prose translated as a call");
  if (!looksLikeToolAttempt(xml)) throw new Error("XML not recognised as an attempt");

  const h = new CodegenHarness({ maxTurns: 10 });
  const state: any = await h.initialize({ tenantId: "t", agentId: "a", taskId: "k", prompt: "go" } as any);
  const r = await h.advance({ state, events: [{ kind: "model.response", payload: { text: xml } }] } as any);
  if (r.status === "completed") throw new Error("markup was accepted as the final answer");
  if (r.commands[0]?.kind !== "js.execute") {
    throw new Error(`expected the call to run, got ${r.commands[0]?.kind}`);
  }
});

await check("模型自创的调用通道也算尝试，不会被当成答案", async () => {
  const { looksLikeToolAttempt } = await import("../src/harness/codegen.ts");
  // Seen live: the model invented a channel, nothing recognised it as a call,
  // and the harness ended the task in the middle of the job.
  const invented = '<system name="tools.search">query: "http get fetch url"</system>';
  if (!looksLikeToolAttempt(invented)) throw new Error("an invented channel was not recognised");
  // Narration and ordinary prose must not be mistaken for one.
  for (const prose of [
    "<system_warning>No more tool calls are possible</system_warning>",
    "这个项目由 IANA 维护，见表格里的 name 字段。",
    "用 config.yaml 里的 name 配置即可。",
  ]) {
    if (looksLikeToolAttempt(prose)) throw new Error(`prose misread as a call: ${prose.slice(0, 40)}`);
  }

  const h = new CodegenHarness({ maxTurns: 10 });
  const state: any = await h.initialize({ tenantId: "t", agentId: "a", taskId: "k", prompt: "go" } as any);
  const r = await h.advance({ state, events: [{ kind: "model.response", payload: { text: invented } }] } as any);
  if (r.status === "completed") throw new Error("the task ended on an invented tool call");
});

await check("空回复永远不算完成", async () => {
  const { isEmptyReply } = await import("../src/harness/codegen.ts");
  // Chasing calling syntaxes one at a time lost: five turned up. These share a
  // shape that needs no recognising — strip the markup and nothing is left.
  for (const t of ['<semdoc style="display:none"></semdoc>', "<USER>\n</USER>", "", "   ", "..."]) {
    if (!isEmptyReply(t)) throw new Error(`should read as empty: ${JSON.stringify(t)}`);
  }
  // And a short real answer is still an answer.
  for (const t of ["Done.", "4", "鸡23只，兔12只。"]) {
    if (isEmptyReply(t)) throw new Error(`should not: ${JSON.stringify(t)}`);
  }

  const h = new CodegenHarness({ maxTurns: 10 });
  const state: any = await h.initialize({ tenantId: "t", agentId: "a", taskId: "k", prompt: "go" } as any);
  const r = await h.advance({
    state,
    events: [{ kind: "model.response", payload: { text: '<semdoc style="display:none"></semdoc>' } }],
  } as any);
  // This exact reply ended a SWE-bench instance after one turn, while the
  // reasoning trace showed the model had planned the fix correctly.
  if (r.status === "completed") throw new Error("an empty reply was taken as the final answer");
  if (r.commands[0]?.kind !== "model.request") throw new Error("the model was not asked again");
});

await check("无法翻译的调用会被要求重写，且有次数上限", async () => {
  // Recognisably an attempt, but nothing a call can be built from.
  const bad = '<function_calls>\n  something the parser cannot read\n</function_calls>';
  const h = new CodegenHarness({ maxTurns: 10 });
  let st: any = await h.initialize({ tenantId: "t", agentId: "a", taskId: "k", prompt: "go" } as any);
  const first = await h.advance({ state: st, events: [{ kind: "model.response", payload: { text: bad } }] } as any);
  if (first.commands[0]?.kind !== "model.request") throw new Error("the model was not asked again");
  st = first.state;
  let last = first;
  for (let i = 0; i < 4; i++) {
    last = await h.advance({ state: st, events: [{ kind: "model.response", payload: { text: bad } }] } as any);
    st = last.state;
  }
  if (last.status !== "completed") throw new Error("the nudge never gives up");
});

await check("刚派发的命令不会被当成空闲", async () => {
  const { store } = newStore();
  await store.init();
  await stranded(store, "k4");           // dispatched in this very millisecond
  const n = await (store as any).outstandingCommands();
  if (n !== 1) throw new Error(`a command dispatched now looked idle: ${n}`);
});

await check("本地执行掉了也会被重新排队", async () => {
  const { store, clock } = newStore();
  await store.init();
  await store.createAgent("t", "a");
  await store.createTask("t", "a", "k5", {});
  const lease = (await store.acquireLease("t", "k5", "w1", 60_000))!;
  await store.commitAdvance({
    tenantId: "t", taskId: "k5", generation: 0, fencingToken: lease.fencingToken,
    expectedCheckpointVersion: 0, checkpoint: {}, stateVersion: 1, status: "waiting",
    consumedThrough: null, waits: [],
    commands: [{ commandId: "cmd-js", kind: "js.execute", payload: { source: "output(1)" } }],
  } as any);
  for (const c of await store.claimOutbox(5)) await store.markDispatched(c.commandId);
  clock.t += 60_000;
  // model.request-only recovery leaves it stranded; js.execute must be covered.
  const n = await (store as any).requeueStale(30_000, ["js.execute", "tool.call"]);
  if (n !== 1) throw new Error(`a dead local command was not requeued: ${n}`);
  const again = await store.claimOutbox(5);
  if (!again.some((c) => c.commandId === "cmd-js")) throw new Error("requeued but not claimable");
});

await check("没有回复的命令也会销账", async () => {
  const { store } = newStore();
  await store.init();
  await store.createAgent("t", "a");
  await store.createTask("t", "a", "k6", {});
  const lease = (await store.acquireLease("t", "k6", "w1", 60_000))!;
  await store.commitAdvance({
    tenantId: "t", taskId: "k6", generation: 0, fencingToken: lease.fencingToken,
    expectedCheckpointVersion: 0, checkpoint: {}, stateVersion: 1, status: "waiting",
    consumedThrough: null, waits: [],
    commands: [{ commandId: "cmd-out", kind: "message.out", payload: { text: "done" } }],
  } as any);
  for (const c of await store.claimOutbox(5)) await store.markDispatched(c.commandId);
  await (store as any).settleAnswered();
  if ((await (store as any).outstandingCommands()) !== 0) {
    throw new Error("a command that answers nothing counted as in flight for ever");
  }
  // And so it cannot block a message from rescuing the task.
  if (!(await store.reopenTask("t", "k6"))) throw new Error("it still blocked the reopen");
});

console.log(`\n  Strand contract\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
