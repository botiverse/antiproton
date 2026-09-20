/**
 * An operator adding a mount the defaults do not give (`/admin/mounts`).
 * The runtime half: every silent skip of `provision` becomes an answer, and an
 * alias that is already taken is never replaced.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { AgentRuntime, reconcileSeed } from "../cf/src/runtime.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { httpPlugin } from "../src/plugins/http.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const NEEDS_ACCOUNT: Plugin = {
  id: "needs-account", version: "1.0.0", defaultForAllAgents: true,
  config: [
    { name: "origin", type: "string", required: true, summary: "Where it calls." },
    { name: "scope", type: "string", requiredWithCredential: true, summary: "What the account may do." },
  ],
  credential: { required: true, summary: "An account.", shape: "token" },
  tools: [{ name: "ping", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { return { ok: true }; },
};

async function runtime() {
  const store = new SqliteStore(":memory:");
  await store.init();
  const rt = new AgentRuntime({
    ctx: { storage: {} } as any, bucket: {} as any, bucketName: "b",
    models: { resolve: () => null } as any, extraPlugins: [NEEDS_ACCOUNT],
  } as any);
  (rt as any).store = store;
  (rt as any).ready = async () => {};
  return { store, rt };
}

const web = { alias: "web2", plugin: "http", config: { account: "open web", maxBytes: 24_000 } };

await check("a mount is added, and adding the same one again is a repeat", async () => {
  const { store, rt } = await runtime();
  const first = await rt.addMount("t", "a", web);
  must(first.ok && first.added === true, `first: ${JSON.stringify(first)}`);
  const m = await store.getMountByAlias("t", "a", "web2");
  must(m?.plugin === "http" && m.secretRef === null && m.policy === null, `mount: ${JSON.stringify(m)}`);
  const again = await rt.addMount("t", "a", web);
  must(again.ok && again.added === false, `again: ${JSON.stringify(again)}`);
});

await check("an alias that is a different mount is refused, not replaced", async () => {
  const { store, rt } = await runtime();
  await rt.addMount("t", "a", web);
  const other = await rt.addMount("t", "a", { ...web, config: { account: "open web", maxBytes: 1_000 } });
  must(!other.ok && /already a different mount/.test(other.error), `other config: ${JSON.stringify(other)}`);
  const plugin = await rt.addMount("t", "a", { alias: "web2", plugin: "state", config: { account: "x" } });
  must(!plugin.ok, `other plugin: ${JSON.stringify(plugin)}`);
  must((await store.getMountByAlias("t", "a", "web2"))?.publicConfig?.maxBytes === 24_000, "the mount changed");
  // Same settings, another plugin: only the plugin comparison can refuse this.
  const samePlugin = await rt.addMount("t", "a", { ...web, plugin: "needs-account" });
  must(!samePlugin.ok && /already a different mount/.test(samePlugin.error), `same settings, other plugin: ${JSON.stringify(samePlugin)}`);
});

await check("a default alias is not given to another plugin, even while its seed is switched off", async () => {
  const { store, rt } = await runtime();
  await store.setPluginChoice("t", "a", "http", "disable");
  const r = await rt.addMount("t", "a", { alias: "web", plugin: "needs-account", config: { origin: "https://x.test" } });
  must(!r.ok && /default http mount/.test(r.error), `took web: ${JSON.stringify(r)}`);
  must(!(await store.getMountByAlias("t", "a", "web")), "mounted anyway");
});

await check("a switched-off plugin is an answer, not a silent skip", async () => {
  const { store, rt } = await runtime();
  await store.setPluginChoice("t", "a", "http", "disable");
  const r = await rt.addMount("t", "a", web);
  must(!r.ok && /switched off/.test(r.error), `off: ${JSON.stringify(r)}`);
  must(!(await store.getMountByAlias("t", "a", "web2")), "mounted anyway");
});

await check("an unknown plugin, a bad alias and an undeclared setting are refused", async () => {
  const { store, rt } = await runtime();
  const nope = await rt.addMount("t", "a", { alias: "x", plugin: "nope", config: {} });
  must(!nope.ok && /no plugin named nope/.test(nope.error), `unknown: ${JSON.stringify(nope)}`);
  for (const alias of ["", "Web", "a__b", "1web", "w".repeat(25)]) {
    const r = await rt.addMount("t", "a", { ...web, alias });
    must(!r.ok && /an alias is/.test(r.error), `alias ${JSON.stringify(alias)}: ${JSON.stringify(r)}`);
  }
  const typo = await rt.addMount("t", "a", { ...web, config: { account: "open web", max_bytes: 1 } });
  must(!typo.ok, `undeclared setting: ${JSON.stringify(typo)}`);
  must((await store.listMounts("t", "a")).length === 0, "something was mounted");
});

await check("a plugin that needs an account is mounted without one", async () => {
  // The credential form needs the mount to exist, so requiring the account at
  // mount time would make such a plugin unmountable. Its other rules still hold.
  const { store, rt } = await runtime();
  const r = await rt.addMount("t", "a", { alias: "acct", plugin: "needs-account", config: { origin: "https://x.test" } });
  must(r.ok && r.added, `needs an account: ${JSON.stringify(r)}`);
  must((await store.getMountByAlias("t", "a", "acct"))?.secretRef === null, "a credential reference was set");
  const noOrigin = await rt.addMount("t", "a", { alias: "acct2", plugin: "needs-account", config: {} });
  must(!noOrigin.ok && /origin/.test(noOrigin.error), `a required setting missing: ${JSON.stringify(noOrigin)}`);
  // The switch only lifts the account rule for this call; the plugin itself is unchanged.
  must(NEEDS_ACCOUNT.credential?.required === true, "the plugin's own declaration was changed");
});

await check("the console's reconcile leaves another plugin's mount under a seed alias alone", async () => {
  const seed = { alias: "web", plugin: "http", config: { account: "open web", maxBytes: 24_000 } };
  const other = reconcileSeed({ plugin: "raft", publicConfig: { serverUrl: "https://r.test" }, secretRef: null }, seed, httpPlugin);
  must("refused" in other && /raft mount, not the http seed/.test(other.refused), `other plugin: ${JSON.stringify(other)}`);
  const same = reconcileSeed({ plugin: "http", publicConfig: seed.config, secretRef: null }, seed, httpPlugin);
  must("update" in same && same.update === null, `unchanged: ${JSON.stringify(same)}`);
  const drift = reconcileSeed({ plugin: "http", publicConfig: { account: "open web", maxBytes: 48_000 }, secretRef: null }, seed, httpPlugin);
  must("update" in drift && drift.update?.maxBytes === 24_000, `drifted: ${JSON.stringify(drift)}`);
  // A credential and no allowlist is forbidden, so that seed is not applied under a key.
  const keyed = reconcileSeed({ plugin: "http", publicConfig: { account: "x" }, secretRef: "agent:web" }, seed, httpPlugin);
  must("refused" in keyed, `under a credential: ${JSON.stringify(keyed)}`);
});

/**
 * Renaming obeys the rule adding obeys (#439).
 *
 * `MOUNT_ALIAS` had one caller — the add path — so a rename could reach a name
 * the charset forbids. That is not cosmetic, because `:` is what separates a
 * mount's credential row (named after its alias) from an inbound hook's
 * `hook:<id>` inside the ONE per-agent secrets namespace: a credential-less
 * mount renamed onto a live hook's name, then given a credential, replaces
 * that hook's signing secret with an upsert that checks nothing. The service
 * keeps posting and the signature stops matching, several steps from the cause
 * The whole chain has been demonstrated against a real store, not argued from the code.
 *
 * On the Durable Object rather than the stub above: a rename that is ALLOWED
 * runs through the gateway and the store, and the stub's runtime keeps a
 * gateway pointing at a different store than the one the test injects — so it
 * can only ever observe a refusal, and a guard checked only by refusals is one
 * that "refuse everything" would also pass.
 */
