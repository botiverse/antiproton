/**
 * `record` never throws, and a swallowed write leaves a trace.
 *
 * The contract promises plugins that recording usage cannot fail the thing it
 * describes, so the gateway swallows a ledger that refuses. But an audit with
 * silent holes reads exactly like a quiet week, so the criterion was written
 * before the code (cody, Piper, 2026-09-12): make the ledger write fail, open a
 * box, and three things must hold — the box opened, the call's operation row is
 * flagged, the count went up. Missing any one, this is not done.
 *
 * Through the real gateway and a real store, because the swallow and the trace
 * both live in the gateway, and a plugin-level test cannot see either.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway, type UsageRecorder } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const ctx = { tenantId: "t", agentId: "a", taskId: "k" };

/** A box plugin written to the real contract: it records beside its work. */
const boxes: Plugin = {
  id: "boxes", version: "1.0.0", defaultForAllAgents: true,
  tools: [{ name: "open", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" }],
  async invoke(_tool, _args, c) {
    await c.record({ kind: "container", event: "opened", ref: "b-1" });
    return { boxId: "b-1" };
  },
  async release(c) {
    await c.record({ kind: "container", event: "closed", ref: "b-1" });
    return true;
  },
};

async function fixture(recorder?: UsageRecorder) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "sandbox", plugin: "boxes",
    installationId: "i", connectionId: null, toolVersion: "1.0.0",
    publicConfig: {}, secretRef: null, policy: null,
  });
  const gw = new ToolGateway(store, [boxes], { async resolve() { return null; } }, recorder);
  return { store, gw };
}

const refusing: UsageRecorder = { async write() { throw new Error("ledger down"); } };

await check("写得进去的时候:事件带着租户、agent、挂载名到达,没有任何痕迹", async () => {
  const got: any[] = [];
  const { store, gw } = await fixture({ async write(at, e) { got.push({ ...at, ...e }); } });
  const r = await gw.invoke(ctx, "sandbox.open", {});
  if (r.status !== "succeeded") throw new Error(`the call did not succeed: ${JSON.stringify(r)}`);
  if (got.length !== 1 || got[0].tenantId !== "t" || got[0].agentId !== "a" || got[0].alias !== "sandbox" || got[0].ref !== "b-1") {
    throw new Error(`the ledger got ${JSON.stringify(got)}`);
  }
  if ((await store.getOperation("t", r.operationId!))!.usageLost !== 0) throw new Error("a recorded call was flagged");
  if ((await store.listUsageLost("t", "a")).length !== 0) throw new Error("a recorded event was kept as lost");
});

await check("账本写失败:盒子照开 · operations 那行带标记 · 计数 +1", async () => {
  const { store, gw } = await fixture(refusing);
  const r = await gw.invoke(ctx, "sandbox.open", {});
  // 1. The box opened: the refusal did not reach the call.
  if (r.status !== "succeeded" || (r.result as any)?.boxId !== "b-1") {
    throw new Error(`a refused ledger write failed the call: ${JSON.stringify(r)}`);
  }
  // 2. The call's row says so.
  const op = await store.getOperation("t", r.operationId!);
  if (op?.usageLost !== 1) throw new Error(`the operation row is not flagged: ${JSON.stringify(op)}`);
  // 3. The count went up — and what it counts is the event itself.
  const lost = await store.listUsageLost("t", "a");
  if (lost.length !== 1) throw new Error(`${lost.length} kept events, not 1`);
  if (lost[0]!.ref !== "b-1" || lost[0]!.event !== "opened" || lost[0]!.operationId !== r.operationId) {
    throw new Error(`the kept event is not the one refused: ${JSON.stringify(lost[0])}`);
  }
});

await check("没有调用在途的路径(归还)也留痕,只是没有行可标", async () => {
  // Boxes are stopped at settle and by the idle pass, where there is no
  // operation row. The trace cannot depend on one.
  const { store, gw } = await fixture(refusing);
  const out = await gw.releaseTask(ctx);
  if (out.released.join() !== "sandbox" || out.failed.length) throw new Error(`release: ${JSON.stringify(out)}`);
  const lost = await store.listUsageLost("t", "a");
  if (lost.length !== 1 || lost[0]!.event !== "closed" || lost[0]!.operationId !== null) {
    throw new Error(`the release's lost event: ${JSON.stringify(lost)}`);
  }
});

await check("没配账本时不是静默:每条事件都被留下", async () => {
  // The default recorder refuses, so a deployment without a ledger shows what
  // it did not record rather than looking like nothing was used.
  const { store, gw } = await fixture();
  await gw.invoke(ctx, "sandbox.open", {});
  if ((await store.listUsageLost("t", "a")).length !== 1) throw new Error("the default recorder dropped the event silently");
});

await check("两边都写不进:调用仍然成功,并且在日志里说出来", async () => {
  const { store, gw } = await fixture(refusing);
  (store as any).noteUsageLost = async () => { throw new Error("store down"); };
  const said: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try {
    const r = await gw.invoke(ctx, "sandbox.open", {});
    if (r.status !== "succeeded") throw new Error(`a double failure reached the call: ${JSON.stringify(r)}`);
  } finally {
    console.error = original;
  }
  if (!said.some((l) => l.includes("b-1"))) throw new Error(`nothing said which event was lost: ${JSON.stringify(said)}`);
});

console.log(`\n  Usage recording\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
