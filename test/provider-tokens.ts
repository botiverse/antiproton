/**
 * The operator's provider-token route (cf/src/admin-provider-tokens.ts), without a network or a database: which
 * tenant a tenant-scoped token may be issued for, and that refusing a name at issuance leaves a row issued earlier
 * resolving, listed and revocable. The same reservation on `/admin/api-keys`, through the Worker's own `fetch`; and
 * `/admin/service-tokens`, which accepts a `raft_` tenant only for a named, live provisioned agent there.
 */
import { register } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { adminProviderTokens, PROVIDER_TOKEN_HASH, RESERVED_TENANT_PREFIX } from "../cf/src/admin-provider-tokens.ts";
import { adminServiceTokens } from "../cf/src/admin-service-tokens.ts";
import { derivedTenant } from "../cf/src/provision/handlers.ts";
import type { ProviderTokenDirectory, ProviderTokenIdentity } from "../cf/src/control-plane.ts";
import { hashProviderToken, looksLikeProviderToken, newProviderToken } from "../cf/src/provider-token.ts";

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
    async issue(r) {
      // As D1 answers a second row for the primary key (test/spec/control-plane-spec.ts reads the real one).
      if (rows.some((x) => x.hash === r.hash)) throw new Error("D1_ERROR: UNIQUE constraint failed: provider_tokens.hash: SQLITE_CONSTRAINT");
      rows.unshift({ ...r, createdAt: ++clock, revokedAt: null, lastUsedAt: null });
    },
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
const call = (req: Request, dir: ProviderTokenDirectory, hashRegistration = false) =>
  adminProviderTokens(req, TOKEN, dir, new URL(req.url), { hashRegistration });
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

// ---- registering by hash: the holder keeps the plaintext ------------------------------------------------------

/** The command docs/runbook.md "Canary environment" gives the token's holder, run exactly as written there. */
const HASH_COMMAND = `printf %s "$TOKEN" | sha256sum | cut -d' ' -f1`;
const shellHash = (token: string) => execFileSync("bash", ["-c", HASH_COMMAND], { env: { ...process.env, TOKEN: token }, encoding: "utf8" }).trim();
const ORIGIN = "https://api-aws-staging.botiverse.dev";
const byHash = (hash: unknown, extra: Record<string, unknown> = {}) => ({ label: "raft-staging-canary", scope: "platform", raftOrigin: ORIGIN, hash, ...extra });

await check("the runbook's shell command is hashProviderToken: the same 64 lowercase hex for minted tokens, and the runbook gives it verbatim", async () => {
  const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8");
  assert(runbook.includes(HASH_COMMAND), `docs/runbook.md does not give ${HASH_COMMAND}`);
  for (const token of [newProviderToken(), newProviderToken(), "pt-" + "A_-z09".repeat(8)]) {
    const want = await hashProviderToken(token);
    assert(PROVIDER_TOKEN_HASH.test(want), `hashProviderToken gave ${want}: not what the route accepts`);
    assert(shellHash(token) === want, `the shell command disagrees with hashProviderToken for a token of ${token.length} characters`);
  }
});

await check("registered by hash with the switch on: 201 with hash, label, scope and raftOrigin, no token anywhere, and the row resolves for the token", async () => {
  const token = newProviderToken();
  const hash = shellHash(token);
  for (const [body, tenant] of [[byHash(hash), undefined], [{ ...byHash(hash), scope: "tenant", tenantId: "canary-t" }, "canary-t"]] as const) {
    const dir = directory();
    const res = await call(request("POST", body), dir, true);
    const text = await res.text();
    assert(res.status === 201, `${res.status} ${text}`);
    const got = JSON.parse(text) as Record<string, unknown>;
    assert(got.hash === hash && got.label === "raft-staging-canary" && got.scope === body.scope && got.raftOrigin === ORIGIN && got.tenantId === tenant, text);
    assert(!("token" in got) && !/pt-/.test(text) && !text.includes(token), `the answer carries a token: ${text}`);
    const who = await dir.lookup(await hashProviderToken(token));
    assert(who?.scope === body.scope && who.raftOrigin === ORIGIN, `the token does not resolve: ${JSON.stringify(who)}`);
  }
});