async function realRuntime() {
  const host = sqliteHost();
  const rt: any = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any, extraPlugins: [],
  } as any);
  await rt.store.init();
  rt.ready = async () => {};
  await rt.store.createAgent("t", "a");
  await rt.addMount("t", "a", web);
  return rt;
}

await check("a rename is held to the same alias rule as an add", async () => {
  const rt = await realRuntime();
  // The name an inbound hook's secret is filed under (src/runtime/inbound.ts).
  const r = await rt.renameMount("t", "a", "web2", "hook:h-1");
  must(!r.ok, `renaming onto a hook's secret name was allowed: ${JSON.stringify(r)}`);
  must(/an alias is/.test(r.error ?? ""), `refused for some other reason: ${JSON.stringify(r)}`);
  // And the mount is where it was: a refusal that half-moved it would be worse than the bug.
  must(await rt.store.getMountByAlias("t", "a", "web2"), "the mount left its old name behind");
  must(!(await rt.store.getMountByAlias("t", "a", "hook:h-1")), "the mount arrived under the forbidden name");
});

await check("what it refuses is the charset, and a legal rename still goes through", async () => {
  const rt = await realRuntime();
  // Nothing is stored under this name: the rule has to hold on an alias that
  // collides with nothing, or it is only the uniqueness check wearing a new hat.
  const bad = await rt.renameMount("t", "a", "web2", "Web2");
  must(!bad.ok && /an alias is/.test(bad.error ?? ""), `an alias outside the charset was accepted: ${JSON.stringify(bad)}`);
  // The other half, which a "refuse everything" guard would fail: the mount really moves.
  const ok = await rt.renameMount("t", "a", "web2", "web-3");
  must(ok.ok, `a legal rename was refused: ${JSON.stringify(ok)}`);
  must(await rt.store.getMountByAlias("t", "a", "web-3"), "the legal rename answered ok without moving the mount");
});

console.log(`\n  Adding a mount by hand\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
