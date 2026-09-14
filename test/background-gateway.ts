/**
 * The gateway's half of a background tool call (task #16): a plugin that
 * returns `Backgrounded` leaves a running operation with its handle, ordinary
 * data never does, and coming back to the work later sees the call's context.
 * Through the real gateway and store.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { backgrounded, type Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const ctx = { tenantId: "t", agentId: "a", taskId: "k" };
const seen: Array<{ what: string; alias: string; credential: string | null; handle: unknown }> = [];
const tool = (name: string) => ({ name, summary: "", parameters: {}, sideEffects: "read" as const, idempotency: "native" as const });
const box: Plugin = {
  id: "box", version: "1.0.0", defaultForAllAgents: true,
  tools: [tool("long"), tool("shapey")],
  async invoke(t) {
    if (t === "long") return backgrounded({ boxId: "b1", execId: "e1" }, "npm test is still running");
    // Real data that happens to look like the signal.
    return { handle: { execId: "not-a-job" }, note: "just data" };
  },
  async pollBackground(handle, c) { seen.push({ what: "poll", alias: c.alias, credential: c.credential, handle }); return { done: true, result: { exitCode: 0 } }; },
  async cancelBackground(handle, c) { seen.push({ what: "cancel", alias: c.alias, credential: c.credential, handle }); },
};
const plain: Plugin = { id: "plain", version: "1.0.0", defaultForAllAgents: true, tools: [tool("x")], async invoke() { return 1; } };

async function fixture() {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const [alias, plugin] of [["work", "box"], ["other", "plain"]] as const) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, plugin, installationId: "i", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: alias === "work" ? "ref:work" : null, policy: null,
    });
  }
  const gw = new ToolGateway(store, [box, plain], { async resolve() { return "SECRET"; } });
  return { store, gw };
}

await check("a backgrounded call leaves a running operation carrying the plugin's handle", async () => {
  const { store, gw } = await fixture();
  const r: any = await gw.invoke(ctx, "work.long", {});
  assert(r.status === "running", `expected running, got ${JSON.stringify(r)}`);
  assert(r.background?.alias === "work" && r.background?.tool === "long", `where the work lives is missing: ${JSON.stringify(r.background)}`);
  assert(r.background?.handle?.execId === "e1" && r.background?.note === "npm test is still running", `handle or note lost: ${JSON.stringify(r.background)}`);
  const op = await store.getOperation("t", r.operationId);
  assert(op?.status === "running", `the operation row says ${op?.status}`);
});

await check("data shaped like the signal is still just data", async () => {
  const { gw } = await fixture();
  const r: any = await gw.invoke(ctx, "work.shapey", {});
  assert(r.status === "succeeded", `a result containing handle/note was taken for a job: ${JSON.stringify(r)}`);
  assert(r.result?.note === "just data", `the data was altered: ${JSON.stringify(r.result)}`);
});

await check("poll and cancel see the context the call saw: this mount, its credential, the handle", async () => {
  const { gw } = await fixture();
  seen.length = 0;
  const p: any = await gw.pollBackground(ctx, "work", { boxId: "b1", execId: "e1" });
  assert(p.done === true && p.result?.exitCode === 0, `poll answer lost: ${JSON.stringify(p)}`);
  await gw.cancelBackground(ctx, "work", { boxId: "b1", execId: "e1" });
  assert(seen.length === 2, `plugin saw ${seen.length} calls`);
  for (const s of seen) {
    assert(s.alias === "work" && s.credential === "SECRET", `${s.what} saw alias ${s.alias}, credential ${s.credential}`);
    assert((s.handle as any)?.execId === "e1", `${s.what} got the wrong handle: ${JSON.stringify(s.handle)}`);
  }
});

await check("coming back to a mount or plugin that cannot report says so", async () => {
  const { gw } = await fixture();
  let msg = "";
  try { await gw.pollBackground(ctx, "other", {}); } catch (e) { msg = String((e as Error).message); }
  assert(/cannot report/.test(msg) && msg.includes("other"), `a plugin without pollBackground was not named: ${msg}`);
  msg = "";
  try { await gw.pollBackground(ctx, "gone", {}); } catch (e) { msg = String((e as Error).message); }
  assert(/no longer exists/.test(msg), `a missing mount was not reported: ${msg}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
