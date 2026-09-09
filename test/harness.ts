/** Harness decision logic, offline. The live run proved the loop works; these
 *  pin the behaviours that the live run showed were wrong. */
import { CodegenHarness, extractCode, DEFAULT_COMPACTION } from "../src/harness/codegen.ts";
import type { RuntimeEvent } from "../src/core/types.ts";

let seq = 0;
const ev = (kind: string, payload: unknown): RuntimeEvent => ({
  eventId: `e${++seq}`, tenantId: "t", agentId: "a", taskId: "task", threadId: null,
  sequence: seq, kind, payload, dedupKey: null, createdAt: 0,
});
const ctx = { tenantId: "t", agentId: "a", taskId: "task", generation: 0 };

type Test = { row: string; name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (row: string, name: string, fn: () => Promise<void>) => tests.push({ row, name, fn });
function assert(c: unknown, w: string): asserts c { if (!c) throw new Error(`assertion failed: ${w}`); }
const eq = (a: unknown, b: unknown, w: string) =>
  assert(Object.is(a, b), `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

test("代码提取", "a fenced js block is extracted, prose is not", async () => {
  eq(extractCode("here you go\n```js\nconst x = 1;\n```\ndone"), "const x = 1;", "js fence");
  eq(extractCode("```javascript\nlet y;\n```"), "let y;", "javascript fence");
  eq(extractCode("no code at all"), null, "prose returns null");
});

test("思考不回灌", "a reasoning trace is recorded but never sent back to the model", async () => {
  const h = new CodegenHarness();
  const state = await h.initialize({});
  const secret = "PRIVATE-CHAIN-OF-THOUGHT";
  const out = await h.advance({
    state,
    events: [ev("model.response", {
      text: "```js\noutput(1);\n```",
      reasoning: `the user probably wants X. ${secret}`,
      usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 40 },
    })],
    context: ctx,
  });
  // Next it will execute; the request after that carries the messages.
  const after = await h.advance({
    state: out.state,
    events: [ev("js.result", { status: "completed", outputs: [1] })],
    context: ctx,
  });
  const sent = JSON.stringify((after.commands[0] as any)?.payload?.messages ?? []);
  assert(!sent.includes(secret), "reasoning must not reach the provider");
  assert(sent.includes("output(1)"), "the reply itself is still carried");
});

test("消息转命令", "an inbound message produces exactly one model request", async () => {
  const h = new CodegenHarness();
  const state = await h.initialize({ mounts: [{ alias: "gh", plugin: "github", version: "1.0.0", config: {} }] });
  const out = await h.advance({ state, events: [ev("message", { text: "do it" })], context: ctx });
  eq(out.commands.length, 1, "one command");
  eq(out.commands[0]!.kind, "model.request", "model request");
  eq(out.status, "waiting", "parked");
  const msgs = (out.state as any).messages;
  eq(msgs[msgs.length - 1].content, "do it", "user message folded in");
  assert(String(msgs[0].content).includes("gh  (github v1.0.0"), "mounts advertised in the system prompt");
});

test("代码转执行", "a reply containing code becomes a js.execute command", async () => {
  const h = new CodegenHarness();
  let state = await h.initialize({});
  state = (await h.advance({ state, events: [ev("message", { text: "go" })], context: ctx })).state;
  const out = await h.advance({
    state, events: [ev("model.response", { text: "sure\n```js\noutput(1);\n```" })], context: ctx,
  });
  eq(out.commands[0]!.kind, "js.execute", "js command");
  eq((out.commands[0]!.payload as any).source, "output(1);", "source extracted");
});

test("无代码即终态", "a reply with no code ends the task", async () => {
  const h = new CodegenHarness();
  let state = await h.initialize({});
  state = (await h.advance({ state, events: [ev("message", { text: "go" })], context: ctx })).state;
  const out = await h.advance({ state, events: [ev("model.response", { text: "The answer is 42." })], context: ctx });
  eq(out.status, "completed", "completed");
  eq((out.commands[0]!.payload as any).text, "The answer is 42.", "answer emitted");
});

test("剩余轮次可见", "execution feedback tells the model how many turns remain", async () => {
  const h = new CodegenHarness({ maxTurns: 4 });
  let state = await h.initialize({});
  state = (await h.advance({ state, events: [ev("message", { text: "go" })], context: ctx })).state;
  state = (await h.advance({ state, events: [ev("model.response", { text: "```js\noutput(1);\n```" })], context: ctx })).state;
  const out = await h.advance({
    state, events: [ev("js.result", { status: "completed", outputs: [1] })], context: ctx,
  });
  const msgs = (out.state as any).messages;
  assert(String(msgs[msgs.length - 1].content).includes("3 execution turn(s) left"), "budget surfaced to the model");
});

test("预算耗尽不丢工作", "a spent budget asks for a final answer instead of blocking", async () => {
  const h = new CodegenHarness({ maxTurns: 2 });
  let state = await h.initialize({});
  state = (await h.advance({ state, events: [ev("message", { text: "go" })], context: ctx })).state;
  // Turn 1: still inside budget, so this one runs.
  const first = await h.advance({ state, events: [ev("model.response", { text: "```js\noutput(1);\n```" })], context: ctx });
  eq(first.commands[0]!.kind, "js.execute", "turn 1 still executes");
  state = (await h.advance({ state: first.state, events: [ev("js.result", { status: "completed", outputs: [1] })], context: ctx })).state;
  // Turn 2 spends the last of the budget.
  const over = await h.advance({
    state, events: [ev("model.response", { text: "```js\noutput(2);\n```" })], context: ctx,
  });
  eq(over.status, "waiting", "not blocked");
  eq(over.commands[0]!.kind, "model.request", "asks the model to wrap up");
  eq((over.state as any).finalizing, true, "finalizing flagged");
  const last = (over.state as any).messages.at(-1).content;
  assert(String(last).includes("out of execution turns"), "instruction is explicit");

  const done = await h.advance({
    state: over.state,
    events: [ev("model.response", { text: "Found 21 matches.\n```js\nignored();\n```" })],
    context: ctx,
  });
  eq(done.status, "completed", "final reply completes the task");
  eq((done.commands[0]!.payload as any).text, "Found 21 matches.", "trailing code stripped from the answer");
});

test("上下文压缩", "compaction drops scratch work, keeps every customer turn", async () => {
  const h = new CodegenHarness({ maxTurns: 40, compaction: { ...DEFAULT_COMPACTION, triggerTokens: 100, keepCycles: 2 } });
  let state = await h.initialize({});
  // Five cycles: customer asks, agent writes code, execution reports back.
  for (let i = 0; i < 5; i++) {
    state = (await h.advance({ state, events: [ev("message", { text: `requirement ${i}` })], context: ctx })).state;
    state = (await h.advance({
      state,
      events: [ev("model.response", { text: `\`\`\`js\nawait tool\`retail.get_order_details \${{}}\`;\n\`\`\``, usage: { promptTokens: 50_000 } })],
      context: ctx,
    })).state;
    state = (await h.advance({
      state,
      events: [ev("js.result", { status: "completed", outputs: [{ ref: `r2://bucket/blob-${i}.json` }] })],
      context: ctx,
    })).state;
  }
  const msgs = (state as any).messages as Array<{ role: string; tag: string; content: string }>;
  eq((state as any).compactions > 0, true, "compaction ran");
  eq(msgs[0]!.tag, "system", "head untouched — the cached prefix must not move");
  for (let i = 0; i < 5; i++) {
    assert(msgs.some((m) => m.tag === "customer" && m.content === `requirement ${i}`), `requirement ${i} kept`);
  }
  const note = msgs.find((m) => m.tag === "note" && m.content.includes("Context compacted"));
  assert(note, "a note records what was removed");
  assert(note!.content.includes("retail.get_order_details"), "note names the tools already used");
  assert(note!.content.includes("r2://bucket/blob-0.json"), "note names the parked artifacts");
  assert(msgs.filter((m) => m.tag === "execution").length <= 3, "old execution cycles dropped");
});

