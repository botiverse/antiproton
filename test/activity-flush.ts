/**
 * The activity drain (cf/src/activity-raft.ts) on a real SQLite outbox with a
 * recording gateway: the cursor moves only on a send that returned, a throw
 * keeps the rows, a skipping service still advances, the trace export prunes
 * only through what both readers consumed.
 */
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { appendTrace, type TraceRow } from "../src/trace/outbox.ts";
import { flushActivity, activityCursor, flushActivityThenTrace } from "../cf/src/activity-raft.ts";
import { flushTrace } from "../cf/src/trace-r2.ts";
import { Backgrounded, interrupt, type ActivityEvent, type Plugin } from "../src/plugins/types.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { recordBackgroundJob, runBackgroundPass, stopSessionJobs } from "../src/runtime/background-jobs.ts";
import { pendingTrace } from "../src/trace/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const OWNER = { tenantId: "t1", agentId: "raft_a1" };
const tool = (n: number): TraceRow => ({ at: 1_790_000_000_000 + n * 1000, ...OWNER, kind: "tool.call", spanId: `op_${n}`, status: "succeeded", verdict: "ok", ms: 5, attrs: { tool: "messages_send", mount: "raft" } });
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

await check("the alarm's order: a failing activity send holds the export at its unmoved cursor, so the next pass still finds and sends the rows", async () => {
  const { sql } = sqliteHost();
  const bucket = { async put() {} };
  appendTrace(sql, [tool(1), answered(2)]);
  const g = gateway("throw");
  const first = await flushActivityThenTrace(g, bucket, sql, OWNER.tenantId, OWNER.agentId);
  must(first.activityError !== null && /unreachable/.test(first.activityError) && first.traceError === null, JSON.stringify(first));
  must(left(sql) === 2 && activityCursor(sql) === 0, `rows left ${left(sql)} cursor ${activityCursor(sql)}`);
  g.mode = "send";
  const second = await flushActivityThenTrace(g, bucket, sql, OWNER.tenantId, OWNER.agentId);
  must(second.activityError === null && g.batches.length === 1 && g.batches[0]!.length === 3, JSON.stringify({ second, batches: g.batches.length }));
  must(left(sql) === 0 && activityCursor(sql) === 2, `rows left ${left(sql)} cursor ${activityCursor(sql)}`);
  // A failing export is reported the same way and keeps its own rows.
  appendTrace(sql, [tool(3)]);
  const failing = { async put() { throw new Error("r2 unavailable"); } };
  const third = await flushActivityThenTrace(g, failing, sql, OWNER.tenantId, OWNER.agentId);
  must(third.activityError === null && /r2 unavailable/.test(third.traceError ?? "") && left(sql) === 1, JSON.stringify({ third, left: left(sql) }));
});

console.log(`\n  activity flush\n  ${"─".repeat(56)}`);
await check("status rides the activity log: it goes out on the events, and a failed send holds it with them and resends it", async () => {
  const { sql } = sqliteHost(); const g = gateway("throw");
  appendTrace(sql, [tool(1), answered(2)]);
  try { await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId); } catch { /* held */ }
  must(activityCursor(sql) === 0, "a failed send moved the cursor");
  g.mode = "send";
  await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId);
  const statuses = g.batches[0]!.filter((e) => e.status).map((e) => `${e.hookEventName ?? "-"}:${e.status}`);
  must(statuses.join(",") === "PreToolUse:working,Stop:online", `statuses on the resent batch: ${JSON.stringify(g.batches[0])}`);
});

