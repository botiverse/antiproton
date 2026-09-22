/**
 * trace_outbox: the export shape of what happened, one row per ended span.
 *
 * The inputs that matter: rows come back oldest-first and prune forgets
 * them; seq is monotone and never reused (a row's identity downstream is
 * (tenant, agent, seq), so a reused seq would make a retry indistinguishable
 * from new work); fields and attrs are bounded so a strange tool name or a
 * runaway payload cannot bloat the table; the columns are the settled set —
 * span_id, not id, because the column holds another table's id; and the
 * vocabulary is the contract, checked at write and again at read, because
 * the drain dispatches on it and a wrong value would not redden there.
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
  eq(pending.dropped, 0, "nothing dropped");
  eq(pending.rows.map((r) => [r.spanId, r.kind, r.status]), [["op_1", "tool.call", "succeeded"], ["op_2", "model.call", "stop"]], "in write order");
  eq(pending.rows[0].attrs, { tool: "github.issue_list" }, "attrs round-trip as an object");
  pruneTrace(host.sql, pending.rows[0].seq);
  eq(pendingTrace(host.sql, 0).rows.map((r) => r.spanId), ["op_2"], "the pruned row is gone");
});

check("seq is monotone and never reused, so a retry can be told from new work", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  appendTrace(host.sql, [row({ spanId: "op_1" })]);
  const first = pendingTrace(host.sql, 0).rows.at(-1)!.seq;
  pruneTrace(host.sql, first);
  appendTrace(host.sql, [row({ spanId: "op_2" })]);
  const second = pendingTrace(host.sql, 0).rows.at(-1)!.seq;
  must(second > first, `seq moved forward: ${second} after pruning ${first}`);
});

check("fields are truncated at the documented bound so a strange name cannot bloat the table", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  const long = "x".repeat(TRACE_FIELD_MAX * 2);
  appendTrace(host.sql, [row({ spanId: long, status: long })]);
  const [got] = pendingTrace(host.sql, 0).rows;
  eq(got.spanId.length, TRACE_FIELD_MAX, "span_id cut");
  eq(got.status.length, TRACE_FIELD_MAX, "status cut");
});

check("attrs drop whole keys to fit, and say so, rather than cutting mid-string into unparseable JSON", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  // Last-in drops first, so a seam writes the facts it cares about first.
  const big = { keep: "small", a: "y".repeat(TRACE_ATTRS_MAX), b: "z".repeat(TRACE_ATTRS_MAX) };
  appendTrace(host.sql, [row({ attrs: big })]);
  const [got] = pendingTrace(host.sql, 0).rows;
  const raw = got.attrs;
  must(JSON.stringify(raw).length <= TRACE_ATTRS_MAX, `serialized attrs fit: ${JSON.stringify(raw).length}`);
  eq(raw.keep, "small", "what fits survives");
  eq(raw.truncated, true, "and the cut is announced, not silent");
});

check("a row without its join key is an orphan by definition and is dropped, not stored", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  appendTrace(host.sql, [row({ spanId: "" }), row({ spanId: "op_1" }), row({ kind: undefined as any })]);
  eq(pendingTrace(host.sql, 0).rows.map((r) => r.spanId), ["op_1"], "only the joinable row landed");
  appendTrace(host.sql, [row({ at: NaN })]);
  eq(pendingTrace(host.sql, 0).rows.length, 1, "and a row without a time is not a span");
});

check("vocabulary is the contract: a kind the drain cannot dispatch on is dropped at write", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  appendTrace(host.sql, [row({ kind: "bogus.kind" as any }), row({ verdict: "weird" as any }), row({ spanId: "op_1" })]);
  // The table itself, not the read-side filter: this check pins that a
  // wrong-vocabulary row never enters storage, so the two guards are
  // independent — read-side filtering cannot mask a missing write-side drop.
  const stored = host.sql.exec("SELECT kind, span_id FROM trace_outbox ORDER BY seq").toArray() as any[];
  eq(stored.map((r) => [r.kind, r.span_id]), [["tool.call", "op_1"]], "the wrong-vocabulary rows never landed");
});

check("and at read: a corrupted row is counted, not passed through as a valid type", () => {
  const host = sqliteHost();
  ensureTraceOutbox(host.sql);
  appendTrace(host.sql, [row({ spanId: "op_1" })]);
  host.sql.exec("UPDATE trace_outbox SET kind = 'bogus.kind'");
  let pending = pendingTrace(host.sql, 0);
  eq(pending.rows.length, 0, "the corrupted row is not handed to the drain as a TraceKind");
  eq(pending.dropped, 1, "it is counted, so the leniency is not silent");
  host.sql.exec("UPDATE trace_outbox SET kind = 'tool.call', attrs = '\"just a string\"'");
  pending = pendingTrace(host.sql, 0);
  eq(pending.rows.length, 1, "the row is back once its vocabulary is");
  eq(pending.rows[0].attrs, { unparseable: true }, "and a parseable-but-wrong-shaped attrs is the same one shape of damage");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
