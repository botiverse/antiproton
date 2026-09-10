/**
 * Letting go of what is billed for merely existing.
 *
 * A container outlives its task unless something hands it back, and the only
 * signal that something went wrong is the exception the plugin raises. That
 * exception used to be caught and dropped one layer above the plugin, which is
 * how thirteen boxes were once found alive with a release path that had been
 * reporting success the whole time. Best effort is right — a finished task must
 * not fail over tidying up — but best effort must not mean silent.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const plugin = (id: string, release: () => Promise<boolean | void>): Plugin => ({
  id, version: "1.0.0", tools: [],
  async invoke() { return {}; },
  release,
});

async function fixture(plugins: Plugin[]) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const p of plugins) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias: p.id, plugin: p.id,
      installationId: `i-${p.id}`, connectionId: null, toolVersion: "1.0.0",
      publicConfig: {}, secretRef: null, policy: null,
    });
  }
  const gw = new ToolGateway(store, plugins, { async resolve() { return null; } });
  return { store, gw, ctx: { tenantId: "t", agentId: "a", taskId: "k" } };
}

await check("释放失败会被报告,而不是吞掉", async () => {
  const f = await fixture([
    plugin("held", async () => { throw new Error("box b-1 not released: delete returned 500"); }),
  ]);
  const r = await f.gw.releaseTask(f.ctx);
  if (r.failed.length !== 1) throw new Error(`a failed release was not reported: ${JSON.stringify(r)}`);
  if (!r.failed[0]!.error.includes("b-1")) throw new Error(`the reason was lost: ${r.failed[0]!.error}`);
  if (r.released.includes("held")) throw new Error("a failed release was counted as released");
});

await check("一个挂掉不影响别的 mount 被释放", async () => {
  const freed: string[] = [];
  const f = await fixture([
    plugin("bad", async () => { throw new Error("nope"); }),
    plugin("good", async () => { freed.push("good"); return true; }),
  ]);
  const r = await f.gw.releaseTask(f.ctx);
  if (!freed.includes("good")) throw new Error("a later mount was skipped after an earlier failure");
  if (r.released.join() !== "good") throw new Error(`released: ${r.released.join()}`);
  if (r.failed.length !== 1) throw new Error("the failure was not reported");
});

await check("没东西可释放不算失败", async () => {
  const f = await fixture([plugin("empty", async () => false)]);
  const r = await f.gw.releaseTask(f.ctx);
  if (r.failed.length) throw new Error("nothing to release was treated as a failure");
  if (r.released.length) throw new Error("nothing was held, yet something was reported released");
});

console.log(`\n  Releasing what is metered\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
