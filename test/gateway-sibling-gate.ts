/**
 * `sibling(alias)` hands a plugin another mount's credential, so it answers only for a mount the agent could
 * call. Before this, the call path refused a mount whose plugin was switched off, missing from the registry or
 * pinned to another version, and `sandboxForms` skipped it — but `sibling` resolved its credential anyway, and
 * named its plugin. Each case pairs the direct call (the control: refused, as it always was) with the sibling
 * read (refused now too), and a mount that is callable still answers, so a gate that refused everything would
 * not pass either.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const ctx = { tenantId: "t", agentId: "a", taskId: "k" };
const run = [{ name: "run", summary: "", parameters: {}, sideEffects: "read" as const, idempotency: "native" as const }];
const service = (id: string, version = "1.0.0"): Plugin => ({ id, version, tools: run, async invoke() { return { ran: id }; } });

// The plugin that asks: reports what each sibling answered, without the db handle.
const probe: Plugin = {
  id: "probe", version: "1.0.0",
  tools: [{ name: "peek", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke(_t, args, c) {
    const out: Record<string, unknown> = {};
    for (const alias of (args as { aliases: string[] }).aliases) {
      const s = await c.sibling(alias);
      out[alias] = s ? { credential: s.credential, plugin: s.plugin } : null;
    }
    return out as any;
  },
};

async function fixture() {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.createTask("t", "a", "k", {});
  const mount = (alias: string, plugin: string, toolVersion = "1.0.0") => store.addMount({
    tenantId: "t", agentId: "a", alias, plugin, installationId: `i-${alias}`, connectionId: null,
    toolVersion, publicConfig: {}, secretRef: `ref:${alias}`, policy: null,
  });
  await mount("p", "probe");
  await mount("ok", "svc");            // callable: the positive control
  await mount("old", "svc", "0.9.0");  // pinned to a version the registry no longer has
  await mount("acct", "offsvc");       // seeded, but switched off for this agent
  await mount("ghost", "gone");        // its plugin is not installed on this deployment, though switched on
  await mount("optin", "extra");       // not seeded, switched on for this agent
  await mount("dormant", "extra2");    // not seeded, never switched on
  await store.setPluginChoice("t", "a", "offsvc", "disable");
  await store.setPluginChoice("t", "a", "extra", "enable");
  // A choice outlives the plugin it names, so the registry check — not the switch — is what refuses `ghost`.
  await store.setPluginChoice("t", "a", "gone", "enable");
  const resolved: string[] = [];
  const plugins = [probe, service("svc"), service("offsvc"), service("extra"), service("extra2")];
  const gw = new ToolGateway(store, plugins, new Set(["probe", "svc", "offsvc"]), {
    async resolve(ref: string) { resolved.push(ref); return `secret-of-${ref}`; },
  } as any);
  const peek = async (...aliases: string[]) => {
    const r: any = await gw.invoke(ctx, "p.peek", { aliases });
    assert(r.status === "succeeded", `the probe did not run: ${JSON.stringify(r)}`);
    return r.result as Record<string, { credential: string | null; plugin: string } | null>;
  };
  return { gw, peek, resolved };
}

/** Refused, and refused without a trace of the mount: no credential, no plugin name, and nothing resolved. */
async function refusedBoth(alias: string, code: string) {
  const { gw, peek, resolved } = await fixture();
  const direct: any = await gw.invoke(ctx, `${alias}.run`, {});
  assert(direct.status === "rejected" && direct.error?.code === code, `control: the direct call answered ${JSON.stringify(direct)}`);
  const got = await peek(alias);
  assert(got[alias] === null, `sibling("${alias}") answered ${JSON.stringify(got[alias])}`);
  assert(!resolved.includes(`ref:${alias}`), `sibling("${alias}") resolved its credential: ${JSON.stringify(resolved)}`);
}

await check("a callable sibling still hands over its credential and names its plugin (control)", async () => {
  const { gw, peek } = await fixture();
  const direct: any = await gw.invoke(ctx, "ok.run", {});
  assert(direct.status === "succeeded", `the direct call answered ${JSON.stringify(direct)}`);
  const got = await peek("ok");
  assert(got.ok?.credential === "secret-of-ref:ok" && got.ok.plugin === "svc", `sibling("ok") answered ${JSON.stringify(got.ok)}`);
});

