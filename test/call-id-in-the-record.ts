/**
 * The operation record names the call the model made.
 *
 * `operation.completed` said which operation finished and how; it did not say
 * WHICH of the model's tool calls that operation served. The console pairs a
 * `tool.result` with a `model.response.toolCalls[].id` (cf/src/ui.ts), so the
 * operation — where the identity of a failure now lives — sat beside that pair
 * with nothing to join on. The console needs that join to put a badge on the
 * card, and it has to be RECORDED rather than inferred, because inference is
 * what reading the prose was.
 *
 * It is the model's id, passed to be written down and acted on nowhere. In
 * particular it is NOT `idempotencyKey`, which `run_js` derives per request
 * (`${toolCallId}:${n++}`): one call makes many requests, so the key separates
 * them and this joins them.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { completedPayload } from "../src/store/operation-event.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const caller = { tenantId: "t", agentId: "a", taskId: "k" };

const plugin = (id: string, fail: boolean): Plugin => ({
  id, version: "1.0.0", defaultForAllAgents: true,
  tools: [{ name: "go", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { if (fail) throw new Error("the service refused"); return { ok: true }; },
});

/** Both backends, because the Durable Object is the one production runs on. */
const BACKENDS = {
  sqlite: async () => { const s = new SqliteStore(":memory:"); await s.init(); return s; },
  "durable-object": async () => {
    const host = sqliteHost();
    const s = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
    await s.init();
    return s;
  },
} as const;

async function fixture(fail: boolean, backend: keyof typeof BACKENDS = "sqlite") {
  const store: any = await BACKENDS[backend]();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  return { store, gw: new ToolGateway(store, [{ ...plugin("svc", fail) }], new Set(([{ ...plugin("svc", fail) }]).map((p: any) => p.id)), { async resolve() { return null; } }) };
}

const completed = async (store: any) =>
  (await store.taskEvents("t", "k")).filter((e: any) => e.kind === "operation.completed");

for (const backend of Object.keys(BACKENDS) as Array<keyof typeof BACKENDS>) {
  await check(`a call that succeeded records the id the model called it by (${backend})`, async () => {
    const { gw, store } = await fixture(false, backend);
    await gw.invoke(caller, "svc.go", {}, { callId: "toolu_01" });
    const [e] = await completed(store);
    must(e, "no operation.completed was recorded");
    must(e.payload?.callId === "toolu_01",
      `the record says callId ${JSON.stringify(e.payload?.callId)}: nothing joins it to the model's call`);
  });

  await check(`a call that FAILED records it too (${backend})`, async () => {
    const { gw, store } = await fixture(true, backend);
    const r: any = await gw.invoke(caller, "svc.go", {}, { callId: "toolu_02" });
    must(r.status !== "succeeded", "the call did not fail");
    const [e] = await completed(store);
    // The failures are the ones a page most wants to mark, so an id carried
    // only on success would be missing exactly where it is needed. It also
    // sits beside the identity fields, which only a failure has.
    must(e.payload?.callId === "toolu_02",
      `a failure recorded callId ${JSON.stringify(e.payload?.callId)}`);
    must(e.payload?.status === "failed", `status ${JSON.stringify(e.payload?.status)}`);
  });
}

await check("many requests, one call: the key separates them and the id joins them", async () => {
  // What `run_js` does: several host calls inside one model call, each with its
  // own idempotency key derived from that one id.
  const { gw, store } = await fixture(false);
  await gw.invoke(caller, "svc.go", {}, { callId: "toolu_03", idempotencyKey: "toolu_03:0" });
  await gw.invoke(caller, "svc.go", {}, { callId: "toolu_03", idempotencyKey: "toolu_03:1" });
  const es = await completed(store);
  must(es.length === 2, `expected two operations, got ${es.length}`);
  must(es.every((e: any) => e.payload?.callId === "toolu_03"),
    `the two operations name ${JSON.stringify(es.map((e: any) => e.payload?.callId))}`);
  must(new Set(es.map((e: any) => e.payload?.operationId)).size === 2,
    "the two requests collapsed into one operation, so there is nothing for the id to join");
});

await check("a call with no id records no id, rather than an empty one", async () => {
  const { gw, store } = await fixture(false);
  await gw.invoke(caller, "svc.go", {});
  const [e] = await completed(store);
  must(!("callId" in (e.payload ?? {})),
    `the payload grew a key nobody set: ${JSON.stringify(e.payload)}`);
});

await check("absent stays absent in the builder, where a written `undefined` would be visible", async () => {
  // The check above cannot fail on its own: the payload reaches the row through
  // JSON, and `JSON.stringify` drops an `undefined` value, so `callId: undefined`
  // would read back as absent either way. I tried writing `callId: undefined` and
  // BOTH suites stayed green — a pass bought by the serialiser, not by this code.
  // So the rule is asserted where it can be broken.
  const bare = completedPayload("op_1", "succeeded", null) as any;
  must(!("callId" in bare), `the builder wrote a key nobody set: ${JSON.stringify(Object.keys(bare))}`);
  must(!("identity" in bare) && !("credentialRef" in bare),
    `the builder wrote identity keys nobody set: ${JSON.stringify(Object.keys(bare))}`);
  // And the shape every reader written before today still gets, exactly.
  must(JSON.stringify(Object.keys(bare)) === JSON.stringify(["operationId", "status", "resultRef"]),
    `the payload of a plain completion changed: ${JSON.stringify(Object.keys(bare))}`);
});

for (const backend of Object.keys(BACKENDS) as Array<keyof typeof BACKENDS>) {
  await check(`what the builder made is what a reader gets back, key for key (${backend})`, async () => {
    // The segment nobody was asking about: the checks above read the STORE and the
    // console's read the rendered list, so "written -> stored -> read back" was covered only field by
    // field, for fields someone had thought to name. A store that dropped, renamed or reordered a key
    // nobody asserted would pass all of them. So this compares the whole object against the builder's
    // own output for the same inputs.
    const { store } = await fixture(false, backend);
    // Written directly, so the comparison is about the store and not about what the gateway chose to send.
    await store.recordOperation({
      operationId: "op_rt", tenantId: "t", agentId: "a", taskId: "k",
      mountAlias: "svc", tool: "svc.go", toolVersion: "1.0.0",
    });
    const facts = { callId: "toolu_rt", identity: "unreadable", credentialRef: "agent" } as const;
    await store.completeOperation("t", "op_rt", "failed", null, undefined, facts);
    const [e] = await completed(store);
    const want = completedPayload("op_rt", "failed", null, undefined, facts);
    must(JSON.stringify(e.payload) === JSON.stringify(want),
      `the row reads ${JSON.stringify(e.payload)}, the builder made ${JSON.stringify(want)}`);
  });
}

console.log(`\n  the call the operation served\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
