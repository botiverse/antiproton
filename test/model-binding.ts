/** Whose key an agent spends, and what happens when nobody has said. */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ModelResolver } from "../src/runtime/model-resolver.ts";
import type { SecretResolver } from "../src/runtime/gateway.ts";

const results: Array<{ row: string; name: string; ok: boolean; error?: string }> = [];
const test = async (row: string, name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ row, name, ok: true }); }
  catch (e) { results.push({ row, name, ok: false, error: (e as Error).message }); }
};
function assert(c: unknown, what: string): asserts c {
  if (!c) throw new Error(`assertion failed: ${what}`);
}
const eq = (a: unknown, b: unknown, what: string) =>
  assert(Object.is(a, b), `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const resolved: string[] = [];
const secrets: SecretResolver = {
  async resolve(ref) { resolved.push(ref); return ref === "missing" ? null : `key-for-${ref}`; },
};
const fresh = async () => {
  const s = new SqliteStore(":memory:");
  await s.init();
  return s;
};
const bind = (tenantId: string, agentId: string | null, model: string, secretRef: string) => ({
  tenantId, agentId, provider: "openai-compatible", model,
  baseUrl: "https://provider.example", secretRef,
});

await test("没有绑定就拒绝运行", "an agent with no binding is refused, not billed to the operator", async () => {
  const store = await fresh();
  const r = new ModelResolver(store, secrets);
  let msg = "";
  try { await r.resolve({ tenantId: "t1", agentId: "a1" }); }
  catch (e) { msg = (e as Error).message; }
  assert(msg.includes("no model binding"), `expected a refusal, got: ${msg || "no error"}`);
  await store.close();
});

await test("agent 覆盖租户默认", "an agent-level binding overrides the tenant default", async () => {
  const store = await fresh();
  await store.setModelBinding(bind("t1", null, "tenant-default", "env:T1"));
  await store.setModelBinding(bind("t1", "a1", "agent-override", "env:T1_A1"));
  const r = new ModelResolver(store, secrets);
  eq((await r.resolve({ tenantId: "t1", agentId: "a1" })).id.split("/")[1], "agent-override", "override used");
  eq((await r.resolve({ tenantId: "t1", agentId: "a2" })).id.split("/")[1], "tenant-default", "default used");
  await store.close();
});

await test("凭据不随绑定外泄", "the binding that leaves the store carries a reference, never a key", async () => {
  const store = await fresh();
  await store.setModelBinding(bind("t1", null, "m", "env:SECRET_ONE"));
  const b = await store.getModelBinding("t1", "a1");
  eq(b!.secretRef, "env:SECRET_ONE", "reference is returned");
  assert(!JSON.stringify(b).includes("key-for-"), "no resolved credential anywhere in the binding");
  await store.close();
});

await test("跨租户不可见", "one tenant's binding is invisible to another", async () => {
  const store = await fresh();
  await store.setModelBinding(bind("t1", null, "m", "env:T1"));
  eq(await store.getModelBinding("t2", "a1"), null, "other tenant sees nothing");
  await store.close();
});

await test("凭据解析失败要报错", "a binding whose secret does not resolve fails loudly", async () => {
  const store = await fresh();
  await store.setModelBinding(bind("t1", null, "m", "missing"));
  const r = new ModelResolver(store, secrets);
  let msg = "";
  try { await r.resolve({ tenantId: "t1", agentId: "a1" }); }
  catch (e) { msg = (e as Error).message; }
  assert(msg.includes("did not resolve"), `expected a resolution failure, got: ${msg || "no error"}`);
  await store.close();
});

await test("重新绑定立即生效", "re-binding a key takes effect on the next call, not on a cache eviction", async () => {
  const store = await fresh();
  await store.setModelBinding(bind("t1", null, "first", "env:OLD"));
  const r = new ModelResolver(store, secrets);
  eq((await r.resolve({ tenantId: "t1", agentId: "a1" })).id.split("/")[1], "first", "first binding");
  await store.setModelBinding(bind("t1", null, "second", "env:NEW"));
  eq((await r.resolve({ tenantId: "t1", agentId: "a1" })).id.split("/")[1], "second", "rebinding is immediate");
  assert(resolved.includes("env:NEW"), "the new credential was dereferenced");
  await store.close();
});

console.log(`\n  model binding — whose key an agent spends\n  ${"─".repeat(66)}`);
for (const r of results) {
  const label = `${r.row.padEnd(14)} ${r.name}`;
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗\x1b[0m ${label}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(66)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
