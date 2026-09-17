/**
 * The agent side of usage (src/usage/outbox.ts): what is appended where the
 * work happens (a model reply's tokens, a tool call through a mount, a run_js)
 * and how it sums by the hour. Sending to D1 is test/spec/usage-spec.ts.
 */
import { PiSqliteStorage } from "../src/store/pi-storage.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { runJsTool } from "../src/runtime/pi-tools.ts";
import {
  appendUsage, jsRunRows, modelTokenRows, pendingUsage, pruneUsage, toHourly, toolCallRows, HOUR_MS, USAGE_KEY_MAX,
} from "../src/usage/outbox.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const base = { at: 1_800_000_000_000, tenantId: "t", agentId: "a" };
const describe = (rows: Array<{ resource: string; key: string; quantity: number; unit: string }>) =>
  rows.map((r) => `${r.resource}/${r.key}/${r.quantity}${r.unit}`).sort().join(" ");

await check("the outbox keeps rows in order, drops zeros and non-numbers, keeps corrections, and forgets what was sent", () => {
  const host = sqliteHost();
  appendUsage(host.sql, [
    { ...base, resource: "r", key: "k", quantity: 3, unit: "u" },
    { ...base, resource: "r", key: "zero", quantity: 0, unit: "u" },
    { ...base, resource: "r", key: "nan", quantity: NaN, unit: "u" },
    { ...base, resource: "r", key: "inf", quantity: Infinity, unit: "u" },
    { ...base, resource: "r", key: "fix", quantity: -2, unit: "u" },
    { ...base, resource: "r", key: "x".repeat(USAGE_KEY_MAX + 50), quantity: 1, unit: "u" },
  ]);
  const rows = pendingUsage(host.sql, 0);
  must(rows.map((r) => r.key.slice(0, 5)).join(",") === "k,fix,xxxxx" && rows[2].key.length === USAGE_KEY_MAX, JSON.stringify(rows.map((r) => r.key.length)));
  must(rows[0].seq < rows[1].seq && rows[1].seq < rows[2].seq, "not in order");
  pruneUsage(host.sql, rows[1].seq);
  must(pendingUsage(host.sql, 0).length === 1 && pendingUsage(host.sql, rows[2].seq).length === 0, "prune");
  host.dispose();
});

await check("rows sum by agent, hour, resource, key and unit", () => {
  const rows = [
    { ...base, resource: "r", key: "k", quantity: 1, unit: "u" },
    { ...base, at: base.at + 1, resource: "r", key: "k", quantity: 2, unit: "u" },
    { ...base, resource: "r", key: "k", quantity: 5, unit: "ms" },
    { ...base, at: base.at + HOUR_MS, resource: "r", key: "k", quantity: 4, unit: "u" },
    { ...base, agentId: "b", resource: "r", key: "k", quantity: 8, unit: "u" },
  ];
  const h = toHourly(rows).map((x) => `${x.agentId}/${x.hour % HOUR_MS === 0}/${x.unit}=${x.quantity}`).sort().join(" ");
  must(h === "a/true/ms=5 a/true/u=3 a/true/u=4 b/true/u=8", h);
});

await check("a model reply counts each kind of token it reported, under its model", () => {
  const got = describe(modelTokenRows(base, "deepseek-chat", { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 7 }));
  must(got === "model.tokens/deepseek-chat:cache_read/50tokens model.tokens/deepseek-chat:input/100tokens model.tokens/deepseek-chat:output/20tokens model.tokens/deepseek-chat:reasoning/7tokens", got);
  must(modelTokenRows(base, "", { input: 1 })[0].key === "unknown:input", "an unnamed model");
});