await check("statuses go out strictly later than the one before, across passes too, and a resent batch is dated the same", async () => {
  // As read on production 2026-09-29: the model asks for a tool at X and the tool takes 0 ms, so its
  // start is X too. Sent in two passes, both say a status at X, and Raft's latest-wins has a tie.
  const { sql } = sqliteHost(); const g = gateway();
  const X = 1_790_000_050_000;
  appendTrace(sql, [
    { at: X, ...OWNER, kind: "model.call", spanId: "mj_x", status: "toolUse", verdict: "ok", ms: 100, attrs: { model: "m" } },
    { at: X, ...OWNER, kind: "tool.call", spanId: "op_x", status: "succeeded", verdict: "ok", ms: 0, attrs: { tool: "mounts", mount: "tools" } },
  ]);
  await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId, 1);
  g.mode = "throw";
  try { await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId, 1); } catch { /* held */ }
  g.mode = "send";
  await flushActivity(g, sql, OWNER.tenantId, OWNER.agentId, 1);
  const again = gateway();
  const times = g.batches.flat().filter((e) => e.status).map((e) => Date.parse(e.occurredAt));
  must(times.length === 3 && times.every((t, i) => i === 0 || t > times[i - 1]!), `status instants: ${JSON.stringify(g.batches)}`);
  must(times[2] === X + 1, `the tool's start moved by more than the millisecond it needed: ${times[2]! - X}`);
  // The clock moved only with the cursor: a pass with nothing new sends nothing and moves nothing.
  await flushActivity(again, sql, OWNER.tenantId, OWNER.agentId, 1);
  must(again.batches.length === 0, "a pass with nothing new sent something");
});


/**
 * A turn as the runtime makes it, through the gateway and the store that production runs on (the Durable Object
 * store, over the same SQLite the drain reads), drained to the events Raft builds its per-turn summary from. Raft
 * pairs a PreToolUse with its PostToolUse(Failure) by `toolUseId`, so every call must be exactly one start and one end
 * under an id no other call has — including the calls that share the model's call id and the ones completed twice.
 */
