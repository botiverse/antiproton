/**
 * `sibling(alias)` hands a plugin another mount's credential, so it answers only for a mount the agent could
 * call. Before this, the call path refused a mount whose plugin was switched off, missing from the registry or
 * pinned to another version, and `sandboxForms` skipped it — but `sibling` resolved its credential anyway, and
 * named its plugin. Each case pairs the direct call (the control: refused, as it always was) with the sibling
 * read (refused now too), and a mount that is callable still answers, so a gate that refused everything would
 * not pass either.
 *
 * And the credential of a callable sibling goes only to that mount's own plugin and the plugins its plugin lists in
 * `Plugin.siblingReaders`: the raft mount's credential reaches Raft's Agent Login directly, past every refusal the
 * raft plugin makes, so any other plugin gets the sibling with `credential: null` (plugin, db and policy as before).
 * The asker is matched by the plugin id the platform recorded on its mount, never an alias its owner chose, and an id
 * names one plugin: a second registration under an existing id is refused, so no plugin takes a listed one's place.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { createRaftPlugin } from "../src/plugins/raft.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const ctx = { tenantId: "t", agentId: "a", taskId: "k" };
const run = [{ name: "run", summary: "", parameters: {}, sideEffects: "read" as const, idempotency: "native" as const }];
// Each lets the probe read its mounts' credential (`siblingReaders`), so these cases are about callability alone.
const service = (id: string, version = "1.0.0"): Plugin => ({ id, version, tools: run, async invoke() { return { ran: id }; }, siblingReaders: ["probe"] });

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

// ---- Who may read a sibling's credential (`Plugin.siblingReaders`) ----

const RAFT_CREDENTIAL = "sk_agent_sibling_gate_0123456789";

/** A plugin whose one tool reports what `ctx.sibling(alias)` handed it. */
function asker(id: string): Plugin {
  return {
    id, version: "1.0.0",
    tools: [{ name: "peek", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
    async invoke(_tool, args, ctx) {
      const s = await ctx.sibling(String((args as { alias?: unknown })?.alias ?? "raft"));
      return s ? { credential: s.credential, plugin: s.plugin, db: typeof s.db?.get === "function", kind: s.credentialRefKind ?? null } : { none: true };
    },
  } as Plugin;
}

const raft = createRaftPlugin();

async function gated(plugins: Plugin[], mounts: Array<{ alias: string; plugin: string }>) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  const all = [raft, ...plugins];
  const version = (id: string) => all.find((p) => p.id === id)!.version;
  await store.addMount({ tenantId: "t", agentId: "a", alias: "raft", plugin: "raft", installationId: "i-raft", connectionId: null,
    toolVersion: version("raft"), publicConfig: { serverUrl: "https://raft.example" }, secretRef: "secret:raft", policy: null });
  for (const m of mounts) {
    await store.addMount({ tenantId: "t", agentId: "a", alias: m.alias, plugin: m.plugin, installationId: `i-${m.alias}`, connectionId: null,
      toolVersion: version(m.plugin), publicConfig: {}, secretRef: null, policy: null });
  }
  const resolved: string[] = [];
  const gateway = new ToolGateway(store, all, new Set(all.map((p) => p.id)),
    { async resolve(ref: string) { resolved.push(ref); return ref === "secret:raft" ? RAFT_CREDENTIAL : null; } });
  return Object.assign(async (alias: string, args: unknown = {}) => {
    const r = await gateway.invoke(ctx, `${alias}.peek`, args as any) as any;
    assert(r.status === "succeeded", `${alias}.peek: ${JSON.stringify(r)}`);
    return r.result as { credential?: string | null; plugin?: string; db?: boolean; kind?: string | null; none?: true };
  }, { resolved });
}

await check("raft names who may read its credential: stamp and raftbench, and that is a security decision written beside it", async () => {
  assert(JSON.stringify(raft.siblingReaders) === JSON.stringify(["stamp", "raftbench"]), `siblingReaders: ${JSON.stringify(raft.siblingReaders)}`);
});

await check("a listed plugin gets the raft credential; one not listed gets the mount with credential null, plugin and db unchanged", async () => {
  const peek = await gated([asker("stamp"), asker("raftbench"), asker("reminder"), asker("newcomer")],
    [{ alias: "stamp", plugin: "stamp" }, { alias: "bench", plugin: "raftbench" }, { alias: "reminder", plugin: "reminder" }, { alias: "newcomer", plugin: "newcomer" }]);
  for (const alias of ["stamp", "bench"]) {
    const s = await peek(alias);
    assert(s.credential === RAFT_CREDENTIAL && s.plugin === "raft", `${alias}: ${JSON.stringify(s)}`);
  }
  for (const alias of ["reminder", "newcomer"]) {
    peek.resolved.length = 0;
    const s = await peek(alias);
    assert(!peek.resolved.includes("secret:raft"), `${alias}'s read resolved the raft credential`);
    assert(s.credential === null, `${alias} was handed the raft credential`);
    // What reminder reads (which plugin the mount is) and the database are as they were.
    assert(s.plugin === "raft" && s.db === true, `${alias}: ${JSON.stringify(s)}`);
  }
});

await check("the asker is its mount's plugin, not its alias: a mount named stamp of another plugin gets no credential", async () => {
  const peek = await gated([asker("newcomer")], [{ alias: "stamp", plugin: "newcomer" }, { alias: "raftbench", plugin: "newcomer" }]);
  for (const alias of ["stamp", "raftbench"]) {
    const s = await peek(alias);
    assert(s.credential === null && s.plugin === "raft", `a ${alias}-named mount of another plugin: ${JSON.stringify(s)}`);
  }
});

await check("a plugin's own mounts read each other as before: the gate is about other plugins", async () => {
  const mine = asker("ledger");
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const alias of ["one", "two"]) {
    await store.addMount({ tenantId: "t", agentId: "a", alias, plugin: "ledger", installationId: `i-${alias}`, connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: `secret:${alias}`, policy: null });
  }
  const gateway = new ToolGateway(store, [mine], new Set(["ledger"]), { async resolve(ref: string) { return `cred-of-${ref}`; } });
  const r = await gateway.invoke(ctx, "one.peek", { alias: "two" }) as any;
  assert(r.status === "succeeded" && r.result.credential === "cred-of-secret:two", JSON.stringify(r));
});

await check("an id names one plugin: a second plugin registered under an existing id is refused, not kept over the first", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  let threw = "";
  try { new ToolGateway(store, [asker("stamp"), raft, asker("stamp")], new Set()); } catch (e) { threw = String((e as Error).message); }
  assert(/two plugins are registered as "stamp"/.test(threw), `a second "stamp" was accepted: ${threw || "no error"}`);
  threw = "";
  try { new ToolGateway(store, [raft, createRaftPlugin()], new Set()); } catch (e) { threw = String((e as Error).message); }
  assert(/"raft"/.test(threw), `a second "raft" was accepted: ${threw || "no error"}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
