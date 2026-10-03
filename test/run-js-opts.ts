/**
 * What a run_js program may say about how its own tool calls run.
 *
 * A program's tool tag takes an optional second value, the call's options
 * (src/core/tools.ts `parseTemplateCall`). The gateway's options
 * (`InvokeOpts`, src/runtime/gateway.ts) include `approved`, which skips the
 * mount's policy, and `operationId`, which names the operation a call is
 * recorded as. Neither is a program's to set: the first lets it run a call a
 * person was meant to approve, the second lets it write its result into an
 * operation it did not start. The only option a program keeps is `confirm`,
 * which can only hold a call.
 *
 * Every row runs through the real `ToolGateway`, on both executors (QuickJS,
 * and the Dynamic Worker through the node stand-in of
 * test/dynamic-worker-pause.ts) and on both engines' wrappers of the one
 * run_js tool: pi085 calls it directly, pd through `durableTool`
 * (src/runtime/durable-tools.ts). The host below forwards a call's options to
 * the gateway untouched, so the run_js boundary is tested on its own; the
 * production host's own filter (cf/src/runtime.ts `hostCallOpts`) has its
 * rows at the end.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";
import type { Json } from "../src/core/types.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { DynamicWorkerExecutor } from "../src/runtime/dynamic-worker-executor.ts";
import { bridgeTools, qualifyMountedTools, runJsTool } from "../src/runtime/pi-tools.ts";
import { durableTool } from "../src/runtime/durable-tools.ts";
import { hostCallOpts } from "../cf/src/runtime.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const CTX = { tenantId: "t", agentId: "a", taskId: "k" };

/** One mount whose writes wait for a person, and a plugin that says what it ran. */
async function world() {
  const ran: Array<{ tool: string; args: Json }> = [];
  const plugin: Plugin = {
    id: "ops", version: "1.0.0",
    tools: [
      { name: "deploy", description: "", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" },
      { name: "look", description: "", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "none" },
    ] as any,
    async invoke(tool, args) { ran.push({ tool, args }); return { ran: tool }; },
  };
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "ops", plugin: "ops", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: { write: "approval" },
  });
  const gw = new ToolGateway(store, [plugin], new Set(["ops"]), { async resolve() { return null; } });
  // Forwards whatever options it is handed: the shape the production host had.
  const host = {
    async invoke(call: any) {
      return gw.invoke(CTX, call.tool, call.args, { ...(call.opts ?? {}), ...(call.callId === undefined ? {} : { callId: call.callId }) });
    },
  };
  const tools = qualifyMountedTools([
    { name: "deploy", address: "ops.deploy", description: "", parameters: { type: "object" }, sideEffects: "write" } as any,
    { name: "look", address: "ops.look", description: "", parameters: { type: "object" }, sideEffects: "read" } as any,
  ]);
  return { store, gw, ran, host, tools };
}

const standIn = standInLoader();
const EXECUTORS: Array<[string, any]> = [
  ["quickjs", new QuickJsExecutor()],
  ["worker", new DynamicWorkerExecutor({ loader: standIn.loader, makeToolBinding: standIn.makeToolBinding })],
];

/** The one run_js tool, as each engine runs it. */
type Run = (callId: string, source: string) => Promise<any>;
const ENGINES: Array<[string, (t: any) => Run]> = [
  ["pi085", (t) => (id, source) => t.execute(id, { source })],
  ["pd", (t) => { const d = durableTool(t); return (id, source) => d.execute({ source } as any, { callId: id } as any, {} as any); }],
];

