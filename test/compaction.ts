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

/** A small window, so the fixtures stay small. The point of the config is
 *  that this number is the only thing that has to change per model. */
const WINDOW = 32_000;
const over = Math.ceil(WINDOW * DEFAULT_COMPACTION.triggerFraction) + 1;


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
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: WINDOW });
  const st = await loaded(h);
  st.promptTokens = over; // past the trigger for this window
  const out = await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx });
  assert((out.state as any).compacting, "a summarisation is in flight");
  eq(out.commands.length, 1, "one command");
  const sent = JSON.stringify((out.commands[0] as any).payload.messages);
  assert(sent.includes("Goal"), "the handover template is asked for");
  assert(sent.includes("stargazers_count 是 4"), "the history being summarised is included");
  assert(!sent.includes("Constraints and preferences\\n\\n# The handover so far"), "first pass is the initial prompt");
});

await check("交接回来后历史变短，但发现留下", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: WINDOW });
  const st = await loaded(h);
  st.promptTokens = over;
  // Measured before the request, because the trim happens when the handover is
  // asked for rather than when it comes back: the middle is already in the
  // outgoing request, and a compaction that only shrinks afterwards cannot be
  // committed when the checkpoint is what is over budget.
  const before = JSON.stringify(st).length;
  const asked = await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx });
  assert(JSON.stringify(asked.state).length < before / 2, "the request itself trims");

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
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: WINDOW });
  let st: any = await loaded(h);
  st.promptTokens = over;
  st = (await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx })).state;
  st = (await h.advance({
    state: st, events: [ev("model.response", { text: "## Goal\n第一份交接" })], context: ctx,
  })).state;
  eq(st.summary, "## Goal\n第一份交接", "the handover is remembered");

  for (let i = 0; i < 40; i++) {
    st.messages.push({ role: "user", tag: "execution", content: `more ${i} ` + "x".repeat(4000) });
  }
  st.promptTokens = over;
  const again = await h.advance({ state: st, events: [ev("message", { text: "再继续" })], context: ctx });
  const sent = JSON.stringify((again.commands[0] as any).payload.messages);
  assert(sent.includes("Do not simply append"), "the update prompt is used the second time");
  assert(sent.includes("第一份交接"), "and the previous handover is fed back in");
});

await check("工具输出被截断，否则摘要的是网页而不是工作", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: WINDOW });
  const st: any = await loaded(h);
  st.messages.push({ role: "user", tag: "execution", content: "PAGE" + "y".repeat(50_000) });
  st.promptTokens = over;
  const out = await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx });
  const sent = String((out.commands[0] as any).payload.messages[1].content);
  assert(!sent.includes("y".repeat(3000)), "a huge tool result is not sent whole to the summariser");
});

await check("收尾阶段不压缩", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: WINDOW });
  const st: any = await loaded(h);
  st.promptTokens = over;
  st.finalizing = true;
  // Not a message: a new request deliberately clears `finalizing` and refills
  // the turn budget, so it would undo the very state being tested.
  const out = await h.advance({
    state: st, events: [ev("js.result", { status: "completed", outputs: [1] })], context: ctx,
  });
  assert(!(out.state as any).compacting, "an answer being written is not interrupted to compact");
});

await check("压缩在库里是可见的记录，历史不丢", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: WINDOW });
  const st = await loaded(h);
  st.promptTokens = over;
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

await check("hybrid 也会压缩，且默认是开着的", async () => {
  const { HybridHarness } = await import("../src/harness/hybrid.ts");
  const h = new HybridHarness({ maxTurns: 40, compaction: DEFAULT_COMPACTION, contextWindow: WINDOW });
  const st: any = await h.initialize({ tools: [] });
  for (let i = 0; i < 40; i++) {
    st.messages.push({ role: "user", content: `page ${i} ` + "x".repeat(4000) });
  }
  st.promptTokens = over;
  const out = await h.advance({ state: st, events: [ev("message", { text: "继续" })] } as any);
  eq((out.commands[0] as any).payload.purpose, "compaction", "hybrid asks for a handover too");

  // A handover has no tool calls, and a reply with no tool calls is how this
  // harness recognises a finished answer — so without its own branch, compacting
  // would end the task.
  const done = await h.advance({
    state: out.state, events: [ev("model.response", { text: "## Goal\nx", toolCalls: [] })],
  } as any);
  assert(done.status !== "completed", "the handover did not end the task");
  assert((done.state as any).summary, "and became the summary");

  // Built and left unconfigured is the same as not built. The default the
  // deployment uses must be the one that actually compacts.
  eq(DEFAULT_COMPACTION.mode, "summarise", "the shipped default summarises");
});

