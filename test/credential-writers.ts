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
import { recordBackgroundJob } from "../src/runtime/background-jobs.ts";

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
async function runtime(secretRef: string | null, at = { alias: "m", plugin: "keyed" }, deps: Record<string, unknown> = {}) {
  // The runtime's own store over a real SQLite host, so the attach path can
  // reach its check through the gateway the constructor built.
  const host = sqliteHost();
  const rt = new AgentRuntime({
    ctx: { storage: host } as any, bucket: {} as any, bucketName: "b",
    models: { resolve: () => null } as any, extraPlugins: [KEYED],
    // A key this deployment can seal with, so attach reaches the judgement under test.
    secretKek: Buffer.from(new Uint8Array(32)).toString("base64"),
    ...deps,
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
  return { store, rt, ref, meta, host, alias: at.alias };
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

// ---- a box outlives no credential change (#818) ----------------------------------------------------------------

/**
 * The seeded sandbox mount on the operator's run9 account, holding a box made on it, and a run9 that answers here
 * and records which account each request came with. No request leaves the process. `deleteStatus` is what run9
 * says to the box's deletion.
 */
async function heldSandbox(deleteStatus: number | (() => number) = 200, opts: {
  /** run9's `/whoami` organisation for each access key; a key not named answers 401. */
  orgs?: Record<string, string>;
  /** Access keys whose credential check run9 refuses. */
  rejects?: string[];
} = {}) {
  const OPS = { ak: "ops-ak", sk: "ops-sk" };
  const w = await runtime(OPERATOR_RUN9_REF, SANDBOX, { operatorRun9: OPS });
  w.store.pluginDb.put({ tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" }, "box", "state",
    { machines: { main: { boxId: "b-ops", createdAt: 1, lastUsedAt: 1, credentialRef: "operator" } } }, null);
  const calls: Array<{ method: string; path: string; who: string; refAtCall: string | null }> = [];
  const accountOf = (auth: string) => atob(auth.replace(/^Basic /, "")).split(":")[0]!;
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const method = String(init?.method ?? "GET");
    const path = new URL(String(url)).pathname;
    calls.push({ method, path, who: accountOf(String(init?.headers?.authorization ?? "")), refAtCall: await w.ref() });
    const who = accountOf(String(init?.headers?.authorization ?? ""));
    if (method === "DELETE") {
      const status = typeof deleteStatus === "function" ? deleteStatus() : deleteStatus;
      return new Response(status === 200 ? "{}" : "{\"error\":\"no\"}", { status });
    }
    if (path === "/whoami") {
      const org = opts.orgs?.[who];
      return org ? new Response(JSON.stringify({ auth_kind: "api_key", org: { org_id: org } })) : new Response("{\"error\":\"invalid api key\"}", { status: 401 });
    }
    // The credential check asks for a box that never exists: reached and authorised.
    if (path.endsWith("/b_credential_check_only")) {
      return opts.rejects?.includes(who)
        ? new Response("{\"error\":\"invalid api key\"}", { status: 401 })
        : new Response("{\"error\":\"box not found\"}", { status: 400 });
    }
    return new Response("{}");
  }) as any;
  const box = () => (w.store.pluginDb.get({ tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" }, "box", "state") as any)?.machines?.main?.boxId;
  const deletes = () => calls.filter((c) => c.method === "DELETE");
  /** The mount holding one box, made under `kind`. */
  const holds = (id: string, kind: string) => w.store.pluginDb.put({ tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" }, "box", "state",
    { machines: { main: { boxId: id, createdAt: 1, lastUsedAt: 1, credentialRef: kind } } }, null);
  /** The tenant's key on the mount with nothing held, then a box made with it. */
  const ownKeyHolding = async (id: string) => {
    w.store.pluginDb.put({ tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" }, "box", "state", { machines: {} }, null);
    must((await w.rt.attachCredential("t", "a", "sandbox", { ak: "own-ak", sk: "own-sk" })).ok, "attach");
    holds(id, "agent");
    calls.length = 0;
  };
  return { ...w, calls, box, deletes, holds, ownKeyHolding, restore: () => { globalThis.fetch = real; } };
}

await check("a key of the tenant's own over the operator's: the operator's box is deleted first, with the operator's key", async () => {
  const w = await heldSandbox();
  try {
    const r = await w.rt.attachCredential("t", "a", "sandbox", { ak: "own-ak", sk: "own-sk" });
    must(r.ok, `the attach was refused: ${(r as any).error}`);
    const del = w.calls.filter((c) => c.method === "DELETE" && c.path.endsWith("/boxes/b-ops"));
    must(del.length === 1, `the operator's box was not deleted: ${JSON.stringify(w.calls)}`);
    must(del[0]!.who === "ops-ak", `deleted with ${del[0]!.who}'s key, not the account it is on`);
    must(del[0]!.refAtCall === OPERATOR_RUN9_REF, `deleted after the mount had moved to ${del[0]!.refAtCall}`);
    must(!w.box(), `the record still names ${w.box()}`);
    must((await w.ref()) === agentRef("sandbox"), `the key did not go on: ${await w.ref()}`);
  } finally { w.restore(); }
});

await check("when run9 will not delete the operator's box, the key does not go on, so the one key that can still delete it stays", async () => {
  const w = await heldSandbox(500);
  try {
    const r = await w.rt.attachCredential("t", "a", "sandbox", { ak: "own-ak", sk: "own-sk" });
    must(!r.ok && /not changed/.test(r.error) && /b-ops/.test(r.error), `the attach went ahead: ${JSON.stringify(r)}`);
    must((await w.ref()) === OPERATOR_RUN9_REF, `the mount moved to ${await w.ref()}`);
    // The tenant's key is only asked about (the check, before anything is released); it never touches the box.
    must(!w.calls.some((c) => c.who === "own-ak" && c.method !== "GET"), `the tenant's key was used: ${JSON.stringify(w.calls)}`);
  } finally { w.restore(); }
});

await check("removing the tenant's key deletes the box it made first, with that key; refused if the delete fails", async () => {
  for (const status of [200, 500]) {
    const w = await heldSandbox(status);
    try {
      // Nothing held while the key goes on; then a box made with it.
      w.store.pluginDb.put({ tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" }, "box", "state", { machines: {} }, null);
      must((await w.rt.attachCredential("t", "a", "sandbox", { ak: "own-ak", sk: "own-sk" })).ok, "attach");
      w.store.pluginDb.put({ tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" }, "box", "state",
        { machines: { main: { boxId: "b-own", createdAt: 1, lastUsedAt: 1, credentialRef: "agent" } } }, null);
      w.calls.length = 0;
      const removed = await w.rt.removeCredential("t", "a", "sandbox");
      const del = w.calls.filter((c) => c.method === "DELETE" && c.path.endsWith("/boxes/b-own"));
      must(del.length === 1 && del[0]!.who === "own-ak", `${status}: not deleted with the tenant's key: ${JSON.stringify(w.calls)}`);
      if (status === 200) {
        must(removed && (await w.ref()) === OPERATOR_RUN9_REF, `the key was not removed: ${await w.ref()}`);
      } else {
        must(!removed && (await w.ref()) === agentRef("sandbox"), `removed with its box still alive: ${await w.ref()}`);
      }
    } finally { w.restore(); }
  }
});

await check("a key run9 rejects changes nothing: no box is deleted, the record and the mount stay as they were", async () => {
  const w = await heldSandbox(200, { rejects: ["typo-ak"] });
  try {
    const r = await w.rt.attachCredential("t", "a", "sandbox", { ak: "typo-ak", sk: "x" });
    must(!r.ok && /rejected/.test(r.error), `the rejected key was taken: ${JSON.stringify(r)}`);
    must(w.deletes().length === 0 && !w.calls.some((c) => c.path.endsWith("/stop")), `a box was released for a rejected key: ${JSON.stringify(w.calls)}`);
    must(w.box() === "b-ops", `the record lost its box: ${w.box()}`);
    must((await w.ref()) === OPERATOR_RUN9_REF, `the mount moved to ${await w.ref()}`);
  } finally { w.restore(); }
  // Over a key of the tenant's own: that key, the only one that can delete its box, stays.
  const v = await heldSandbox(200, { rejects: ["typo-ak"] });
  try {
    await v.ownKeyHolding("b-own");
    const r = await v.rt.attachCredential("t", "a", "sandbox", { ak: "typo-ak", sk: "x" });
    must(!r.ok && v.deletes().length === 0 && v.box() === "b-own", `released or forgotten: ${JSON.stringify(v.calls)}`);
    must((await v.ref()) === agentRef("sandbox") && (await v.store.getSecret("t", "a", "sandbox")), "the tenant's key was dropped");
    must((await v.rt.removeCredential("t", "a", "sandbox")) && v.deletes().some((c) => c.who === "own-ak"), "the kept key could not delete its box");
  } finally { v.restore(); }
});

await check("a delete run9 keeps refusing keeps refusing the change, every time, until it succeeds", async () => {
  let status = 500;
  const w = await heldSandbox(() => status);
  try {
    for (const n of [1, 2]) {
      const r = await w.rt.attachCredential("t", "a", "sandbox", { ak: "own-ak", sk: "own-sk" });
      must(!r.ok && /not changed/.test(r.error), `attach ${n} went ahead: ${JSON.stringify(r)}`);
      must(w.box() === "b-ops", `attach ${n}: the record let go of a box run9 did not delete`);
      must((await w.ref()) === OPERATOR_RUN9_REF, `attach ${n}: the mount moved to ${await w.ref()}`);
    }
    must(w.deletes().length === 2 && w.deletes().every((c) => c.who === "ops-ak"), `deletes: ${JSON.stringify(w.deletes())}`);
    status = 200;
    const r = await w.rt.attachCredential("t", "a", "sandbox", { ak: "own-ak", sk: "own-sk" });
    must(r.ok && !w.box() && (await w.ref()) === agentRef("sandbox"), `the attach after the delete: ${JSON.stringify(r)}`);
  } finally { w.restore(); }
});

await check("a new key on the same run9 account deletes nothing: the box stays and the key goes on", async () => {
  const w = await heldSandbox(200, { orgs: { "own-ak": "org-1", "own2-ak": "org-1", "ops-ak": "org-ops" } });
  try {
    await w.ownKeyHolding("b-own");
    const r = await w.rt.attachCredential("t", "a", "sandbox", { ak: "own2-ak", sk: "own2-sk" });
    must(r.ok, `refused: ${JSON.stringify(r)}`);
    must(w.deletes().length === 0 && w.box() === "b-own", `the box was released: ${JSON.stringify(w.calls)}`);
    must((await w.ref()) === agentRef("sandbox"), "the key did not go on");
    // A key of another account: the box goes first, with the key that made it.
    const s = await w.rt.attachCredential("t", "a", "sandbox", { ak: "ops-ak", sk: "ops-sk" });
    must(s.ok && w.deletes().length === 1 && !w.box(), `another account's key kept the box: ${JSON.stringify(w.calls)}`);
  } finally { w.restore(); }
});

await check("an account that cannot be told is not the same one: the box is released", async () => {
  // own-ak answers /whoami, the new key does not.
  const w = await heldSandbox(200, { orgs: { "own-ak": "org-1" } });
  try {
    await w.ownKeyHolding("b-own");
    const r = await w.rt.attachCredential("t", "a", "sandbox", { ak: "own2-ak", sk: "own2-sk" });
    must(r.ok && w.deletes().length === 1 && w.deletes()[0]!.who === "own-ak", `not released: ${JSON.stringify(w.calls)}`);
  } finally { w.restore(); }
  // Same organisation, but the box was made under another kind of credential than the mount's now.
  const v = await heldSandbox(200, { orgs: { "own-ak": "org-1", "own2-ak": "org-1" } });
  try {
    await v.ownKeyHolding("b-legacy");
    v.holds("b-legacy", "operator");
    const r = await v.rt.attachCredential("t", "a", "sandbox", { ak: "own2-ak", sk: "own2-sk" });
    must(r.ok && v.deletes().length === 1, `a box made under another credential was kept: ${JSON.stringify(v.calls)}`);
  } finally { v.restore(); }
});

await check("a running background job refuses the change, with nothing deleted and the mount unchanged (S2)", async () => {
  const w = await heldSandbox();
  try {
    recordBackgroundJob(w.host.sql, { tenantId: "t", agentId: "a" }, { id: "j1", session: "s", mount: "sandbox", tool: "shell", handle: null });
    const r = await w.rt.attachCredential("t", "a", "sandbox", { ak: "own-ak", sk: "own-sk" });
    must(!r.ok && /background job/.test(r.error) && /not changed/.test(r.error), `the attach went ahead: ${JSON.stringify(r)}`);
    must(w.deletes().length === 0 && w.box() === "b-ops" && (await w.ref()) === OPERATOR_RUN9_REF, `changed: ${JSON.stringify(w.calls)}`);
  } finally { w.restore(); }
});

await check("a refused remove says why", async () => {
  const w = await heldSandbox(500);
  try {
    await w.ownKeyHolding("b-own");
    const r = await w.rt.removeCredentialOrWhy("t", "a", "sandbox");
    must(!r.ok && /b-own/.test(r.error) && /not changed/.test(r.error), `no reason: ${JSON.stringify(r)}`);
    must(w.box() === "b-own" && (await w.ref()) === agentRef("sandbox"), "the remove went ahead");
    const none = await w.rt.removeCredentialOrWhy("t", "a", "nope");
    must(!none.ok && /no mount named nope/.test(none.error), `a missing mount: ${JSON.stringify(none)}`);
  } finally { w.restore(); }
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
