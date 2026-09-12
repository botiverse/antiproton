/**
 * A tenant's key, derived rather than issued.
 *
 * The identity is carried in the public half and *proved* by the secret half,
 * so these tests are about one sentence: naming a tenant is not being one.
 */
import { deriveKey, callerOf } from "../broker/src/keys.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const S = "a shared secret between two of our own workers";
const pair = (k: { ak: string; sk: string }) => `${k.ak}:${k.sk}`;

await check("同一个 (租户, agent) 每次算出来都一样,所以不用存", async () => {
  const a = await deriveKey(S, { tenantId: "t-a", agentId: "a1" });
  const b = await deriveKey(S, { tenantId: "t-a", agentId: "a1" });
  if (a.sk !== b.sk) throw new Error("the same agent got two different keys, so it would have to be stored");
  const who = await callerOf(S, pair(a));
  if (who?.tenantId !== "t-a" || who.agentId !== "a1") throw new Error(JSON.stringify(who));
});

await check("两列都被证明,不是一列证明一列自报", async () => {
  // Binding only to the tenant would leave the audit's agent column asserted
  // by the caller: any agent could file its usage under a sibling's name.
  const a1 = await deriveKey(S, { tenantId: "t-a", agentId: "a1" });
  const a2 = await deriveKey(S, { tenantId: "t-a", agentId: "a2" });
  if (a1.sk === a2.sk) throw new Error("two agents of one tenant share a key, so the agent column is self-reported");

  // a1's signature under a2's name: the name is not what is checked.
  const forged = `${a2.ak}:${a1.sk}`;
  if (await callerOf(S, forged)) throw new Error("one agent could file its usage under a sibling's name");
});

await check("改名字改不出身份 —— 签名是对着名字算的", async () => {
  const a = await deriveKey(S, { tenantId: "t-a", agentId: "a1" });
  const claimed = `ak_t-victim.a1:${a.sk}`;
  if (await callerOf(S, claimed)) throw new Error("claiming another tenant by renaming the public half worked");
});

await check("换了共享密钥,旧 key 全部失效 —— 这就是轮换,也是它的代价", async () => {
  const a = await deriveKey(S, { tenantId: "t-a", agentId: "a1" });
  if (await callerOf("a different secret", pair(a))) throw new Error("a key survived the secret it was derived from");
  // And the cost, stated: rotation cuts everyone off at once. There is no
  // per-tenant revocation, which is written beside the function because the
  // day it matters is the day someone needs to cut off exactly one account.
});

await check("畸形的呈递一律不是身份", async () => {
  for (const bad of [null, "", "nonsense", "ak_t.a", "ak_t.a:", ":sk", "ak_:sk", "ak_t.:sk", "tok_t.a:sk"]) {
    if (await callerOf(S, bad as any)) throw new Error(`${JSON.stringify(bad)} was accepted as an identity`);
  }
});

console.log(`\n  Derived keys\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
