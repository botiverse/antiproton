/**
 * A mount that says its calls cannot overlap, and the path that ignored it.
 *
 * `exclusive` was honoured in one place: pi runs a turn's tool calls in
 * parallel unless a tool says otherwise, and the bridge marks these
 * `executionMode: "sequential"`. But that is the harness, and the harness is
 * not the only way in — `run_js` dispatches by address, and its sandbox allows
 * eight host calls in flight. A script doing two shells at once therefore
 * reached the plugin concurrently, and the plugin's state is read-modify-write:
 * the second write wins, the first box id is lost, and the container it named
 * goes on being billed with nothing left that can release it.
 *
 * So the rule belongs where every path meets, which is the same argument that
 * put credentials, policy and the enable switch here.
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
const tool = { name: "touch", summary: "", parameters: {}, sideEffects: "write" as const, idempotency: "none" as const };

/** Counts overlap the way the real bug happens: read, wait, write. */
function racer(id: string, exclusive: boolean) {
  const seen: string[] = [];
  let inside = 0;
  let overlapped = false;
  const plugin: Plugin = {
    // `defaultForAllAgents` because the gateway refuses a mount whose plugin is
    // not enabled for this agent, and these fixtures are about a different rule.
    id, version: "1.0.0", tools: [tool], 

    async invoke(_t: string, args: any) {
      inside += 1;
      if (inside > 1) overlapped = true;
      const state = (await this.__ctx.connection.get()) as any;
      await new Promise((r) => setTimeout(r, 5));
      await this.__ctx.connection.set({ ...(state ?? {}), last: (args as any).mark });
      seen.push(String((args as any).mark));
      inside -= 1;
      return { ok: true };
    },
  } as any;
  // Read, pause, write — the same shape as the real release: it reads the
  // connection state, destroys the box, and writes the emptied state back.
  // Attached to the group rather than the top level, and only when this racer
  // is the serialised one: `holds` is now what says both things at once.
  if (exclusive) {
    plugin.holds = {
      async activity() { return { live: null }; },
      async release(c: any) {
        inside += 1;
        if (inside > 1) overlapped = true;
        await c.connection.get();
        await new Promise((r) => setTimeout(r, 5));
        await c.connection.set({});
        seen.push("release");
        inside -= 1;
        return true;
      },
    };
  }
  return { plugin, seen, overlapped: () => overlapped };
}

async function fixture(plugin: Plugin) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: plugin.id, plugin: plugin.id,
    installationId: "i", connectionId: null, toolVersion: plugin.version,
    publicConfig: {}, secretRef: null, policy: null,
  });
  // The plugin needs its own context to read and write state, which the
  // gateway builds; this hands it back the way `invoke` receives it.
  const gw = new ToolGateway(store, [plugin], new Set(([plugin]).map((p: any) => p.id)), { async resolve() { return null; } });
  const original = plugin.invoke.bind(plugin);
  (plugin as any).invoke = function (t: string, args: any, c: any) {
    (this as any).__ctx = c;
    return original(t, args, c);
  };
  return { store, gw };
}

await check("独占的挂载:两个并发调用不重叠,两次写都留下", async () => {
  const r = racer("node", true);
  const { gw, store } = await fixture(r.plugin);
  await Promise.all([
    gw.invoke(ctx, "node.touch", { mark: "one" } as any),
    gw.invoke(ctx, "node.touch", { mark: "two" } as any),
  ]);
  if (r.overlapped()) throw new Error("two calls to an exclusive mount ran at the same time");
  if (r.seen.length !== 2) throw new Error(`both calls should have run: ${r.seen.join(",")}`);
  const state: any = await store.getConnection("t", "a", "node");
  if (!state?.last) throw new Error("neither write survived");
});

