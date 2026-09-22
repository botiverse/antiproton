/**
 * The two functions that write a mount's secret reference, and what each may
 * write. Neither had a case before (#531): an attach overwrote whatever was
 * there, including the operator's reference — which nothing puts back — and
 * a remove cleared to null. The first is refused now; the rest is pinned as
 * it is today, so the revert that follows changes it on purpose.
 */
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { AgentRuntime, OPERATOR_RUN9_REF } from "../cf/src/runtime.ts";
import { agentRef } from "../src/runtime/secrets.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const KEYED: Plugin = {
  id: "keyed", version: "1.0.0",
  credential: { required: true, summary: "An account.", shape: "token" },
  tools: [{ name: "ping", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { return { ok: true }; },
};

async function runtime(secretRef: string | null) {
  // The runtime's own store over a real SQLite host, so the attach path can
  // reach its check through the gateway the constructor built.
  const host = sqliteHost();
  const rt = new AgentRuntime({
    ctx: { storage: host } as any, bucket: {} as any, bucketName: "b",
    models: { resolve: () => null } as any, extraPlugins: [KEYED],
    // A key this deployment can seal with, so attach reaches the judgement under test.
    secretKek: Buffer.from(new Uint8Array(32)).toString("base64"),
  } as any);
  const store: any = (rt as any).store;
  await store.init();
  (rt as any).ready = async () => {};
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "m", plugin: "keyed", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef, policy: null,
  });
  if (secretRef && secretRef.startsWith(agentRef(""))) await store.putSecret("t", "a", "m", { ciphertext: "c", iv: "v" });
  const ref = async () => (await store.getMountByAlias("t", "a", "m"))?.secretRef ?? null;
  return { store, rt, ref };
}

await check("attaching a key to a mount that uses the operator's account is refused, and the reference is untouched", async () => {
  const { rt, ref } = await runtime(OPERATOR_RUN9_REF);
  const r = await rt.attachCredential("t", "a", "m", { token: "mine" });
  must(!r.ok, "the attach was accepted over the operator's reference");
  must(/operator/.test(r.error ?? ""), `the refusal does not say why: ${r.error}`);
  must((await ref()) === OPERATOR_RUN9_REF, `the operator's reference was overwritten: ${await ref()}`);
});

await check("attaching a key to a mount with no account points the mount at the agent's own secret", async () => {
  const { rt, ref } = await runtime(null);
  const r = await rt.attachCredential("t", "a", "m", { token: "mine" });
  must(r.ok, `the attach was refused: ${r.error}`);
  must((await ref()) === agentRef("m"), `the mount points at ${await ref()}`);
});

await check("removing the agent's own key clears the reference (today's behaviour, pinned until the revert lands)", async () => {
  const { rt, ref } = await runtime(agentRef("m"));
  must(await rt.removeCredential("t", "a", "m"), "the remove was refused");
  must((await ref()) === null, `the reference reads ${await ref()}`);
});

await check("removing on a mount that uses the operator's account is refused and changes nothing", async () => {
  const { rt, ref } = await runtime(OPERATOR_RUN9_REF);
  must(!(await rt.removeCredential("t", "a", "m")), "the operator's reference was removed");
  must((await ref()) === OPERATOR_RUN9_REF, `the reference reads ${await ref()}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
