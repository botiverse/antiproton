/** The trace-row → activity-event mapping (src/runtime/activity.ts): what each row kind becomes, and nothing the service does not know. */
import { activityEvents, ACTIVITY_BATCH_MAX, orderStatuses } from "../src/runtime/activity.ts";
import type { TraceOutboxRow } from "../src/trace/outbox.ts";
import { PROVISION_TASK } from "../src/runtime/status.ts";

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
  const ev = activityEvents("raft_a", [row(5, "tool.call", "succeeded", "ok", { ms: 2500, attrs: { tool: "messages_send", mount: "raft" } })]);
  must(ev.length === 2, JSON.stringify(ev));
  const [pre, post] = ev;
  must(pre!.hookEventName === "PreToolUse" && pre!.eventId === "raft_a:5:pre" && pre!.toolName === "raft__messages_send" && pre!.occurredAt === new Date(T0 + 5000 - 2500).toISOString(), JSON.stringify(pre));
  must(post!.hookEventName === "PostToolUse" && post!.eventId === "raft_a:5" && post!.durationMs === 2500 && post!.errorClass === undefined && post!.occurredAt === new Date(T0 + 5000).toISOString(), JSON.stringify(post));
});

check("both events of a tool call carry the operation id as toolUseId, and two calls never share one, even under one model call id", () => {
  const ev = activityEvents("raft_a", [
    row(40, "tool.call", "succeeded", "ok", { spanId: "op_a", ms: 5, attrs: { tool: "go", mount: "m", callId: "toolu_1" } }),
    row(41, "tool.call", "succeeded", "ok", { spanId: "op_b", ms: 5, attrs: { tool: "go", mount: "m", callId: "toolu_1" } }),
  ]);
  must(ev.map((e) => e.toolUseId).join(",") === "op_a,op_a,op_b,op_b", JSON.stringify(ev));
  must(ev[0]!.hookEventName === "PreToolUse" && ev[1]!.hookEventName === "PostToolUse", JSON.stringify(ev));
});

check("a command's exit status rides its end, a non-zero exit with ok true; a tool with no command has no exitCode key", () => {
  const [, shell] = activityEvents("raft_a", [row(42, "tool.call", "succeeded", "ok", { ms: 30, attrs: { tool: "shell", mount: "sandbox", exitCode: 2 } })]);
  must(shell!.hookEventName === "PostToolUse" && shell!.ok === true && shell!.exitCode === 2, JSON.stringify(shell));
  const [pre, other] = activityEvents("raft_a", [row(43, "tool.call", "succeeded", "ok", { ms: 30, attrs: { tool: "messages_send", mount: "raft" } })]);
  must(!("exitCode" in other!) && !("exitCode" in pre!) && !("ok" in pre!), `${JSON.stringify(pre)} ${JSON.stringify(other)}`);
});

check("ok is true for succeeded, false for failed and rejected, and an explicit null for unknown and cancelled", () => {
  const want = { succeeded: "true", failed: "false", rejected: "false", unknown: "null", cancelled: "null" } as const;
  const verdicts = { succeeded: "ok", failed: "failed", rejected: "blocked", unknown: "failed", cancelled: "cancelled" } as const;
  for (const status of Object.keys(want) as Array<keyof typeof want>) {
    const [, end] = activityEvents("raft_a", [row(44, "tool.call", status, verdicts[status], { ms: 1, attrs: { tool: "t", mount: "m" } })]);
    must(JSON.stringify(end!.ok) === want[status] && "ok" in end!, `${status}: ${JSON.stringify(end)}`);
    // On the wire: a null is sent, not dropped.
    must(JSON.stringify(end).includes(`"ok":${want[status]}`), `${status} on the wire: ${JSON.stringify(end)}`);
  }
});

