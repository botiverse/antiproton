/**
 * Service tokens (task #7): the shape that is issued and recognised
 * (cf/src/service-token.ts), and the operator's route (cf/src/admin-service-tokens.ts),
 * without a network or a database.
 */
import { hashServiceToken, looksLikeServiceToken, newServiceToken, SERVICE_TOKEN_PREFIX } from "../cf/src/service-token.ts";
import { adminServiceTokens, LABEL_MAX } from "../cf/src/admin-service-tokens.ts";
import type { ServiceTokenDirectory, ServiceTokenRow } from "../cf/src/control-plane.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const TOKEN = "operator-token-for-tests";

/** The directory in memory: what the route writes and reads, nothing more. */
function directory(): ServiceTokenDirectory & { rows: ServiceTokenRow[] } {
  const rows: ServiceTokenRow[] = [];
  let clock = 1_800_000_000_000;
  return {
    rows,
    async issue(r) { rows.unshift({ ...r, createdAt: ++clock, revokedAt: null, lastUsedAt: null }); },
    async lookup(hash) { const r = rows.find((x) => x.hash === hash && x.revokedAt === null); return r ? { label: r.label, tenantId: r.tenantId, agentId: r.agentId } : null; },
    async revoke(hash) { const r = rows.find((x) => x.hash === hash && x.revokedAt === null); if (!r) return false; r.revokedAt = ++clock; return true; },
    async list() { return rows.map((r) => ({ ...r })); },
    async touch() {},
  };
}
const request = (method: string, body?: unknown, headers: Record<string, string> = { "x-harness-token": TOKEN }, query = "") =>
  new Request(`https://antiproton.ai/admin/service-tokens${query}`, {
    method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
// No default for the token: `undefined` is a case here (nothing configured), not an omission.
const call = (req: Request, token: string | undefined, dir: ServiceTokenDirectory) => adminServiceTokens(req, token, dir, new URL(req.url));

await check("a new token carries the prefix and 32 random bytes, differs every time, and is recognised by shape alone", async () => {
  const a = newServiceToken(); const b = newServiceToken();
  assert(a !== b && a.startsWith(SERVICE_TOKEN_PREFIX), `tokens ${a} ${b}`);
  assert(/^st-[A-Za-z0-9_-]{43}$/.test(a), `unexpected shape: ${a}`);
  assert(looksLikeServiceToken(a), "its own token was not recognised");
  for (const bad of ["", "st-", "st-short", `ap-${"x".repeat(43)}`, `${a} `, `${a}!`, a.slice(1)]) {
    assert(!looksLikeServiceToken(bad), `recognised ${JSON.stringify(bad)}`);
  }
  const h = await hashServiceToken(a);
  assert(/^[0-9a-f]{64}$/.test(h) && h === await hashServiceToken(a) && !h.includes(a.slice(3, 12)), `hash ${h}`);
});

await check("refused before the directory is touched: no token configured, a wrong token, an unknown method", async () => {
  const cases: Array<[string, Request, string | undefined, number]> = [
    ["no token configured", request("GET"), undefined, 401],
    ["a wrong token", request("GET", undefined, { "x-harness-token": "nope" }), TOKEN, 401],
    ["no header", request("GET", undefined, {}), TOKEN, 401],
    ["PUT", request("PUT"), TOKEN, 405],
  ];
  for (const [label, req, token, status] of cases) {
    const dir = directory();
    const res = await call(req, token, dir);
    assert(res.status === status, `${label}: ${res.status}, not ${status}`);
    assert(res.headers.get("cache-control") === "no-store", `${label}: cache-control ${res.headers.get("cache-control")}`);
    assert(dir.rows.length === 0, `${label}: the directory changed`);
  }
});

await check("issuing shows the token once; the listing carries its hash and never the token; revoking reports once", async () => {
  const dir = directory();
  const issued = await call(request("POST", { label: "nightly" }), TOKEN, dir);
  assert(issued.status === 201, `issue ${issued.status}`);
  const body = await issued.json() as { token: string; hash: string; label: string; tenantId: string; agentId: string };
  assert(looksLikeServiceToken(body.token) && body.hash === await hashServiceToken(body.token), "the answer's hash is not the token's");
  assert(body.label === "nightly" && body.tenantId === "demo" && body.agentId === "u-nightly", `identity ${JSON.stringify(body)}`);
  assert(dir.rows[0]!.hash === body.hash && !JSON.stringify(dir.rows).includes(body.token), "the directory saw the token itself");
  const listed = await (await call(request("GET"), TOKEN, dir)).text();
  assert(listed.includes(body.hash) && listed.includes('"nightly"') && !listed.includes(body.token), "the listing carries the token, or lost the row");
  const first = await (await call(request("DELETE", undefined, undefined, `?hash=${body.hash}`), TOKEN, dir)).json() as { revoked: boolean };
  const second = await (await call(request("DELETE", undefined, undefined, `?hash=${body.hash}`), TOKEN, dir)).json() as { revoked: boolean };
  assert(first.revoked === true && second.revoked === false, `revokes ${first.revoked} ${second.revoked}`);
  assert((await dir.lookup(body.hash)) === null, "a revoked token still resolves");
  const again = await (await call(request("GET"), TOKEN, dir)).json() as { tokens: ServiceTokenRow[] };
  assert(again.tokens.length === 1 && again.tokens[0]!.revokedAt !== null, "the listing dropped the revoked row, or forgot when");
});

await check("what is refused with 400: no label, a label too long, an agent that cannot name an object, a hash that is not one", async () => {
  const dir = directory();
  const cases: Array<[string, Request]> = [
    ["no body", request("POST")],
    ["not JSON", new Request("https://antiproton.ai/admin/service-tokens", { method: "POST", headers: { "x-harness-token": TOKEN }, body: "{" })],
    ["empty label", request("POST", { label: "  " })],
    ["label too long", request("POST", { label: "x".repeat(LABEL_MAX + 1) })],
    ["label not a string", request("POST", { label: 7 })],
    ["agent with a slash", request("POST", { label: "ok", agentId: "a/b" })],
    ["hash that is not one", request("DELETE", undefined, undefined, "?hash=abc")],
    ["no hash", request("DELETE")],
  ];
  for (const [label, req] of cases) {
    const res = await call(req, TOKEN, dir);
    assert(res.status === 400, `${label}: ${res.status}, not 400`);
  }
  assert(dir.rows.length === 0, "a refused request issued a token");
  // A pinned agent and tenant are kept as given, and a label at the limit is fine.
  const ok = await (await call(request("POST", { label: "x".repeat(LABEL_MAX), tenantId: "t-2", agentId: "u-shared" }), TOKEN, dir)).json() as { tenantId: string; agentId: string };
  assert(ok.tenantId === "t-2" && ok.agentId === "u-shared", `pinned ${JSON.stringify(ok)}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
