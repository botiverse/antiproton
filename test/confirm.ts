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
import { bridgeTools, liftConfirm, declaresConfirm } from "../src/runtime/pi-tools.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (c: unknown, why: string) => { if (!c) throw new Error(why); };

async function fixture() {
  const seen: unknown[] = [];
  const plugin: Plugin = {
    // `defaultForAllAgents` because since the three-state switch (#216) a plugin
    // that does not say so is off for every agent, and the gateway refuses the
    // call before confirm is ever read. This file is about confirm.
    id: "p", version: "1.0.0", defaultForAllAgents: true,
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
  const gw = new ToolGateway(store, [plugin], new Set(([plugin]).map((p: any) => p.id)), { async resolve() { return null; } });
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
  const r = await f.gw.invoke(f.ctx, "p.zap", { x: 1 }, { confirm: true });
  must(r.status === "pending" && (r as any).error?.code === "awaiting_approval", `expected a hold, got ${JSON.stringify(r)}`);
  must(f.seen.length === 0, "the plugin ran before anyone approved");
  const held = (await f.store.listApprovals("t", "pending"))[0];
  must(held && (held.request as any).heldBy === "agent", "the card does not say the agent asked for it");
});

await check("approval runs the recorded call without the confirm field", async () => {
  const f = await fixture();
  const r = await f.gw.invoke(f.ctx, "p.zap", { x: 1 }, { confirm: true });
  const out = await f.gw.applyApproval("t", (r as any).operationId, "approved", "tygg");
  must(out.ok && out.executed && out.result?.status === "succeeded", `approval did not run it: ${JSON.stringify(out)}`);
  must(JSON.stringify(f.seen[0]) === JSON.stringify({ x: 1 }), `the plugin saw ${JSON.stringify(f.seen[0])}`);
});

await check("the bridge lifts confirm out of the model's arguments into the call's options", async () => {
  const calls: any[] = [];
  const host = { async invoke(call: any) { calls.push(call); return { status: "succeeded", operationId: "op", result: {} }; } };
  const [zap] = bridgeTools([{ name: "zap", address: "p.zap", description: "", parameters: {}, sideEffects: "write", idempotency: "none" } as any], host as any);
  const run = (zap as any).execute.bind(zap) as (id: string, p: unknown) => Promise<unknown>;
  await run("c1", { x: 1, confirm: true });
  must(JSON.stringify(calls[0].args) === JSON.stringify({ x: 1 }), `the plugin would have seen ${JSON.stringify(calls[0].args)}`);
  must(calls[0].opts?.confirm === true, "the option did not travel");
  await run("c2", { x: 2 });
  must(calls[1].opts?.confirm !== true, "a call without confirm was marked");
});

await check("a tool that declares its own confirm parameter keeps it, and is never held by it", async () => {
  const calls: any[] = [];
  const host = { async invoke(call: any) { calls.push(call); return { status: "succeeded", operationId: "op", result: {} }; } };
  const [own] = bridgeTools([{ name: "book", address: "p.book", description: "", parameters: { type: "object", properties: { confirm: { type: "boolean" } } }, sideEffects: "write", idempotency: "none" } as any], host as any);
  await ((own as any).execute.bind(own) as (id: string, p: unknown) => Promise<unknown>)("c1", { confirm: true });
  must(JSON.stringify(calls[0].args) === JSON.stringify({ confirm: true }), `the tool's own argument was taken: ${JSON.stringify(calls[0].args)}`);
  must(calls[0].opts?.confirm !== true, "the tool's own argument raised a card");
  must(declaresConfirm({ properties: { confirm: {} } }) && !declaresConfirm({ properties: { x: {} } }) && !declaresConfirm(null), "declaresConfirm");
});

await check("only a literal true asks; anything else is an ordinary argument", async () => {
  must(liftConfirm({ confirm: "yes" }).confirm === false, "a string confirm was treated as a hold");
  must(JSON.stringify(liftConfirm({ confirm: "yes" }).args) === JSON.stringify({ confirm: "yes" }), "an ordinary argument named confirm was stripped");
  must(liftConfirm(null).confirm === false && liftConfirm([1]).confirm === false, "non-objects");
});

await check("no seeded mount carries an approval policy", async () => {
  const gated = AgentRuntime.DEFAULT_MOUNTS.filter((m) => m.policy);
  must(gated.length === 0, `still gated: ${gated.map((m) => m.alias).join(", ")}`);
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
