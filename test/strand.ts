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

await check("给up 的命令会变成可见的失败", async () => {
  const { store, clock } = newStore();
  await store.init();
  const claimed = await stranded(store, "k1");
  const gone = await (clock.t += 60_000, (store as any).abandonStale(30_000, ["model.request"]));
  if (gone.length !== 1) throw new Error(`expected 1 abandoned, got ${gone.length}`);
  const c = gone[0];
  if (c.tenantId !== "t" || c.agentId !== "a" || c.taskId !== "k1") {
    throw new Error(`abandonment lost its context: ${JSON.stringify(c)}`);
  }
  if (c.commandId !== claimed[0]!.commandId) throw new Error("wrong command reported");
});

await check("搁浅的任务可被消息救活", async () => {
  const { store, clock } = newStore();
  await store.init();
  await stranded(store, "k2");
  // While the command is still out, a message must NOT restart the task: the
  // reply is coming and restarting would double the work.
  if (await store.reopenTask("t", "k2")) throw new Error("reopened while a command was in flight");
  await (clock.t += 60_000, (store as any).abandonStale(30_000, ["model.request"]));
  if (!(await store.reopenTask("t", "k2"))) throw new Error("a stranded task stayed unreachable");
  const t = await store.loadTask("t", "k2");
  if (t?.status !== "runnable") throw new Error(`expected runnable, got ${t?.status}`);
});

await check("等待审批的任务不会被消息绕过", async () => {
  const { store, clock } = newStore();
  await store.init();
  await stranded(store, "k3");
  await (clock.t += 60_000, (store as any).abandonStale(30_000, ["model.request"]));
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

console.log(`\n  Strand contract\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
