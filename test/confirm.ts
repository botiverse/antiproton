/**
 * The agent's own hold.
 *
 * The person's decision (task #10): every seeded mount is open, and whether a
 * call deserves a card is the agent's judgement, not a policy's. The agent says
 * so by adding `confirm: true` to any call. The gateway holds that call exactly
 * as a policy would, the field never reaches the plugin, and on approval the
 * recorded call — without the field — is what runs.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (c: unknown, why: string) => { if (!c) throw new Error(why); };

async function fixture() {
  const seen: unknown[] = [];
  const plugin: Plugin = {
    id: "p", version: "1.0.0",
    tools: [{ name: "zap", description: "", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" } as any],
    async invoke(_tool, args) { seen.push(args); return { zapped: true }; },
  };
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "p", plugin: "p", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  const gw = new ToolGateway(store, [plugin], { async resolve() { return null; } });
  return { store, gw, seen, ctx: { tenantId: "t", agentId: "a", taskId: "k" } };
}

await check("an open mount runs a write straight away", async () => {
  const f = await fixture();
  const r = await f.gw.invoke(f.ctx, "p.zap", { x: 1 });
  must(r.status === "succeeded", `expected success, got ${r.status}`);
  must(JSON.stringify(f.seen[0]) === JSON.stringify({ x: 1 }), "the plugin saw the arguments");
});

await check("confirm: true holds the same call for a person, and the plugin never sees it", async () => {
  const f = await fixture();
  const r = await f.gw.invoke(f.ctx, "p.zap", { x: 1, confirm: true });
  must(r.status === "pending" && (r as any).error?.code === "awaiting_approval", `expected a hold, got ${JSON.stringify(r)}`);
  must(f.seen.length === 0, "the plugin ran before anyone approved");
  const held = (await f.store.listApprovals("t", "pending"))[0];
  must(held && (held.request as any).heldBy === "agent", "the card does not say the agent asked for it");
});

await check("approval runs the recorded call without the confirm field", async () => {
  const f = await fixture();
  const r = await f.gw.invoke(f.ctx, "p.zap", { x: 1, confirm: true });
  const out = await f.gw.applyApproval("t", (r as any).operationId, "approved", "tygg");
  must(out.ok && out.executed && out.result?.status === "succeeded", `approval did not run it: ${JSON.stringify(out)}`);
  must(JSON.stringify(f.seen[0]) === JSON.stringify({ x: 1 }), `the plugin saw ${JSON.stringify(f.seen[0])}`);
});

await check("only a literal true asks; anything else is an ordinary argument", async () => {
  const f = await fixture();
  const r = await f.gw.invoke(f.ctx, "p.zap", { confirm: "yes" });
  must(r.status === "succeeded", "a string confirm was treated as a hold");
  must(JSON.stringify(f.seen[0]) === JSON.stringify({ confirm: "yes" }), "an ordinary argument named confirm was stripped");
});

await check("no seeded mount carries an approval policy", async () => {
  const gated = AgentRuntime.DEFAULT_MOUNTS.filter((m) => m.policy);
  must(gated.length === 0, `still gated: ${gated.map((m) => m.alias).join(", ")}`);
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
