/**
 * The two functions that write a mount's secret reference, and what each may
 * write. Neither had a case before (#531): an attach overwrote whatever was
 * there, including the operator's reference — which nothing put back — and a
 * remove cleared to null.
 *
 * Both are decided by the catalogue now, never by the reference's kind: an
 * overwrite is allowed exactly where a remove can give the same reference
 * back, and `sandbox` is the one seeded alias that carries one, so it is the
 * subject wherever a revert is under test.
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

/** `at` names the mount. `sandbox` is the one alias the catalogue seeds with a
 *  reference, so it is what a revert has to be tested against. */
async function runtime(secretRef: string | null, at = { alias: "m", plugin: "keyed" }) {
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
    tenantId: "t", agentId: "a", alias: at.alias, plugin: at.plugin, installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef, policy: null,
  });
  if (secretRef && secretRef.startsWith(agentRef(""))) await store.putSecret("t", "a", at.alias, { ciphertext: "c", iv: "v" });
  const ref = async () => (await store.getMountByAlias("t", "a", at.alias))?.secretRef ?? null;
  const meta = async () => rt.credentialMeta("t", "a", (await store.getMountByAlias("t", "a", at.alias))!);
  return { store, rt, ref, meta, alias: at.alias };
}

await check("attaching a key to a mount that uses the operator's account is refused, and the reference is untouched", async () => {
  const { rt, ref } = await runtime(OPERATOR_RUN9_REF);
  const r = await rt.attachCredential("t", "a", "m", { token: "mine" });
  must(!r.ok, "the attach was accepted over the operator's reference");
  must(/operator/.test(r.error ?? ""), `the refusal does not say why: ${r.error}`);
  must((await ref()) === OPERATOR_RUN9_REF, `the operator's reference was overwritten: ${await ref()}`);
});

await check("a reference of a kind no mount carries today is refused by the same test, not by its name", async () => {
  // The judgement is "not ours", not "the operator's": a deployment-set
  // reference (env:) is protected the day something writes one onto a mount.
  const { rt, ref } = await runtime("env:SOMETHING");
  const r = await rt.attachCredential("t", "a", "m", { token: "mine" });
  must(!r.ok && /did not attach \(env\)/.test(r.error ?? ""), `env reference was not refused as not ours: ${r.error}`);
  must((await ref()) === "env:SOMETHING", `the reference was overwritten: ${await ref()}`);
});

await check("attaching a key to a mount with no account points the mount at the agent's own secret", async () => {
  const { rt, ref } = await runtime(null);
  const r = await rt.attachCredential("t", "a", "m", { token: "mine" });
  must(r.ok, `the attach was refused: ${r.error}`);
  must((await ref()) === agentRef("m"), `the mount points at ${await ref()}`);
});

await check("removing the agent's own key from a mount the catalogue does not seed leaves no account", async () => {
  // The other half of the revert: "go back to what the catalogue says" is
  // nothing here, because this alias is not one the catalogue seeds. Written
  // as a placeholder while the refusal landed (#532); it now says which branch
  // it is, rather than which release it belongs to.
  const { rt, ref } = await runtime(agentRef("m"));
  must(await rt.removeCredential("t", "a", "m"), "the remove was refused");
  must((await ref()) === null, `the reference reads ${await ref()}`);
});

await check("removing on a mount that uses the operator's account is refused and changes nothing", async () => {
  const { rt, ref } = await runtime(OPERATOR_RUN9_REF);
  must(!(await rt.removeCredential("t", "a", "m")), "the operator's reference was removed");
  must((await ref()) === OPERATOR_RUN9_REF, `the reference reads ${await ref()}`);
});

const SANDBOX = { alias: "sandbox", plugin: "sandbox" };

await check("removing the agent's own key from a seeded mount gives the shared account back", async () => {
  // The whole point of the feature: a key of your own is a detour, not a
  // one-way door. What comes back is the catalogue's own reference, so the
  // mount ends on the account it would have had if nobody had ever attached.
  const { rt, ref } = await runtime(agentRef("sandbox"), SANDBOX);
  must(await rt.removeCredential("t", "a", "sandbox"), "the remove was refused");
  must((await ref()) === OPERATOR_RUN9_REF, `the mount was left on ${await ref()}`);
});

await check("revertsTo says what a mount would go back to, and says it before anything is attached", async () => {
  // A property of the mount, not of its current state: the same answer with
  // the shared account in place and with the agent's own key over it, which is
  // what lets one page state follow from the other.
  const seeded = await runtime(OPERATOR_RUN9_REF, SANDBOX);
  must((await seeded.meta()).revertsTo === "operator", `seeded, untouched: ${(await seeded.meta()).revertsTo}`);
  const overridden = await runtime(agentRef("sandbox"), SANDBOX);
  must((await overridden.meta()).revertsTo === "operator", `seeded, overridden: ${(await overridden.meta()).revertsTo}`);
  const plain = await runtime(agentRef("m"));
  must((await plain.meta()).revertsTo === "none", `not seeded: ${(await plain.meta()).revertsTo}`);
});

await check("a key of your own may go over the shared account, because that one can be given back", async () => {
  // The carve-out, and the only reason for it: this reference is the one the
  // catalogue names for this mount, so `removeCredential` restores exactly it.
  // Asserted on the refusal not firing rather than on a completed attach —
  // sandbox's credential is checked against run9, which a test does not reach.
  const { rt } = await runtime(OPERATOR_RUN9_REF, SANDBOX);
  const r = await rt.attachCredential("t", "a", "sandbox", { token: "mine" });
  must(!/did not attach/.test((r as any).error ?? ""),
    `the overwrite was refused as not ours even though the catalogue names it: ${(r as any).error}`);
});

await check("a shared account the catalogue does not name is still refused, even on a seeded alias", async () => {
  // Presence is not enough: the catalogue has to name THIS reference. Giving
  // back `operator:run9` where `operator:elsewhere` was would move the mount to
  // an account it never had, and say nothing about it.
  const { rt, ref } = await runtime("operator:elsewhere", SANDBOX);
  const r = await rt.attachCredential("t", "a", "sandbox", { token: "mine" });
  must(!r.ok && /did not attach \(operator\)/.test(r.error ?? ""), `it was not refused: ${(r as any).error}`);
  must((await ref()) === "operator:elsewhere", `the reference was overwritten: ${await ref()}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
