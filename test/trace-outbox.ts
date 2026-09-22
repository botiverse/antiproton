/**
 * trace_outbox: the export shape of what happened, one row per ended span.
 *
 * The inputs that matter: rows come back oldest-first and prune forgets
 * them; seq is monotone and never reused (a row's identity downstream is
 * (tenant, agent, seq), so a reused seq would make a retry indistinguishable
 * from new work); fields and attrs are bounded so a strange tool name or a
 * runaway payload cannot bloat the table; and the columns are the settled
 * set — span_id, not id, because the column holds another table's id.
 */
import { appendTrace, ensureTraceOutbox, pendingTrace, pruneTrace, TRACE_ATTRS_MAX, TRACE_FIELD_MAX, type TraceRow } from "../src/trace/outbox.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const eq = (got: unknown, want: unknown, msg: string) =>
  must(JSON.stringify(got) === JSON.stringify(want), `${msg}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

const base = { tenantId: "t", agentId: "a" };
const T0 = Date.parse("2026-09-22T10:00:00Z");
const row = (over: Partial<TraceRow> = {}): TraceRow => ({
  ...base, at: T0 + 60_000, kind: "tool.call", spanId: "op_1", status: "succeeded", verdict: "ok", attrs: { tool: "github.issue_list" }, ...over,
});

check("the table has exactly the settled columns — span_id, not id; status and verdict both", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  const cols = (host.sql.exec("PRAGMA table_info(trace_outbox)").toArray() as any[]).map((r) => String(r.name));
  eq(cols, ["seq", "at", "tenant_id", "agent_id", "kind", "span_id", "parent_id", "status", "verdict", "ms", "attrs"], cols.join(","));
});

check("append hands back what was written, oldest first, and prune forgets it", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  appendTrace(host.sql, [row({ spanId: "op_1" }), row({ spanId: "op_2", at: T0 + 120_000, kind: "model.call", status: "stop", verdict: "ok" })]);
  const pending = pendingTrace(host.sql, 0);
  eq(pending.map((r) => [r.spanId, r.kind, r.status]), [["op_1", "tool.call", "succeeded"], ["op_2", "model.call", "stop"]], "in write order");
  eq(pending[0].attrs, { tool: "github.issue_list" }, "attrs round-trip as an object");
  pruneTrace(host.sql, pending[0].seq);
  eq(pendingTrace(host.sql, 0).map((r) => r.spanId), ["op_2"], "the pruned row is gone");
});

check("seq is monotone and never reused, so a retry can be told from new work", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  appendTrace(host.sql, [row({ spanId: "op_1" })]);
  const first = pendingTrace(host.sql, 0).at(-1)!.seq;
  pruneTrace(host.sql, first);
  appendTrace(host.sql, [row({ spanId: "op_2" })]);
  const second = pendingTrace(host.sql, 0).at(-1)!.seq;
  must(second > first, `seq moved forward: ${second} after pruning ${first}`);
});

check("fields are truncated at the documented bound so a strange name cannot bloat the table", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  const long = "x".repeat(TRACE_FIELD_MAX * 2);
  appendTrace(host.sql, [row({ spanId: long, status: long })]);
  const [got] = pendingTrace(host.sql, 0);
  eq(got.spanId.length, TRACE_FIELD_MAX, "span_id cut");
  eq(got.status.length, TRACE_FIELD_MAX, "status cut");
});

check("attrs drop whole keys to fit, and say so, rather than cutting mid-string into unparseable JSON", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  // Last-in drops first, so a seam writes the facts it cares about first.
  const big = { keep: "small", a: "y".repeat(TRACE_ATTRS_MAX), b: "z".repeat(TRACE_ATTRS_MAX) };
  appendTrace(host.sql, [row({ attrs: big })]);
  const [got] = pendingTrace(host.sql, 0);
  const raw = got.attrs;
  must(JSON.stringify(raw).length <= TRACE_ATTRS_MAX, `serialized attrs fit: ${JSON.stringify(raw).length}`);
  eq(raw.keep, "small", "what fits survives");
  eq(raw.truncated, true, "and the cut is announced, not silent");
});

check("a row without its join key is an orphan by definition and is dropped, not stored", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  appendTrace(host.sql, [row({ spanId: "" }), row({ spanId: "op_1" }), row({ kind: undefined as any })]);
  eq(pendingTrace(host.sql, 0).map((r) => r.spanId), ["op_1"], "only the joinable row landed");
  appendTrace(host.sql, [row({ at: NaN })]);
  eq(pendingTrace(host.sql, 0).length, 1, "and a row without a time is not a span");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
