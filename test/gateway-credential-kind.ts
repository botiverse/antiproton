/**
 * The gateway says what kind of credential a mount names, so a plugin holding a null one can tell "names
 * none" from "names one that did not arrive" — the two that used to be the same null, and are fixed by
 * different people (#plugins:770a1824, 2026-09-20).
 *
 * The other half is the paths that deliberately report nothing. `activity`, `usage` and
 * `promptContribution` are called with `credential: null` because nobody resolved one for them; reporting
 * a kind there would let a plugin call a mount "unreadable" when the truth is that it was never read.
 * `unreported` is the honest answer, and these cases pin it as a decision rather than an omission.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { credentialState, markIdentity, type Plugin, type PluginContext } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const ctx = { tenantId: "t", agentId: "a", taskId: "k" };
// Collected rather than assigned: a `let` written inside the plugin is invisible to the checker's
// narrowing, and the casts that hides are worse than an array with a last element.
const invoked: PluginContext[] = [];
const askedActivity: PluginContext[] = [];

const box: Plugin = {
  id: "box", version: "1.0.0", defaultForAllAgents: true,
  tools: [{ name: "run", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke(_t, _a, c) { invoked.push(c as PluginContext); return { ok: true }; },
  async activity(c) { askedActivity.push(c as PluginContext); return { live: null }; },
};

/** `refs` maps a mount alias to its secretRef; `held` is what the resolver can answer. */
async function fixture(refs: Record<string, string | null>, held: Record<string, string> = {}) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const [alias, secretRef] of Object.entries(refs)) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, plugin: "box", installationId: `i-${alias}`, connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef, policy: null,
    });
  }
  return new ToolGateway(store, [box], new Set(([box]).map((p: any) => p.id)), { async resolve(ref: string) { return held[ref] ?? null; } });
}

await check("a mount that names nothing reads as none, not as a credential that failed to arrive", async () => {
  const gw = await fixture({ work: null });
  await gw.invoke(ctx, "work.run", {});
  const c = invoked.at(-1);
  assert(c, "the plugin was not called");
  assert(c.credentialRefKind === "none", `kind: ${c.credentialRefKind}`);
  assert(credentialState(c) === "none", `state: ${credentialState(c)}`);
});

await check("a mount whose named credential did not arrive reads as unreadable, not as no account", async () => {
  // The production shape this came from: the mount names `agent:work`, the row behind it is gone, and the
  // resolver answers a missing row with null. Saying "attach an account" here sends the wrong person.
  const gw = await fixture({ work: "agent:work" });
  await gw.invoke(ctx, "work.run", {});
  const c = invoked.at(-1);
  assert(c, "the plugin was not called");
  assert(c.credential === null && c.credentialRefKind === "agent",
    `credential/kind: ${JSON.stringify({ credential: c.credential, kind: c.credentialRefKind })}`);
  assert(credentialState(c) === "unreadable", `state: ${credentialState(c)}`);
});

await check("a credential that did arrive reads as attached, whatever kind names it", async () => {
  const gw = await fixture({ work: "operator:run9" }, { "operator:run9": "a-value" });
  await gw.invoke(ctx, "work.run", {});
  const c = invoked.at(-1);
  assert(c, "the plugin was not called");
  assert(credentialState(c) === "attached" && c.credentialRefKind === "operator",
    `state/kind: ${credentialState(c)}/${c.credentialRefKind}`);
});

await check("a sibling's null is as readable as this mount's", async () => {
  const gw = await fixture({ work: null, other: "agent:other" });
  await gw.invoke(ctx, "work.run", {});
  const c = invoked.at(-1);
  assert(c, "the plugin was not called");
  const sib = await c.sibling("other");
  assert(sib?.credentialRefKind === "agent", `sibling kind: ${JSON.stringify(sib)}`);
  assert(credentialState({ credential: sib!.credential, credentialRefKind: sib!.credentialRefKind }) === "unreadable",
    "a sibling that names a credential it cannot read looked like one that names none");
});

await check("a path that never resolved a credential reports nothing, rather than calling it unreadable", async () => {
  // `activity` is asked with credential: null by design. If it were handed the kind, a mount naming
  // `agent:work` would read as "unreadable" — a claim about a resolution nobody attempted.
  const gw = await fixture({ work: "agent:work" });
  await gw.mountActivity(ctx, "work");
  const c = askedActivity.at(-1);
  assert(c, "activity was not called");
  assert(c.credentialRefKind === undefined, `kind: ${c.credentialRefKind}`);
  assert(credentialState(c) === "unreported", `state: ${credentialState(c)}`);
});

await check("a failed call carries the identity as fields, not only inside the sentence", () => {
  // Vera's acceptance for this half: the complete error of a failed call contains `identity` and
  // `credentialRef`. Until it did, a page that wanted to mark an anonymous failure could only match the
  // plugin's prose — and matching a remembered half-sentence is how a reading goes wrong.
  return (async () => {
    const store = new SqliteStore(":memory:");
    await store.init();
    await store.createAgent("t", "a");
    await store.addMount({
      tenantId: "t", agentId: "a", alias: "work", plugin: "sulky", installationId: "i", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: "agent:work", policy: null,
    });
    const sulky: Plugin = {
      id: "sulky", version: "1.0.0", defaultForAllAgents: true,
      tools: [{ name: "run", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
      async invoke(_t, _a, c) { throw markIdentity(new Error("github 403: rate limited"), c as PluginContext); },
    };
    const gw = new ToolGateway(store, [sulky], new Set(([sulky]).map((p: any) => p.id)), { async resolve() { return null; } });
    const r: any = await gw.invoke(ctx, "work.run", {});
    assert(r.status === "failed", `status: ${r.status}`);
    assert(r.error.identity === "unreadable" && r.error.credentialRef === "agent",
      `fields on the error: ${JSON.stringify(r.error)}`);
    assert(typeof r.error.message === "string" && r.error.message.includes("403"),
      "the sentence went missing while the fields were added");
  })();
});

await check("a plugin that said nothing about identity still produces the error every reader handles", () => {
  return (async () => {
    const gw = await fixture({ work: null });
    const silent: Plugin = {
      id: "box", version: "1.0.0", defaultForAllAgents: true,
      tools: [{ name: "run", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
      async invoke() { throw new Error("plain failure"); },
    };
    const store = new SqliteStore(":memory:");
    await store.init();
    await store.createAgent("t", "a");
    await store.addMount({
      tenantId: "t", agentId: "a", alias: "work", plugin: "box", installationId: "i", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
    });
    void gw;
    const g2 = new ToolGateway(store, [silent], new Set(([silent]).map((p: any) => p.id)), { async resolve() { return null; } });
    const r: any = await g2.invoke(ctx, "work.run", {});
    assert(!("identity" in r.error) && !("credentialRef" in r.error),
      `absent fields were invented: ${JSON.stringify(r.error)}`);
  })();
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
