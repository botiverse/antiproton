/**
 * The agent's status changes (src/runtime/status.ts), derived by the runtime from
 * its own trace rows: which rows mean which status, starts dated back by the
 * span's measured time, and only transitions sent.
 */
import { statusEvents } from "../src/runtime/status.ts";
import type { TraceOutboxRow } from "../src/trace/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const T = 1_790_000_000_000;
const row = (seq: number, at: number, kind: TraceOutboxRow["kind"], status: string, ms?: number): TraceOutboxRow =>
  ({ seq, at: T + at, tenantId: "t", agentId: "a", kind, spanId: `s${seq}`, status, verdict: "ok", ...(ms === undefined ? {} : { ms }), attrs: {} }) as TraceOutboxRow;
const seq = (evs: ReturnType<typeof statusEvents>) => evs.map((e) => `${e.status}@${Date.parse(e.occurredAt) - T}`).join(" ");

check("one turn with a tool: thinking when the message lands, working while tools run, online when it is answered", () => {
  const evs = statusEvents("a", [
    row(1, 0, "inbound", "delivered"),
    row(2, 1_000, "model.call", "toolUse", 900),   // asked for a tool
    row(3, 1_500, "tool.call", "succeeded", 400),  // the tool ran 1100..1500
    row(4, 3_000, "model.call", "stop", 1_400),    // the final answer, called at 1600
  ]);
  must(seq(evs) === "thinking@0 working@1000 thinking@1600 online@3000", seq(evs));
});

check("a start is dated back by the span's measured time, and events come out in time order", () => {
  const evs = statusEvents("a", [row(1, 5_000, "model.call", "stop", 4_000)]);
  must(seq(evs) === "thinking@1000 online@5000", seq(evs));
});

check("only transitions: a status already in force is not sent again, including the one before this batch", () => {
  const evs = statusEvents("a", [
    row(1, 1_000, "tool.call", "succeeded", 100),
    row(2, 2_000, "tool.call", "succeeded", 100),
  ], "working");
  must(evs.length === 0, `repeated working was sent: ${seq(evs)}`);
});

check("a model call that failed is error; one that was cancelled ends the turn as online; rows that say nothing say nothing", () => {
  must(seq(statusEvents("a", [row(1, 100, "model.call", "error", 50)])) === "thinking@50 error@100", "error");
  must(seq(statusEvents("a", [row(1, 100, "model.call", "aborted", 50)])) === "thinking@50 online@100", "aborted");
  must(statusEvents("a", [row(1, 100, "inbound", "rejected"), row(2, 200, "lease" as TraceOutboxRow["kind"], "released")]).length === 0, "silent rows");
});

check("event ids are unique per row and per start, so a resend is deduped and never collides", () => {
  const evs = statusEvents("a", [row(7, 1_000, "model.call", "toolUse", 500), row(8, 2_000, "model.call", "stop", 500)]);
  const ids = evs.map((e) => e.eventId);
  must(new Set(ids).size === ids.length && ids.every((id) => id.startsWith("a:")), JSON.stringify(ids));
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
