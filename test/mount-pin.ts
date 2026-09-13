/**
 * A stored mount names a plugin and pins its version. Both of those can stop
 * being true, and the gateway's answer when they do is a refusal.
 *
 * Why this suite exists: neither refusal had a case, and `cf/src/runtime.ts`
 * already records what that cost — "github went to 2.0.0 and every mount
 * seeded before that day was refused on every call after it, silently, because
 * the one test that would have noticed died the same day."
 *
 * The same two refusals are what a *stale* deploy produces, which is why they
 * are worth pinning now (Piper, 2026-09-13). Production state moves forward on
 * its own: `repinMounts` lifts every mount to the registry's version, and the
 * sandbox rename rewrote `mounts.plugin` from `run9` to `sandbox`. Ship code
 * older than either and the rows outlive it — a lower registry version makes
 * every re-pinned mount answer `version_mismatch`, and a plugin id no longer
 * registered makes every renamed mount answer `plugin_unavailable`. So a
 * rollback is not a downgrade to older behaviour; it is a refusal on every
 * call. That argument is the reason the deploy gate must ask "is this the
 * current code", not "is this code merged" (#247's follow-up).
 *
 * What each case pins is the refusal itself: the code, the fact that it names
 * what disagrees, and that the plugin is never invoked under a contract that
 * no longer holds.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { ToolError, ToolResult } from "../src/core/tools.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

/**
 * The refusal, or a failure naming what came back instead.
 *
 * `ToolResult` is discriminated on `status`, so narrowing is all this needs —
 * reaching for `(r.error as any)` here would be reading a field the type says
 * may not be there, which is the shape of thing being cleaned up this week.
 */
function refusal(r: ToolResult): ToolError {
  if (r.status !== "rejected") throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.error;
}

/** A plugin that records whether it was reached, so a refusal can be shown to refuse. */
function spy(version: string): Plugin & { calls: number } {
  const p = {
    id: "boxes", version, defaultForAllAgents: true,
    tools: [{ name: "ping", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
    calls: 0,
    async invoke() { p.calls += 1; return { ok: true }; },
  } satisfies Plugin & { calls: number };
  return p;
}

/** One mount, written with `plugin` and `toolVersion` as stored, not as registered. */
async function fixture(stored: { plugin: string; toolVersion: string }, registered: Plugin[]) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "box", plugin: stored.plugin,
    installationId: "i-box", connectionId: null, toolVersion: stored.toolVersion,
    publicConfig: {}, secretRef: null, policy: null,
  });
  const gw = new ToolGateway(store, registered, { async resolve() { return "value"; } });
  return { store, gw, ctx: { tenantId: "t", agentId: "a", taskId: "k" } };
}

await check("注册表的版本比挂载钉的低时,调用被拒而不是照旧执行", async () => {
  // The direction that matters is this one: a mount pinned at 2.0.0 meeting a
  // registry that says 1.0.0 is exactly what shipping older code produces.
  const plugin = spy("1.0.0");
  const { gw, ctx } = await fixture({ plugin: "boxes", toolVersion: "2.0.0" }, [plugin]);
  const r = await gw.invoke(ctx, "box.ping", {});
  if (refusal(r).code !== "version_mismatch") {
    throw new Error(`a mount pinned at 2.0.0 was served by a 1.0.0 registry: ${JSON.stringify(r)}`);
  }
  if (plugin.calls !== 0) throw new Error("the plugin ran under a contract the mount had not agreed to");
});

await check("版本不一致的拒绝要把两个版本都说出来", async () => {
  // A refusal that does not say which two numbers disagree cannot tell the
  // reader whether the code or the row is the stale one — and with a rollback
  // it is the code, which is the opposite of the usual case.
  const { gw, ctx } = await fixture({ plugin: "boxes", toolVersion: "2.0.0" }, [spy("1.0.0")]);
  const r = await gw.invoke(ctx, "box.ping", {});
  const message = refusal(r).message;
  for (const v of ["2.0.0", "1.0.0"]) {
    if (!message.includes(v)) throw new Error(`the refusal does not say ${v}: ${message}`);
  }
});

await check("挂载记的插件 id 不在注册表里时,拒绝里要带那个 id", async () => {
  // The shape the sandbox rename would hit from older code: rows say
  // `sandbox`, the registry offers `run9`, and every migrated mount resolves
  // to nothing. It must refuse by name, because the name is the whole finding.
  const { gw, ctx } = await fixture({ plugin: "sandbox", toolVersion: "1.0.0" }, [{ ...spy("1.0.0"), id: "run9" }]);
  const r = await gw.invoke(ctx, "box.ping", {});
  if (refusal(r).code !== "plugin_unavailable") {
    throw new Error(`a mount naming an unregistered plugin was served anyway: ${JSON.stringify(r)}`);
  }
  const message = refusal(r).message;
  if (!message.includes("sandbox")) throw new Error(`the refusal does not name the plugin the row asks for: ${message}`);
});

await check("对得上的挂载照常执行 —— 这几条拒绝不是把门焊死", async () => {
  // Without this, every case above passes on a gateway that refuses
  // everything, which is the failure mode a guard test invites.
  const plugin = spy("1.0.0");
  const { gw, ctx } = await fixture({ plugin: "boxes", toolVersion: "1.0.0" }, [plugin]);
  const r = await gw.invoke(ctx, "box.ping", {});
  if (r.status !== "succeeded") throw new Error(`a mount that agrees with the registry was refused: ${JSON.stringify(r)}`);
  if (plugin.calls !== 1) throw new Error(`the plugin ran ${plugin.calls} times`);
});

console.log(`\n  A mount's plugin and pin must still exist\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
// A suite that runs no cases must not report success. `pass === results.length` is the whole of
// this file's verdict, and an empty run satisfies it — which is how a suite
// dies without saying so: the gate runs every file (#245), but a file that
// stopped asserting anything still exits 0. `cf/src/runtime.ts` records what
// that cost once, when the one test guarding a version pin died the same day
// the pin broke and nothing went red until the breakage reached production.
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
