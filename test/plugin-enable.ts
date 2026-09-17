/**
 * Switching a plugin off, and what must survive it.
 *
 * Two layers: the plugin says whether every agent gets it, and an agent may
 * answer for itself. `pluginEnabled` resolves the pair (Piper's half); this is
 * the half that stores the answer and acts on it — provisioning, the
 * catalogue, and the gateway.
 *
 * Three properties are worth more than the switch itself:
 *
 * - **Off has to stay off.** Provisioning runs on every console open and adds
 *   any seed that is missing, so without the check, turning a plugin off lasts
 *   until the next page load.
 * - **Off must not destroy anything.** A disabled mount keeps its credential,
 *   its connection state and its alias; the tools are withheld and the gateway
 *   refuses. Switching it back on returns what was there, and there is no
 *   unmount in this codebase precisely because that loss is not reversible.
 * - **Withholding the tools is not refusing the call.** A conversation opened
 *   before the switch still holds the old tool list, and `run_js` dispatches by
 *   address without consulting a catalogue at all.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { AgentRuntime, catalogueKey, enabledMounts, parsePluginChoice, reuseHarness, unofferedMounts } from "../cf/src/runtime.ts";
import { pluginEnabled, credentialForm } from "../src/plugins/types.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import { httpPlugin } from "../src/plugins/http.ts";
import { statePlugin } from "../src/plugins/state.ts";
import { artifactsPlugin } from "../src/plugins/artifacts.ts";
import { sandboxPlugin } from "../src/plugins/sandbox.ts";
import { builtinToolsPlugin } from "../src/plugins/builtin.ts";
import { demoPlugin } from "../src/plugins/demo.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const OFFERED: Plugin = {
  id: "offered", version: "1.0.0", defaultForAllAgents: true,
  tools: [{ name: "ping", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { return { ok: true }; },
};

async function fixture(plugins: Plugin[] = [OFFERED]) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const p of plugins) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias: p.id, plugin: p.id,
      installationId: `i-${p.id}`, connectionId: null, toolVersion: p.version,
      publicConfig: {}, secretRef: `secret-of-${p.id}`, policy: null,
    });
  }
  const gw = new ToolGateway(store, plugins, { async resolve() { return "value"; } });
  return { store, gw, ctx: { tenantId: "t", agentId: "a", taskId: "k" } };
}

await check("inherit 是【没有行】,不是存下来的第三个值", async () => {
  const { store } = await fixture();
  if (Object.keys(await store.pluginChoices("t", "a")).length) throw new Error("a fresh agent already had an answer");

  await store.setPluginChoice("t", "a", "offered", "disable");
  if ((await store.pluginChoices("t", "a")).offered !== "disable") throw new Error("the answer did not survive");

  await store.setPluginChoice("t", "a", "offered", "inherit");
  const back = await store.pluginChoices("t", "a");
  if ("offered" in back) {
    throw new Error(`inherit was stored as a value (${back.offered}); a stored copy of today's default keeps answering after the default changes`);
  }
});

await check("agent 自己的答案压过插件默认,两个方向都是", async () => {
  const on = { defaultForAllAgents: true }, off = { defaultForAllAgents: false };
  const cases: Array<[typeof on, any, boolean]> = [
    [on, "disable", false],   // the one that matters: turning a plugin on for
    [off, "enable", true],    // everyone must not re-arm it for someone who said no
    [on, "inherit", true],
    [off, "inherit", false],
    [on, undefined, true],
    [off, null, false],
  ];
  for (const [plugin, choice, want] of cases) {
    if (pluginEnabled(plugin, choice) !== want) {
      throw new Error(`${JSON.stringify(plugin)} + ${JSON.stringify(choice)} resolved to ${!want}`);
    }
  }
});

await check("关掉的种子不会在下次打开控制台时被加回来", async () => {
  // provision runs on every console open and adds whatever seed is missing.
  // Before the check, that reconcile silently undid the switch — which reads
  // as the button not working, not as a rule being applied twice.
  const store = new SqliteStore(":memory:");
  await store.init();
  const rt = new AgentRuntime({
    ctx: { storage: {} } as any, bucket: {} as any, bucketName: "b",
    models: { resolve: () => null } as any,
  } as any);
  (rt as any).store = store;
  (rt as any).ready = async () => {};
  const seeds = [{ alias: "web", plugin: "http", config: { account: "open web", maxBytes: 24_000 }, secretRef: null, policy: null }];

  await store.setPluginChoice("t", "a", "http", "disable");
  await rt.provision("t", "a", seeds as any);
  if (await store.getMountByAlias("t", "a", "web")) throw new Error("a disabled seed was mounted anyway");

  await rt.provision("t", "a", seeds as any);
  if (await store.getMountByAlias("t", "a", "web")) throw new Error("the reconcile put back what the agent switched off");

  await store.setPluginChoice("t", "a", "http", "inherit");
  await rt.provision("t", "a", seeds as any);
  if (!(await store.getMountByAlias("t", "a", "web"))) throw new Error("switching it back on did not restore the seed");
});

await check("关掉一个插件不销毁凭据和挂载", async () => {
  // There is no unmount in this codebase, and that is deliberate: a mount
  // carries a credential reference and connection state, and losing those is
  // not reversible. Off must be a withholding, not a deletion.
  const { store } = await fixture();
  await store.setPluginChoice("t", "a", "offered", "disable");
  const mount = await store.getMountByAlias("t", "a", "offered");
  if (!mount) throw new Error("switching a plugin off deleted the mount");
  if (mount.secretRef !== "secret-of-offered") throw new Error("the credential reference did not survive");
});

await check("会话里旧的工具表和 run_js 都不能绕过这个开关", async () => {
  // The catalogue is computed when a harness opens. A conversation older than
  // the switch still holds the old list, and `run_js` calls by address without
  // reading a catalogue at all — so withholding tools cannot be the whole of
  // it. The gateway is the choke point, as it is for credentials and policy.
  const { gw, store, ctx } = await fixture();
  const before = await gw.invoke(ctx, "offered.ping", {});
  if (before.status !== "succeeded") throw new Error(`the fixture does not work: ${JSON.stringify(before)}`);

  await store.setPluginChoice("t", "a", "offered", "disable");
  const after = await gw.invoke(ctx, "offered.ping", {});
  if (after.status !== "rejected" || after.error?.code !== "plugin_disabled") {
    throw new Error(`a switched-off mount answered a call by address: ${JSON.stringify(after)}`);
  }
  // The refusal is addressed to a model that must now do something else, so it
  // says a person reopens it — and it does not hand back a dispatch address.
  const message = String(after.error?.message ?? "");
  if (message.includes("offered.ping")) throw new Error(`the refusal names a dispatch address: ${message}`);
});

await check("关掉的挂载不出现在目录里,但装不出来的插件仍然留着", async () => {
  // Two different absences. A plugin the agent switched off is withheld: the
  // model is not offered its tools, because it would be refused for using
  // them. A mount naming a plugin nobody installed is kept, because it has its
  // own refusal and its own line in the console — dropping it would turn "this
  // mount is broken" into "this mount is gone".
  const installed = new Map<string, { defaultForAllAgents?: boolean }>([
    ["on", { defaultForAllAgents: true }],
    ["off", { defaultForAllAgents: false }],
  ]);
  const mounts = [
    { alias: "a", plugin: "on" }, { alias: "b", plugin: "off" },
    { alias: "c", plugin: "on" }, { alias: "d", plugin: "gone" },
  ];
  const kept = (choices: any) => enabledMounts(mounts, installed as any, choices).map((m) => m.alias).join("");

  if (kept({}) !== "acd") throw new Error(`by default: ${kept({})}`);
  if (kept({ on: "disable" }) !== "d") throw new Error(`switching a plugin off left its mounts in: ${kept({ on: "disable" })}`);
  if (kept({ off: "enable" }) !== "abcd") throw new Error(`switching one on did not bring it back: ${kept({ off: "enable" })}`);
  if (!kept({ on: "disable", off: "disable" }).includes("d")) {
    throw new Error("a mount pinned to an uninstalled plugin was dropped, so nothing reports it any more");
  }
});

await check("表单里来的字符串,不是三个词就不收", async () => {
  // The console posts a form, so what arrives is whatever the page sent. A
  // near miss is the dangerous one: `"disabled"` stored as-is resolves to
  // neither enable nor disable, and the agent's answer becomes a word nothing
  // reads.
  for (const good of ["enable", "disable", "inherit"]) {
    if (parsePluginChoice(good) !== good) throw new Error(`${good} was refused`);
  }
  for (const bad of ["disabled", "Enable", "off", "", null, undefined, 1, true]) {
    if (parsePluginChoice(bad) !== null) throw new Error(`${JSON.stringify(bad)} was accepted as a choice`);
  }
});

await check("种子只包含【用户什么都不用给就能用】的插件", async () => {
  // The other filter, and the reason it is not the same one. `enable` decides
  // whether a plugin may be mounted at all; this decides whether a new agent
  // may be handed one already mounted. A plugin whose credential is required
  // and personal cannot pass: the mount would look fine and 401 on the agent's
  // first call, which is the quiet failure `credential` exists to prevent.
  const artifacts: any = { put: async () => ({}), get: async () => null };
  const store: any = new Proxy({}, { get: () => async () => null });
  const registry: Plugin[] = [];
  registry.push(githubPlugin, demoPlugin, httpPlugin, sandboxPlugin(artifacts, "b"),
    statePlugin(store, artifacts, "b"), artifactsPlugin(artifacts, "b"),
    builtinToolsPlugin(store, () => registry));

  for (const seed of AgentRuntime.DEFAULT_MOUNTS as any[]) {
    const plugin = registry.find((p) => p.id === seed.plugin);
    if (!plugin) throw new Error(`seed ${seed.alias} names a plugin nobody installed`);
    const form = credentialForm((plugin as any).credential);
    const personal = form.kind !== "none" && form.accountRequired && !seed.secretRef;
    if (personal) {
      throw new Error(`seed ${seed.alias} needs a credential the user has not given yet, so a new agent gets a mount that fails on its first call`);
    }
  }
});

await check("unofferedMounts: 关了的算 switched_off · 没装的算 plugin_unavailable · 其余都提供", async () => {
  // run_js answers a stale name with the reason in this list. The two reasons
  // need different sentences — a person can switch one back on, the other needs
  // an operator — so a mount must never land in the wrong one.
  const installed = new Map<string, { defaultForAllAgents?: boolean }>([
    ["github", { defaultForAllAgents: false }],
    ["http", { defaultForAllAgents: true }],
  ]);
  const mounts = [{ alias: "gh", plugin: "github" }, { alias: "web", plugin: "http" }, { alias: "ghost", plugin: "nope" }];
  const read = (choices: Record<string, any>) =>
    unofferedMounts(mounts, installed as any, choices).map((u) => `${u.mount.alias}:${u.reason}`).sort().join();
  const byDefault = read({});
  if (byDefault !== "gh:switched_off,ghost:plugin_unavailable") throw new Error(`with no answers read ${byDefault}`);
  const flipped = read({ github: "enable", http: "disable" });
  if (flipped !== "ghost:plugin_unavailable,web:switched_off") throw new Error(`after flipping both answers read ${flipped}`);
  // Offered and unoffered partition every mount: nothing in both, nothing in neither.
  const offered = mounts.filter((m) => installed.has(m.plugin) && enabledMounts([m], installed as any, {}).length).map((m) => m.alias);
  const not = unofferedMounts(mounts, installed as any, {}).map((u) => u.mount.alias);
  if (offered.some((a) => not.includes(a)) || offered.length + not.length !== mounts.length) {
    throw new Error(`offered ${JSON.stringify(offered)} and unoffered ${JSON.stringify(not)} do not partition the mounts`);
  }
});

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

await check("a harness built while a plugin was off is rebuilt once it is back on, but never under a running turn", async () => {
  // Found on preview 2026-09-17: the tool list of a conversation opened while
  // github was off stayed off after it was switched back on.
  const mount = { alias: "gh", plugin: "github", toolVersion: "2.0.0", publicConfig: {}, secretRef: null, policy: null };
  const off = catalogueKey([mount], { github: "disable" });
  const on = catalogueKey([mount], {});
  must(off !== on, "switching a plugin back on left the key unchanged, so nothing would be rebuilt");
  must(!reuseHarness(off, on, false), "an idle harness built while the plugin was off was handed out again");
  must(reuseHarness(off, on, true), "a running turn had its harness replaced under it");
  must(reuseHarness(on, on, false), "an unchanged catalogue rebuilt the harness");
});

await check("the key follows every mount change the catalogue reads, and never holds the credential", async () => {
  const base = { alias: "gh", plugin: "github", toolVersion: "2.0.0", publicConfig: { a: 1 }, secretRef: null as string | null, policy: null as any };
  const k = (m: typeof base, extra: typeof base[] = []) => catalogueKey([m, ...extra], {});
  const other = { ...base, alias: "web", plugin: "http" };
  const changed = [
    ["a mount added", k(base, [other])],
    ["a version repinned", k({ ...base, toolVersion: "2.1.0" })],
    ["a setting changed", k({ ...base, publicConfig: { a: 2 } })],
    ["a credential attached", k({ ...base, secretRef: "agent:gh" })],
    ["a policy changed", k({ ...base, policy: { write: "approval" } })],
    ["a mount renamed", k({ ...base, alias: "github" })],
  ] as const;
  for (const [what, key] of changed) must(key !== k(base), `${what} left the key unchanged`);
  must(k(base, [other]) === catalogueKey([other, base], {}), "the same mounts in another order gave another key");
  const withRef = k({ ...base, secretRef: "agent:gh-very-specific-ref" });
  must(!withRef.includes("very-specific"), "the key carries the credential reference");
});

console.log(`\n  Switching a plugin off\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
