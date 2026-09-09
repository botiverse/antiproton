/** Progressive tool disclosure: the harness decides how many options the model
 *  sees, and discovery is what widens that offer. */
import { HybridHarness, qualifyMountedTools, type MountedTool } from "../src/harness/hybrid.ts";
import type { RuntimeEvent } from "../src/core/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
const test = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: (e as Error).message }); }
};
function assert(c: unknown, what: string): asserts c {
  if (!c) throw new Error(`assertion failed: ${what}`);
}
const eq = (a: unknown, b: unknown, what: string) =>
  assert(Object.is(a, b), `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const mk = (n: number, app = "big"): MountedTool[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`, description: `does thing ${i}`,
    parameters: { type: "object", properties: {} }, address: `${app}.tool_${i}`,
  }));
const DISCOVERY: MountedTool[] = [
  { name: "search", description: "find tools", parameters: { type: "object", properties: {} }, address: "tools.search" },
];
const ev = (kind: string, payload: unknown): RuntimeEvent => ({
  eventId: "e", tenantId: "t", agentId: "a", taskId: "k", threadId: null,
  sequence: 1, kind, payload, dedupKey: null, createdAt: 0,
});
const toolsOf = (out: any) => (out.commands[0].payload.tools as any[]).map((t) => t.name);

await test("默认全铺 — with no threshold configured, the whole catalogue is offered", async () => {
  const cat = [...mk(400), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat });
  eq(h.narrowing, false, "narrowing is opt-in, not the default");
  const st: any = await h.initialize({});
  eq(st.offered.length, 401, "everything offered");
});

await test("小目录全铺 — a catalogue at or below the threshold is offered whole", async () => {
  const cat = [...mk(10), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 32 });
  eq(h.narrowing, false, "not narrowing");
  const st: any = await h.initialize({});
  eq(st.offered.length, 11, "everything offered");
  const out = await h.advance({ state: st, events: [ev("message", { text: "hi" })] } as any);
  eq(toolsOf(out).length, 12, "all tools plus run_js reach the model");
});

await test("大目录只给固定工具 — above the threshold, only pinned tools start offered", async () => {
  const cat = [...mk(400), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 32 });
  eq(h.narrowing, true, "narrowing");
  const st: any = await h.initialize({});
  eq(st.offered.length, 1, "only the discovery tool");
  const out = await h.advance({ state: st, events: [ev("message", { text: "hi" })] } as any);
  eq(toolsOf(out).join(","), "search,run_js", "model sees discovery and the sandbox only");
});

await test("发现结果扩大供给 — a discovery result makes tools natively callable", async () => {
  const cat = [...mk(400), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 32 });
  let st: any = await h.initialize({});
  const out = await h.advance({
    state: st,
    events: [ev("tool.result", { callId: "c1", tool: "tools.search", content: JSON.stringify([
      { name: "tool_7" }, { name: "tool_9" },
    ]) })],
  } as any);
  const offered = toolsOf(out);
  assert(offered.includes("tool_7") && offered.includes("tool_9"), `promoted: ${offered.join(",")}`);
  assert(!offered.includes("tool_8"), "only what discovery returned");
});

await test("发现结果用地址表述 — promotion matches the addresses discovery actually returns", async () => {
  // The real failure this missed: tools.search answers with mount-qualified
  // addresses, and for colliding bare names the model-facing name differs from
  // the address. Matching on bare names promoted nothing, so the agent searched
  // for the same tool over and over.
  const collide: MountedTool[] = [
    { name: "a__show", description: "x", parameters: {}, address: "a.show" },
    { name: "b__show", description: "y", parameters: {}, address: "b.show" },
  ];
  const cat = [...mk(400), ...collide, ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 32 });
  const st: any = await h.initialize({});
  const out = await h.advance({
    state: st,
    events: [ev("tool.result", { callId: "c", tool: "tools.search",
      content: JSON.stringify([{ name: "b.show", summary: "y" }]) })],
  } as any);
  const offered = toolsOf(out);
  assert(offered.includes("b__show"), `qualified tool promoted by address: ${offered.join(",")}`);
  assert(!offered.includes("a__show"), "only the one discovery named");
});

await test("用过的工具不被驱逐 — a tool the agent called survives later promotions", async () => {
  const cat = [...mk(400), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 4 });
  let st: any = await h.initialize({});
  st.offered = ["search", "tool_1"];
  st.used = ["tool_1"];
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `big.tool_${100 + i}` }));
  const out = await h.advance({
    state: st,
    events: [ev("tool.result", { callId: "c", tool: "tools.search", content: JSON.stringify(many) })],
  } as any);
  const offered = toolsOf(out);
  assert(offered.includes("tool_1"), `used tool retained: ${offered.join(",")}`);
});

