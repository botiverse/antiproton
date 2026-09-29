/**
 * Every agent's web search goes through Exa on the operator's key: the seeded `search` mount resolves
 * OPERATOR_EXA_REF to the deployment's key server-side, and `http`'s keyless search is withheld from the
 * model while that mount can search.
 */
import { AgentRuntime, keylessSearchWithheld, OPERATOR_EXA_REF } from "../cf/src/runtime.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const originalFetch = globalThis.fetch;

async function runtime(operatorExa?: string) {
  const host = sqliteHost();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    ...(operatorExa ? { operatorExa } : {}),
  } as any);
  await rt.ready();
  await rt.provision("t", "a");
  return rt;
}

await check("a new agent gets a `search` mount on Exa, and its search sends the operator's key to Exa", async () => {
  const rt = await runtime("exa-operator-key");
  const mount = await rt.store.getMountByAlias("t", "a", "search");
  must(mount?.plugin === "exa" && mount.secretRef === OPERATOR_EXA_REF, JSON.stringify(mount));
  const seen: Array<{ url: string; key: string | null }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    seen.push({ url: String(url), key: new Headers(init?.headers ?? {}).get("x-api-key") });
    return new Response(JSON.stringify({ results: [{ title: "T", url: "https://x.test/", highlights: ["h"] }] }), { headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const r = await rt.gateway().invoke({ tenantId: "t", agentId: "a", taskId: "a:main" }, "search.search", { query: "q" });
    must(r.status === "succeeded", JSON.stringify(r));
  } finally { globalThis.fetch = originalFetch; }
  must(seen.length === 1 && seen[0]!.url === "https://api.exa.ai/search" && seen[0]!.key === "exa-operator-key", JSON.stringify(seen));
});

await check("the keyless search is withheld while an Exa mount can search, and kept when it cannot", async () => {
  const web = { alias: "web", plugin: "http", secretRef: null };
  const seeded = { alias: "search", plugin: "exa", secretRef: OPERATOR_EXA_REF };
  must(keylessSearchWithheld([web, seeded], true).join() === "web.search", "operator key: not withheld");
  must(keylessSearchWithheld([web, seeded], false).length === 0, "no operator key: withheld anyway, leaving no search");
  must(keylessSearchWithheld([web, { alias: "mine", plugin: "exa", secretRef: "agent:mine" }], false).join() === "web.search", "own key: not withheld");
  must(keylessSearchWithheld([web, { alias: "mine", plugin: "exa", secretRef: null }], true).length === 0, "keyless exa mount: withheld");
  must(keylessSearchWithheld([web], true).length === 0, "no exa mount: withheld");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
