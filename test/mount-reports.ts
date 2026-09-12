/**
 * What a mount says about itself, asked through the gateway.
 *
 * The console's sandbox panel used to read a run9 box id, its exec count and
 * its saved refs straight out of the connection-state JSON — one plugin's
 * private shape sitting in a page, and the last of the reach-ins the plugin
 * audit found. These are the two questions that replace it, and the property
 * worth holding is that the framework asking them never learns which plugins
 * have containers.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const ctx = { tenantId: "t", agentId: "a", taskId: "k" };

/** A plugin that keeps something, answering in the contract's shape. */
const keeper: Plugin = {
  id: "keeper", version: "1.0.0", tools: [],
  async invoke() { return {}; },
  async activity(c) {
    const st: any = await c.connection.get();
    return {
      live: st?.boxId ? { id: st.boxId, startedAt: st.createdAt ?? 0, lastUsedAt: st.lastUsedAt ?? 0 } : null,
      billing: "billed for every second it exists, not per call",
    } as any;
  },
  async usage() {
    return [{ id: "b-old", startedAt: 1_000, endedAt: 2_000, lastUsedAt: 1_500, uses: 3 }];
  },
};

/** A plugin that keeps nothing and implements neither. Most plugins are this. */
const plain: Plugin = { id: "plain", version: "1.0.0", tools: [], async invoke() { return {}; } };

async function fixture(plugins: Plugin[]) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const p of plugins) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias: p.id, plugin: p.id,
      installationId: `i-${p.id}`, connectionId: null, toolVersion: p.version,
      publicConfig: {}, secretRef: null, policy: null,
    });
  }
  return { store, gw: new ToolGateway(store, plugins, { async resolve() { return null; } }) };
}

await check("正在跑的那个由挂载自己回答,页面不读它的私有状态", async () => {
  const { store, gw } = await fixture([keeper]);
  await store.putConnection("t", "a", "keeper", { boxId: "b-1", createdAt: 10, lastUsedAt: 90 });
  const a: any = await gw.mountActivity(ctx, "keeper");
  if (a.live?.id !== "b-1") throw new Error(JSON.stringify(a));
  if (a.live.startedAt !== 10) throw new Error("startedAt did not come back, so a page cannot show a duration");
  if (!/every second/.test(a.billing ?? "")) throw new Error("the billing sentence is missing, so the page would have to write it");
});

await check("历史是另一个调用,不是一个 flag —— 闹钟不该为没人读的历史付钱", async () => {
  const { gw } = await fixture([keeper]);
  const u = await gw.mountUsage(ctx, "keeper");
  if (u.length !== 1 || u[0]!.id !== "b-old") throw new Error(JSON.stringify(u));
  // And the shapes are independent: asking what is running must not have
  // required the history, and vice versa.
  const a: any = await gw.mountActivity(ctx, "keeper");
  if ("usage" in a) throw new Error("the running answer carries history, so one call is paying for both");
});

await check("什么都不持有的插件回答的是真话,而不是抛错", async () => {
  const { gw } = await fixture([plain]);
  const a = await gw.mountActivity(ctx, "plain");
  if (a.live !== null) throw new Error("a plugin that keeps nothing was read as running something");
  if ((await gw.mountUsage(ctx, "plain")).length) throw new Error("a plugin with no history invented some");
});

await check("挂载不存在、插件没装,同样是真话", async () => {
  const { gw } = await fixture([keeper]);
  if ((await gw.mountActivity(ctx, "ghost")).live !== null) throw new Error("a mount that does not exist reported a container");
  if ((await gw.mountUsage(ctx, "ghost")).length) throw new Error("a mount that does not exist reported history");
});

await check("问的时候不解析凭据 —— 它恰好在凭据可能已被撤掉的时刻被问", async () => {
  let asked = false;
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "keeper", plugin: "keeper",
    installationId: "i", connectionId: null, toolVersion: "1.0.0",
    publicConfig: {}, secretRef: "agent:keeper", policy: null,
  });
  const gw = new ToolGateway(store, [{
    ...keeper,
    async activity(c) { if (c.credential !== null) throw new Error("a credential was resolved for this question"); return { live: null }; },
  }], { async resolve() { asked = true; return "value"; } });
  const a = await gw.mountActivity(ctx, "keeper");
  if (a.live !== null) throw new Error(JSON.stringify(a));
  if (asked) throw new Error("the secret resolver was called to answer what is running");

  // And the same for history, which the first version of this test did not
  // cover: I sabotaged `mountUsage` into resolving a credential and everything
  // stayed green, because only `mountActivity` was guarded. One rule, two
  // callers, and a test that watched one of them.
  const withCred = new ToolGateway(store, [{
    ...keeper,
    async usage(c) { if (c.credential !== null) throw new Error("a credential was resolved for history"); return []; },
  }], { async resolve() { asked = true; return "value"; } });
  await withCred.mountUsage(ctx, "keeper");
  if (asked) throw new Error("the secret resolver was called to answer what has finished");
});

console.log(`\n  What a mount reports\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