check("a held call a person denied is ok false; a cancel with no denial on the row stays null", () => {
  const [, denied] = activityEvents("raft_a", [row(47, "tool.call", "cancelled", "cancelled", { ms: 1, attrs: { tool: "zap", mount: "m", denied: true } })]);
  must(denied!.hookEventName === "PostToolUseFailure" && denied!.ok === false, `denied: ${JSON.stringify(denied)}`);
  const [, cancelled] = activityEvents("raft_a", [row(48, "tool.call", "cancelled", "cancelled", { ms: 1, attrs: { tool: "zap", mount: "m" } })]);
  must("ok" in cancelled! && cancelled!.ok === null, `plain cancel: ${JSON.stringify(cancelled)}`);
});

check("durationMs is how long the tool ran (runMs) when the row says it, so an approval wait is not in it; the start stays at the request", () => {
  const [pre, post] = activityEvents("raft_a", [row(45, "tool.call", "succeeded", "ok", { ms: 60_000, attrs: { tool: "zap", mount: "m", runMs: 1_200 } })]);
  must(post!.durationMs === 1_200, `durationMs ${post!.durationMs}`);
  must(pre!.occurredAt === new Date(T0 + 45_000 - 60_000).toISOString(), `the start moved: ${pre!.occurredAt}`);
  const [, old] = activityEvents("raft_a", [row(46, "tool.call", "succeeded", "ok", { ms: 700, attrs: { tool: "zap", mount: "m" } })]);
  must(old!.durationMs === 700, `without runMs: ${old!.durationMs}`);
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
  const allowed = new Set(["eventId", "hookEventName", "occurredAt", "toolName", "toolUseId", "durationMs", "exitCode", "ok", "errorClass", "status", "detail"]);
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
    { ...row(30, "tool.call", "succeeded", "ok", { ms: 195, attrs: { tool: "messages_send", mount: "raft" } }), seq: 301, at: T0 + 30_200 },
    row(31, "model.call", "stop", "ok", { ms: 700 }),
  ]);
  const pre = ev.find((e) => e.hookEventName === "PreToolUse");
  must(pre?.status === "working" && pre.detail === "Using raft__messages_send", JSON.stringify(pre));
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
/**
 * The trace of a hosted agent Raft made with `awaitImport` (staging, 2026-10-13), as its outbox held it: the seeded
 * mounts, the provider's enable_push, the harness opened for the prewarm, the import lifting the hold, the prewarm.
 * Raft showed it "working" from the enable_push on, and since it was never woken it stayed so.
 */