let pass = 0, fail = 0;
test("被扣下即挂起", "a held call parks the task instead of asking the model to route around it", async () => {
  const h = new CodegenHarness({ maxTurns: 20 });
  const state: any = await h.initialize({ mounts: [] });
  const ev = (kind: string, payload: unknown) => ({
    eventId: "e", tenantId: "t", agentId: "a", taskId: "k", threadId: null,
    sequence: 1, kind, payload, dedupKey: null, createdAt: 0,
  }) as any;

  const out = await h.advance({
    state,
    events: [ev("js.result", {
      callId: "c1", status: "completed", outputs: [], heldOperationIds: ["op_held_1"],
    })],
  } as any);

  // Not a model.request: the loop stops here and the decision restarts it.
  eq(out.commands.length, 0, "no further work is dispatched");
  eq(out.status, "waiting", "the task parks");
  eq(out.waits.length, 1, "on the held operation");
  eq((out.waits[0] as any).operationId, "op_held_1", "the right one");
  const last = (out.state as any).messages.at(-1);
  assert(String(last.content).includes("Held for approval"), "and the model is told why in words");
  assert(String(last.content).includes("resume"), "including that it resumes by itself");
});

test("未被扣下则照常继续", "an ordinary result still drives the next turn", async () => {
  const h = new CodegenHarness({ maxTurns: 20 });
  const state: any = await h.initialize({ mounts: [] });
  const out = await h.advance({
    state,
    events: [{
      eventId: "e", tenantId: "t", agentId: "a", taskId: "k", threadId: null,
      sequence: 1, kind: "js.result", payload: { callId: "c1", status: "completed", outputs: [1] },
      dedupKey: null, createdAt: 0,
    }],
  } as any);
  eq(out.commands[0]!.kind, "model.request", "asks the model again");
  eq(out.waits.length, 0, "and parks on nothing");
});

console.log(`\n  Harness (codegen loop)\n  ${"─".repeat(62)}`);
for (const t of tests) {
  try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.row.padEnd(14)} ${t.name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.row.padEnd(14)} ${t.name}\n      \x1b[31m${(e as Error).message}\x1b[0m`); }
}
console.log(`  ${"─".repeat(62)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
