/**
 * The store's two trace seams (src/trace/seams.ts): a tool.call row when an
 * operation ends, an approval.wait row when a decision lands. Each row is
 * written in the same transaction as the fact it joins back to, on both
 * backends, because the Durable Object is the one production runs on and the
 * sqlite store is the one the bench runs on.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { pendingTrace } from "../src/trace/outbox.ts";
import { operationEnded, operationVerdict } from "../src/trace/seams.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

/** Both backends, each with a way to read its own trace_outbox back. */
const BACKENDS = {
  sqlite: async () => {
    const path = join(mkdtempSync(join(tmpdir(), "trace-ops-")), "store.sqlite");
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

const OP = {
  operationId: "op_1", tenantId: "t", agentId: "a", taskId: "k",
  mountAlias: "svc", tool: "svc.go", toolVersion: "1.0.0",
};

for (const backend of Object.keys(BACKENDS) as Array<keyof typeof BACKENDS>) {
  await check(`an operation's end leaves a tool.call row that joins back to it (${backend})`, async () => {
    const { store, sql } = await BACKENDS[backend]();
    await store.recordOperation(OP);
    // A progress update is not an end: no row yet.
    await store.completeOperation("t", "op_1", "running", null);
    must(pendingTrace(sql, 0).rows.length === 0, "a 'running' update wrote a trace row");
    await store.completeOperation("t", "op_1", "succeeded", null, undefined, { callId: "toolu_9" });
    const fact = sql.exec("SELECT operation_id, agent_id, task_id, status, created_at, updated_at FROM operations").toArray()[0];
    const { rows, dropped } = pendingTrace(sql, 0);
    must(dropped === 0, "a well-formed row was dropped on read");
    must(rows.length === 1, `one trace row, found ${rows.length}`);
    const row = rows[0]!;
    must(row.kind === "tool.call", `kind ${row.kind}`);
    must(row.spanId === String(fact.operation_id), `span ${row.spanId} does not join ${fact.operation_id}`);
    must(row.status === String(fact.status), `status ${row.status} is not the operation's ${fact.status}`);
    must(row.verdict === "ok", `verdict ${row.verdict}`);
    must(row.at === Number(fact.updated_at), `at ${row.at} is not the end ${fact.updated_at}`);
    must(row.ms === Number(fact.updated_at) - Number(fact.created_at),
      `ms ${row.ms} is not the fact's own ${fact.updated_at} - ${fact.created_at}`);
    must(row.tenantId === "t" && row.agentId === String(fact.agent_id), "the row lost its owner");
    must(row.attrs.tool === "svc.go" && row.attrs.mount === "svc" && row.attrs.task === String(fact.task_id)
      && row.attrs.callId === "toolu_9", `attrs ${JSON.stringify(row.attrs)}`);
  });

  await check(`a denied approval leaves an approval.wait row that joins back to it (${backend})`, async () => {
    const { store, sql } = await BACKENDS[backend]();
    await store.recordOperation(OP);
    await store.requireApproval({ ...OP, request: { tool: "go", args: {}, heldBy: "policy" } });
    const r = await store.decideApproval("t", "op_1", "denied", "alice");
    must(r.ok, "the decision was refused");
    const fact = sql.exec("SELECT operation_id, agent_id, state, created_at, decided_at FROM approvals").toArray()[0];
    const { rows } = pendingTrace(sql, 0);
    const waits = rows.filter((x) => x.kind === "approval.wait");
    must(waits.length === 1, `one approval.wait row, found ${waits.length}`);
    const row = waits[0]!;
    must(row.spanId === String(fact.operation_id), `span ${row.spanId} does not join ${fact.operation_id}`);
    must(row.status === "denied" && row.status === String(fact.state), `status ${row.status}`);
    must(row.verdict === "blocked", `verdict ${row.verdict} for a denial`);
    must(row.at === Number(fact.decided_at), `at ${row.at} is not decided_at ${fact.decided_at}`);
    must(row.ms === Number(fact.decided_at) - Number(fact.created_at), `ms ${row.ms} is not the wait's own arithmetic`);
    must(row.attrs.approver === "alice" && row.attrs.tool === "svc.go", `attrs ${JSON.stringify(row.attrs)}`);
    // Deciding twice is refused, so it cannot write a second span.
    const again = await store.decideApproval("t", "op_1", "approved", "bob");
    must(!again.ok, "a second decision was accepted");
    must(pendingTrace(sql, 0).rows.filter((x) => x.kind === "approval.wait").length === 1, "a refused decision wrote a row");
  });
}

await check("every operation status is either an end with a verdict the outbox accepts, or not an end", () => {
  // Exhaustive by the switch's typecheck; this pins which side each is on.
  const ends: Record<string, string> = { succeeded: "ok", failed: "failed", cancelled: "cancelled", unknown: "failed" };
  for (const [s, v] of Object.entries(ends)) {
    must(operationEnded(s as any), `${s} should end the span`);
    must(operationVerdict(s as any) === v, `${s} → ${operationVerdict(s as any)}, want ${v}`);
  }
  for (const s of ["pending", "running"]) must(!operationEnded(s as any), `${s} must not end the span`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