await check("with the switch off (production) a hash is refused with 403 and nothing is written; cf/wrangler.jsonc does not set it, preview and the canary do", async () => {
  const dir = directory();
  const res = await call(request("POST", byHash(await hashProviderToken(newProviderToken()))), dir);
  const body = await res.json() as { error?: string; token?: string };
  assert(res.status === 403 && body.error === "hash_registration_disabled" && body.token === undefined && dir.rows.length === 0, `${res.status} ${JSON.stringify(body)} rows=${dir.rows.length}`);
  const vars = (file: string) => JSON.parse(readFileSync(new URL(`../cf/${file}`, import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")).vars;
  assert(!("PROVIDER_TOKEN_HASH_REGISTRATION" in vars("wrangler.jsonc")), "cf/wrangler.jsonc sets PROVIDER_TOKEN_HASH_REGISTRATION: production would register tokens by hash");
  for (const f of ["wrangler.preview.jsonc", "wrangler.canary.jsonc"]) assert(vars(f).PROVIDER_TOKEN_HASH_REGISTRATION === "1", `cf/${f}: ${JSON.stringify(vars(f).PROVIDER_TOKEN_HASH_REGISTRATION)}`);
});

await check("a malformed hash is a 400 and nothing is written: only what hashProviderToken produces is taken", async () => {
  const good = await hashProviderToken(newProviderToken());
  for (const bad of [good.toUpperCase(), good.slice(1), good + "0", Buffer.from(good, "hex").toString("base64url"), "z".repeat(64), ` ${good}`, "", 7, null]) {
    const dir = directory();
    const res = await call(request("POST", byHash(bad)), dir, true);
    const body = await res.json() as { error?: string };
    assert(res.status === 400 && body.error === "hash" && dir.rows.length === 0, `${JSON.stringify(bad)}: ${res.status} ${JSON.stringify(body)}`);
  }
  // A plaintext sent beside the hash is refused too: the point is that it never comes here.
  const dir = directory();
  const res = await call(request("POST", byHash(good, { token: "pt-" + "x".repeat(43) })), dir, true);
  assert(res.status === 400 && dir.rows.length === 0, `token beside hash: ${res.status}`);
});

await check("a hash already registered is a 409, live or revoked, and the first row is left as it was", async () => {
  const hash = await hashProviderToken(newProviderToken());
  const dir = directory();
  assert((await call(request("POST", byHash(hash)), dir, true)).status === 201, "first registration");
  const again = await call(request("POST", byHash(hash, { label: "other" })), dir, true);
  assert(again.status === 409 && (await again.json() as { error?: string }).error === "duplicate", `duplicate: ${again.status}`);
  await dir.revoke(hash);
  const revoked = await call(request("POST", byHash(hash)), dir, true);
  assert(revoked.status === 409, `after revoke: ${revoked.status}`);
  assert(dir.rows.length === 1 && dir.rows[0]!.label === "raft-staging-canary" && dir.rows[0]!.revokedAt !== null, JSON.stringify(dir.rows));
});

await check("operator-only: without the operator header the hash path is a 401 and nothing is written", async () => {
  const dir = directory();
  const req = new Request("https://antiproton.ai/admin/provider-tokens", { method: "POST", headers: { "content-type": "application/json", "x-harness-token": "wrong" }, body: JSON.stringify(byHash(await hashProviderToken(newProviderToken()))) });
  const res = await adminProviderTokens(req, TOKEN, dir, new URL(req.url), { hashRegistration: true });
  assert(res.status === 401 && dir.rows.length === 0, `${res.status} rows=${dir.rows.length}`);
});

await check("minting is unchanged, switch on or off: 201 with a fresh pt- token whose hash is the row's", async () => {
  for (const on of [false, true]) {
    const dir = directory();
    const res = await call(request("POST", { label: "minted", scope: "platform", raftOrigin: ORIGIN }), dir, on);
    const body = await res.json() as { token?: string; hash?: string; label?: string; scope?: string; raftOrigin?: string };
    assert(res.status === 201 && typeof body.token === "string" && looksLikeProviderToken(body.token), `${on}: ${res.status} ${JSON.stringify(Object.keys(body))}`);
    assert(body.hash === await hashProviderToken(body.token!) && dir.rows.length === 1 && dir.rows[0]!.hash === body.hash, `${on}: hash`);
    assert(JSON.stringify(Object.keys(body)) === '["token","hash","label","scope","raftOrigin"]', `${on}: ${JSON.stringify(Object.keys(body))}`);
  }
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

/** A control database holding only provider_tokens, as the Worker's own queries read and write it. */
function tokenDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => {
      if (/^INSERT INTO provider_tokens/.test(sql)) {
        const [hash, label, scope, tenant_id, raft_origin, created_at] = args;
        if (rows.has(String(hash))) throw new Error("D1_ERROR: UNIQUE constraint failed: provider_tokens.hash: SQLITE_CONSTRAINT");
        rows.set(String(hash), { hash, label, scope, tenant_id, raft_origin, created_at, revoked_at: null, last_used_at: null });
      }
      return { meta: { changes: 1 } };
    },
    first: async () => {
      if (/FROM provider_tokens WHERE hash = \?/.test(sql)) { const r = rows.get(String(args[0])); return r && r.revoked_at === null ? r : null; }
      return null;
    },
    all: async () => ({ results: [] }),
  });
  return { rows, db: { prepare: (sql: string) => stmt(sql), batch: async () => [] } };
}

await check("through the Worker: a token registered by hash (switch on) is accepted on /provision, and the same request with an unregistered token is a 401", async () => {
  const token = newProviderToken();
  const { rows, db } = tokenDb();
  const env = { AUTOMATION_TOKEN: TOKEN, PROVIDER_TOKEN_HASH_REGISTRATION: "1", CONTROL_DB: db,
    AGENT: { idFromName: (n: string) => n, get: () => { throw new Error("no object is reached"); } } };
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  const reg = await worker.fetch(new Request("https://x/admin/provider-tokens", {
    method: "POST", headers: { "x-harness-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(byHash(shellHash(token))),
  }), env as never, ctx);
  const regText = await reg.text();
  assert(reg.status === 201 && !regText.includes("pt-") && rows.size === 1, `register: ${reg.status} ${regText}`);
  const get = (bearer: string) => worker.fetch(new Request("https://x/provision/agents/raft_01JNOSUCH", { headers: { authorization: `Bearer ${bearer}` } }), env as never, ctx);
  const ok = await get(token);
  const okText = await ok.text();
  assert(ok.status !== 401 && !/not one this deployment issued/.test(okText), `the registered token was refused: ${ok.status} ${okText}`);
  const other = await get(newProviderToken());
  assert(other.status === 401, `an unregistered token: ${other.status}`);
  // The same Worker with the switch off: refused, nothing written.
  const off = await worker.fetch(new Request("https://x/admin/provider-tokens", {
    method: "POST", headers: { "x-harness-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(byHash(shellHash(newProviderToken()))),
  }), { ...env, PROVIDER_TOKEN_HASH_REGISTRATION: undefined } as never, ctx);
  assert(off.status === 403 && rows.size === 1, `switch off: ${off.status} rows=${rows.size}`);
});

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
