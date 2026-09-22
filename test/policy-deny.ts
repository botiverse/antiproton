/**
 * A call the policy refuses never ran, and the record must say so. The
 * operation is recorded before the policy is asked, so a refusal has to end
 * it: left "pending", an attempt that never started sat on the books as one
 * still under way. Both backends, because the Durable Object is the one
 * production runs on.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { pendingTrace } from "../src/trace/outbox.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const caller = { tenantId: "t", agentId: "a", taskId: "k" };
const plugin = (): Plugin => ({
  id: "svc", version: "1.0.0",
  tools: [{ name: "go", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" }],
  async invoke() { throw new Error("a denied call must never reach the plugin"); },
});

const BACKENDS = {
  sqlite: async () => {
    const path = join(mkdtempSync(join(tmpdir(), "policy-deny-")), "store.sqlite");
    const s = new SqliteStore(path); await s.init();
    const db = new DatabaseSync(path);
    const sql = { exec: (q: string, ...b: unknown[]) => {
      const st = db.prepare(q);
      const rows = st.columns().length ? st.all(...(b as any[])) : (st.run(...(b as any[])), []);
      return { toArray: () => rows };
    } };
    return { store: s as any, sql: sql as any };
  },
  "durable-object": async () => {
    const host = sqliteHost();
    const s = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
    await s.init();
    return { store: s as any, sql: host.sql };
  },
} as const;

for (const backend of Object.keys(BACKENDS) as Array<keyof typeof BACKENDS>) {
  await check(`a call the policy refuses is ended as rejected, not left pending (${backend})`, async () => {
    const { store, sql } = await BACKENDS[backend]();
    await store.createAgent("t", "a");
    await store.addMount({
      tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: { tools: { go: "deny" } },
    });
    const gw = new ToolGateway(store, [plugin()], new Set(["svc"]), { async resolve() { return null; } });
    const r: any = await gw.invoke(caller, "svc.go", {}, { callId: "toolu_d" });
    must(r.status === "rejected" && r.error?.code === "policy_denied", `the call was not refused: ${JSON.stringify(r)}`);
    const ops = sql.exec("SELECT operation_id, status FROM operations").toArray() as any[];
    must(ops.length === 1, `one operation record, found ${ops.length}`);
    must(ops[0].status === "rejected", `the record says ${ops[0].status}: a refusal left on the books as under way`);
    const events = (await store.taskEvents("t", "k")).filter((e: any) => e.kind === "operation.completed");
    must(events.length === 1 && events[0].payload?.status === "rejected" && events[0].payload?.callId === "toolu_d",
      `the completion event is missing or wrong: ${JSON.stringify(events.map((e: any) => e.payload))}`);
    const { rows } = pendingTrace(sql, 0);
    const calls = rows.filter((x) => x.kind === "tool.call");
    must(calls.length === 1, `one tool.call trace row, found ${calls.length}`);
    must(calls[0]!.spanId === String(ops[0].operation_id) && calls[0]!.status === "rejected" && calls[0]!.verdict === "blocked",
      `trace row ${JSON.stringify(calls[0])} does not say the road was closed`);
  });
}

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