await check("a committed model reply lands in the outbox with its model, in the same commit, and only when an owner is set", async () => {
  const host = sqliteHost();
  const storage = new PiSqliteStorage(host, { usageOwner: { tenantId: "t", agentId: "a" }, now: () => base.at });
  const usage = { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await storage.commit([
    { kind: "entry", entry: { id: "e1", parentId: null, type: "message", message: { role: "assistant", model: "m-in-commit", content: [], usage } } } as any,
    { kind: "usage", row: { id: "u1", usage, entryId: "e1", adjustment: false } } as any,
  ], {} as any);
  await storage.commit([{ kind: "usage", row: { id: "u2", usage: { ...usage, input: 1, output: 0 }, entryId: "e1", adjustment: true } } as any], {} as any);
  await storage.commit([{ kind: "usage", row: { id: "u3", usage: { ...usage, input: 2, output: 0 }, adjustment: false } } as any], {} as any);
  const got = describe(pendingUsage(host.sql, 0));
  must(got === "model.tokens/m-in-commit:input/10tokens model.tokens/m-in-commit:input/1tokens model.tokens/m-in-commit:output/3tokens model.tokens/unknown:input/2tokens", got);
  must(pendingUsage(host.sql, 0).every((r) => r.tenantId === "t" && r.agentId === "a" && r.at === base.at), "owner or time");

  const other = sqliteHost();
  const quiet = new PiSqliteStorage(other);
  await quiet.commit([{ kind: "usage", row: { id: "u1", usage, adjustment: false } } as any], {} as any);
  must(pendingUsage(other.sql, 0).length === 0, "counted without an owner");
  host.dispose(); other.dispose();
});

await check("a tool call through a mount is counted once, as ok or failed, with its time", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  const p: Plugin = {
    id: "p", version: "1.0.0", defaultForAllAgents: true,
    tools: [
      { name: "fine", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" },
      { name: "boom", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" },
    ],
    async invoke(tool) { if (tool === "boom") throw new Error("no"); await new Promise((r) => setTimeout(r, 15)); return { ok: true }; },
  };
  await store.addMount({ tenantId: "t", agentId: "a", alias: "m", plugin: "p", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  const gw = new ToolGateway(store, [p]);
  const ctx = { tenantId: "t", agentId: "a", taskId: "k" };
  await gw.invoke(ctx, "m.fine", {});
  await gw.invoke(ctx, "m.boom", {});
  await gw.invoke(ctx, "m.nope", {});
  const rows = store.usageOutbox();
  const got = rows.filter((r) => r.unit === "calls").map((r) => `${r.key}=${r.quantity}`).join(",");
  must(got === "p.fine:ok=1,p.boom:failed=1", got);
  // A zero duration is not a row; a call that took time is.
  const fineMs = rows.find((r) => r.unit === "ms" && r.key === "p.fine:ok")?.quantity ?? 0;
  must(fineMs >= 10, `time row ${fineMs}`);
  await store.close?.();
});

await check("every run_js is counted, however it ends, and a counting failure does not fail the run", async () => {
  const seen: any[] = [];
  const outcome = { value: "completed" as string };
  const sandbox = { async execute() {
    if (outcome.value === "throw") throw new Error("executor down");
    return { status: outcome.value, outputs: [], hostCalls: 2, error: outcome.value === "completed" ? undefined : "x" };
  } };
  const tool = runJsTool(sandbox as any, { invoke: async () => ({}) } as any, { onRun: (r) => { seen.push(r); throw new Error("counter broke"); } });
  await tool.execute("c1", { source: "1" } as any, undefined as any, undefined as any, undefined as any, undefined as any);
  outcome.value = "failed";
  await tool.execute("c2", { source: "1" } as any, undefined as any, undefined as any, undefined as any, undefined as any).catch(() => {});
  outcome.value = "throw";
  let threw = "";
  await tool.execute("c3", { source: "1" } as any, undefined as any, undefined as any, undefined as any, undefined as any).catch((e) => { threw = String(e.message); });
  must(threw === "executor down", `the run's own error was replaced: ${threw}`);
  must(seen.map((r) => `${r.ok}/${r.hostCalls}`).join(",") === "true/2,false/2,false/0", JSON.stringify(seen));
  must(describe(jsRunRows(base, "ok", 12.6, 2)) === "js.run/ok/13ms js.run/ok/1runs js.run/ok/2tool_calls", describe(jsRunRows(base, "ok", 12.6, 2)));
  must(describe(toolCallRows(base, "p.t", "failed", 3)) === "tool.call/p.t:failed/1calls tool.call/p.t:failed/3ms", "tool rows");
});

console.log(`\n  Usage outbox\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
