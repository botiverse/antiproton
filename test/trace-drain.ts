/**
 * The trace outbox's drain (cf/src/trace-r2.ts): rows past the cursor go to
 * the bucket as newline-delimited JSON under a key that names their seq
 * range, then the cursor moves and the rows are forgotten. A failed put moves
 * nothing; a replay writes the same key with the same bytes; a row the
 * outbox refused is warned about and written down where diagnose reads.
 */
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { appendTrace, ensureTraceOutbox, type TraceRow } from "../src/trace/outbox.ts";
import { flushTrace, traceKey, TRACE_DROPS_KEEP_MS } from "../cf/src/trace-r2.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const OWNER = { tenantId: "t1", agentId: "a1" };
const row = (n: number, kind: TraceRow["kind"] = "tool.call"): TraceRow => ({
  at: 1_700_000_000_000 + n, ...OWNER, kind, spanId: `op_${n}`, status: "succeeded", verdict: "ok", ms: n, attrs: { n },
});

function bucket() {
  const puts: Array<{ key: string; body: string }> = [];
  let fail = false;
  return {
    puts, failNext: () => { fail = true; },
    async put(key: string, body: Uint8Array) {
      if (fail) { fail = false; throw new Error("r2 unavailable"); }
      puts.push({ key, body: new TextDecoder().decode(body) });
    },
  };
}
const cursor = (sql: any) => Number(sql.exec("SELECT through_seq FROM trace_sent WHERE id = 1").toArray()[0]?.through_seq ?? 0);
const left = (sql: any) => Number(sql.exec("SELECT COUNT(*) AS n FROM trace_outbox").toArray()[0].n);
const drops = (sql: any) => sql.exec("SELECT at, dropped FROM trace_drops ORDER BY at").toArray();
const quiet = async <T,>(fn: () => Promise<T>): Promise<{ out: T; warned: string[] }> => {
  const warned: string[] = []; const orig = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
  try { return { out: await fn(), warned }; } finally { console.warn = orig; }
};

await check("rows past the cursor become one object whose key names their range, then are forgotten", async () => {
  const host = sqliteHost(); const b = bucket();
  appendTrace(host.sql, [row(1), row(2), row(3)]);
  const r = await flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId);
  must(r.rows === 3 && r.key === traceKey("t1", "a1", 1, 3), `flush said ${JSON.stringify(r)}`);
  must(b.puts.length === 1 && b.puts[0]!.key === "trace/t1/a1/1-3.ndjson", `puts ${JSON.stringify(b.puts.map((p) => p.key))}`);
  const lines = b.puts[0]!.body.trimEnd().split("\n").map((l) => JSON.parse(l));
  must(lines.length === 3 && lines[0].seq === 1 && lines[2].spanId === "op_3" && lines[1].attrs.n === 2, "the lines do not read back as the rows");
  must(cursor(host.sql) === 3, `cursor ${cursor(host.sql)}`);
  must(left(host.sql) === 0, `${left(host.sql)} rows were not forgotten`);
});

await check("nothing pending writes nothing", async () => {
  const host = sqliteHost(); const b = bucket(); ensureTraceOutbox(host.sql);
  const r = await flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId);
  must(r.rows === 0 && r.key === null && b.puts.length === 0, "an empty pass wrote something");
});

await check("a put that fails moves nothing: the rows stay and the next pass sends them", async () => {
  const host = sqliteHost(); const b = bucket();
  appendTrace(host.sql, [row(1), row(2)]);
  b.failNext();
  let threw = false;
  try { await flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId); } catch { threw = true; }
  must(threw, "the failure was swallowed");
  must(cursor(host.sql) === 0 && left(host.sql) === 2, "a failed put moved the cursor or lost rows");
  const r = await flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId);
  must(r.rows === 2 && b.puts.length === 1 && b.puts[0]!.key === "trace/t1/a1/1-2.ndjson", "the next pass did not send them");
});

await check("a put that landed but whose cursor was never written is replayed as the same key and bytes", async () => {
  const host = sqliteHost(); const b = bucket();
  appendTrace(host.sql, [row(1), row(2)]);
  await flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId);
  // The eviction between put and cursor: undo what came after the put.
  const first = b.puts[0]!;
  host.sql.exec("DELETE FROM trace_sent");
  appendTrace(host.sql, [row(1), row(2)]); // the rows, as they were before the prune
  host.sql.exec("UPDATE trace_outbox SET seq = seq - 2"); // same seqs as the first time
  await flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId);
  must(b.puts.length === 2, `expected a replay, got ${b.puts.length} puts`);
  must(b.puts[1]!.key === first.key && b.puts[1]!.body === first.body, "the replay differed from the first write");
});

