/**
 * Compaction, the way pi does it: summarise the old part, keep the recent part
 * verbatim, and update the summary rather than restarting it.
 *
 * The distinction that matters is between dropping and summarising. Dropping
 * keeps a task alive and throws away what it learned, which is the wrong trade
 * for a long investigation — twenty turns of findings replaced by a note saying
 * some turns were removed. These cases are about what survives.
 */
import { CodegenHarness, DEFAULT_COMPACTION } from "../src/harness/codegen.ts";
import type { RuntimeEvent } from "../src/core/types.ts";

let seq = 0;
const ev = (kind: string, payload: unknown): RuntimeEvent => ({
  eventId: `e${++seq}`, tenantId: "t", agentId: "a", taskId: "k", threadId: null,
  sequence: seq, kind, payload, dedupKey: null, createdAt: 0,
});
const ctx = { tenantId: "t", agentId: "a", taskId: "k", generation: 0 };

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(c: unknown, w: string): asserts c { if (!c) throw new Error(w); }
const eq = (a: unknown, b: unknown, w: string) =>
  assert(Object.is(a, b), `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/** A task that has done real work: a fact worth keeping, then bulk. */
async function loaded(h: CodegenHarness) {
  let st: any = await h.initialize({});
  st = (await h.advance({ state: st, events: [ev("message", { text: "调研 hashcrew" })], context: ctx })).state;
  st = (await h.advance({
    state: st,
    events: [ev("model.response", { text: "```js\noutput(1);\n```", usage: { promptTokens: 100 } })],
    context: ctx,
  })).state;
  st = (await h.advance({
    state: st,
    events: [ev("js.result", { status: "completed", outputs: ["stargazers_count 是 4"] })],
    context: ctx,
  })).state;
  // Bulk, so the retention walk has something to cut.
  for (let i = 0; i < 40; i++) {
    st.messages.push({ role: "user", tag: "execution", content: `page ${i} ` + "x".repeat(4000) });
  }
  return st;
}

await check("超过阈值时先要一份交接，而不是继续问", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION });
  const st = await loaded(h);
  st.promptTokens = 30_000; // past triggerTokens
  const out = await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx });
  assert((out.state as any).compacting, "a summarisation is in flight");
  eq(out.commands.length, 1, "one command");
  const sent = JSON.stringify((out.commands[0] as any).payload.messages);
  assert(sent.includes("Goal"), "the handover template is asked for");
  assert(sent.includes("stargazers_count 是 4"), "the history being summarised is included");
  assert(!sent.includes("Constraints and preferences\\n\\n# The handover so far"), "first pass is the initial prompt");
});

await check("交接回来后历史变短，但发现留下", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION });
  const st = await loaded(h);
  st.promptTokens = 30_000;
  const asked = await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx });
  const before = JSON.stringify(asked.state).length;

  const summary = "## Goal\n调研 hashcrew\n\n## Critical context\nstargazers_count 是 4";
  const done = await h.advance({
    state: asked.state, events: [ev("model.response", { text: summary })], context: ctx,
  });
  const s2 = done.state as any;
  assert(!s2.compacting, "the compaction is finished");
  assert(JSON.stringify(s2).length < before / 2, "the checkpoint actually shrank");
  assert(JSON.stringify(s2.messages).includes("stargazers_count 是 4"), "the finding survived");
  eq(s2.messages[0].tag, "system", "the system message is never summarised");
  // And it carries straight on rather than waiting to be poked.
  eq(done.status, "waiting", "still working");
  eq((done.commands[0] as any).kind, "model.request", "and asks the next question");
});

await check("第二次压缩是更新，不是重写", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION });
  let st: any = await loaded(h);
  st.promptTokens = 30_000;
  st = (await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx })).state;
  st = (await h.advance({
    state: st, events: [ev("model.response", { text: "## Goal\n第一份交接" })], context: ctx,
  })).state;
  eq(st.summary, "## Goal\n第一份交接", "the handover is remembered");

  for (let i = 0; i < 40; i++) {
    st.messages.push({ role: "user", tag: "execution", content: `more ${i} ` + "x".repeat(4000) });
  }
  st.promptTokens = 30_000;
  const again = await h.advance({ state: st, events: [ev("message", { text: "再继续" })], context: ctx });
  const sent = JSON.stringify((again.commands[0] as any).payload.messages);
  assert(sent.includes("Do not simply append"), "the update prompt is used the second time");
  assert(sent.includes("第一份交接"), "and the previous handover is fed back in");
});

await check("工具输出被截断，否则摘要的是网页而不是工作", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION });
  const st: any = await loaded(h);
  st.messages.push({ role: "user", tag: "execution", content: "PAGE" + "y".repeat(50_000) });
  st.promptTokens = 30_000;
  const out = await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx });
  const sent = String((out.commands[0] as any).payload.messages[1].content);
  assert(!sent.includes("y".repeat(3000)), "a huge tool result is not sent whole to the summariser");
});

await check("收尾阶段不压缩", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION });
  const st: any = await loaded(h);
  st.promptTokens = 30_000;
  st.finalizing = true;
  // Not a message: a new request deliberately clears `finalizing` and refills
  // the turn budget, so it would undo the very state being tested.
  const out = await h.advance({
    state: st, events: [ev("js.result", { status: "completed", outputs: [1] })], context: ctx,
  });
  assert(!(out.state as any).compacting, "an answer being written is not interrupted to compact");
});

await check("压缩在库里是可见的记录，历史不丢", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION });
  const st = await loaded(h);
  st.promptTokens = 30_000;
  const asked = await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx });
  const payload = (asked.commands[0] as any).payload;

  // The request says what it is for, so the reply it produces is a record of
  // the compaction rather than an ordinary turn that happens to look odd.
  eq(payload.purpose, "compaction", "the request declares its purpose");
  assert(payload.keptFrom > 1, "and where the kept window begins");
  assert(payload.summarised > 0, "and how much was folded up");

  // What was summarised is gone only from what the model is shown. The events
  // that produced it are the log, and the log is not touched by any of this —
  // the harness never deletes an event, it only rebuilds its own checkpoint.
  const done = await h.advance({
    state: asked.state, events: [ev("model.response", { text: "## Goal\nx" })], context: ctx,
  });
  const shown = JSON.stringify((done.state as any).messages);
  assert(!shown.includes("page 5 xxxx"), "the bulk is out of the model's view");
  assert((done.state as any).summary, "and represented by a handover instead");
});

console.log(`\n  Compaction\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
