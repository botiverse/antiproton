/**
 * Prefix stability, enforced rather than asserted in prose.
 *
 * Measured on this provider: editing the system message drops the cache hit
 * rate from 84.9% to 0.0% across a seven-turn conversation and costs 6.6x the
 * uncached tokens. Editing the tool block costs 1.1x. So the head of the prompt
 * is the one thing a harness must never touch mid-task, and that has to be a
 * test rather than a comment — compaction is exactly the code most likely to
 * break it.
 */
import { CodegenHarness } from "../src/harness/codegen.ts";
import { HybridHarness, type MountedTool } from "../src/harness/hybrid.ts";
import type { RuntimeEvent } from "../src/core/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
const test = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: (e as Error).message }); }
};
function assert(c: unknown, what: string): asserts c {
  if (!c) throw new Error(`assertion failed: ${what}`);
}

let seq = 0;
const ev = (kind: string, payload: unknown): RuntimeEvent => ({
  eventId: `e${++seq}`, tenantId: "t", agentId: "a", taskId: "k", threadId: null,
  sequence: seq, kind, payload, dedupKey: null, createdAt: 0,
});
const head = (s: any) => JSON.stringify(s.messages?.[0] ?? null);

await test("压缩不改头部 — compaction never rewrites the system message", async () => {
  const h = new CodegenHarness({
    maxTurns: 200,
    compaction: { mode: "cycles", triggerTokens: 1, keepCycles: 2 },
  });
  let state: any = await h.initialize({ mounts: [], policy: "be careful" });
  const head0 = head(state);
  let compacted = 0;
  for (let i = 0; i < 12; i++) {
    let out = await h.advance({
      state, events: [ev("model.response", { text: "```js\nawait tool`x.y`({})\n```", usage: { promptTokens: 50_000 } })],
    } as any);
    state = out.state;
    assert(head(state) === head0, `system message changed after model reply ${i}`);
    out = await h.advance({
      state, events: [ev("js.result", { callId: `c${i}`, status: "completed", outputs: [{ n: i }] })],
    } as any);
    state = out.state;
    if (h.lastCompaction) compacted++;
    assert(head(state) === head0, `system message changed after execution ${i}`);
  }
  assert(compacted > 0, "compaction never fired, so the test proved nothing");
});

await test("压缩保留每一条客户消息 — customer turns survive compaction", async () => {
  const h = new CodegenHarness({
    maxTurns: 200, compaction: { mode: "cycles", triggerTokens: 1, keepCycles: 1 },
  });
  let state: any = await h.initialize({ mounts: [] });
  for (let i = 0; i < 8; i++) {
    state = (await h.advance({ state, events: [ev("message", { text: `customer says ${i}` })] } as any)).state;
    state = (await h.advance({
      state, events: [ev("model.response", { text: "```js\nawait tool`x.y`({})\n```", usage: { promptTokens: 50_000 } })],
    } as any)).state;
    state = (await h.advance({
      state, events: [ev("js.result", { callId: `c${i}`, status: "completed", outputs: [] })],
    } as any)).state;
  }
  for (let i = 0; i < 8; i++) {
    assert(
      state.messages.some((m: any) => String(m.content).includes(`customer says ${i}`)),
      `customer turn ${i} was dropped`,
    );
  }
});

await test("hybrid 不改头部 — the hybrid head survives discovery and promotion", async () => {
  const cat: MountedTool[] = [
    ...Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${i}`, description: `d${i}`, parameters: {}, address: `app.tool_${i}`,
    })),
    { name: "search", description: "find tools", parameters: {}, address: "tools.search" },
  ];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 16 });
  let state: any = await h.initialize({ policy: "domain rules" });
  const head0 = head(state);
  for (let i = 0; i < 6; i++) {
    const names = Array.from({ length: 20 }, (_, k) => ({ name: `app.tool_${i * 20 + k}` }));
    state = (await h.advance({
      state, events: [ev("tool.result", { callId: `c${i}`, tool: "tools.search", content: JSON.stringify(names) })],
    } as any)).state;
    assert(head(state) === head0, `hybrid system message changed at round ${i}`);
  }
  assert(h.promotions > 0, "no promotion happened, so the test proved nothing");
});

await test("供给顺序稳定 — promotion appends, it does not reorder what is already offered", async () => {
  const cat: MountedTool[] = [
    ...Array.from({ length: 100 }, (_, i) => ({
      name: `t${i}`, description: `d${i}`, parameters: {}, address: `app.t${i}`,
    })),
    { name: "search", description: "find", parameters: {}, address: "tools.search" },
  ];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 64 });
  let state: any = await h.initialize({});
  const seen: string[][] = [];
  for (let i = 0; i < 4; i++) {
    const out = await h.advance({
      state,
      events: [ev("tool.result", { callId: `c${i}`, tool: "tools.search",
        content: JSON.stringify([{ name: `app.t${i * 3}` }, { name: `app.t${i * 3 + 1}` }]) })],
    } as any);
    state = out.state;
    seen.push((out.commands[0].payload as any).tools.map((t: any) => t.name));
  }
  for (let i = 1; i < seen.length; i++) {
    const prev = seen[i - 1]!.filter((n) => n !== "run_js");
    const cur = seen[i]!.filter((n) => n !== "run_js");
    assert(
      prev.every((n, k) => cur[k] === n),
      `offer reordered between rounds ${i - 1} and ${i}: ${prev.join(",")} vs ${cur.join(",")}`,
    );
  }
});

console.log(`\n  prompt-prefix stability\n  ${"─".repeat(70)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(70)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
