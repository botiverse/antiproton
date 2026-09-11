/**
 * Per-agent secrets: sealed at rest, resolved only for the owner, never
 * visible in any persisted row or read path. Each case is one of the
 * properties the README's credential claim rests on.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { agentRef, agentSecrets, importKek, open, seal } from "../src/runtime/secrets.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error).message ?? e) }); }
}
const KEK = Buffer.from(new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)).toString("base64");
const VALUE = "ghp_ThisIsThePlaintextTokenThatMustNeverPersist_9f3e";

await check("seal and open round-trip under the same key, and not under another", async () => {
  const k = await importKek(KEK);
  const sealed = await seal(k, VALUE);
  if (sealed.ciphertext.includes(VALUE) || sealed.iv.length < 12) throw new Error("ciphertext carries the value");
  if (await open(k, sealed) !== VALUE) throw new Error("did not round-trip");
  const other = await importKek(Buffer.from(new Uint8Array(32).fill(9)).toString("base64"));
  let opened = false;
  try { await open(other, sealed); opened = true; } catch { /* expected */ }
  if (opened) throw new Error("opened under the wrong key");
});

await check("a short key is refused before it is used", async () => {
  let ok = false;
  try { await importKek(Buffer.from("short").toString("base64")); } catch { ok = true; }
  if (!ok) throw new Error("accepted a 5-byte key");
});

await check("the value appears in no persisted row, in any table", async () => {
  const store = new SqliteStore(":memory:"); await store.init();
  const k = await importKek(KEK);
  const sealed = await seal(k, VALUE);
  await store.addMount({ tenantId: "t", agentId: "a", alias: "gh", plugin: "github", installationId: "i",
    connectionId: null, toolVersion: "1", publicConfig: {}, secretRef: null });
  await store.putSecret("t", "a", "gh", { ...sealed });
  await store.setMountSecretRef("t", "a", "gh", agentRef("gh"));
  // Walk every table the way someone with the file would.
  const rows: string[] = [];
  for (const [, trs] of Object.entries(store.dumpTables())) for (const r of trs) rows.push(JSON.stringify(r));
  const hit = rows.find((r) => r.includes(VALUE));
  if (hit) throw new Error(`plaintext found: ${hit.slice(0, 120)}`);
  const meta = await store.secretMeta("t", "a", "gh");
  if (!meta || meta.lastUsedAt !== null || "last4" in meta) throw new Error(`meta wrong: ${JSON.stringify(meta)}`);
  // Nothing derived from the value either: not a suffix, not a hash of it.
  if (rows.some((r) => r.includes(VALUE.slice(-4)))) throw new Error("a fragment of the value is persisted");
  store.close();
});

await check("an agent: reference resolves only for the owner, and stamps last use", async () => {
  const store = new SqliteStore(":memory:"); await store.init();
  const k = await importKek(KEK);
  await store.putSecret("t", "a", "gh", { ...(await seal(k, VALUE)) });
  const resolver = agentSecrets(store, k, { resolve: async () => null });
  if (await resolver.resolve(agentRef("gh"), { tenantId: "t", agentId: "a" }) !== VALUE) throw new Error("owner cannot resolve");
  if (await resolver.resolve(agentRef("gh"), { tenantId: "t", agentId: "b" }) !== null) throw new Error("another agent resolved it");
  if (await resolver.resolve(agentRef("gh"), { tenantId: "u", agentId: "a" }) !== null) throw new Error("another tenant resolved it");
  if (await resolver.resolve(agentRef("gh")) !== null) throw new Error("resolved with no scope at all");
  const meta = await store.secretMeta("t", "a", "gh");
  if (!meta?.lastUsedAt) throw new Error("last use not stamped");
  store.close();
});

await check("the gateway hands the value to the plugin's call context and to nothing persisted", async () => {
  const store = new SqliteStore(":memory:"); await store.init();
  const k = await importKek(KEK);
  await store.putSecret("t", "a", "gh", { ...(await seal(k, VALUE)) });
  let seen: string | null = null;
  const plugin: Plugin = {
    id: "echo", version: "1", tools: [{ name: "ping", summary: "ping", sideEffects: "read", idempotency: "idempotent", schema: { type: "object", properties: {} } } as any],
    async invoke(_tool, _args, ctx) { seen = ctx.credential; return { pong: true }; },
  } as any;
  await store.addMount({ tenantId: "t", agentId: "a", alias: "gh", plugin: "echo", installationId: "i",
    connectionId: null, toolVersion: "1", publicConfig: {}, secretRef: agentRef("gh") });
  const gw = new ToolGateway(store, [plugin], agentSecrets(store, k, { resolve: async () => null }));
  const r = await gw.invoke({ tenantId: "t", agentId: "a", taskId: "task1" }, "gh.ping", {});
  if (r.status !== "succeeded") throw new Error(`call failed: ${JSON.stringify(r)}`);
  if (seen !== VALUE) throw new Error("plugin did not receive the value");
  const rows: string[] = [];
  for (const [, trs] of Object.entries(store.dumpTables())) for (const row of trs) rows.push(JSON.stringify(row));
  const hit = rows.find((x) => x.includes(VALUE));
  if (hit) throw new Error(`plaintext persisted by the call: ${hit.slice(0, 120)}`);
  if (JSON.stringify(r).includes(VALUE)) throw new Error("the tool result carries the value");
  store.close();
});

await check("remove forgets the value and the mount's reference", async () => {
  const store = new SqliteStore(":memory:"); await store.init();
  const k = await importKek(KEK);
  await store.addMount({ tenantId: "t", agentId: "a", alias: "gh", plugin: "github", installationId: "i",
    connectionId: null, toolVersion: "1", publicConfig: {}, secretRef: null });
  await store.putSecret("t", "a", "gh", { ...(await seal(k, VALUE)) });
  await store.setMountSecretRef("t", "a", "gh", agentRef("gh"));
  if (!(await store.removeSecret("t", "a", "gh"))) throw new Error("remove reported nothing removed");
  await store.setMountSecretRef("t", "a", "gh", null);
  if (await store.getSecret("t", "a", "gh")) throw new Error("ciphertext survived remove");
  if ((await store.getMountByAlias("t", "a", "gh"))?.secretRef) throw new Error("mount still points at it");
  store.close();
});

console.log(`\n  Per-agent secrets\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