await check("上下文溢出会触发压缩，而不是重试同一个 prompt", async () => {
  const { isContextOverflow } = await import("../src/harness/codegen.ts");
  for (const err of [
    "This model's maximum context length is 65536 tokens",
    "context_length_exceeded",
    "prompt is too long: 210000 tokens",
  ]) assert(isContextOverflow(err), `should be recognised: ${err}`);
  for (const err of ["429 rate limit", "connection reset", "invalid api key"]) {
    assert(!isContextOverflow(err), `should not be: ${err}`);
  }

  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: WINDOW });
  const st: any = await loaded(h);
  st.promptTokens = 100; // nowhere near the threshold
  const out = await h.advance({
    state: st,
    events: [ev("model.failed", { error: "This model's maximum context length is 65536 tokens" })],
    context: ctx,
  });
  eq((out.commands[0] as any).payload.purpose, "compaction", "it compacts instead");
  // Retrying a prompt that does not fit cannot help, so it must not count
  // against the retry budget either.
  eq((out.state as any).modelFailures ?? 0, 0, "and it is not counted as a failure");
});

await check("可以手动要求压缩", async () => {
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: WINDOW });
  const st: any = await loaded(h);
  st.promptTokens = 100;
  const out = await h.advance({
    state: st, events: [ev("compact.requested", {})], context: ctx,
  });
  eq((out.commands[0] as any).payload.purpose, "compaction", "asked for, so it happens");

  // Even while finalizing, because a person asking outranks the guard that
  // exists only to avoid interrupting an answer.
  const st2: any = await loaded(h);
  st2.promptTokens = 100;
  st2.finalizing = true;
  const out2 = await h.advance({
    state: st2, events: [ev("compact.requested", {})], context: ctx,
  });
  eq((out2.commands[0] as any).payload.purpose, "compaction", "a request wins over finalizing");
});

await check("阈值随模型窗口走，不是写死的 token 数", async () => {
  const st = await loaded(new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: WINDOW }));
  // Trimmed so the byte rule cannot fire: this case is about the token rule,
  // and the fixture is otherwise large enough to trip the other one, which
  // would make both harnesses compact for the same uninteresting reason.
  st.messages = st.messages.slice(0, 12);
  const prompt = 25_000;

  // The same prompt is most of a small window and a fraction of a large one, so
  // it must compact in one and not the other. A fixed token threshold cannot
  // express that, and would be wrong for every model but the one it was picked
  // against.
  const small = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: 32_000 });
  const large = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: 1_000_000 });

  const inSmall = await small.advance({
    state: { ...structuredClone(st), promptTokens: prompt },
    events: [ev("message", { text: "继续" })], context: ctx,
  });
  const inLarge = await large.advance({
    state: { ...structuredClone(st), promptTokens: prompt },
    events: [ev("message", { text: "继续" })], context: ctx,
  });
  eq((inSmall.commands[0] as any).payload.purpose, "compaction", "a small window compacts");
  assert(!(inLarge.commands[0] as any).payload.purpose, "a large one has no reason to");

  // The tail kept verbatim scales with the window too.
  assert(
    JSON.stringify(inLarge.state).length >= JSON.stringify(inSmall.state).length,
    "a larger window keeps at least as much",
  );
});

await check("压缩必须收敛，不能压完又立刻满足条件", async () => {
  const { keepRecentChars } = await import("../src/harness/codegen.ts");

  // The tail is bounded by two things and has to satisfy both: the model's
  // window, and the checkpoint size that triggers a compaction. Derived from
  // the window alone, a 131,072-token model gave a 128 KB tail against a 128 KB
  // trigger — so compaction summarised, kept a tail that was itself over the
  // line, and qualified again on the very next advance. One agent did that
  // twenty-nine times, paying for a model call each round.
  for (const w of [24_000, 32_000, 131_072, 1_000_000]) {
    const kept = keepRecentChars(w, DEFAULT_COMPACTION);
    assert(
      kept < DEFAULT_COMPACTION.maxCheckpointBytes / 2,
      `a ${w}-token window keeps ${Math.round(kept)} chars against a ` +
      `${DEFAULT_COMPACTION.maxCheckpointBytes / 2} byte trigger — it would compact for ever`,
    );
  }

  // And end to end: after a compaction the state must no longer ask for one.
  const h = new CodegenHarness({ compaction: DEFAULT_COMPACTION, contextWindow: 131_072 });
  const st: any = await loaded(h);
  for (let i = 0; i < 60; i++) {
    st.messages.push({ role: "user", tag: "execution", content: `bulk ${i} ` + "x".repeat(4000) });
  }
  st.promptTokens = 100_000;
  const asked = await h.advance({ state: st, events: [ev("message", { text: "继续" })], context: ctx });
  eq((asked.commands[0] as any).payload.purpose, "compaction", "it compacts once");
  const done = await h.advance({
    state: asked.state, events: [ev("model.response", { text: "## Goal\nx", usage: { promptTokens: 3000 } })],
    context: ctx,
  });
  const again = await h.advance({
    state: done.state, events: [ev("js.result", { status: "completed", outputs: [1] })], context: ctx,
  });
  assert(
    (again.commands[0] as any)?.payload?.purpose !== "compaction",
    "and does not immediately compact again",
  );
});

console.log(`\n  Compaction\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
