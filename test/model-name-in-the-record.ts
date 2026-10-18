/**
 * The operation record names the tool the way the model was offered it.
 *
 * An operation's `tool` is its dispatch address (`<plugin>.<tool>`), which no model sees. What Raft's activity log, the
 * "Using …" status and the overflow backstop's send count need is the name in the model's tool list, and that cannot
 * be rebuilt afterwards from the alias and the address: a collision tie-break gives one of two clashing tools a
 * suffix, and nothing after dispatch can tell which. So it is recorded at dispatch (`OperationRecord.modelName`), from
 * the tool list the call was made against, and every reader takes it from there.
 *
 * Run through the production host's option filter (cf/src/runtime.ts `hostCallOpts`), the real gateway and store, and
 * the trace rows the store writes.
 */
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { interrupt, type Plugin } from "../src/plugins/types.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { bridgeTools, modelToolName, qualifyMountedTools, resumeTool, runJsTool, type ToolHost } from "../src/runtime/pi-tools.ts";
import { RunJsContinuations } from "../src/runtime/run-js-resume.ts";
import { hostCallOpts } from "../cf/src/runtime.ts";
import { pendingTrace } from "../src/trace/outbox.ts";
import { activityEvents } from "../src/runtime/activity.ts";
import { programSendCounter } from "../src/runtime/overflow-backstop.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).slice(0, 800) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

// The model's own conversation: the backstop counts a program's sends under task `main`.
const CTX = { tenantId: "t", agentId: "a", taskId: "main" };
// Two tool names that are one name once cut to the provider's 64 characters under alias `chat`: the second takes the
// tie-break suffix.
const LONG = "x".repeat(60);

const plugin: Plugin = {
  id: "svc", version: "1.0.0",
  tools: [
    { name: `${LONG}a`, summary: "", parameters: { type: "object" }, sideEffects: "read", idempotency: "native" },
    { name: `${LONG}b`, summary: "", parameters: { type: "object" }, sideEffects: "read", idempotency: "native" },
    { name: "messages_send", summary: "", parameters: { type: "object" }, sideEffects: "write", idempotency: "native" },
    { name: "ask", summary: "", parameters: { type: "object" }, sideEffects: "write", idempotency: "native" },
  ] as any,
  async invoke(tool) {
    if (tool === "ask") return interrupt({ question: "go on?", answer: { choices: ["go"] }, state: {} });
    return { ran: tool };
  },
  interrupts: { async resume() { return { done: true }; } },
};

async function world() {
  const raw = sqliteHost();
  const store = new DurableObjectStore({ storage: { sql: raw.sql, transactionSync: raw.transactionSync } } as never);
  await store.init();
  await store.createAgent("t", "a");
  // The alias is not the plugin id, as for every MCP connector mount.
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "chat", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  const gw = new ToolGateway(store, [plugin], new Set(["svc"]), { async resolve() { return null; } });
  const host: ToolHost = {
    invoke: (call) => gw.invoke(CTX, call.tool, call.args, hostCallOpts(call)),
    resumeInterrupt: (i, answer, callId) => gw.resumeInterrupt(CTX, i, answer, { callId }),
    cancelInterrupt: (i) => gw.cancelInterrupt(CTX, i),
  };
  const offered = qualifyMountedTools(plugin.tools.map((t) => ({
    name: t.name, address: `chat.${t.name}`, description: "", parameters: t.parameters, sideEffects: t.sideEffects, idempotency: t.idempotency,
  })));
  const continuations = new RunJsContinuations();
  const keeping = { continuations, scope: "s" };
  const bridged = bridgeTools(offered, host, keeping) as any[];
  const toolRows = () => pendingTrace(raw.sql as never, 0).rows.filter((r) => r.kind === "tool.call");
  return { raw, store, gw, host, offered, bridged, keeping, toolRows };
}

await check("a tool offered with a tie-break suffix is recorded, traced and reported under that exact name", async () => {
  const w = await world();
  const tied = w.offered.find((t) => t.address === `chat.${LONG}b`)!;
  const first = w.offered.find((t) => t.address === `chat.${LONG}a`)!;
  must(tied.name.endsWith("2") && tied.name.length === 64, `control: no tie-break was taken: ${tied.name}`);
  // Control: rebuilding the name from alias and tool gives the OTHER tool's name, which is why it is recorded.
  must(modelToolName("chat", `${LONG}b`) === first.name, "control: the two names do not collide");
  const out = await w.bridged.find((t) => t.name === tied.name)!.execute("toolu_1", {});
  const op = await w.store.getOperation("t", out.details.operationId);
  must(op?.modelName === tied.name && op.tool === `svc.${LONG}b`, `the record: ${show(op)}`);
  const rows = w.toolRows();
  must(rows.length === 1 && rows[0]!.attrs.name === tied.name, `the trace row: ${show(rows)}`);
  const ev = activityEvents("a", rows);
  const steps = ev.filter((e) => e.toolName !== undefined);
  must(steps.length === 2 && steps.every((e) => e.toolName === tied.name), `the activity events: ${show(ev)}`);
  must(ev.some((e) => e.detail === `Using ${tied.name}`), `the status detail: ${show(ev)}`);
});

await check("a run_js program's raft-style sends are counted by the name it called, offered name or offered address alike", async () => {
  const w = await world();
  const run = runJsTool(new QuickJsExecutor(), w.host, { tools: w.offered }) as any;
  // Twice by the offered name, once by the address it was offered under, once by plugin id, which was offered under
  // no name at all and so is reported by its address and is not counted as a send.
  await run.execute("p1", { source: [
    "await tool`chat__messages_send ${{ content: 'a' }}`;",
    "await tool`chat__messages_send ${{ content: 'b' }}`;",
    "await tool`chat.messages_send ${{ content: 'c' }}`;",
    "await tool`svc.messages_send ${{ content: 'd' }}`;",
    "output('ok');",
  ].join("\n") });
  const rows = w.toolRows();
  must(rows.length === 4 && rows.every((r) => r.status === "succeeded"), `control: the program's calls: ${show(rows)}`);
  const names = activityEvents("a", rows).filter((e) => e.hookEventName === "PostToolUse").map((e) => e.toolName);
  must(show(names) === show(["chat__messages_send", "chat__messages_send", "chat__messages_send", "svc.messages_send"]), `names: ${show(names)}`);
  const sends = programSendCounter(w.raw.sql as never, "t")("p1");
  must(sends === 3, `the backstop counted ${sends} sends`);
  must(programSendCounter(w.raw.sql as never, "t")("p_other") === 0, "control: another program's id counted sends");
});

await check("the step that answers a tool's question carries the name the asking call was recorded under", async () => {
  const w = await world();
  const asked = await w.bridged.find((t) => t.name === "chat__ask")!.execute("toolu_2", {});
  const token = JSON.parse(asked.content[0].text).token;
  must(typeof token === "string", `control: no question: ${asked.content[0].text}`);
  const resume = resumeTool(w.keeping.continuations, { scope: "s" }) as any;
  await resume.execute("toolu_3", { token, answer: "go" });
  const rows = w.toolRows();
  must(rows.length === 2 && rows.every((r) => r.attrs.name === "chat__ask"), `the call and its resume: ${show(rows.map((r) => r.attrs))}`);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
