/**
 * The identity of a failed call reaches the record, as fields.
 *
 * This is the acceptance for the two lines the gateway owes (@Vera asked for it
 * as something checkable rather than a sentence, 2026-09-20): the context has to
 * carry `credentialRefKind`, and the failure the gateway records has to carry
 * the `identity` and `credentialRef` the plugin stamped on the error. Without
 * both, the console can only badge a failure by matching the message's prose,
 * which is one rewording away from silently showing the wrong identity (@Nova).
 *
 * The mount here names `agent:gh-token` and the resolver answers null, which is
 * the state that produced the false sentence this line of work began with: a
 * mount that HAS a reference, read as a mount that has no account.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { markIdentity, type Plugin, type PluginContext } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const caller = { tenantId: "t", agentId: "a", taskId: "k" };

/**
 * A plugin that fails, and the context it was handed.
 *
 * Built fresh per fixture rather than reset: a box written only inside the
 * callback narrows to `undefined` for the rest of the flow, and the cast that
 * silences that would also hide a plugin that was never called — which is a
 * real failure this has already caught once (the mount was switched off).
 */
function failingPlugin() {
  const seen: { ctx?: PluginContext } = {};
  const plugin: Plugin = {
    // On for this agent without a per-agent switch, so the call reaches the
    // plugin rather than being refused as a mount that is off.
    id: "svc", version: "1.0.0", defaultForAllAgents: true,
    tools: [{ name: "read", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
    async invoke(_tool, _args, ctx) {
      seen.ctx = ctx;
      throw markIdentity(new Error("the service refused"), ctx);
    },
  };
  return { plugin, seen };
}

/**
 * The two backends, built the same way.
 *
 * The event this file is about is written in TWO places — `src/store/sqlite.ts`
 * and `src/store/durable-object.ts` — and the Durable Object is the one
 * production runs. A payload proven on the node backend alone proves the
 * backend no deployment uses, and the two files had spelled the payload out
 * separately, so "the field is there" was a claim about whichever copy the
 * test happened to reach (cody, 2026-09-20). They now share one builder
 * (`src/store/operation-event.ts`); these run the assertion on both anyway,
 * because a shared builder is a fact about today's code and the acceptance
 * should outlive it.
 */
const BACKENDS = {
  sqlite: async () => { const s = new SqliteStore(":memory:"); await s.init(); return s; },
  "durable-object": async () => {
    const host = sqliteHost();
    const s = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
    await s.init();
    return s;
  },
} as const;

async function fixture(secretRef: string | null, backend: keyof typeof BACKENDS = "sqlite") {
  const { plugin, seen } = failingPlugin();
  const store: any = await BACKENDS[backend]();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef, policy: null,
  });
  // A reference that names a credential nobody can read: exactly what
  // `agentSecrets` answers for a missing row.
  return { gw: new ToolGateway(store, [plugin], { async resolve() { return null; } }), seen, store };
}

await check("the context says what kind of credential the mount names", async () => {
  const { gw, seen } = await fixture("agent:gh-token");
  await gw.invoke(caller, "svc.read", {});
  if (!seen.ctx) throw new Error("the plugin was never called");
  if (seen.ctx.credentialRefKind !== "agent") {
    throw new Error(`the mount names agent:gh-token and the context reported ${JSON.stringify(seen.ctx.credentialRefKind)}`);
  }
});

await check("a mount naming no credential is reported as naming none, not as unreported", async () => {
  const { gw, seen } = await fixture(null);
  await gw.invoke(caller, "svc.read", {});
  if (!seen.ctx) throw new Error("the plugin was never called");
  if (seen.ctx.credentialRefKind !== "none") {
    throw new Error(`a mount with no reference reported ${JSON.stringify(seen.ctx.credentialRefKind)}`);
  }
});

await check("the recorded failure carries the identity as fields, not only in its message", async () => {
  const { gw } = await fixture("agent:gh-token");
  const r: any = await gw.invoke(caller, "svc.read", {});
  if (r.status === "succeeded") throw new Error("the call did not fail");
  if (r.error?.identity !== "unreadable") {
    throw new Error(`the failure reports identity ${JSON.stringify(r.error?.identity)}; a page can only read the prose`);
  }
  if (r.error?.credentialRef !== "agent") {
    throw new Error(`the failure reports credentialRef ${JSON.stringify(r.error?.credentialRef)}, so nothing says who fixes it`);
  }
});

/**
 * The acceptance a reader can feel, rather than the one that passes a layer too
 * early (@Nova traced the fields two hops further, @Vera withdrew her own
 * criterion for reading the wrong layer, 2026-09-20).
 *
 * The returned envelope is not the path to the page: `pi-tools.ts` collapses it
 * into a string, and the console's `tool.result` has no structured error slot.
 * What the page already reads is `operation.completed`, whose `result` the store
 * carries verbatim — and the failing branch passes nothing today. So the
 * criterion is the event, not the return value.
 */
for (const backend of Object.keys(BACKENDS) as Array<keyof typeof BACKENDS>) {
await check(`the event the console already reads carries the identity, not only the return value (${backend})`, async () => {
  const { gw, store } = await fixture("agent:gh-token", backend);
  await gw.invoke(caller, "svc.read", {});
  const events = await store.taskEvents("t", "k");
  const completed = events.filter((e: any) => e.kind === "operation.completed");
  if (completed.length !== 1) throw new Error(`expected one operation.completed, got ${completed.length}`);
  // Top level, beside `operationId` and `status` — not inside `result`, which
  // the store spreads only when there is one (`sqlite.ts`). A failure has no
  // result, so an identity living in there would vanish on exactly the calls
  // that have an identity worth reading; and its absence would then mean "this
  // call produced nothing" rather than "nobody reported the identity", which
  // makes two different absences look alike (@Nova's shape, @Vera's reading).
  const payload = (completed[0] as any).payload ?? {};
  if (payload.identity === undefined) {
    throw new Error(`the recorded event carries no identity, so the console has nothing structured to badge: ${JSON.stringify(payload)}`);
  }
  if (payload.identity !== "unreadable" || payload.credentialRef !== "agent") {
    throw new Error(`the recorded event says ${JSON.stringify({ identity: payload.identity, credentialRef: payload.credentialRef })}`);
  }
  if (payload.result !== undefined && payload.result?.identity !== undefined) {
    throw new Error("the identity is inside `result`, where a failure's absent result takes it away");
  }
});
}

console.log(`\n  the identity of a failed call, in the record\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
