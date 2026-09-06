/**
 * Steering through the real loop: kernel + harness + command executor, with a
 * scripted model instead of a network one. §10 claims a message can arrive
 * mid-work and an interrupt has a defined scope — these are those claims.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { Kernel } from "../src/runtime/kernel.ts";
import { CommandExecutor } from "../src/runtime/commands.ts";
import { CodegenHarness } from "../src/harness/codegen.ts";
import type { ModelAdapter, ModelMessage, ModelResponse } from "../src/model/types.ts";
import type { ExecutorHost } from "../src/runtime/executor.ts";
import type { ToolResult } from "../src/core/tools.ts";

const T = "tenant-a", AGENT = "agent-1", TASK = "task-1";

/** Replies from a script, and records what it was actually shown. */
class ScriptedModel implements ModelAdapter {
  readonly id = "scripted";
  seen: ModelMessage[][] = [];
  #script: string[];
  constructor(script: string[]) { this.#script = [...script]; }
  async complete(messages: ModelMessage[]): Promise<ModelResponse> {
    this.seen.push(messages.map((m) => ({ ...m })));
    const text = this.#script.shift() ?? "done, nothing left to do";
    return {
      text, finishReason: "stop", truncated: false,
      usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 },
    };
  }
}

const host: ExecutorHost = {
  async invoke(): Promise<ToolResult> {
    return { status: "succeeded", operationId: `op_${Math.floor(performance.now() * 1000)}`, result: { ok: true } };
  },
};

async function fixture(script: string[]) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(T, AGENT);
  const harness = new CodegenHarness({ maxTurns: 10 });
  await store.createTask(T, AGENT, TASK, await harness.initialize({}));
  const model = new ScriptedModel(script);
  const commands = new CommandExecutor(store, model, host);
  const kernel = new Kernel(store, harness, { holder: "w1", leaseTtlMs: 60_000 });
  const ctx = { tenantId: T, agentId: AGENT, taskId: TASK };
  const step = () => kernel.step(T, TASK, null, (cmd) => commands.dispatch(ctx, cmd));
  return { store, model, commands, kernel, step };
}
const say = (store: SqliteStore, text: string) =>
  store.appendEvent({ tenantId: T, agentId: AGENT, taskId: TASK, kind: "message", payload: { text } });

type Test = { row: string; name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (row: string, name: string, fn: () => Promise<void>) => tests.push({ row, name, fn });
function assert(c: unknown, w: string): asserts c { if (!c) throw new Error(`assertion failed: ${w}`); }
const eq = (a: unknown, b: unknown, w: string) =>
  assert(Object.is(a, b), `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

test("工作中追加消息", "a message arriving mid-work reaches the model on the next turn", async () => {
  const { store, model, step } = await fixture([
    "```js\noutput('step one');\n```",
    "```js\noutput('step two');\n```",
    "all done",
  ]);
  await say(store, "start the job");
  await step(); // message -> model.request
  await step(); // model.response -> js.execute

  // Arrives while the task is parked on its execution result.
  await say(store, "actually, only count the open ones");

  await step(); // js.result + the new message -> model.request
  const lastPrompt = model.seen.at(-1)!;
  assert(
    lastPrompt.some((m) => m.content.includes("only count the open ones")),
    "steering message is in the model's context",
  );
  assert(
    lastPrompt.some((m) => m.content.includes("step one")),
    "prior execution result is still there",
  );
  const task = await store.loadTask(T, TASK);
  eq(task!.status, "waiting", "task keeps working rather than restarting");
  await store.close();
});

test("消息不依赖执行边界", "messages land while no worker holds the task", async () => {
  const { store, step } = await fixture(["```js\noutput(1);\n```", "done"]);
  await say(store, "first");
  await step();
  await step();
  await step();
  // No lease, no worker: delivery must still be durable.
  const before = (await store.pendingEvents(T, TASK, "harness")).length;
  await say(store, "second, sent while idle");
  const after = await store.pendingEvents(T, TASK, "harness");
  eq(after.length, before + 1, "queued regardless of execution state");
  eq((after.at(-1)!.payload as any).text, "second, sent while idle", "content preserved");
  await store.close();
});

test("中断范围", "an interrupt bumps generation and stale work cannot advance", async () => {
  const { store, kernel, step } = await fixture(["```js\noutput('long job');\n```", "done"]);
  await say(store, "start");
  await step();

  const before = await store.loadTask(T, TASK);
  const gen = await store.interrupt(T, TASK);
  eq(gen, before!.generation + 1, "generation bumped");
  eq((await store.loadTask(T, TASK))!.status, "interrupted", "task marked interrupted");

  // Generation and fencing are independent gates: even a worker holding a
  // perfectly valid lease is refused if it carries the pre-interrupt generation.
  const lease = await store.acquireLease(T, TASK, "w1", 30_000);
  assert(lease, "the live lease holder can still renew");
  const late = await store.commitAdvance({
    tenantId: T, taskId: TASK, generation: before!.generation,
    fencingToken: lease!.fencingToken, expectedCheckpointVersion: before!.checkpointVersion,
    checkpoint: { clobbered: true }, status: "runnable", consumedThrough: null, waits: [], commands: [],
  });
  assert(!late.ok && late.reason === "stale_generation", "old generation refused");
  await store.close();
});

test("中断后继续", "work resumes on the new generation with history intact", async () => {
  const { store, model, step } = await fixture([
    "```js\noutput('first attempt');\n```",
    "```js\noutput('revised attempt');\n```",
    "finished the revised job",
  ]);
  await say(store, "do the thing");
  await step();
  await step();
  await step();
  await store.interrupt(T, TASK);
  await say(store, "stop that, do it differently");

  let guard = 0;
  while (guard++ < 6) {
    const r = await step();
    if (r.outcome === "no_work") break;
    const t = await store.loadTask(T, TASK);
    if (t && ["completed", "failed", "blocked"].includes(t.status)) break;
  }
  const task = await store.loadTask(T, TASK);
  eq(task!.status, "completed", "resumed and finished after the interrupt");
  eq(task!.generation, 1, "still on the post-interrupt generation");
  const prompt = model.seen.at(-1)!;
  assert(prompt.some((m) => m.content.includes("stop that, do it differently")), "new instruction seen");
  assert(prompt.some((m) => m.content.includes("first attempt")), "pre-interrupt history retained as fact");
  await store.close();
});

test("多条 steering 合并", "several messages queued between turns arrive together, in order", async () => {
  const { store, model, step } = await fixture(["```js\noutput(1);\n```", "done"]);
  await say(store, "start");
  await step();
  await step();
  await say(store, "note one");
  await say(store, "note two");
  await step();
  const contents = model.seen.at(-1)!.map((m) => m.content);
  const i1 = contents.findIndex((c) => c.includes("note one"));
  const i2 = contents.findIndex((c) => c.includes("note two"));
  assert(i1 >= 0 && i2 >= 0, "both delivered");
  assert(i1 < i2, "order preserved");
  await store.close();
});

let pass = 0, fail = 0;
console.log(`\n  Steering & interrupt (full loop, scripted model)\n  ${"─".repeat(62)}`);
for (const t of tests) {
  try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.row.padEnd(18)} ${t.name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.row.padEnd(18)} ${t.name}\n      \x1b[31m${(e as Error).message}\x1b[0m`); }
}
console.log(`  ${"─".repeat(62)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
