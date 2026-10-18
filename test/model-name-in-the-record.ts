/**
 * The operation record names the tool the way the model was offered it.
 *
 * An operation's `tool` is its dispatch address (`<plugin>.<tool>`), which no model sees. What Raft's activity log, the
 * "Using …" status and the overflow backstop's send count need is the name in the model's tool list, and that cannot
 * be rebuilt afterwards from the alias and the address: a collision tie-break gives one of two clashing tools a
 * suffix, and nothing after dispatch can tell which. So it is recorded at dispatch (`OperationRecord.modelName`): the
 * gateway, which alone resolves every form a call can name a tool by, looks the tool it resolved to up in the turn's
 * offered list, and every reader takes the name from there.
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

/** A plugin this agent has switched off: mounted, never offered, and refused at dispatch. */
const off: Plugin = {
  id: "off", version: "1.0.0",
  tools: [{ name: "messages_send", summary: "", parameters: { type: "object" }, sideEffects: "write", idempotency: "native" }] as any,
  async invoke() { return { ran: "off" }; },
};

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
  const mount = (alias: string, id: string) => store.addMount({
    tenantId: "t", agentId: "a", alias, plugin: id, installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  await mount("chat", "svc");
  await mount("off", "off");
  await store.setPluginChoice("t", "a", "off", "disable");
  const gw = new ToolGateway(store, [plugin, off], new Set(["svc", "off"]), { async resolve() { return null; } });
  // The turn's list: the enabled mount's tools, qualified, as the runtime's catalogue builds it (`#catalogueFor`).
  const offered = qualifyMountedTools(plugin.tools.map((t) => ({
    name: t.name, address: `chat.${t.name}`, description: "", parameters: t.parameters, sideEffects: t.sideEffects, idempotency: t.idempotency,
  })));
  // The runtime host's wiring of both calls (cf/src/runtime.ts `#host`): the turn's list goes with each.
  const host: ToolHost = {
    invoke: (call) => gw.invoke(CTX, call.tool, call.args, hostCallOpts(call, offered)),
    resumeInterrupt: (i, answer, callId) => gw.resumeInterrupt(CTX, i, answer, { callId, offered }),
    cancelInterrupt: (i) => gw.cancelInterrupt(CTX, i),
  };
  const continuations = new RunJsContinuations();
  const keeping = { continuations, scope: "s" };
  const bridged = bridgeTools(offered, host, keeping) as any[];
  const toolRows = () => pendingTrace(raw.sql as never, 0).rows.filter((r) => r.kind === "tool.call");
  const program = async (id: string, lines: string[]) => {
    const run = runJsTool(new QuickJsExecutor(), host, { tools: offered }) as any;
    return run.execute(id, { source: [...lines, "output('ok');"].join("\n") });
  };
  const sends = (id: string) => programSendCounter(raw.sql as never, "t")(id);
  return { raw, store, gw, host, offered, bridged, keeping, toolRows, program, sends, mount };
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

await check("a run_js program's sends are named and counted whichever form named the tool: offered name, alias address, plugin address", async () => {
  const w = await world();
  await w.program("p1", [
    "await tool`chat__messages_send ${{ content: 'a' }}`;",
    "await tool`chat.messages_send ${{ content: 'b' }}`;",
    // By plugin id: only the gateway resolves this to the `chat` mount, and the name is looked up from what it resolved.
    "await tool`svc.messages_send ${{ content: 'c' }}`;",
  ]);
  const rows = w.toolRows();
  must(rows.length === 3 && rows.every((r) => r.status === "succeeded"), `control: the program's calls: ${show(rows)}`);
  const names = activityEvents("a", rows).filter((e) => e.hookEventName === "PostToolUse").map((e) => e.toolName);
  must(show(names) === show(["chat__messages_send", "chat__messages_send", "chat__messages_send"]), `names: ${show(names)}`);
  must(w.sends("p1") === 3, `the backstop counted ${w.sends("p1")} sends`);
  must(w.sends("p_other") === 0, "control: another program's id counted sends");
});

await check("an address-form call to a tool that is not a send gets that tool's own offered name, a tie-break suffix included, and is no send", async () => {
  const w = await world();
  const tied = w.offered.find((t) => t.address === `chat.${LONG}b`)!;
  const first = w.offered.find((t) => t.address === `chat.${LONG}a`)!;
  await w.program("p2", [`await tool\`svc.${LONG}b \${{}}\`;`, `await tool\`chat.${LONG}a \${{}}\`;`]);
  const names = w.toolRows().map((r) => r.attrs.name);
  must(show(names) === show([tied.name, first.name]) && tied.name !== first.name, `names: ${show(names)}`);
  must(w.sends("p2") === 0, `reads counted as ${w.sends("p2")} sends`);
});

await check("a switched-off plugin's send is refused at dispatch: no operation, no name, no send", async () => {
  const w = await world();
  must(!w.offered.some((t) => t.address.startsWith("off.")), "control: the switched-off mount was offered");
  const out = await w.program("p3", ["const r = await tool`off.messages_send ${{ content: 'x' }}`; output(r);"]);
  must(/plugin_disabled|switched off/.test(String(out.content?.[0]?.text)), `not refused: ${out.content?.[0]?.text}`);
  must(w.toolRows().length === 0 && w.sends("p3") === 0, `it ran: ${show(w.toolRows())}`);
});

await check("a send to a tool the turn was not offered can still run (a mount added mid-turn): unnamed, shown by its address, and counted", async () => {
  const w = await world();
  // Added after the turn's list was fixed: dispatch checks the mount's tools as they are now, the list does not have it.
  await w.mount("late", "svc");
  await w.program("p4", ["await tool`late.messages_send ${{ content: 'x' }}`;"]);
  const rows = w.toolRows();
  must(rows.length === 1 && rows[0]!.status === "succeeded" && !("name" in rows[0]!.attrs), `the call: ${show(rows)}`);
  must(activityEvents("a", rows).every((e) => e.toolName === "svc.messages_send"), `shown as: ${show(activityEvents("a", rows))}`);
  must(w.sends("p4") === 1, `the backstop counted ${w.sends("p4")} sends`);
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