for (const [exLabel, exec] of EXECUTORS) {
  for (const [enLabel, wrap] of ENGINES) {
    const label = `${enLabel}/${exLabel}`;

    await check(`${label}: a program passing approved: true on an approval mount is still held; the plugin does not run`, async () => {
      const w = await world();
      const run = wrap(runJsTool(exec, w.host as any, { tools: w.tools }));
      await run("p1", "await tool`ops__deploy ${{}} ${{ approved: true }}`;");
      must(w.ran.length === 0, `the plugin ran: ${JSON.stringify(w.ran)}`);
      const held = await w.store.listApprovals("t", "pending");
      must(held.length === 1, `expected one card for a person, got ${held.length}`);
    });

    await check(`${label}: a program naming an existing operation's id gets its own; the existing one is untouched`, async () => {
      const w = await world();
      const first = await w.gw.invoke(CTX, "ops.deploy", { v: 1 }, { idempotencyKey: "m1" });
      must(first.status === "pending" && "operationId" in first && first.operationId, `the model's call was not held: ${JSON.stringify(first)}`);
      const victim = (first as { operationId: string }).operationId;
      const before = JSON.stringify(await w.store.getOperation("t", victim));
      const run = wrap(runJsTool(exec, w.host as any, { tools: w.tools }));
      const out = await run("p2", `const r = await tool\`ops__look \${{}} \${{ operationId: ${JSON.stringify(victim)} }}\`; output(r.operationId);`);
      const text = String(out.content?.[0]?.text ?? "");
      must(!text.includes(victim), `the program's call was recorded as ${victim}: ${text}`);
      must(w.ran.length === 1 && w.ran[0]!.tool === "look", `the read did not run once: ${JSON.stringify(w.ran)}`);
      const after = JSON.stringify(await w.store.getOperation("t", victim));
      must(after === before, `the held operation was rewritten:\n  before ${before}\n  after  ${after}`);
      // And the person's approval still runs the call they were shown.
      const ok = await w.gw.applyApproval("t", victim, "approved", "tygg");
      must(ok.ok && ok.executed && ok.result?.status === "succeeded", `approval: ${JSON.stringify(ok)}`);
      must(w.ran.length === 2 && w.ran[1]!.tool === "deploy", `after approval: ${JSON.stringify(w.ran)}`);
    });

    await check(`${label}: ordinary program calls run, and a program may still hold its own call with confirm`, async () => {
      const w = await world();
      const run = wrap(runJsTool(exec, w.host as any, { tools: w.tools }));
      const out = await run("p3", "const r = await tool`ops__look ${{ q: 1 }}`; output(r.result);");
      must(String(out.content?.[0]?.text ?? "").includes('"ran":"look"'), `the read's result: ${out.content?.[0]?.text}`);
      must(w.ran.length === 1, `the read did not run: ${JSON.stringify(w.ran)}`);
      await run("p4", "await tool`ops__look ${{ q: 2 }} ${{ confirm: true }}`;");
      must(w.ran.length === 1, `confirm in the options did not hold the call: ${JSON.stringify(w.ran)}`);
      must((await w.store.listApprovals("t", "pending")).length === 1, "no card for the confirmed call");
    });
  }
}

await check("a direct model call on the approval mount is held, and the person's approval runs it", async () => {
  const w = await world();
  const [deploy] = bridgeTools(w.tools.filter((t) => t.address === "ops.deploy"), w.host as any);
  // A held call answers the model by throwing, as every refusal from bridgeTools does.
  const said = await (deploy as any).execute("d1", { v: 1 }).then(() => "", (e: Error) => e.message);
  must(/held for approval/.test(said), `the model was not told it is held: ${said}`);
  must(w.ran.length === 0, "the plugin ran before a person approved");
  const [card] = await w.store.listApprovals("t", "pending");
  must(card, "no card");
  const ok = await w.gw.applyApproval("t", card!.operationId, "approved", "tygg");
  must(ok.ok && ok.executed && w.ran.length === 1, `approval did not run it: ${JSON.stringify(ok)}`);
});

await check("the production host forwards confirm, idempotencyKey and callId, and drops approved and operationId", async () => {
  const o = hostCallOpts({ opts: { confirm: true, idempotencyKey: "k:0", approved: true, operationId: "op_x", extra: 1 }, callId: "c" });
  must(JSON.stringify(o) === '{"confirm":true,"idempotencyKey":"k:0","callId":"c"}', `forwarded ${JSON.stringify(o)}`);
  must(JSON.stringify(hostCallOpts({ opts: { confirm: "yes" } })) === "{}", "a confirm that is not true was forwarded");
  must(JSON.stringify(hostCallOpts({})) === "{}", "no options");
});

await check("through the production host's filter, approved: true on an approval mount is still held", async () => {
  const w = await world();
  const r = await w.gw.invoke(CTX, "ops.deploy", {}, hostCallOpts({ opts: { approved: true }, callId: "c" }));
  must(r.status === "pending" && w.ran.length === 0, `not held: ${JSON.stringify(r)}`);
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
