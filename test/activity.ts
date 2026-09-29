/** The trace-row → activity-event mapping (src/runtime/activity.ts): what each row kind becomes, and nothing the service does not know. */
import { activityEvents, ACTIVITY_BATCH_MAX, orderStatuses } from "../src/runtime/activity.ts";
import type { TraceOutboxRow } from "../src/trace/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const T0 = 1_790_000_000_000;
const row = (seq: number, kind: TraceOutboxRow["kind"], status: string, verdict: TraceOutboxRow["verdict"], extra: Partial<TraceOutboxRow> = {}): TraceOutboxRow =>
  ({ seq, at: T0 + seq * 1000, tenantId: "t", agentId: "raft_a", kind, spanId: `s${seq}`, status, verdict, attrs: {}, ...extra });

check("a delivered inbound row is the message that starts the turn; other inbound outcomes are not", () => {
  const ev = activityEvents("raft_a", [row(1, "inbound", "delivered", "ok"), row(2, "inbound", "duplicate", "ok"), row(3, "inbound", "rejected", "blocked")]);
  must(ev.length === 1 && ev[0]!.hookEventName === "UserPromptSubmit" && ev[0]!.eventId === "raft_a:1" && ev[0]!.occurredAt === new Date(T0 + 1000).toISOString(), JSON.stringify(ev));
});

check("a tool row is two events: the call dated its start and the result dated its end, named as the model names the tool", () => {
  const ev = activityEvents("raft_a", [row(5, "tool.call", "succeeded", "ok", { ms: 2500, attrs: { tool: "send_message", mount: "raft" } })]);
  must(ev.length === 2, JSON.stringify(ev));
  const [pre, post] = ev;
  must(pre!.hookEventName === "PreToolUse" && pre!.eventId === "raft_a:5:pre" && pre!.toolName === "raft__send_message" && pre!.occurredAt === new Date(T0 + 5000 - 2500).toISOString(), JSON.stringify(pre));
  must(post!.hookEventName === "PostToolUse" && post!.eventId === "raft_a:5" && post!.durationMs === 2500 && post!.errorClass === undefined && post!.occurredAt === new Date(T0 + 5000).toISOString(), JSON.stringify(post));
});

check("a tool row that did not succeed is a failure carrying the status as its class", () => {
  for (const [status, verdict] of [["failed", "failed"], ["rejected", "blocked"], ["cancelled", "cancelled"]] as const) {
    const ev = activityEvents("raft_a", [row(7, "tool.call", status, verdict, { ms: 10, attrs: { tool: "run", mount: "sandbox" } })]);
    must(ev[1]!.hookEventName === "PostToolUseFailure" && ev[1]!.errorClass === status && ev[1]!.toolName === "sandbox__run", `${status}: ${JSON.stringify(ev)}`);
  }
});

check("a model row ends the turn on stop, length and aborted, dies on error, and says nothing while it asked for tools", () => {
  const ev = activityEvents("raft_a", [
    row(10, "model.call", "toolUse", "ok"), row(11, "model.call", "stop", "ok"), row(12, "model.call", "length", "ok"),
    row(13, "model.call", "aborted", "cancelled"), row(14, "model.call", "error", "failed"),
  ]);
  const hooks = ev.filter((e) => e.hookEventName);
  must(hooks.map((e) => `${e.eventId}=${e.hookEventName}`).join(",") === "raft_a:11=Stop,raft_a:12=Stop,raft_a:13=Stop,raft_a:14=BridgeFatal", JSON.stringify(ev));
  must(hooks[3]!.errorClass === "model_call_failed", JSON.stringify(hooks[3]));
  // The status after each: the tool-use answer is a status-only working, the first stop turns online
  // (the later stops repeat it and say nothing new), the error is error.
  must(ev.map((e) => `${e.hookEventName ?? "-"}:${e.status ?? ""}`).join(",") === "Stop:online,Stop:,Stop:,BridgeFatal:error,-:working", JSON.stringify(ev));
});

check("approval and container rows are not the service's business", () => {
  must(activityEvents("raft_a", [row(20, "approval.wait", "approved", "ok"), row(21, "container.lease", "released", "ok")]).length === 0, "something was emitted");
});

check("every event carries only fields the service knows, ids are unique, and two batches never exceed the request limit", () => {
  const rows: TraceOutboxRow[] = [];
  for (let i = 1; i <= ACTIVITY_BATCH_MAX; i++) rows.push(row(i, "tool.call", "succeeded", "ok", { ms: 1, attrs: { tool: "t", mount: "m" } }));
  const ev = activityEvents("raft_a", rows);
  must(ev.length === 2 * ACTIVITY_BATCH_MAX && ev.length <= 200, `events ${ev.length}`);
  must(new Set(ev.map((e) => e.eventId)).size === ev.length, "duplicate event ids");
  const allowed = new Set(["eventId", "hookEventName", "occurredAt", "toolName", "durationMs", "errorClass", "status", "detail"]);
  for (const e of ev) for (const k of Object.keys(e)) must(allowed.has(k), `unknown field ${k}`);
  // The worst case for status-only events: every row a measured model call that asked for tools, each a
  // thinking start and a working end with no activity event to ride on.
  const models: TraceOutboxRow[] = [];
  for (let i = 1; i <= ACTIVITY_BATCH_MAX; i++) models.push(row(i, "model.call", "toolUse", "ok", { ms: 100 }));
  const worst = activityEvents("raft_a", models);
  must(worst.length <= 200 && worst.every((e) => e.status && !e.hookEventName), `worst-case batch: ${worst.length}`);
});

check("in a real turn the tool call says which tool it is working on, on the PreToolUse; other statuses carry no detail", () => {
  // The model asks for a tool (answer at 30s), the tool runs 30.005–30.2s, the model answers (stop at 31s).
  const ev = activityEvents("raft_a", [
    row(30, "model.call", "toolUse", "ok", { ms: 800 }),
    { ...row(30, "tool.call", "succeeded", "ok", { ms: 195, attrs: { tool: "send_message", mount: "raft" } }), seq: 301, at: T0 + 30_200 },
    row(31, "model.call", "stop", "ok", { ms: 700 }),
  ]);
  const pre = ev.find((e) => e.hookEventName === "PreToolUse");
  must(pre?.status === "working" && pre.detail === "Using raft__send_message", JSON.stringify(pre));
  must(ev.filter((e) => e.detail !== undefined).length === 1, `detail on other events: ${JSON.stringify(ev)}`);
});

check("a status earlier than the last one sent keeps its date and does not move the clock; one at the same instant moves by 1 ms", () => {
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const older = [{ eventId: "a", occurredAt: at(90), status: "working" as const }];
  must(orderStatuses(older, T0 + 100) === T0 + 100 && older[0]!.occurredAt === at(90), `moved: ${JSON.stringify(older)}`);
  const tied = [{ eventId: "b", occurredAt: at(100), status: "online" as const }, { eventId: "c", occurredAt: at(100), hookEventName: "Stop" as const }];
  must(orderStatuses(tied, T0 + 100) === T0 + 101 && tied[0]!.occurredAt === at(101) && tied[1]!.occurredAt === at(100), `tie: ${JSON.stringify(tied)}`);
});

console.log(`\n  activity mapping\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