const CINDY: TraceOutboxRow[] = [
  {"seq":1,"at":1791998439624,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"mount.seeded","spanId":"tools@1","status":"added","verdict":"ok","attrs":{"alias":"tools","plugin":"tools","since":1,"outcome":"added","reason":null,"notice":"first tools"}},
  {"seq":2,"at":1791998439624,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"mount.seeded","spanId":"artifacts@1","status":"added","verdict":"ok","attrs":{"alias":"artifacts","plugin":"artifacts","since":1,"outcome":"added","reason":null,"notice":"first tools"}},
  {"seq":3,"at":1791998439624,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"mount.seeded","spanId":"web@1","status":"added","verdict":"ok","attrs":{"alias":"web","plugin":"http","since":1,"outcome":"added","reason":null,"notice":"first tools"}},
  {"seq":4,"at":1791998439624,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"mount.seeded","spanId":"search@1","status":"added","verdict":"ok","attrs":{"alias":"search","plugin":"exa","since":1,"outcome":"added","reason":null,"notice":"first tools"}},
  {"seq":5,"at":1791998439624,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"mount.seeded","spanId":"gh@1","status":"added","verdict":"ok","attrs":{"alias":"gh","plugin":"github","since":1,"outcome":"added","reason":null,"notice":"first tools"}},
  {"seq":6,"at":1791998439624,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"mount.seeded","spanId":"sandbox@1","status":"added","verdict":"ok","attrs":{"alias":"sandbox","plugin":"sandbox","since":1,"outcome":"added","reason":null,"notice":"first tools"}},
  {"seq":7,"at":1791998439624,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"mount.seeded","spanId":"state@1","status":"added","verdict":"ok","attrs":{"alias":"state","plugin":"state","since":1,"outcome":"added","reason":null,"notice":"first tools"}},
  {"seq":8,"at":1791998439624,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"mount.seeded","spanId":"reminder@2","status":"not-for","verdict":"ok","attrs":{"alias":"reminder","plugin":"reminder","since":2,"outcome":"not-for","reason":"for console agents; this one is raft"}},
  {"seq":9,"at":1791998443791,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"tool.call","spanId":"op_467345f4bef14202943f","status":"succeeded","verdict":"ok","ms":1801,"attrs":{"tool":"raft.enable_push","mount":"raft","task":"provision"}},
  {"seq":10,"at":1791998444624,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"harness.open","spanId":"[redacted]#main@1791998444624","status":"cold-start","verdict":"ok","ms":0,"attrs":{"reason":"cold-start","cause":"first","changed":[],"engine":"pi085","session":"main","conversation":"main","systemSha256":"6b6f049f51286f47021283edb62fe7111dc8fd5187c1469fc783c38e073128b2","toolsSha256":"57a601c46061e4326350b27745fe1085c7cad3b607db632b59938f9e0bb78e18","tools":111,"prevAgeMs":null,"version":"a33a71d3-7049-4ac6-b330-50ccc98e80f1"}},
  {"seq":11,"at":1791998444962,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"import.hold","spanId":"[redacted]","status":"import","verdict":"ok","ms":5338,"attrs":{"reason":"the workspace import landed"}},
  {"seq":12,"at":1791998449541,"tenantId":"raft_ac44861c-3d98-48c2-85e8-002f9c006602","agentId":"raft_a58cbdb2-d7ea-4b94-b869-1ae51e255f07","kind":"model.prewarm","spanId":"[redacted]","status":"warmed","verdict":"ok","ms":1439,"attrs":{"outcome":"warmed","model":"deepseek-flash","inputTokens":23290,"cacheReadTokens":0,"outputTokens":1}},
];
const CINDY_AGENT = CINDY[0]!.agentId;

check("a provisioned agent's own trace before any turn (real rows) says nothing: the provider's enable_push is not the agent working", () => {
  const ev = activityEvents(CINDY_AGENT, CINDY);
  must(ev.length === 0, JSON.stringify(ev));
});

check("the same rows with the ready row the runtime writes when the import lands: one event, a status-only online", () => {
  const lifted = CINDY.find((r) => r.kind === "import.hold")!;
  const ready: TraceOutboxRow = { seq: 13, at: lifted.at, tenantId: lifted.tenantId, agentId: CINDY_AGENT, kind: "agent.ready",
    spanId: `ready_${CINDY_AGENT}`, status: "ready", verdict: "ok", attrs: { reason: "the workspace import landed" } };
  const ev = activityEvents(CINDY_AGENT, [...CINDY, ready]);
  must(ev.length === 1 && ev[0]!.status === "online" && ev[0]!.hookEventName === undefined && ev[0]!.eventId === `${CINDY_AGENT}:13:status`
    && ev[0]!.occurredAt === new Date(lifted.at).toISOString(), JSON.stringify(ev));
});

check("the agent's own tool call is still working, and the same call run under the provider's task is not", () => {
  const own = row(5, "tool.call", "succeeded", "ok", { ms: 100, attrs: { tool: "enable_push", mount: "raft", task: "main" } });
  const ev = activityEvents("raft_a", [own]);
  must(ev.length === 2 && ev[0]!.hookEventName === "PreToolUse" && ev[0]!.status === "working", JSON.stringify(ev));
  must(activityEvents("raft_a", [{ ...own, attrs: { ...own.attrs, task: PROVISION_TASK } }]).length === 0, "the provider's call was reported");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
