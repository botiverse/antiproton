/**
 * The operator's provider-token route (cf/src/admin-provider-tokens.ts), without a network or a database: which
 * tenant a tenant-scoped token may be issued for, and that refusing a name at issuance leaves a row issued earlier
 * resolving, listed and revocable. The same reservation on `/admin/api-keys`, through the Worker's own `fetch`; and
 * `/admin/service-tokens`, which accepts a `raft_` tenant only for a named, live provisioned agent there.
 */
import { register } from "node:module";
import { adminProviderTokens, RESERVED_TENANT_PREFIX } from "../cf/src/admin-provider-tokens.ts";
import { adminServiceTokens } from "../cf/src/admin-service-tokens.ts";
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

// The Worker itself, for /admin/api-keys: its `cloudflare:` imports answered by stand-ins, as in test/admin-fail-closed.ts.
const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { default: worker } = await import("../cf/src/index.ts");
const { setLogSink } = await import("../src/core/log.ts");
setLogSink(() => {});

/** POST /admin/api-keys against a database that records every statement it runs. */
async function issueApiKey(tenantId: string) {
  const writes: string[] = [];
  const stmt = (sql: string): any => ({
    bind: () => stmt(sql),
    run: async () => { writes.push(sql); return { meta: { changes: 1 } }; },
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  const env = {
    AUTOMATION_TOKEN: TOKEN,
    CONTROL_DB: { prepare: stmt, batch: async () => [] },
    AGENT: { idFromName: (n: string) => n, get: () => { throw new Error("no object is reached issuing a key"); } },
  };
  const res = await worker.fetch(new Request("https://x/admin/api-keys", {
    method: "POST", headers: { "x-harness-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ tenantId, ownerAgentId: "owner-1", label: "a label" }),
  }), env as never, { waitUntil() {}, passThroughOnException() {} } as never);
  return { status: res.status, body: await res.json() as { error?: string; hint?: string; key?: string; tenantId?: string }, inserted: writes.filter((w) => /INSERT INTO api_keys/.test(w)).length };
}

await check("an API key is refused for a tenant under raft_: its owner agent and the agents it makes would live there", async () => {
  for (const tenantId of ["raft_pu-verify-1013", derivedTenant("srv:prod"), "raft_x"]) {
    const out = await issueApiKey(tenantId);
    assert(out.status === 400 && out.body.error === "tenantId" && /reserved/.test(out.body.hint ?? "") && out.body.hint!.includes(RESERVED_TENANT_PREFIX),
      `${tenantId}: ${out.status} ${JSON.stringify(out.body)}`);
    assert(out.body.key === undefined && out.inserted === 0, `${tenantId}: a key was issued`);
  }
});

await check("an API key for any other tenant is issued as before", async () => {
  for (const tenantId of ["bench", "raft-staging", "Raft_x", "demo"]) {
    const out = await issueApiKey(tenantId);
    assert(out.status === 200 && typeof out.body.key === "string" && out.body.tenantId === tenantId && out.inserted === 1, `${tenantId}: ${out.status} ${JSON.stringify(out.body)}`);
  }
});

/** POST /admin/service-tokens against a directory and a provisioned-agents registry, both in memory. */
async function issueServiceToken(body: Record<string, unknown>, agents: Array<{ tenantId: string; agentId: string; status: string; deletedAt: number | null }>) {
  const rows: unknown[] = [];
  const lookups: string[] = [];
  const dir = {
    async issue(r: unknown) { rows.push(r); }, async lookup() { return null; }, async revoke() { return false; },
    async list() { return []; }, async touch() {},
  };
  const provisioned = {
    async getByAgentId(tenantId: string, agentId: string) {
      lookups.push(`${tenantId}/${agentId}`);
      return (agents.find((a) => a.tenantId === tenantId && a.agentId === agentId) ?? null) as never;
    },
  };
  const req = new Request("https://x/admin/service-tokens", {
    method: "POST", headers: { "x-harness-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const res = await adminServiceTokens(req, TOKEN, dir as never, new URL(req.url), provisioned);
  return { status: res.status, body: await res.json() as { error?: string; hint?: string; token?: string; agentId?: string }, rows, lookups };
}
const SERVER_TENANT = "raft_d21383ee-df0a-4ed0-8f4c-ef263f2adb68";
const LIVE: { tenantId: string; agentId: string; status: string; deletedAt: number | null } = { tenantId: SERVER_TENANT, agentId: "raft_01JAGENT", status: "active", deletedAt: null };

await check("a service token for a raft_ tenant is issued for a live provisioned agent named by agentId", async () => {
  const out = await issueServiceToken({ label: "operator", tenantId: SERVER_TENANT, agentId: "raft_01JAGENT" }, [LIVE]);
  assert(out.status === 201 && out.rows.length === 1 && out.body.agentId === "raft_01JAGENT", `${out.status} ${JSON.stringify(out.body)}`);
  assert(out.lookups.join(",") === `${SERVER_TENANT}/raft_01JAGENT`, `looked up ${out.lookups}`);
});

await check("a service token for a raft_ tenant is refused with a 400 without agentId, or for an agent that is not live there", async () => {
  const cases: Array<[string, Record<string, unknown>, typeof LIVE[]]> = [
    // The label's default agent would be a new principal in the server's tenant. Refused even when a row happens to
    // carry the default's name (u-operator): the agent must be named, not inferred from a label.
    ["no agentId", { label: "operator", tenantId: SERVER_TENANT }, [LIVE, { ...LIVE, agentId: "u-operator" }]],
    ["never provisioned", { label: "operator", tenantId: SERVER_TENANT, agentId: "raft_01JOTHER" }, [LIVE]],
    ["another tenant's agent", { label: "operator", tenantId: SERVER_TENANT, agentId: "raft_01JAGENT" }, [{ ...LIVE, tenantId: "raft_other" }]],
    ["deleted", { label: "operator", tenantId: SERVER_TENANT, agentId: "raft_01JAGENT" }, [{ ...LIVE, status: "deleted", deletedAt: 5 }]],
    ["marked deleted only", { label: "operator", tenantId: SERVER_TENANT, agentId: "raft_01JAGENT" }, [{ ...LIVE, status: "deleted" }]],
  ];
  for (const [name, body, agents] of cases) {
    const out = await issueServiceToken(body, agents);
    assert(out.status === 400 && out.body.error === "agentId" && out.body.hint!.includes(RESERVED_TENANT_PREFIX) && /provisioned/.test(out.body.hint ?? ""),
      `${name}: ${out.status} ${JSON.stringify(out.body)}`);
    assert(out.body.token === undefined && out.rows.length === 0, `${name}: a token was issued`);
  }
});

await check("a service token for any other tenant is issued as before, with or without agentId, and nothing is looked up", async () => {
  for (const body of [{ label: "a@b.c" }, { label: "x", tenantId: "demo" }, { label: "x", tenantId: "raft-staging", agentId: "new-agent" }, { label: "x", tenantId: "Raft_x" }]) {
    const out = await issueServiceToken(body, []);
    assert(out.status === 201 && out.rows.length === 1 && out.lookups.length === 0, `${JSON.stringify(body)}: ${out.status} ${JSON.stringify(out.body)} lookups=${out.lookups}`);
  }
});

console.log(`\n  provider tokens (admin route)\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