await test("供给有上限 — the offer never exceeds the threshold, pinned survive", async () => {
  const cat = [...mk(400), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 8 });
  let st: any = await h.initialize({});
  const names = Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}` }));
  const out = await h.advance({
    state: st,
    events: [ev("tool.result", { callId: "c", tool: "tools.search", content: JSON.stringify(names) })],
  } as any);
  const offered = toolsOf(out).filter((n) => n !== "run_js");
  assert(offered.length <= 8, `offer capped: ${offered.length}`);
  assert(offered.includes("search"), "pinned discovery tool is never evicted");
});

await test("非发现结果不扩大供给 — an ordinary tool result does not widen the offer", async () => {
  const cat = [...mk(400), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 32 });
  const st: any = await h.initialize({});
  const out = await h.advance({
    state: st,
    events: [ev("tool.result", { callId: "c", tool: "big.tool_1", content: "mentions tool_7 and tool_9" })],
  } as any);
  eq(toolsOf(out).join(","), "search,run_js", "offer unchanged");
});

await test("检查点不含目录 — the catalogue is configuration, not state", async () => {
  const cat = [...mk(400), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 32 });
  const st = await h.initialize({});
  const bytes = JSON.stringify(st).length;
  assert(bytes < 4000, `checkpoint is ${bytes} bytes; the catalogue must not be in it`);
});

await test("旧检查点可迁移 — a v1 checkpoint carrying tools becomes offered names", async () => {
  const cat = [...mk(10), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat, maxOffered: 32 });
  const v1 = { messages: [], tools: [{ name: "tool_1" }, { name: "run_js" }],
               addresses: { tool_1: "big.tool_1" }, turns: 0, done: false, finalizing: false, promptTokens: 0 };
  const m: any = await h.migrate(v1);
  eq(m.offered.join(","), "tool_1", "names carried over, run_js dropped");
});

await test("名字冲突报错 — two mounts claiming one name is refused, not overwritten", async () => {
  const clash: MountedTool[] = [
    { name: "show", description: "a", parameters: {}, address: "x.show" },
    { name: "show", description: "b", parameters: {}, address: "y.show" },
  ];
  let threw = false;
  try { new HybridHarness({ catalogue: clash }); } catch { threw = true; }
  assert(threw, "collision refused");
  const fixed = qualifyMountedTools(clash);
  eq(new Set(fixed.map((t) => t.name)).size, 2, "qualifier resolves it");
});

await test("目录不匹配响亮失败 — a checkpoint naming absent tools is an error, not a smaller toolset", async () => {
  const cat = [...mk(10), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat });
  const st: any = await h.initialize({});
  st.offered.push("tool_from_a_mount_that_is_gone");
  let threw = "";
  try {
    await h.advance({ state: st, events: [ev("message", { text: "hi" })] } as any);
  } catch (e) { threw = (e as Error).message; }
  assert(threw.includes("does not have"), `expected a loud failure, got: ${threw || "no error"}`);
  assert(threw.includes("migrate"), "the error should say where to reconcile it");
});

await test("migrate 是和解的地方 — migrate drops names the catalogue no longer has", async () => {
  const cat = [...mk(10), ...DISCOVERY];
  const h = new HybridHarness({ catalogue: cat });
  const st: any = await h.initialize({});
  const m: any = await h.migrate({ ...st, offered: [...st.offered, "gone_tool"] });
  assert(!m.offered.includes("gone_tool"), "unknown name dropped");
  assert(m.offered.includes("tool_1"), "known names kept");
  // And the reconciled state advances without throwing.
  await h.advance({ state: m, events: [ev("message", { text: "hi" })] } as any);
});

await test("a rebuilt harness must be given its catalogue again before advancing", async () => {
  const catalogue = [
    { name: "get", description: "fetch", parameters: { type: "object", properties: {} }, address: "web.get" },
  ];
  const first = new HybridHarness({ maxTurns: 10 });
  const state = await first.initialize({ tools: catalogue });

  // What an eviction leaves behind: the checkpoint survives, the instance does
  // not. Advancing on a fresh harness that was never told the catalogue must
  // refuse rather than quietly offer nothing.
  const rebuilt = new HybridHarness({ maxTurns: 10 });
  let refused = false;
  try {
    await rebuilt.advance({ state, events: [ev("message", { text: "go" })] } as any);
  } catch (e) {
    refused = /does not have/.test(String((e as Error).message));
  }
  assert(refused, "a harness without its catalogue must refuse, not degrade");

  // Which is what the runtime reinstates before every advance.
  rebuilt.setCatalogue(catalogue as any);
  const out = await rebuilt.advance({ state, events: [ev("message", { text: "go" })] } as any);
  const offered = (out.commands[0] as any)?.payload?.tools ?? [];
  assert(offered.some((t: any) => t.name === "get"), "the catalogue is back");
});

console.log(`\n  progressive tool disclosure\n  ${"─".repeat(66)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(66)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
