/**
 * The gateway's refusals are sentences a model can act on, and none names a
 * dispatch address.
 *
 * Two of them used to be a bare identifier: `plugin_unavailable` carried the
 * plugin id and `unknown_tool` the tool name, so a model learned only the word
 * it had typed (Dora, Piper, 2026-09-13). Through the real gateway and store.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway, pluginUnavailableMessage, unknownToolMessage } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const ctx = { tenantId: "t", agentId: "a", taskId: "k" };
const box: Plugin = {
  id: "box", version: "1.0.0", 
  tools: [{ name: "run", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { return { ok: true }; },
};

async function fixture(mountPlugin: string) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "work", plugin: mountPlugin, installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  return new ToolGateway(store, [box], new Set(([box]).map((p: any) => p.id)), { async resolve() { return null; } });
}

await check("插件没装的挂载: 说出挂载和插件,并说明要运维来修,不带派发地址", async () => {
  const gw = await fixture("run9");
  const r: any = await gw.invoke(ctx, "work.run", {});
  if (r.status !== "rejected" || r.error?.code !== "plugin_unavailable") throw new Error(`got ${JSON.stringify(r)}`);
  if (r.error.message !== pluginUnavailableMessage("work", "run9")) throw new Error(`not the sentence: ${r.error.message}`);
  if (r.error.message === "run9") throw new Error("the message is still the bare plugin id");
  // The next move: nothing the model can do; an operator has to fix the mount.
  if (!/an operator fixes the mount/.test(r.error.message)) throw new Error(`the refusal does not say who fixes it: ${r.error.message}`);
  if (r.error.message.includes("work.run")) throw new Error(`the refusal names a dispatch address: ${r.error.message}`);
});

await check("挂载在、工具不存在: 说出挂载和工具名,不带派发地址", async () => {
  const gw = await fixture("box");
  const r: any = await gw.invoke(ctx, "work.walk", {});
  if (r.status !== "rejected" || r.error?.code !== "unknown_tool") throw new Error(`got ${JSON.stringify(r)}`);
  if (r.error.message !== unknownToolMessage("work", "walk")) throw new Error(`not the sentence: ${r.error.message}`);
  if (r.error.message === "walk") throw new Error("the message is still the bare tool name");
  // The next move, not just the fact: another tool on the same mount.
  if (!/call one of the tools it does offer/.test(r.error.message)) throw new Error(`the refusal does not say what to do next: ${r.error.message}`);
  if (r.error.message.includes("work.walk")) throw new Error(`the refusal names a dispatch address: ${r.error.message}`);
});

await check("a refusal before any operation leaves one tool.refused row, with the name, the code and the call, never the arguments", async () => {
  // The tool.call row is written when an operation ends; these never had one, so before this row they left nothing.
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const [alias, plugin, policy] of [["work", "box", null], ["gone", "run9", null], ["shut", "box", { read: "deny" }]] as const) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, plugin, installationId: `i-${alias}`, connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: policy as any,
    });
  }
  const rows: any[] = [];
  const record = store.recordTrace.bind(store);
  store.recordTrace = async (r) => { rows.push(...r); return record(r); };
  const gw = new ToolGateway(store, [box], new Set([box.id]), { async resolve() { return null; } });
  const args = { q: "v4lue" };
  const answers: any[] = [
    await gw.invoke(ctx, "work.walk", args, { callId: "call_1" }),
    await gw.invoke(ctx, "gone.run", args, { callId: "call_2", fromProgram: true }),
    await gw.invoke(ctx, "nowhere.run", args, { callId: "call_3" }),
    // Refused by policy after its operation was recorded: that one has its tool.call row, and no second.
    await gw.invoke(ctx, "shut.run", args, { callId: "call_4" }),
  ];
  const codes = answers.map((a) => a.error?.code);
  if (codes.slice(0, 2).join() !== "unknown_tool,plugin_unavailable" || codes[3] !== "policy_denied") throw new Error(`answers: ${JSON.stringify(codes)}`);
  const refused = rows.filter((r) => r.kind === "tool.refused");
  const seen = refused.map((r) => [r.spanId, r.status, r.verdict, r.attrs.tool, r.attrs.by, r.attrs.from, r.attrs.task]);
  const want = [
    ["call_1", "unknown_tool", "blocked", "work.walk", "gateway", "model", "k"],
    ["call_2", "plugin_unavailable", "blocked", "gone.run", "gateway", "program", "k"],
    ["call_3", codes[2], "blocked", "nowhere.run", "gateway", "model", "k"],
  ];
  if (JSON.stringify(seen) !== JSON.stringify(want)) throw new Error(`rows: ${JSON.stringify(seen)}`);
  // The store writes that one's row inside its own transaction (`toolCallRow`), not through recordTrace.
  if (rows.some((r) => r.spanId === "call_4")) {
    throw new Error(`a policy refusal is the tool.call row's alone: ${JSON.stringify(rows.map((r) => [r.kind, r.spanId]))}`);
  }
  if (JSON.stringify(rows).includes("v4lue")) throw new Error("an argument reached the trace");
  // What the caller is told is unchanged by the row.
  if (answers[0].error.message !== unknownToolMessage("work", "walk") || "operationId" in answers[0]) throw new Error(JSON.stringify(answers[0]));
});

console.log(`\n  Gateway refusals\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