await check("释放与调用不重叠 —— 释放走的是同一把锁", async () => {
  // A release is a read-modify-write on the state a `shell` call rewrites, and
  // it used to run outside the per-mount chain: the command reads "no
  // container", starts box B and records it, while the release writes back the
  // empty state it read first. Box B is then alive, billing, and named by
  // nothing. Overlap is the property; the racer watches it.
  const r = racer("node", true);
  const { gw } = await fixture(r.plugin);
  await Promise.all([
    gw.invoke(ctx, "node.touch", { mark: "during" } as any),
    gw.releaseTask(ctx, { alias: "node" }),
  ]);
  if (r.overlapped()) throw new Error("a release ran while a call on the same mount was still inside the plugin");
  if (!r.seen.includes("release")) throw new Error(`the release did not run: ${r.seen.join(",")}`);
});

await check("没有声明独占的挂载不排队 —— 这条规则是挂载自己说的", async () => {
  const r = racer("web", false);
  const { gw } = await fixture(r.plugin);
  await Promise.all([
    gw.invoke(ctx, "web.touch", { mark: "one" } as any),
    gw.invoke(ctx, "web.touch", { mark: "two" } as any),
  ]);
  if (!r.overlapped()) throw new Error("a plugin that never asked for exclusivity was serialised anyway");
});

await check("一个被拒的调用不会卡住排在它后面的那个", async () => {
  const r = racer("node", true);
  const { gw } = await fixture(r.plugin);
  const [bad, good] = await Promise.all([
    gw.invoke(ctx, "node.nosuchtool", {} as any),
    gw.invoke(ctx, "node.touch", { mark: "after" } as any),
  ]);
  if (bad.status !== "rejected") throw new Error("an unknown tool was accepted");
  if (good.status !== "succeeded") throw new Error(`the call behind a refusal did not run: ${JSON.stringify(good)}`);
});

await check("不同 agent 的同名挂载互不排队", async () => {
  const r = racer("node", true);
  const { gw, store } = await fixture(r.plugin);
  await store.createAgent("t", "b");
  await store.addMount({
    tenantId: "t", agentId: "b", alias: "node", plugin: "node",
    installationId: "i2", connectionId: null, toolVersion: "1.0.0",
    publicConfig: {}, secretRef: null, policy: null,
  });
  await Promise.all([
    gw.invoke(ctx, "node.touch", { mark: "a" } as any),
    gw.invoke({ ...ctx, agentId: "b" }, "node.touch", { mark: "b" } as any),
  ]);
  // Two agents are two machines. Serialising them together would make one
  // agent's container wait on another's, which is not what the mount asked for.
  //
  // Asserted by overlap, not by the clock. This read `Date.now() - t0 > 40`
  // once, and it failed exactly once — while a deploy was running on the same
  // machine — which is a test reporting on the host rather than on the code.
  // A wall-clock threshold is a claim about how busy the box is; overlap is
  // the property itself, and the racer already watches it.
  if (!r.overlapped()) throw new Error("two different agents were serialised against each other");
});

await check("队列住在实例上 —— 所以【一个 agent 一个 gateway】是它的前提,不是巧合", async () => {
  // The guarantee lives in another file: `cf/src/index.ts`'s
  // `this.#runtime ??= new AgentRuntime(...)` builds the runtime
  // once per Durable Object, and a Durable Object is one single-threaded
  // instance per (tenant, agent). This case does not test that line; it makes
  // the *consequence* of losing it visible, so a future "new AgentRuntime per
  // request" shows up here as overlap rather than as a container nobody can
  // release six weeks later.
  const r = racer("node", true);
  const { store, gw } = await fixture(r.plugin);
  const second = new ToolGateway(store, [r.plugin], new Set(([r.plugin]).map((p: any) => p.id)), { async resolve() { return null; } });

  await Promise.all([
    gw.invoke(ctx, "node.touch", { mark: "one" } as any),
    second.invoke(ctx, "node.touch", { mark: "two" } as any),
  ]);
  if (!r.overlapped()) {
    throw new Error(
      "two gateways serialised against each other, so this test no longer describes the design: " +
      "the queue is per instance, and its correctness rests on there being one",
    );
  }
});

console.log(`\n  Exclusive mounts\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
