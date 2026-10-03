/**
 * Mounts and kept secrets from the console: `POST /ui/mount/add`, `/ui/mount/refresh`,
 * `/ui/mount/remove`, `/ui/secret`, `/ui/secret/remove`, and `kept` on `GET /ui/plugins`.
 *
 * Two halves. The runtime's rules first, on the real Durable Object store over node:sqlite with a
 * stand-in plugin whose snapshot and `configProblem` the cases control. Then the routes, through
 * the Worker's own `fetch` and `AgentDO` (the `cloudflare:workers` stand-in test/pd-migrate-object.ts
 * uses), with the real `mcp` plugin talking to an in-process server put in place of `globalThis.fetch`,
 * so the sign-in gate, the anonymous refusal, the ownership check and the answers are the shipped ones.
 */
import { register } from "node:module";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { mcpPlugin } from "../src/plugins/mcp.ts";
import { configFromForm } from "../src/runtime/mount-config.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { sessionCookieFor } from "../cf/src/auth.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { AgentRuntime, CONSOLE_MOUNTS_MAX, consoleAdded } = await import("../cf/src/runtime.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

// Every line the code under test prints, so a secret value can be looked for in the logs too.
const logged: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : show(a))).join(" ")); if (level !== "log") real(...args); };
}

const KEK = Buffer.alloc(32, 7).toString("base64");

// ---- the runtime ------------------------------------------------------------

/** Holds a "slow" server's listing until the case lets it go. */
let releaseSlow: () => void = () => {};
const slowListing = () => new Promise<void>((r) => { releaseSlow = r; });
let slowGate: Promise<void> | null = null;

/** A plugin offered to the console, whose server is the case's to decide. */
const REMOTE: Plugin = {
  id: "remote", version: "1.0.0", consoleMount: true, tools: [],
  config: [
    { name: "url", type: "string", required: true, summary: "Where." },
    { name: "headers", type: "string[]", summary: "Sent." },
    { name: "timeoutMs", type: "number", min: 1, max: 60_000, summary: "How long." },
  ],
  configProblem: (c) => (String(c.url).includes("inward") ? "the url points inward" : undefined),
  mountTools: (m) => m.toolSnapshot?.tools ?? [],
  async snapshotTools(ctx) {
    if (String(ctx.publicConfig?.url).includes("down")) throw new Error("the server is down");
    if (String(ctx.publicConfig?.url).includes("slow") && slowGate) {
      await slowGate;
      return { tools: [{ name: "old_tool", summary: "From the removed mount's server.", parameters: { type: "object" }, sideEffects: "read", idempotency: "none" }] };
    }
    return { tools: [{ name: "ping", summary: "Ping.", parameters: { type: "object" }, sideEffects: "read", idempotency: "none" }] };
  },
  async invoke() { return {}; },
};
/** The same, without the console flag: only the operator may add it. */
const OPERATOR_ONLY: Plugin = { ...REMOTE, id: "operator-only", consoleMount: undefined };

async function runtime(opts: { kek?: boolean } = {}) {
  const host = sqliteHost();
  const rt: any = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    extraPlugins: [REMOTE, OPERATOR_ONLY], ...(opts.kek === false ? {} : { secretKek: KEK }),
  } as any);
  await rt.store.init();
  rt.ready = async () => {};
  await rt.store.createAgent("t", "a");
  return { rt, host };
}
const form = (url: string, extra: Record<string, string> = {}) => ({ url, ...extra });
const noHooks = { list: async () => [] };

