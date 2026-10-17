/**
 * The operator's provider-token route (cf/src/admin-provider-tokens.ts), without a network or a database: which
 * tenant a tenant-scoped token may be issued for, and that refusing a name at issuance leaves a row issued earlier
 * resolving, listed and revocable.
 */
import { adminProviderTokens, RESERVED_TENANT_PREFIX } from "../cf/src/admin-provider-tokens.ts";
import { derivedTenant } from "../cf/src/provision/handlers.ts";
import type { ProviderTokenDirectory, ProviderTokenIdentity } from "../cf/src/control-plane.ts";
import { hashProviderToken } from "../cf/src/provider-token.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const TOKEN = "operator-token-for-tests";
type Row = ProviderTokenIdentity & { hash: string; createdAt: number; revokedAt: number | null; lastUsedAt: number | null };

/** The directory in memory: what the route writes and reads, nothing more. */
function directory(seed: Row[] = []): ProviderTokenDirectory & { rows: Row[] } {
  const rows: Row[] = [...seed];
  let clock = 1_800_000_000_000;
  return {
    rows,
    async issue(r) { rows.unshift({ ...r, createdAt: ++clock, revokedAt: null, lastUsedAt: null }); },
    async lookup(hash) {
      const r = rows.find((x) => x.hash === hash && x.revokedAt === null);
      if (!r) return null;
      const { hash: _h, createdAt: _c, revokedAt: _r, lastUsedAt: _l, ...identity } = r;
      return identity as ProviderTokenIdentity;
    },
    async revoke(hash) { const r = rows.find((x) => x.hash === hash && x.revokedAt === null); if (!r) return false; r.revokedAt = ++clock; return true; },
    async list() { return rows.map((r) => ({ ...r })); },
    async touch() {},
  };
}
const request = (method: string, body?: unknown, query = "") =>
  new Request(`https://antiproton.ai/admin/provider-tokens${query}`, {
    method, headers: { "x-harness-token": TOKEN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const call = (req: Request, dir: ProviderTokenDirectory) => adminProviderTokens(req, TOKEN, dir, new URL(req.url));
const issue = (tenantId: string) => ({ label: "a label", scope: "tenant", tenantId, raftOrigin: "https://api.raft.build" });

await check("the reserved prefix is the one the derivation writes, for plain and digested server ids alike", async () => {
  for (const id of ["srv-1", "d21383ee-df0a-4ed0-8f4c-ef263f2adb68", "srv:prod", "x".repeat(64)]) {
    assert(derivedTenant(id).startsWith(RESERVED_TENANT_PREFIX), `${id.slice(0, 24)} derives ${derivedTenant(id)}`);
  }
});

await check("a tenant token is refused for a tenant under raft_, with a 400 that says why, and nothing is issued", async () => {
  // The first is the shape a platform token derives for server pu-verify-1013; the second a digested one.
  for (const tenantId of ["raft_pu-verify-1013", derivedTenant("srv:prod"), "raft_x"]) {
    const dir = directory();
    const res = await call(request("POST", issue(tenantId)), dir);
    const body = await res.json() as { error?: string; hint?: string; token?: string };
    assert(res.status === 400, `${tenantId}: ${res.status} ${JSON.stringify(body)}`);
    assert(body.error === "tenantId" && /reserved/.test(body.hint ?? "") && body.hint!.includes(RESERVED_TENANT_PREFIX), `${tenantId}: ${JSON.stringify(body)}`);
    assert(body.token === undefined && dir.rows.length === 0, `${tenantId}: a token was issued`);
  }
});

await check("a tenant that only resembles the prefix is issued as before", async () => {
  for (const tenantId of ["raft-staging", "Raft_x", "raftx", "t-raft", "eval-cindy", "demo"]) {
    const dir = directory();
    const res = await call(request("POST", issue(tenantId)), dir);
    const body = await res.json() as { tenantId?: string; token?: string };
    assert(res.status === 201 && body.tenantId === tenantId && typeof body.token === "string", `${tenantId}: ${res.status} ${JSON.stringify(body)}`);
    assert(dir.rows.length === 1 && dir.rows.some((r) => r.scope === "tenant" && r.tenantId === tenantId), `${tenantId}: rows ${JSON.stringify(dir.rows)}`);
  }
});

await check("a platform token is unaffected: it has no tenant, and its server's raft_ tenant is derived per request", async () => {
  const dir = directory();
  const res = await call(request("POST", { label: "platform", scope: "platform", raftOrigin: "https://api.raft.build" }), dir);
  assert(res.status === 201 && dir.rows.length === 1 && dir.rows[0]!.scope === "platform", `${res.status} ${await res.text()}`);
});

await check("a row issued under raft_ before the refusal still resolves, is listed, and can be revoked", async () => {
  const token = "pt_live_" + "E".repeat(43);
  const hash = await hashProviderToken(token);
  const dir = directory([{ hash, label: "pu-verify-1013", scope: "tenant", tenantId: "raft_pu-verify-1013", raftOrigin: "https://pu-verify.invalid", createdAt: 1, revokedAt: null, lastUsedAt: null }]);
  const who = await dir.lookup(hash);
  assert(who?.scope === "tenant" && who.tenantId === "raft_pu-verify-1013", `lookup: ${JSON.stringify(who)}`);
  const listed = await call(request("GET"), dir);
  const tokens = (await listed.json() as { tokens: Row[] }).tokens;
  assert(listed.status === 200 && tokens.some((t) => t.hash === hash && t.scope === "tenant" && t.tenantId === "raft_pu-verify-1013"), `list: ${JSON.stringify(tokens)}`);
  const revoked = await call(request("DELETE", undefined, `?hash=${hash}`), dir);
  assert(revoked.status === 200 && (await revoked.json() as { revoked: boolean }).revoked === true && await dir.lookup(hash) === null, "revoke");
});

console.log(`\n  provider tokens (admin route)\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
