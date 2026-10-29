/**
 * `PluginContext.sibling` hands another mount's credential only to the plugins that mount's plugin names in
 * `Plugin.siblingReaders`, and to its own plugin. The raft mount's credential reaches Raft's Agent Login directly, past
 * every refusal the raft plugin makes, so a plugin outside the list must get the sibling with `credential: null` — its
 * plugin, database and policy as before. The asker is matched by the plugin id the platform recorded on its mount,
 * never by an alias its owner chose. And an id names one plugin: a second registration under an existing id is refused,
 * so no plugin can take over a listed one's grant.
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
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const RAFT_CREDENTIAL = "sk_agent_sibling_gate_0123456789";
const caller = { tenantId: "t", agentId: "a", taskId: "k" };

/** A plugin whose one tool reports what `ctx.sibling(alias)` handed it. */
function probe(id: string): Plugin {
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

async function world(plugins: Plugin[], mounts: Array<{ alias: string; plugin: string }>) {
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
  const gateway = new ToolGateway(store, all, new Set(all.map((p) => p.id)),
    { async resolve(ref: string) { return ref === "secret:raft" ? RAFT_CREDENTIAL : null; } });
  return async (alias: string, args: unknown = {}) => {
    const r = await gateway.invoke(caller, `${alias}.peek`, args as any) as any;
    must(r.status === "succeeded", `${alias}.peek: ${JSON.stringify(r)}`);
    return r.result as { credential?: string | null; plugin?: string; db?: boolean; kind?: string | null; none?: true };
  };
}

await check("raft names who may read its credential: stamp and raftbench, and that is a security decision written beside it", async () => {
  must(JSON.stringify(raft.siblingReaders) === JSON.stringify(["stamp", "raftbench"]), `siblingReaders: ${JSON.stringify(raft.siblingReaders)}`);
});

await check("a listed plugin gets the raft credential; one not listed gets the mount with credential null, plugin and db unchanged", async () => {
  const peek = await world([probe("stamp"), probe("raftbench"), probe("reminder"), probe("newcomer")],
    [{ alias: "stamp", plugin: "stamp" }, { alias: "bench", plugin: "raftbench" }, { alias: "reminder", plugin: "reminder" }, { alias: "newcomer", plugin: "newcomer" }]);
  for (const alias of ["stamp", "bench"]) {
    const s = await peek(alias);
    must(s.credential === RAFT_CREDENTIAL && s.plugin === "raft", `${alias}: ${JSON.stringify(s)}`);
  }
  for (const alias of ["reminder", "newcomer"]) {
    const s = await peek(alias);
    must(s.credential === null, `${alias} was handed the raft credential`);
    // What reminder reads (which plugin the mount is) and the database are as they were.
    must(s.plugin === "raft" && s.db === true, `${alias}: ${JSON.stringify(s)}`);
  }
});

await check("the asker is its mount's plugin, not its alias: a mount named stamp of another plugin gets no credential", async () => {
  const peek = await world([probe("newcomer")], [{ alias: "stamp", plugin: "newcomer" }, { alias: "raftbench", plugin: "newcomer" }]);
  for (const alias of ["stamp", "raftbench"]) {
    const s = await peek(alias);
    must(s.credential === null && s.plugin === "raft", `a ${alias}-named mount of another plugin: ${JSON.stringify(s)}`);
  }
});

await check("a plugin's own mounts read each other as before: the gate is about other plugins", async () => {
  const mine = probe("ledger");
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const alias of ["one", "two"]) {
    await store.addMount({ tenantId: "t", agentId: "a", alias, plugin: "ledger", installationId: `i-${alias}`, connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: `secret:${alias}`, policy: null });
  }
  const gateway = new ToolGateway(store, [mine], new Set(["ledger"]), { async resolve(ref: string) { return `cred-of-${ref}`; } });
  const r = await gateway.invoke(caller, "one.peek", { alias: "two" }) as any;
  must(r.status === "succeeded" && r.result.credential === "cred-of-secret:two", JSON.stringify(r));
});

await check("an id names one plugin: a second plugin registered under an existing id is refused, not kept over the first", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  let threw = "";
  try { new ToolGateway(store, [probe("stamp"), raft, probe("stamp")], new Set()); } catch (e) { threw = String((e as Error).message); }
  must(/two plugins are registered as "stamp"/.test(threw), `a second "stamp" was accepted: ${threw || "no error"}`);
  threw = "";
  try { new ToolGateway(store, [raft, createRaftPlugin()], new Set()); } catch (e) { threw = String((e as Error).message); }
  must(/"raft"/.test(threw), `a second "raft" was accepted: ${threw || "no error"}`);
});

console.log(`\n  gateway sibling gate\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