// Who can reach an owner's secret, one property per case so a red names which one broke.
const pluginsDir = new URL("../src/plugins/", import.meta.url);
async function pluginFilesMatching(re: RegExp): Promise<string[]> {
  const { readdirSync, readFileSync } = await import("node:fs");
  return (readdirSync(pluginsDir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && f !== "types.ts" && re.test(readFileSync(new URL(f, pluginsDir), "utf8")))
    .sort();
}
/**
 * Each entry of the deployment's plugin list, as written in cf/src/runtime.ts.
 * A tripwire over that text, not a proof: a key or store bound to a name before
 * the list and passed by that name is not seen, and a `Plugin` built elsewhere
 * (`extraPlugins` arrive built) is outside it: its reach was decided where it was
 * constructed. What it does refuse is a second change to the list (a non-empty
 * starting list, or another list kept as the runtime's, included), an entry
 * handed the whole runtime, and an entry handed `#secrets` (the resolver that
 * decrypts `agent:` references), the routes that would bypass it in plain sight.
 */
async function deployedPluginEntries(): Promise<string[]> {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../cf/src/runtime.ts", import.meta.url), "utf8");
  // The list starts empty and is the one the runtime keeps, so the push below is the only place an entry is written.
  const inits = src.match(/(?<![#.\w])plugins\s*(:[^=;]*)?=(?!=)[^;]*;/g) ?? [];
  must(show(inits) === show(["plugins: Plugin[] = [];"]), `cf/src/runtime.ts sets up the plugin list as ${show(inits)}, not one empty \`const plugins: Plugin[] = [];\`; this test reads only the one plugins.push( list`);
  const kept = src.match(/this\.#plugins\s*=(?!=)[^;]*;/g) ?? [];
  must(show(kept) === show(["this.#plugins = plugins;"]), `cf/src/runtime.ts keeps ${show(kept)} as its plugins, not the one list; this test reads only the one plugins.push( list`);
  const writes = src.match(/\bplugins\s*(\.\s*(push|unshift|splice|fill|copyWithin)\b|\[[^\]]*\]\s*=(?!=))/g) ?? [];
  must(writes.length === 1, `cf/src/runtime.ts changes the plugin list ${writes.length} times (${show(writes)}); this test reads only the one plugins.push( list`);
  const list = /plugins\.push\(\n([\s\S]*?)\n\s*\);/.exec(src);
  must(list, "cf/src/runtime.ts has no plugins.push( list; this test reads the deployment's plugins from it");
  const entries = list![1]!.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  const handedRuntime = entries.filter((e) => /\bthis\b(?!\s*\.)/.test(e));
  must(!handedRuntime.length, `plugins handed the whole runtime, and with it the key and the store: ${show(handedRuntime)}`);
  return entries;
}

// Exact lists below, so a pattern that matches nothing fails as surely as a second member.
await check("only mcp.ts, of the plugin files but types.ts, names ownerSecret", async () => {
  const readers = await pluginFilesMatching(/ownerSecret/);
  must(show(readers) === show(["mcp.ts"]), `plugins that read owner secrets: ${show(readers)}; ownerSecret is only for a value sent where a mount's settings say (PluginContext.ownerSecret)`);
});

await check("only mcp declares readsOwnerSecrets, the grant the gateway reads", async () => {
  const granted = await pluginFilesMatching(/readsOwnerSecrets\s*:\s*true/);
  must(show(granted) === show(["mcp.ts"]), `plugins that declare readsOwnerSecrets: ${show(granted)}`);
});

await check("only statePlugin is handed the sealing key or the secret resolver, only it and builtin the raw store, and state.ts never names the owner's prefix", async () => {
  // The key, not an import, is what decrypts: read where the deployment hands it out.
  const entries = await deployedPluginEntries();
  // The resolver (`#secrets`) already opens what the key opens, so handing it out counts the same.
  const keyed = entries.filter((e) => /kek|#secrets\b/i.test(e)).map((e) => e.split("(")[0]);
  must(show(keyed) === show(["statePlugin"]), `plugins handed the sealing key or the secret resolver: ${show(keyed)}; only state may, and only under kept: (Plugin.readsOwnerSecrets)`);
  const stores = entries.filter((e) => /this\.store\b/.test(e)).map((e) => e.split("(")[0]);
  must(show(stores) === show(["statePlugin", "builtinToolsPlugin"]), `plugins handed the raw store: ${show(stores)}; with it, a plugin can list, overwrite and delete owner secrets (Plugin.readsOwnerSecrets)`);
  const { readFileSync } = await import("node:fs");
  must(!/OWNER_PREFIX/.test(readFileSync(new URL("state.ts", pluginsDir), "utf8")), "state.ts names OWNER_PREFIX; its tools read only kept: (Plugin.readsOwnerSecrets)");
});

await check("configFromForm: lines with blanks dropped, a number via Number(), blank means absent, strings trimmed", () => {
  const fields = REMOTE.config!;
  const r = configFromForm(fields, { url: "  https://x.test/mcp ", headers: "A: 1\n\n  \r\nB: {{k}}  \n", timeoutMs: " 2500 ", alias: "x" });
  must(r.ok && show(r.config) === show({ url: "https://x.test/mcp", headers: ["A: 1", "B: {{k}}"], timeoutMs: 2500 }), show(r));
  const blank = configFromForm(fields, { url: "https://x.test", headers: "\n \n", timeoutMs: "  " });
  must(blank.ok && show(blank.config) === show({ url: "https://x.test" }), `blank fields were kept: ${show(blank)}`);
  const nan = configFromForm(fields, { url: "https://x.test", timeoutMs: "soon" });
  must(!nan.ok && /should be a number/.test(nan.error), `NaN was let through: ${show(nan)}`);
});

await check("a console add stores the mount marked as console-added, switches the plugin on, and keeps its tools", async () => {
  const { rt } = await runtime();
  must((await rt.store.pluginChoices("t", "a"))["remote"] === undefined, "control: the plugin already had a choice");
  const r = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test/mcp", { headers: "X-Key: {{key}}\n" }));
  must(r.ok && r.added && r.tools?.ok && show(r.tools.tools) === show(["ping"]), `add: ${show(r)}`);
  const m = await rt.store.getMountByAlias("t", "a", "srv");
  must(m && consoleAdded(m) && show(m.publicConfig.headers) === show(["X-Key: {{key}}"]), `mount: ${show(m)}`);
  must(m.toolSnapshot?.tools?.[0]?.name === "ping", "no tool snapshot was kept");
  must((await rt.store.pluginChoices("t", "a"))["remote"] === "enable", "inherit was not turned into enable");
  // The operator's path marks nothing.
  const admin = await rt.addMount("t", "a", { alias: "op", plugin: "remote", config: { url: "https://op.test" } });
  must(admin.ok && !consoleAdded(await rt.store.getMountByAlias("t", "a", "op")), "an operator's mount reads as console-added");
});

await check("a snapshot that fails keeps the mount and says why", async () => {
  const { rt } = await runtime();
  const r = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://down.test/mcp"));
  must(r.ok && r.added && r.tools && !r.tools.ok && /server is down/.test(r.tools.error), `add: ${show(r)}`);
  must(await rt.store.getMountByAlias("t", "a", "srv"), "the mount was not kept");
});

await check("a plugin without consoleMount is refused from the console, before anything is stored", async () => {
  const { rt } = await runtime();
  for (const plugin of ["operator-only", "http", "state"]) {
    const r = await rt.addConsoleMount("t", "a", plugin, "x", form("https://x.test"));
    must(!r.ok && /cannot be added from the console/.test(r.error), `${plugin}: ${show(r)}`);
  }
  must((await rt.store.listMounts("t", "a")).length === 0, "something was mounted");
  must(Object.keys(await rt.store.pluginChoices("t", "a")).length === 0, "a choice was recorded");
  // The flag itself: mcp sets it, and no other installed plugin does.
  must(mcpPlugin.consoleMount === true, "mcp is not offered to the console");
  const flagged = rt.plugins().filter((p: Plugin) => p.consoleMount).map((p: Plugin) => p.id).sort();
  must(show(flagged) === show(["mcp", "remote"]), `offered to the console: ${show(flagged)}`);
});

await check("an explicit disable is refused, not overridden", async () => {
  const { rt } = await runtime();
  await rt.store.setPluginChoice("t", "a", "remote", "disable");
  const r = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test"));
  must(!r.ok && /switched off/.test(r.error), show(r));
  must(!(await rt.store.getMountByAlias("t", "a", "srv")), "mounted anyway");
  must((await rt.store.pluginChoices("t", "a"))["remote"] === "disable", "the owner's disable was changed");
});

await check(`the cap: ${CONSOLE_MOUNTS_MAX} console-added mounts, and operator mounts do not count`, async () => {
  const { rt } = await runtime();
  await rt.addMount("t", "a", { alias: "op", plugin: "remote", config: { url: "https://op.test" } }); // the operator's
  for (let i = 0; i < CONSOLE_MOUNTS_MAX; i++) {
    const r = await rt.addConsoleMount("t", "a", "remote", `s${i}`, form(`https://s${i}.test`));
    must(r.ok && r.added, `mount ${i}: ${show(r)}`);
  }
  const over = await rt.addConsoleMount("t", "a", "remote", "one-more", form("https://more.test"));
  must(!over.ok && /most it may have/.test(over.error), `the ${CONSOLE_MOUNTS_MAX + 1}th: ${show(over)}`);
  must(!(await rt.store.getMountByAlias("t", "a", "one-more")), "the one over the cap was stored");
  must((await rt.removeMount("t", "a", "s0", noHooks)).ok, "remove one");
  const again = await rt.addConsoleMount("t", "a", "remote", "one-more", form("https://more.test"));
  must(again.ok && again.added, `after removing one: ${show(again)}`);
});

await check("configProblem and the declared checks refuse before anything is stored, on every path", async () => {
  const { rt } = await runtime();
  const own = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://inward.test"));
  must(!own.ok && /points inward/.test(own.error), `configProblem, console: ${show(own)}`);
  const missing = await rt.addConsoleMount("t", "a", "remote", "srv", {});
  must(!missing.ok && /needs "url"/.test(missing.error), `required: ${show(missing)}`);
  const big = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://x.test", { timeoutMs: "999999" }));
  must(!big.ok && /between/.test(big.error), `bounds: ${show(big)}`);
  must(Object.keys(await rt.store.pluginChoices("t", "a")).length === 0, "a refused add switched the plugin on");
  // The operator's route and provisioning hear the same refusal.
  await rt.store.setPluginChoice("t", "a", "remote", "enable");
  const admin = await rt.addMount("t", "a", { alias: "srv", plugin: "remote", config: { url: "https://inward.test" } });
  must(!admin.ok && /points inward/.test(admin.error), `configProblem, /admin/mounts: ${show(admin)}`);
  let thrown = "";
  try { await rt.provision("t", "a", [{ alias: "srv", plugin: "remote", config: { url: "https://inward.test" } }], { chosen: true }); }
  catch (e) { thrown = String((e as Error).message); }
  must(/points inward/.test(thrown), `configProblem, provisioning: ${thrown || "accepted"}`);
  must((await rt.store.listMounts("t", "a")).length === 0, "a refused mount was stored");
});

await check("remove deletes the mount, its tool snapshot, its databases and a left-over credential row", async () => {
  const { rt, host } = await runtime();
  await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test"));
  must((await rt.store.getMountByAlias("t", "a", "srv"))?.toolSnapshot, "control: no snapshot to remove");
  host.sql.exec("INSERT INTO plugin_db(tenant_id, agent_id, alias, plugin, store, key, value, idx, updated_at) VALUES ('t','a','srv','remote','s','k','\"v\"',NULL,0)");
  host.sql.exec("INSERT INTO plugin_db(tenant_id, agent_id, alias, plugin, store, key, value, idx, updated_at) VALUES ('t','a','other','remote','s','k','\"v\"',NULL,0)");
  await rt.store.putSecret("t", "a", "srv", { ciphertext: "c", iv: "i" });
  const r = await rt.removeMount("t", "a", "srv", noHooks);
  must(r.ok, `remove: ${show(r)}`);
  must(!(await rt.store.getMountByAlias("t", "a", "srv")), "the mount is still there");
  const rows = host.sql.exec("SELECT alias FROM plugin_db").toArray().map((x: any) => x.alias);
  must(show(rows) === show(["other"]), `plugin databases after: ${show(rows)}`);
  must(!(await rt.store.getSecret("t", "a", "srv")), "the credential row named after the alias survived");
  // A mount added again under the alias inherits no tool list from the one removed.
  const back = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://down.test"));
  must(back.ok && !(await rt.store.getMountByAlias("t", "a", "srv"))?.toolSnapshot, "the new mount carries the old snapshot");
  const gone = await rt.removeMount("t", "a", "nope", noHooks);
  must(!gone.ok && !gone.conflict && /no mount named/.test(gone.error), `unknown alias: ${show(gone)}`);
});

await check("both stores' removeMount delete the row, its databases and the named credential row, and nothing of another mount", async () => {
  const { DurableObjectStore } = await import("../src/store/durable-object.ts");
  const { SqliteStore } = await import("../src/store/sqlite.ts");
  const host = sqliteHost();
  const doStore = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  const lite = new SqliteStore(":memory:");
  for (const [name, store] of [["durable-object", doStore], ["sqlite", lite]] as const) {
    await store.init();
    for (const alias of ["srv", "other"]) {
      await store.addMount({ tenantId: "t", agentId: "a", alias, plugin: "remote", installationId: `console:${alias}`, connectionId: null,
        toolVersion: "1.0.0", publicConfig: { url: "https://x.test" }, secretRef: null, policy: null });
      store.pluginDb.ensure().put({ tenantId: "t", agentId: "a", alias, plugin: "remote" }, "s", "k", "v", null);
      await store.putSecret("t", "a", alias, { ciphertext: "c", iv: "i" });
    }
    must(await store.removeMount("t", "a", "srv", "srv"), `${name}: removeMount answered false`);
    must(!(await store.getMountByAlias("t", "a", "srv")) && await store.getMountByAlias("t", "a", "other"), `${name}: the wrong rows went`);
    const dbs = store.pluginDb.summary("t", "a").map((r: any) => r.alias);
    must(show(dbs) === show(["other"]), `${name}: plugin databases after: ${show(dbs)}`);
    must(!(await store.getSecret("t", "a", "srv")) && await store.getSecret("t", "a", "other"), `${name}: credential rows after`);
    must(!(await store.removeMount("t", "a", "srv", null)), `${name}: a second remove answered true`);
  }
  // Another agent's mount under the same alias, in each store: a remove is scoped to its agent.
  for (const [name, store] of [["durable-object", doStore], ["sqlite", lite]] as const) {
    for (const agentId of ["a", "b"]) {
      await store.addMount({ tenantId: "t", agentId, alias: "same", plugin: "remote", installationId: "console:same", connectionId: null,
        toolVersion: "1.0.0", publicConfig: { url: "https://x.test" }, secretRef: null, policy: null });
      store.pluginDb.put({ tenantId: "t", agentId, alias: "same", plugin: "remote" }, "s", "k", "v", null);
      await store.putSecret("t", agentId, "same", { ciphertext: "c", iv: "i" });
    }
    must(await store.removeMount("t", "a", "same", "same"), `${name}: remove`);
    must(await store.getMountByAlias("t", "b", "same"), `${name}: the other agent's mount went`);
    must(store.pluginDb.summary("t", "b").some((r: any) => r.alias === "same"), `${name}: the other agent's plugin database went`);
    must(await store.getSecret("t", "b", "same"), `${name}: the other agent's credential row went`);
  }
});

await check("remove keeps a credential row another mount still references", async () => {
  const { rt } = await runtime();
  await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test"));
  await rt.addMount("t", "a", { alias: "user", plugin: "remote", config: { url: "https://user.test" } });
  await rt.store.putSecret("t", "a", "srv", { ciphertext: "c", iv: "i" });
  await rt.store.setMountSecretRef("t", "a", "user", "agent:srv");
  must((await rt.removeMount("t", "a", "srv", noHooks)).ok, "remove");
  must(await rt.store.getSecret("t", "a", "srv"), "the row another mount references was deleted");
  // Control: with no reference, the same row is a leftover and goes.
  await rt.store.setMountSecretRef("t", "a", "user", null);
  await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test"));
  must((await rt.removeMount("t", "a", "srv", noHooks)).ok && !(await rt.store.getSecret("t", "a", "srv")), "an unreferenced leftover row stayed");
});

await check("a listing still in flight when its mount is removed and added again is not written onto the new mount", async () => {
  const { rt } = await runtime();
  slowGate = slowListing();
  try {
    const first = rt.addConsoleMount("t", "a", "remote", "srv", form("https://slow.test"));
    await new Promise((r) => setTimeout(r, 20));
    must((await rt.removeMount("t", "a", "srv", noHooks)).ok, "remove while the listing is out");
    slowGate = null;
    const second = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://down.test"));
    must(second.ok && second.added && !second.tools.ok, `the new mount: ${show(second)}`);
    releaseSlow();
    const late = await first;
    must(late.ok && late.tools && !late.tools.ok && /removed or replaced/.test(late.tools.error), `the old listing: ${show(late)}`);
    const m = await rt.store.getMountByAlias("t", "a", "srv");
    must(m && !m.toolSnapshot && m.publicConfig.url === "https://down.test", `the old list reached the new mount: ${show(m?.toolSnapshot)}`);
    must(/server is down/.test(rt.snapshotError("srv") ?? ""), `the new mount's own error was overwritten: ${rt.snapshotError("srv")}`);
  } finally { slowGate = null; releaseSlow(); }
});

await check("remove is refused while a credential, a live hook or a held call is on the mount, and for an operator-only plugin", async () => {
  const { rt } = await runtime();
  await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test"));
  await rt.store.setMountSecretRef("t", "a", "srv", "agent:srv");
  const cred = await rt.removeMount("t", "a", "srv", noHooks);
  must(!cred.ok && cred.conflict && /account attached/.test(cred.error), `credential: ${show(cred)}`);
  await rt.store.setMountSecretRef("t", "a", "srv", null);
  const live = { list: async () => [{ hookId: "h", tenantId: "t", agentId: "a", alias: "srv", createdAt: 0, revokedAt: null }] };
  const hook = await rt.removeMount("t", "a", "srv", live);
  must(!hook.ok && hook.conflict && /live inbound hook/.test(hook.error), `hook: ${show(hook)}`);
  const revoked = { list: async () => [{ hookId: "h", tenantId: "t", agentId: "a", alias: "srv", createdAt: 0, revokedAt: 1 }] };
  const broken = { list: async () => { throw new Error("D1 is away"); } };
  const unread = await rt.removeMount("t", "a", "srv", broken);
  must(!unread.ok && unread.conflict && /could not check/.test(unread.error), `an unreadable index: ${show(unread)}`);
  await rt.store.requireApproval({ tenantId: "t", operationId: "op1", agentId: "a", taskId: "main", mountAlias: "srv", tool: "ping", request: {} });
  const held = await rt.removeMount("t", "a", "srv", revoked);
  must(!held.ok && held.conflict && /waiting for a decision/.test(held.error), `held: ${show(held)}`);
  must(await rt.store.getMountByAlias("t", "a", "srv"), "a refused remove deleted the mount");
  await rt.store.decideApproval("t", "op1", "denied", "me");
  must((await rt.removeMount("t", "a", "srv", revoked)).ok, "with the hook revoked and the call decided, the remove is refused");
  await rt.addMount("t", "a", { alias: "op", plugin: "operator-only", config: { url: "https://op.test" } });
  await rt.store.setPluginChoice("t", "a", "operator-only", "enable");
  await rt.addMount("t", "a", { alias: "op", plugin: "operator-only", config: { url: "https://op.test" } });
  const op = await rt.removeMount("t", "a", "op", noHooks);
  must(!op.ok && op.conflict && /cannot be removed from the console/.test(op.error), `operator-only: ${show(op)}`);
});

await check("owner secrets: sealed under owner:, listed for the console, and out of the agent's secret_* tools entirely", async () => {
  const { rt, host } = await runtime();
  const value = "sk-live-0123456789abcdef";
  must(show(await rt.putOwnerSecret("t", "a", "key", value)) === show({ ok: true }), "put");
  const listed = await rt.ownerSecrets("t", "a");
  must(listed.length === 1 && listed[0].name === "key" && typeof listed[0].storedAt === "string" && listed[0].lastReadAt === null, `console list: ${show(listed)}`);
  const raw = () => show(host.sql.exec("SELECT name, ciphertext FROM secrets").toArray());
  must(raw().includes("owner:key") && !raw().includes("kept:key") && !raw().includes(value), `rows: ${raw()}`);
  // The model's tools: cannot read, list, overwrite or delete it.
  const state = rt.plugins().find((p: Plugin) => p.id === "state");
  const call = (tool: string, args: Record<string, unknown>) =>
    state.invoke(tool, args, { caller: { tenantId: "t", agentId: "a", taskId: "main" }, publicConfig: {} }).then((r: any) => r, (e: Error) => ({ error: e.message }));
  const got = await call("secret_get", { name: "key" });
  must(!("value" in got) && /no secret named key/.test(got.error), `secret_get reached it: ${show(got)}`);
  must(show(await call("secret_list", {})) === show({ secrets: [] }), "secret_list shows it");
  await call("secret_put", { name: "key", value: "agent-own-value" });
  await call("secret_delete", { name: "key" });
  const owner = host.sql.exec("SELECT ciphertext FROM secrets WHERE name = 'owner:key'").toArray();
  must(owner.length === 1, "the agent's put or delete reached the owner's row");
  must(show((await rt.ownerSecrets("t", "a")).map((x: any) => x.name)) === show(["key"]), "the owner's list changed");
  for (const [name, v, why] of [["bad name", value, /name must be/], ["key", "", /non-empty/], ["key", "x".repeat(8_001), /longer than 8000/]] as const) {
    const r = await rt.putOwnerSecret("t", "a", name, v);
    must(!r.ok && why.test(r.error) && !r.error.includes(value), `${name}/${v.length}: ${show(r)}`);
  }
  must(show(await rt.removeOwnerSecret("t", "a", "key")) === show({ ok: true, removed: true }), "remove");
  must((await rt.ownerSecrets("t", "a")).length === 0, "still listed");
  const { rt: bare } = await runtime({ kek: false });
  const nokek = await bare.putOwnerSecret("t", "a", "key", value);
  must(!nokek.ok && /SECRET_KEK/.test(nokek.error), `without a KEK: ${show(nokek)}`);
});

// ---- the routes -------------------------------------------------------------

const SESSION = "s".repeat(32);
const T = "t1", A = "a1", OTHER_T = "t2", OTHER_A = "a2";
const VALUE = "sk-console-secret-9f8e7d6c5b4a";

/** An MCP server in the place of `fetch`, recording the headers it was sent. */
const seenHeaders: Array<Record<string, string>> = [];
let serverDown = false;
let echoKey = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  if (serverDown) throw new Error("connect ECONNREFUSED");
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  if (String(init.method ?? "GET") !== "POST") return new Response(null, { status: 405 });
  const msg = JSON.parse(String(init.body));
  seenHeaders.push(headers);
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  if (msg.method === "initialize") return json({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
  if (msg.method === "tools/list" && echoKey) {
    // A server that repeats the header it was sent into what it lists.
    const key = headers["x-api-key"] ?? "";
    return json({ tools: [
      { name: "echo", description: `Echo; your key is ${key}`, inputSchema: { type: "object", properties: { k: { type: "string", description: `defaults to ${key}` } } }, annotations: { readOnlyHint: true } },
      { name: `k_${key}`, description: "named after the key", inputSchema: { type: "object" } },
    ] });
  }
  if (msg.method === "tools/list") return json({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

let liveHooks: Array<Record<string, unknown>> = [];
const d1 = () => {
  const stmt = (sql: string) => {
    const s: any = {
      bind: () => s, first: async () => null, run: async () => ({ meta: { changes: 1 } }),
      all: async () => ({ results: sql.includes("inbound_hooks") ? liveHooks : [] }),
    };
    return s;
  };
  return { prepare: (sql: string) => stmt(sql), batch: async (s: unknown[]) => s.map(() => ({ results: [], meta: { changes: 1 } })) };
};
const hosts: Array<{ dispose(): void }> = [];
const objects = new Map<string, any>();
const env: Record<string, unknown> = {
  MODEL_QUEUE: { send: async () => {} },
  ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
  ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "m1", DEEPSEEK_BASE_URL: "https://model.example/v1",
  AUTOMATION_TOKEN: "operator-token", SESSION_SECRET: SESSION, SECRET_KEK: KEK, UI_ALLOW_ANONYMOUS: "1",
  AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? fresh(n) },
};
function fresh(n: string) {
  const own = sqliteHost();
  hosts.push(own);
  let alarmAt: number | null = null;
  const o = new AgentDO({
    storage: { sql: own.sql, transactionSync: own.transactionSync, getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => n }, getWebSockets: () => [], exports: {},
  } as never, env as never);
  objects.set(n, o);
  return o;
}
const cookieOf = async (tenantId: string, agentId: string) =>
  (await sessionCookieFor(SESSION, { email: `${agentId}@x.test`, name: null, username: null, picture: null, source: "github", agentId, tenantId }, `gh-${agentId}`)).split(";")[0]!;
const mine = await cookieOf(T, A);
const theirs = await cookieOf(OTHER_T, OTHER_A);
const responses: string[] = [];
/** A form post as the console's own page sends one: `Sec-Fetch-Site: same-origin`, unless `headers` says otherwise. */
async function post(path: string, fields: Record<string, string>, opts: { cookie?: string | null; json?: boolean; headers?: Record<string, string | null> } = {}) {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" };
  for (const [k, v] of Object.entries(opts.headers ?? {})) { if (v === null) delete headers[k]; else headers[k] = v; }
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? mine;
  if (opts.json) headers.accept = "application/json";
  const r = await worker.fetch(new Request(`https://console.test${path}`, { method: "POST", headers, body }), env as never);
  const text = await r.text();
  responses.push(text);
  return { status: r.status, text, json: () => JSON.parse(text) };
}
async function get(path: string, cookie = mine) {
  const r = await worker.fetch(new Request(`https://console.test${path}`, { headers: { cookie } }), env as never);
  const text = await r.text();
  responses.push(text);
  return { status: r.status, text };
}
const home = () => objects.get(agentObjectName(T, A)) ?? fresh(agentObjectName(T, A));
const MCP_URL = "https://mcp.example.test/mcp";

const panel = (t: string) => t.includes("<h3>this agent's mounts</h3>");

await check("route: add, through the sign-in gate, answers the plugins panel and the result", async () => {
  const r = await post("/ui/mount/add", { plugin: "mcp", alias: "plain", url: MCP_URL, headers: "\n\n", timeoutMs: "" }, { json: true });
  must(r.status === 200, `status ${r.status}: ${r.text}`);
  const j = r.json();
  must(j.ok && j.added && j.tools?.ok && show(j.tools.tools) === show(["echo"]), `result: ${show(j)}`);
  must(panel(j.html) && j.html.includes("plain__echo"), `html: ${String(j.html).slice(0, 200)}`);
  const m = await home().runtime().store.getMountByAlias(T, A, "plain");
  must(m && consoleAdded(m) && show(m.publicConfig) === show({ url: MCP_URL }), `stored: ${show(m)}`);
  const d = await home().uiPlugins(T, A);
  const row = d.mounts.find((x: any) => x.alias === "plain");
  must(row?.fromConsole === true && row.snapshotError === null && d.consoleMountsMax === 8, `payload: ${show(row)}`);
  must(d.installed.find((p: any) => p.id === "mcp")?.addable === true && d.installed.filter((p: any) => p.addable).length === 1, "addable is not exactly mcp");
  // htmx's answer is the panel itself.
  const plain = await post("/ui/mount/add", { plugin: "mcp", alias: "plain", url: MCP_URL });
  must(plain.status === 200 && panel(plain.text) && !plain.text.trimStart().startsWith("{"), `html: ${plain.status} ${plain.text.slice(0, 80)}`);
});

await check("route: add refusals are 400 with the reason, and store nothing", async () => {
  for (const [fields, why] of [
    [{ plugin: "http", alias: "web9", url: MCP_URL }, /cannot be added from the console/],
    [{ plugin: "mcp", alias: "Bad Alias", url: MCP_URL }, /an alias is/],
    [{ plugin: "mcp", alias: "nourl" }, /needs "url"/],
    [{ plugin: "mcp", alias: "keyed", url: MCP_URL, headers: "Authorization: Bearer abc123" }, /headers/],
    [{ plugin: "mcp", alias: "slow", url: MCP_URL, timeoutMs: "later" }, /should be a number/],
  ] as const) {
    const r = await post("/ui/mount/add", fields, { json: true });
    must(r.status === 400 && why.test(r.json().error), `${show(fields)}: ${r.status} ${r.text}`);
    must(!(await home().runtime().store.getMountByAlias(T, A, fields.alias)), `${fields.alias} was stored`);
  }
  const text = await post("/ui/mount/add", { plugin: "http", alias: "web9", url: MCP_URL });
  must(text.status === 400 && /cannot be added/.test(text.text), `plain refusal: ${text.text}`);
});

await check("route: an inward server url is refused by /ui/mount/add and by /admin/mounts alike (mcp's configProblem), before anything is stored", async () => {
  const INWARD = "https://169.254.169.254.nip.io/mcp";
  const before = seenHeaders.length;
  const ui = await post("/ui/mount/add", { plugin: "mcp", alias: "meta", url: INWARD }, { json: true });
  must(ui.status === 400 && /public host/.test(ui.json().error), `console: ${ui.status} ${ui.text}`);
  const admin = await worker.fetch(new Request("https://console.test/admin/mounts", {
    method: "POST", headers: { "x-harness-token": "operator-token", "content-type": "application/json" },
    body: JSON.stringify({ tenantId: T, agentId: A, alias: "meta", plugin: "mcp", config: { url: INWARD } }),
  }), env as never);
  const body = await admin.json() as { error?: string };
  must(admin.status === 400 && /public host/.test(body.error ?? ""), `admin: ${admin.status} ${show(body)}`);
  must(!(await home().runtime().store.getMountByAlias(T, A, "meta")), "the inward mount was stored");
  must(seenHeaders.length === before, "the inward server was asked for its tools");
});

await check("route: a snapshot failure is 200 with the mount, and the error is kept on it", async () => {
  // The slot names a secret not kept yet, so the listing fails before anything is sent.
  const r = await post("/ui/mount/add", { plugin: "mcp", alias: "docs", url: MCP_URL, headers: "X-Api-Key: {{docs-key}}\n" }, { json: true });
  const j = r.json();
  must(r.status === 200 && j.ok && j.added && j.tools && !j.tools.ok && /no secret named docs-key/.test(j.tools.error), `${r.status} ${r.text}`);
  must(await home().runtime().store.getMountByAlias(T, A, "docs"), "the mount was not kept");
  serverDown = true;
  try {
    const down = await post("/ui/mount/add", { plugin: "mcp", alias: "flaky", url: MCP_URL }, { json: true });
    must(down.status === 200 && !down.json().tools.ok, `server down: ${down.status} ${down.text}`);
  } finally { serverDown = false; }
  const d = await home().uiPlugins(T, A);
  const row = (a: string) => d.mounts.find((x: any) => x.alias === a);
  must(/no secret named docs-key/.test(row("docs")?.snapshotError ?? ""), `docs: ${show(row("docs"))}`);
  must(/could not list flaky/.test(row("flaky")?.snapshotError ?? ""), `flaky: ${show(row("flaky"))}`);
  must(row("docs").fromConsole === true, "not marked as added from the console");
});

await check("route: an owner secret fills the header slot on refresh — ahead of the agent's own of that name — and clears the kept error", async () => {
  const before = seenHeaders.length;
  // The agent kept its own value under the same name first: the owner's must win the slot.
  const state = home().runtime().plugins().find((p: Plugin) => p.id === "state");
  const agentCtx = { caller: { tenantId: T, agentId: A, taskId: "main" }, publicConfig: {} };
  await state.invoke("secret_put", { name: "docs-key", value: "the-agents-own-value" }, agentCtx);
  const put = await post("/ui/secret", { name: "docs-key", value: VALUE }, { json: true });
  must(put.status === 200 && put.json().ok && panel(put.json().html) && show(put.json().secrets.map((s: any) => s.name)) === show(["docs-key"]), `${put.status} ${put.text}`);
  const r = await post("/ui/mount/refresh", { alias: "docs" }, { json: true });
  const j = r.json();
  must(r.status === 200 && j.ok && j.changed === true && show(j.tools) === show(["echo"]) && Array.isArray(j.skipped) && typeof j.toolsTakenAt === "number", `refresh: ${r.status} ${r.text}`);
  must(seenHeaders.slice(before).some((h) => h["x-api-key"] === VALUE), "the slot was not filled from the owner's secret");
  must(!seenHeaders.slice(before).some((h) => h["x-api-key"] === "the-agents-own-value"), "the agent's own value shadowed the owner's");
  // The model, through its own tools, sees only its own row and never the owner's value.
  const got: any = await state.invoke("secret_get", { name: "docs-key" }, agentCtx);
  must(got.value === "the-agents-own-value", `secret_get: ${show(got)}`);
  const list: any = await state.invoke("secret_list", {}, agentCtx);
  must(list.secrets.length === 1 && !show(list).includes(VALUE), `secret_list: ${show(list)}`);
  await state.invoke("secret_delete", { name: "docs-key" }, agentCtx);
  const d = await home().uiPlugins(T, A);
  must(d.mounts.find((x: any) => x.alias === "docs")?.snapshotError === null, "a successful refresh left the error");
  must(show(d.kept.map((k: any) => k.name)) === show(["docs-key"]) && typeof d.kept[0].storedAt === "string" && typeof d.kept[0].lastReadAt === "string", `kept: ${show(d.kept)}`);
  must((await get("/ui/plugins")).status === 200, "GET /ui/plugins");
  const badName = await post("/ui/secret", { name: "no spaces", value: VALUE }, { json: true });
  must(badName.status === 400 && /name must be/.test(badName.json().error), `bad name: ${badName.text}`);
  const failed = await post("/ui/mount/refresh", { alias: "nope" }, { json: true });
  must(failed.status === 200 && !failed.json().ok && /no mount named/.test(failed.json().error), `refresh of nothing: ${failed.text}`);
  const noAlias = await post("/ui/mount/refresh", {}, { json: true });
  must(noAlias.status === 400, `refresh without an alias: ${noAlias.status}`);
});

await check("route: a console write is accepted only from this origin, or from a script holding a token", async () => {
  const store = home().runtime().store;
  const names = async () => (await store.listSecretNames(T, A, "owner:")).map((r: any) => r.name);
  const before = show(await names());
  for (const [label, headers] of [
    ["cross-site", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }],
    ["same-site (another subdomain)", { "sec-fetch-site": "same-site", origin: "https://preview.console.test" }],
    ["no Sec-Fetch-Site, another subdomain's Origin", { "sec-fetch-site": null, origin: "https://preview.console.test" }],
    ["no Sec-Fetch-Site, no Origin", { "sec-fetch-site": null }],
    ["a made-up token beside the cookie", { "sec-fetch-site": null, "x-harness-token": "not-the-token" }],
    // A valid token does not make a cookie's request a script's: the route would act as the cookie's owner.
    ["the real token beside the cookie", { "sec-fetch-site": null, "x-harness-token": "operator-token" }],
    ["the real token beside the cookie, from this origin", { "x-harness-token": "operator-token" }],
  ] as const) {
    for (const [path, fields] of [["/ui/secret", { name: "forged", value: VALUE }], ["/ui/mount/add", { plugin: "mcp", alias: "forged", url: MCP_URL }]] as const) {
      const r = await post(path, fields, { headers: headers as Record<string, string | null> });
      must(r.status === 403 && /refused/.test(r.text), `${label} ${path}: ${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  must(show(await names()) === before && !(await store.getMountByAlias(T, A, "forged")), "a refused write wrote something");
  // Accepted: the console's own page (Sec-Fetch-Site), an older browser on this origin (Origin only), and a script with the token.
  const same = await post("/ui/secret", { name: "ok-sfs", value: VALUE });
  must(same.status === 200, `same-origin: ${same.status} ${same.text.slice(0, 120)}`);
  const legacy = await post("/ui/secret", { name: "ok-origin", value: VALUE }, { headers: { "sec-fetch-site": null, origin: "https://console.test" } });
  must(legacy.status === 200, `Origin only: ${legacy.status} ${legacy.text.slice(0, 120)}`);
  const script = await post("/ui/secret", { name: "ok-token", value: VALUE }, { cookie: null, headers: { "sec-fetch-site": null, "x-harness-token": "operator-token" } });
  must(script.status === 200, `automation token: ${script.status} ${script.text.slice(0, 120)}`);
  must(show(await names()) === show([...JSON.parse(before), "owner:ok-origin", "owner:ok-sfs"].sort()), `owner rows: ${show(await names())}`);
  for (const n of ["ok-sfs", "ok-origin"]) await post("/ui/secret/remove", { name: n });
});

await check("route: a secret the server echoes into its listing is masked before the list is kept or shown", async () => {
  const store = home().runtime().store;
  must((await store.listSecretNames(T, A, "owner:")).some((r: any) => r.name === "owner:docs-key"), "control: the owner secret is not there");
  echoKey = true;
  try {
    const r = await post("/ui/mount/refresh", { alias: "docs" }, { json: true });
    must(r.status === 200 && r.json().ok && r.json().changed, `refresh: ${r.status} ${r.text.slice(0, 200)}`);
  } finally { echoKey = false; }
  const snap = show((await store.getMountByAlias(T, A, "docs"))?.toolSnapshot);
  must(snap.includes("[secret docs-key]"), `the echo did not reach the listing, so this checks nothing: ${snap.slice(0, 300)}`);
  must(!snap.includes(VALUE), "the secret is in the stored listing");
  const d = show(await home().uiPlugins(T, A));
  must(!d.includes(VALUE), "the secret is on the plugins page");
});

await check("route: an operator's mount, added through /admin/mounts, is neither refreshed nor removed from the console", async () => {
  const admin = (token: string) => worker.fetch(new Request("https://console.test/admin/mounts", {
    method: "POST", headers: { "x-harness-token": token, "content-type": "application/json" },
    body: JSON.stringify({ tenantId: T, agentId: A, alias: "opmcp", plugin: "mcp", config: { url: MCP_URL } }),
  }), env as never);
  must((await admin("operator-tokeN")).status === 401 && (await admin("")).status === 401, "a wrong token was let in");
  const added = await admin("operator-token");
  must(added.status === 200 && (await added.json() as any).added === true, `admin add: ${added.status}`);
  must(!(await home().uiPlugins(T, A)).mounts.find((x: any) => x.alias === "opmcp").fromConsole, "the operator's mount reads as console-added");
  const refresh = await post("/ui/mount/refresh", { alias: "opmcp" }, { json: true });
  must(refresh.status === 200 && !refresh.json().ok && /not added from the console/.test(refresh.json().error), `refresh: ${refresh.text}`);
  const remove = await post("/ui/mount/remove", { alias: "opmcp" }, { json: true });
  must(remove.status === 409 && /only the operator/.test(remove.json().error), `remove: ${remove.status} ${remove.text}`);
  must(await home().runtime().store.getMountByAlias(T, A, "opmcp"), "the operator's mount was removed");
});

await check("route: remove answers 409 with the reason while a hook or a credential is on it, then removes and leaves no snapshot", async () => {
  liveHooks = [{ hook_id: "h1", tenant_id: T, agent_id: A, alias: "docs", created_at: 1, revoked_at: null }];
  try {
    const held = await post("/ui/mount/remove", { alias: "docs" }, { json: true });
    must(held.status === 409 && /live inbound hook/.test(held.json().error), `with a hook: ${held.status} ${held.text}`);
  } finally { liveHooks = []; }
  const store = home().runtime().store;
  await store.setMountSecretRef(T, A, "docs", "agent:docs");
  const cred = await post("/ui/mount/remove", { alias: "docs" });
  must(cred.status === 409 && /account attached/.test(cred.text), `with a credential: ${cred.status} ${cred.text}`);
  await store.setMountSecretRef(T, A, "docs", null);
  must((await store.getMountByAlias(T, A, "docs"))?.toolSnapshot, "control: no snapshot before the remove");
  const r = await post("/ui/mount/remove", { alias: "docs" }, { json: true });
  must(r.status === 200 && r.json().removed === true && panel(r.json().html), `remove: ${r.status} ${r.text}`);
  must(!(await store.getMountByAlias(T, A, "docs")), "the mount is still stored");
  const raw = home().ctx.storage.sql;
  const left = raw.exec("SELECT alias, tool_snapshot FROM mounts WHERE alias = 'docs'").toArray();
  must(left.length === 0, `a row for docs survived: ${show(left)}`);
  must(!(await home().uiPlugins(T, A)).mounts.some((m: any) => m.alias === "docs"), "the console still lists it");
  // The flaky mount's kept error goes with it.
  must((await post("/ui/mount/remove", { alias: "flaky" })).status === 200, "remove flaky");
  must(raw.exec("SELECT alias FROM mount_snapshot_errors WHERE alias = 'flaky'").toArray().length === 0, "the snapshot error outlived its mount");
  const missing = await post("/ui/mount/remove", { alias: "ghost" }, { json: true });
  must(missing.status === 400, `an unknown alias: ${missing.status}`);
});

await check("route: secret/remove deletes the kept row; without SECRET_KEK a put is 400", async () => {
  const r = await post("/ui/secret/remove", { name: "docs-key" }, { json: true });
  must(r.status === 200 && r.json().removed === true && r.json().secrets.length === 0, `${r.status} ${r.text}`);
  const kek = env.SECRET_KEK;
  delete env.SECRET_KEK;
  try {
    const nokek = await post("/ui/secret", { name: "k", value: VALUE }, { json: true, cookie: await cookieOf("t3", "a3") });
    must(nokek.status === 400 && /SECRET_KEK/.test(nokek.json().error), `${nokek.status} ${nokek.text}`);
  } finally { env.SECRET_KEK = kek; }
});

await check("route: another tenant's agentId is 404 on every new write, and nothing is written there", async () => {
  // The other tenant's agent exists and has a mount of its own.
  await post("/ui/mount/add", { plugin: "mcp", alias: "theirs", url: MCP_URL }, { cookie: theirs });
  const before = await objects.get(agentObjectName(OTHER_T, OTHER_A)).runtime().store.listMounts(OTHER_T, OTHER_A);
  must(before.some((m: any) => m.alias === "theirs"), "control: the other tenant's mount was not made");
  for (const [path, fields] of [
    ["/ui/mount/add", { plugin: "mcp", alias: "intruder", url: MCP_URL }],
    ["/ui/mount/refresh", { alias: "theirs" }],
    ["/ui/mount/remove", { alias: "theirs" }],
    ["/ui/secret", { name: "planted", value: VALUE }],
    ["/ui/secret/remove", { name: "planted" }],
    ["/ui/plugin/choice", { plugin: "mcp", choice: "disable" }],
  ] as const) {
    const r = await post(path, { ...fields, agentId: OTHER_A }, { json: true });
    must(r.status === 404, `${path} with another tenant's agentId: ${r.status} ${r.text}`);
  }
  const store = objects.get(agentObjectName(OTHER_T, OTHER_A)).runtime().store;
  must(show((await store.listMounts(OTHER_T, OTHER_A)).map((m: any) => m.alias)) === show(before.map((m: any) => m.alias)), "the other agent's mounts changed");
  must((await store.listSecretNames(OTHER_T, OTHER_A, "kept:")).length === 0, "a secret was planted");
  must((await store.pluginChoices(OTHER_T, OTHER_A))["mcp"] !== "disable", "the other agent's plugin was switched off");
});

await check("route: an anonymous viewer is refused every new write and /ui/plugin/choice, and changes nothing", async () => {
  const store = home().runtime().store;
  const choicesBefore = show(await store.pluginChoices(T, A));
  const mountsBefore = (await store.listMounts(T, A)).length;
  for (const [path, fields] of [
    ["/ui/mount/add", { plugin: "mcp", alias: "anon", url: MCP_URL }],
    ["/ui/mount/refresh", { alias: "flaky" }],
    ["/ui/mount/remove", { alias: "flaky" }],
    ["/ui/secret", { name: "anon", value: VALUE }],
    ["/ui/secret/remove", { name: "anon" }],
    ["/ui/plugin/choice", { plugin: "mcp", choice: "disable" }],
  ] as const) {
    const r = await post(path, fields, { cookie: null });
    must(r.status === 403 && /read-only/.test(r.text), `${path} anonymously: ${r.status} ${r.text}`);
  }
  // Anonymous reaches the gate at all: a read is still answered.
  must((await get("/ui/plugins", "")).status === 200, "control: the anonymous viewer cannot read either, so the 403s prove nothing");
  must(show(await store.pluginChoices(T, A)) === choicesBefore, "a plugin choice changed");
  must((await store.listMounts(T, A)).length === mountsBefore, "the mounts changed");
});

await check("route: the owner's own /ui/plugin/choice still works", async () => {
  const r = await post("/ui/plugin/choice", { plugin: "mcp", choice: "disable" });
  must(r.status === 200, `${r.status} ${r.text}`);
  must((await home().runtime().store.pluginChoices(T, A))["mcp"] === "disable", "the choice was not recorded");
  const refused = await post("/ui/mount/add", { plugin: "mcp", alias: "after-off", url: MCP_URL }, { json: true });
  must(refused.status === 400 && /switched off/.test(refused.json().error), `adding after a disable: ${refused.text}`);
});

await check("no secret value appears in any response or log line", async () => {
  must(responses.length > 20, `control: only ${responses.length} responses were recorded`);
  const leaks = responses.filter((t) => t.includes(VALUE));
  must(leaks.length === 0, `${leaks.length} response(s) carried the value: ${leaks[0]?.slice(0, 200)}`);
  const logLeaks = logged.filter((l) => l.includes(VALUE));
  must(logLeaks.length === 0, `${logLeaks.length} log line(s) carried the value`);
});

globalThis.fetch = realFetch;
for (const h of hosts) h.dispose();

// One write, and the exit only once it has drained: a failure that quotes a whole panel is tens of KB,
// and `process.exit` on a pipe drops what is still queued — the summary line first.
const lines = [`\n  Console mounts and kept secrets\n  ${"─".repeat(56)}`];
for (const r of results) {
  lines.push(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${String(r.error).slice(0, 1_500)}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
lines.push(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.stdout.write(lines.join("\n") + "\n", () => process.exit(pass === results.length ? 0 : 1));
