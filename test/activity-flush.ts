/**
 * The activity drain (cf/src/activity-raft.ts) on a real SQLite outbox with a
 * recording gateway: the cursor moves only on a send that returned, a throw
 * keeps the rows, a skipping service still advances, the trace export prunes
 * only through what both readers consumed, and a backlog past the cap is
 * skipped with a warning rather than held for ever.
 */
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { appendTrace, type TraceRow } from "../src/trace/outbox.ts";
import { flushActivity, activityCursor, ACTIVITY_BACKLOG_MAX } from "../cf/src/activity-raft.ts";
import { flushTrace } from "../cf/src/trace-r2.ts";
import type { ActivityEvent } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const OWNER = { tenantId: "t1", agentId: "raft_a1" };
const tool = (n: number): TraceRow => ({ at: 1_790_000_000_000 + n * 1000, ...OWNER, kind: "tool.call", spanId: `op_${n}`, status: "succeeded", verdict: "ok", ms: 5, attrs: { tool: "send_message", mount: "raft" } });
const answered = (n: number): TraceRow => ({ at: 1_790_000_000_000 + n * 1000, ...OWNER, kind: "model.call", spanId: `mj_${n}`, status: "stop", verdict: "ok", attrs: { model: "m" } });
function gateway(mode: "send" | "skip" | "throw" = "send") {
  const g = {
    batches: [] as ActivityEvent[][], mode,
    async reportActivity(_t: string, _a: string, events: readonly ActivityEvent[]) {
      if (g.mode === "throw") throw new Error("raft unreachable");
      if (g.mode === "skip") return [{ alias: "raft", skipped: "push is disabled" }];
      g.batches.push([...events]);
      return [{ alias: "raft", sent: events.length }];
    },
  };
  return g;
}
const left = (sql: any) => Number(sql.exec("SELECT COUNT(*) AS n FROM trace_outbox").toArray()[0].n);
const quiet = async <T,>(fn: () => Promise<T>) => { const warned: string[] = []; const o = console.warn; console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); }; try { return { out: await fn(), warned }; } finally { console.warn = o; } };

await check("rows become events, the send returns, the cursor moves to the last row read; a second pass with nothing new sends nothing", async () => {
  const { sql } = sqliteHost(); const g = gateway();
  appendTrace(sql, [tool(1), answered(2)]);
  const r = await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId);
  must(r.events === 3 && r.sent === 3 && r.through === 2 && activityCursor(sql) === 2, JSON.stringify(r));
  must(g.batches[0]!.map((e) => e.hookEventName).join(",") === "PreToolUse,PostToolUse,Stop", JSON.stringify(g.batches));
  const again = await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId);
  must(again.events === 0 && g.batches.length === 1 && activityCursor(sql) === 2, JSON.stringify(again));
});

await check("a service that throws keeps the rows and the cursor, and the next pass resends the same event ids", async () => {
  const { sql } = sqliteHost(); const g = gateway("throw");
  appendTrace(sql, [tool(1)]);
  let threw = false;
  try { await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId); } catch { threw = true; }
  must(threw && activityCursor(sql) === 0, `cursor ${activityCursor(sql)}`);
  g.mode = "send";
  const r = await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId);
  must(r.sent === 2 && g.batches[0]![1]!.eventId === "raft_a1:1", JSON.stringify(r));
});

await check("a service that is not listening still advances the cursor, so the outbox is never held on its account", async () => {
  const { sql } = sqliteHost(); const g = gateway("skip");
  appendTrace(sql, [tool(1), tool(2)]);
  const r = await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId);
  must(r.sent === 0 && r.skipped.length === 1 && r.through === 2 && activityCursor(sql) === 2, JSON.stringify(r));
});

await check("the trace export prunes only through what the activity reader has consumed, and all of it once it has caught up", async () => {
  const { sql } = sqliteHost();
  const bucket = { async put() {} };
  appendTrace(sql, [tool(1), tool(2), tool(3)]);
  // Activity behind (read one row), trace exports all three: two rows must survive for the activity reader.
  const a = await flushActivity(gateway(), sql, OWNER.tenantId, OWNER.agentId, 1);
  must(a.through === 1, JSON.stringify(a));
  await flushTrace(bucket, sql, OWNER.tenantId, OWNER.agentId, 500, Date.now, a.through);
  must(left(sql) === 2, `rows left ${left(sql)}`);
  const b = await flushActivity(gateway(), sql, OWNER.tenantId, OWNER.agentId);
  must(b.through === 3 && b.events === 4, JSON.stringify(b));
  await flushTrace(bucket, sql, OWNER.tenantId, OWNER.agentId, 500, Date.now, b.through);
  must(left(sql) === 0, `rows left ${left(sql)}`);
  // No second reader named: the export prunes as before.
  appendTrace(sql, [tool(4)]);
  await flushTrace(bucket, sql, OWNER.tenantId, OWNER.agentId);
  must(left(sql) === 0, "unheld rows were kept");
});

await check("a backlog past the cap is skipped to the newest rows with a warning, and the pass says how many", async () => {
  const { sql } = sqliteHost(); const g = gateway();
  const rows: TraceRow[] = [];
  for (let i = 1; i <= ACTIVITY_BACKLOG_MAX + 10; i++) rows.push(answered(i));
  appendTrace(sql, rows);
  const { out, warned } = await quiet(() => flushActivity(g, sql, OWNER.tenantId, OWNER.agentId, 5));
  must(out.dropped === ACTIVITY_BACKLOG_MAX + 5 && out.events === 5 && out.through === ACTIVITY_BACKLOG_MAX + 10, JSON.stringify(out));
  must(warned.length === 1 && /skipped/.test(warned[0]!), JSON.stringify(warned));
  must(g.batches[0]![0]!.eventId === `raft_a1:${ACTIVITY_BACKLOG_MAX + 6}`, JSON.stringify(g.batches[0]![0]));
});

console.log(`\n  activity flush\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
