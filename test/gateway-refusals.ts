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

console.log(`\n  Gateway refusals\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