await check("a row the outbox refused is warned about, written down, and does not stop the good rows", async () => {
  const host = sqliteHost(); const b = bucket();
  appendTrace(host.sql, [row(1)]);
  host.sql.exec("INSERT INTO trace_outbox(at, tenant_id, agent_id, kind, span_id, parent_id, status, verdict, ms, attrs) VALUES (?,?,?,?,?,?,?,?,?,?)",
    1, "t1", "a1", "not.a.kind", "x", null, "s", "ok", null, "{}");
  appendTrace(host.sql, [row(3)]);
  const { out, warned } = await quiet(() => flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId, 500, () => 42));
  must(out.rows === 2 && out.dropped === 1, `flush said ${JSON.stringify(out)}`);
  must(warned.length === 1 && /1 row\(s\)/.test(warned[0]!), `warned: ${JSON.stringify(warned)}`);
  const d = drops(host.sql);
  must(d.length === 1 && Number(d[0].dropped) === 1 && Number(d[0].at) === 42, `trace_drops ${JSON.stringify(d)}`);
  must(b.puts.length === 1 && b.puts[0]!.key === "trace/t1/a1/1-3.ndjson", "the good rows were not written");
  must(cursor(host.sql) === 3 && left(host.sql) === 0, "the dropped row was left behind to be dropped again");
});

await check("a batch that is only refused rows still moves the cursor past them", async () => {
  const host = sqliteHost(); const b = bucket(); ensureTraceOutbox(host.sql);
  host.sql.exec("INSERT INTO trace_outbox(at, tenant_id, agent_id, kind, span_id, parent_id, status, verdict, ms, attrs) VALUES (?,?,?,?,?,?,?,?,?,?)",
    1, "t1", "a1", "not.a.kind", "x", null, "s", "ok", null, "{}");
  const { out } = await quiet(() => flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId));
  must(out.rows === 0 && out.dropped === 1 && b.puts.length === 0, `flush said ${JSON.stringify(out)}`);
  must(cursor(host.sql) === 1 && left(host.sql) === 0, "a refused-only batch would be read and warned about for ever");
  const again = await quiet(() => flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId));
  must(again.out.dropped === 0 && again.warned.length === 0, "the same refused row was warned about twice");
});

await check("a pass takes at most the limit; the rest wait for the next", async () => {
  const host = sqliteHost(); const b = bucket();
  appendTrace(host.sql, Array.from({ length: 7 }, (_, i) => row(i + 1)));
  const r1 = await flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId, 5);
  must(r1.rows === 5 && r1.key === "trace/t1/a1/1-5.ndjson" && cursor(host.sql) === 5 && left(host.sql) === 2, `first pass ${JSON.stringify(r1)}`);
  const r2 = await flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId, 5);
  must(r2.rows === 2 && r2.key === "trace/t1/a1/6-7.ndjson" && cursor(host.sql) === 7 && left(host.sql) === 0, `second pass ${JSON.stringify(r2)}`);
});

await check("the record of drops has a horizon: a put that keeps failing does not grow it for ever", async () => {
  const host = sqliteHost(); const b = bucket(); ensureTraceOutbox(host.sql);
  const bad = () => host.sql.exec("INSERT INTO trace_outbox(at, tenant_id, agent_id, kind, span_id, parent_id, status, verdict, ms, attrs) VALUES (?,?,?,?,?,?,?,?,?,?)",
    1, "t1", "a1", "not.a.kind", "x", null, "s", "ok", null, "{}");
  const t0 = 1_700_000_000_000;
  bad(); await quiet(() => flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId, 500, () => t0));
  bad(); await quiet(() => flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId, 500, () => t0 + 1000));
  must(drops(host.sql).length === 2, "two passes, two lines expected");
  // A pass beyond the horizon of BOTH earlier lines keeps only its own.
  const late = t0 + 1000 + TRACE_DROPS_KEEP_MS + 1;
  bad(); await quiet(() => flushTrace(b, host.sql, OWNER.tenantId, OWNER.agentId, 500, () => late));
  const d = drops(host.sql);
  must(d.length === 1 && Number(d[0].at) === late, `lines older than the horizon survived: ${JSON.stringify(d)}`);
});

await check("a trace key is not an artifact reference and never sits in an agent's artifact scope", async () => {
  const key = traceKey("t1", "a1", 1, 3);
  must(!key.startsWith("r2://") && !key.includes("r2://"), "the key looks like a reference");
  must(!key.startsWith("t/t1/a1/") && key.startsWith("trace/"), `the key ${key} sits where artifacts live`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