async function turn() {
  const host = sqliteHost();
  const store: any = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  await store.init();
  await store.createAgent("t1", "raft_a1");
  const tools = ["shell", "run", "go", "boom", "lost", "ask", "zap"].map((name) => ({
    name, description: "", parameters: { type: "object", properties: {} }, sideEffects: name === "zap" ? "write" : "read", idempotency: "native",
  }));
  const plugin: Plugin = {
    id: "box", version: "1.0.0", tools: tools as any,
    async invoke(tool: string, args: any) {
      if (tool === "shell") return { state: "exited", exitCode: args?.exit ?? 0, output: "" };
      if (tool === "run") return new Backgrounded({ execId: "e1" });
      if (tool === "boom") throw new Error("the service refused");
      if (tool === "lost") throw Object.assign(new Error("timed out after sending"), { retryable: true });
      if (tool === "ask") return interrupt({ question: "which?", answer: { choices: ["a"] }, state: { n: 1 } });
      return { ok: true };
    },
    interrupts: { async resume() { return { resumed: true }; } },
  } as any;
  await store.addMount({
    tenantId: "t1", agentId: "raft_a1", alias: "box", plugin: "box", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: { tools: { go: "allow", boom: "allow", zap: "allow", nope: "deny" } },
  });
  // A denied tool needs its own name in the catalogue: the policy is asked only for a tool that exists.
  (plugin.tools as any).push({ ...tools[2], name: "nope" });
  const gw = new ToolGateway(store, [plugin], new Set(["box"]), { async resolve() { return null; } } as any);
  return { host, store, gw, ctx: { tenantId: "t1", agentId: "raft_a1", taskId: "k" } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APPROVAL_WAIT_MS = 150;

await check("a turn's tool calls are each one start and one end under an id no other call has, whatever shares a call id", async () => {
  const { host, store, gw, ctx } = await turn();
  const ops: Record<string, string> = {};
  const call = async (label: string, tool: string, args: any, opts: any) => {
    const r: any = await gw.invoke(ctx, `box.${tool}`, args, opts);
    ops[label] = r.operationId;
    return r;
  };
  // Two calls to the same tool, the second exiting non-zero.
  await call("shell0", "shell", { exit: 0 }, { callId: "toolu_1" });
  await call("shell2", "shell", { exit: 2 }, { callId: "toolu_2" });
  // A run_js program's host calls: one model call id, a key per request (src/runtime/pi-tools.ts).
  await call("js0", "go", {}, { callId: "toolu_3", idempotencyKey: "toolu_3:0", fromProgram: true });
  await call("js1", "go", {}, { callId: "toolu_3", idempotencyKey: "toolu_3:1", fromProgram: true });
  await call("failed", "boom", {}, { callId: "toolu_4" });
  await call("unknown", "lost", {}, { callId: "toolu_5" });
  const refused = await call("rejected", "nope", {}, { callId: "toolu_6" });
  // A refusal answers without its operation id; the record has it.
  must(refused.status === "rejected", `the policy did not refuse: ${JSON.stringify(refused)}`);
  ops.rejected = String((host.sql.exec("SELECT operation_id FROM operations WHERE tool = 'box.nope'").toArray()[0] as any).operation_id);
  // A question, and the model's answer to it under the same call id: the answer is an operation of its own.
  const asked = await call("asked", "ask", {}, { callId: "toolu_7" });
  must(asked.status === "interrupted", `no question: ${JSON.stringify(asked)}`);
  const resumed: any = await gw.resumeInterrupt(ctx, asked.interrupt, "a", { callId: "toolu_7" });
  ops.resumed = resumed.operationId;
  // Held for a person, then approved after a wait; and one held then denied.
  await call("approved", "zap", {}, { callId: "toolu_8", confirm: true });
  await sleep(APPROVAL_WAIT_MS);
  const ran: any = await gw.applyApproval("t1", ops.approved!, "approved", "alice");
  must(ran.ok && ran.executed, `approval did not run: ${JSON.stringify(ran)}`);
  await call("denied", "zap", {}, { callId: "toolu_9", confirm: true });
  await gw.applyApproval("t1", ops.denied!, "denied", "alice");
  // A command that goes to the background and exits 7 there, completed the way the runtime completes it
  // (cf/src/runtime.ts, `runBackgroundPass`'s completeOperation); and one cancelled there.
  for (const [label, callId] of [["background", "toolu_10"], ["bgCancelled", "toolu_11"]] as const) {
    const bg = await call(label, "run", {}, { callId });
    must(bg.status === "running", `${label} did not go to the background: ${JSON.stringify(bg)}`);
    recordBackgroundJob(host.sql as any, { tenantId: "t1", agentId: "raft_a1" }, { id: bg.operationId, session: "main", mount: "box", tool: "box__run", handle: bg.background.handle, callId }, 0);
  }
  await stopSessionJobs({
    sql: host.sql as any, owner: { tenantId: "t1", agentId: "raft_a1" }, session: "main",
    cancel: async (job) => { if (job.id === ops.background) throw new Error("keep this one running"); },
    completeOperation: async (id, status, facts) => { await store.completeOperation("t1", id, status, null, undefined, facts); },
  });
  await runBackgroundPass({
    sql: host.sql as any, owner: { tenantId: "t1", agentId: "raft_a1" }, now: 60_000,
    poll: async () => ({ done: true, result: { state: "exited", exitCode: 7 } }),
    cancel: async () => {},
    completeOperation: async (id, status, facts) => { await store.completeOperation("t1", id, status, null, undefined, facts); },
    deliver: async () => {},
  });
  // A result too large to inline is completed again with its reference (cf/src/runtime.ts `parkResult`).
  await store.completeOperation("t1", ops.shell0!, "succeeded", "r2://parked");

  const rows = pendingTrace(host.sql as any, 0).rows.filter((r) => r.kind === "tool.call");
  const g = gateway();
  await flushActivity(g, host.sql as any, "t1", "raft_a1");
  const events = g.batches.flat().filter((e) => e.hookEventName === "PreToolUse" || e.hookEventName?.startsWith("PostToolUse"));
  const labels = Object.keys(ops);
  must(new Set(Object.values(ops)).size === labels.length, `two calls were one operation: ${JSON.stringify(ops)}`);
  must(rows.length === labels.length, `${rows.length} tool.call rows for ${labels.length} calls: ${JSON.stringify(rows.map((r) => [r.spanId, r.status]))}`);
  const by = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    must(typeof e.toolUseId === "string" && e.toolUseId.length > 0, `an event without a toolUseId: ${JSON.stringify(e)}`);
    by.set(e.toolUseId!, [...(by.get(e.toolUseId!) ?? []), e]);
  }
  must(by.size === labels.length, `${by.size} toolUseIds for ${labels.length} calls`);
  const post: Record<string, ActivityEvent> = {};
  for (const label of labels) {
    const pair = by.get(ops[label]!) ?? [];
    const starts = pair.filter((e) => e.hookEventName === "PreToolUse");
    const ends = pair.filter((e) => e.hookEventName !== "PreToolUse");
    must(starts.length === 1 && ends.length === 1, `${label}: ${starts.length} start(s), ${ends.length} end(s) under ${ops[label]}`);
    must(starts[0]!.toolName === ends[0]!.toolName, `${label}: the pair names two tools`);
    post[label] = ends[0]!;
  }
  // Outcomes as Raft reads them: ok, and an exit status only where a command ran.
  const outcome = (label: string) => JSON.stringify({ hook: post[label]!.hookEventName, ok: post[label]!.ok, exitCode: post[label]!.exitCode });
  const want: Record<string, unknown> = {
    shell0: { hook: "PostToolUse", ok: true, exitCode: 0 }, shell2: { hook: "PostToolUse", ok: true, exitCode: 2 },
    js0: { hook: "PostToolUse", ok: true }, js1: { hook: "PostToolUse", ok: true },
    failed: { hook: "PostToolUseFailure", ok: false }, unknown: { hook: "PostToolUseFailure", ok: null },
    rejected: { hook: "PostToolUseFailure", ok: false }, asked: { hook: "PostToolUse", ok: true }, resumed: { hook: "PostToolUse", ok: true },
    approved: { hook: "PostToolUse", ok: true }, denied: { hook: "PostToolUseFailure", ok: null },
    background: { hook: "PostToolUse", ok: true, exitCode: 7 }, bgCancelled: { hook: "PostToolUseFailure", ok: null },
  };
  for (const label of labels) must(outcome(label) === JSON.stringify(want[label]), `${label}: ${outcome(label)}, want ${JSON.stringify(want[label])}`);
  for (const label of labels) {
    if ((want[label] as { exitCode?: number }).exitCode === undefined) must(!("exitCode" in post[label]!), `${label} carries an exitCode key`);
    must("ok" in post[label]!, `${label} has no ok key`);
  }
  // The background job's end names the call that started it, as a call that ended in place does.
  const bgRow = rows.find((r) => r.spanId === ops.background)!;
  must(bgRow.attrs.callId === "toolu_10" && bgRow.attrs.exitCode === 7, `background row attrs ${JSON.stringify(bgRow.attrs)}`);
  must(rows.find((r) => r.spanId === ops.bgCancelled)!.attrs.callId === "toolu_11", "the cancelled job's row lost its call id");
  // The duration rule: the approved call counts from when it ran, not from when it was asked for.
  const startOf = (label: string) => Date.parse(by.get(ops[label]!)!.find((e) => e.hookEventName === "PreToolUse")!.occurredAt);
  const span = Date.parse(post.approved!.occurredAt) - startOf("approved");
  must(span >= APPROVAL_WAIT_MS, `the approved call's start is not dated at the request: ${span} ms`);
  must(typeof post.approved!.durationMs === "number" && post.approved!.durationMs < APPROVAL_WAIT_MS,
    `the approved call's durationMs counts the approval wait: ${post.approved!.durationMs} (start to end ${span} ms)`);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