await check("a sibling switched on for this agent answers though its plugin is not seeded (control)", async () => {
  const { gw, peek } = await fixture();
  const direct: any = await gw.invoke(ctx, "optin.run", {});
  assert(direct.status === "succeeded", `the direct call answered ${JSON.stringify(direct)}`);
  const got = await peek("optin");
  assert(got.optin?.credential === "secret-of-ref:optin", `sibling("optin") answered ${JSON.stringify(got.optin)}`);
});

await check("a sibling pinned to another version is refused, as its call is", () => refusedBoth("old", "version_mismatch"));
await check("a sibling whose plugin is switched off is refused, as its call is", () => refusedBoth("acct", "plugin_disabled"));
await check("a sibling never switched on (not seeded, no choice) is refused, as its call is", () => refusedBoth("dormant", "plugin_disabled"));
await check("a sibling whose plugin is not installed is refused, as its call is", () => refusedBoth("ghost", "plugin_unavailable"));

// Being removed is the fourth refusal a call has (`markRemoving`, set by `AgentRuntime.removeMount`): the mount
// still exists in the store while its unmount runs, so only the mark stops its credential being handed out.
await check("a sibling being removed is refused, as its call is", async () => {
  const { gw, peek, resolved } = await fixture();
  const before = await peek("ok");
  assert(before.ok?.credential === "secret-of-ref:ok", `control: before the mark, sibling("ok") answered ${JSON.stringify(before.ok)}`);
  resolved.length = 0;
  const unmark = gw.markRemoving("t", "a", "ok");
  const direct: any = await gw.invoke(ctx, "ok.run", {});
  assert(direct.status === "rejected" && direct.error?.code === "not_mounted", `control: the direct call answered ${JSON.stringify(direct)}`);
  const got = await peek("ok");
  assert(got.ok === null, `sibling("ok") answered ${JSON.stringify(got.ok)} while it is being removed`);
  assert(!resolved.includes("ref:ok"), `sibling("ok") resolved its credential while it is being removed: ${JSON.stringify(resolved)}`);
  unmark();
  const after = await peek("ok");
  assert(after.ok?.credential === "secret-of-ref:ok", `after the mark is lifted, sibling("ok") answered ${JSON.stringify(after.ok)}`);
});

await check("a mount being removed is not wired into the container (sandboxForms)", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.createTask("t", "a", "k", {});
  for (const [alias, plugin] of [["box", "boxsvc"], ["gh", "formsvc"]] as const) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, plugin, installationId: `i-${alias}`, connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: `ref:${alias}`, policy: null,
    });
  }
  const resolved: string[] = [];
  const box: Plugin = {
    id: "boxsvc", version: "1.0.0",
    tools: [{ name: "forms", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
    async invoke(_t, _a, c) { return { aliases: (await c.sandboxForms()).map((f) => f.alias) } as any; },
  };
  const withForm: Plugin = {
    ...service("formsvc"),
    sandboxForm: { summary: "", egress: [], env: () => ({}) },
  };
  const gw = new ToolGateway(store, [box, withForm], new Set(["boxsvc", "formsvc"]), {
    async resolve(ref: string) { resolved.push(ref); return `secret-of-${ref}`; },
  } as any);
  const forms = async () => {
    const r: any = await gw.invoke(ctx, "box.forms", {});
    assert(r.status === "succeeded", `the probe did not run: ${JSON.stringify(r)}`);
    return (r.result as { aliases: string[] }).aliases;
  };
  const before = await forms();
  assert(before.includes("gh"), `control: before the mark, sandboxForms listed ${JSON.stringify(before)}`);
  resolved.length = 0;
  const unmark = gw.markRemoving("t", "a", "gh");
  const during = await forms();
  assert(!during.includes("gh"), `sandboxForms listed ${JSON.stringify(during)} while gh is being removed`);
  assert(!resolved.includes("ref:gh"), `sandboxForms resolved gh's credential while it is being removed: ${JSON.stringify(resolved)}`);
  unmark();
  assert((await forms()).includes("gh"), "after the mark is lifted, sandboxForms no longer lists gh");
});

await check("a missing sibling is still null", async () => {
  const { peek } = await fixture();
  const got = await peek("nope");
  assert(got.nope === null, `sibling("nope") answered ${JSON.stringify(got.nope)}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
