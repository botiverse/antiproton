/**
 * Who administers the deployment (auth.ts isAdmin) and `/admin/models` (cf/src/admin-models.ts): which
 * provider and model the operator's account serves per scope, validated by scope and by the provider's
 * model naming, kept with who set it; and the providers listed without their secrets.
 */
import { adminModels } from "../cf/src/admin-models.ts";
import { isAdmin, type Viewer } from "../cf/src/auth.ts";
import type { ModelOverride } from "../cf/src/control-plane.ts";
import { providersFrom } from "../src/model/providers.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const gh = (sub?: string): Viewer => ({ email: "x@y", name: null, username: "x", picture: null, source: "github", agentId: "a", tenantId: "t", ...(sub ? { sub } : {}) });

await check("admin: the operator's token, or a GitHub identity the deployment lists; nobody else", () => {
  const env = { ADMIN_IDENTITIES: "github:1, github:22" };
  must(isAdmin({ email: "automation", name: null, username: null, picture: null, source: "automation" }, env), "the operator's token");
  must(isAdmin(gh("github:22"), env), "a listed identity");
  must(!isAdmin(gh("github:2"), env), "a prefix of a listed id counted");
  must(!isAdmin(gh(), env), "a GitHub viewer without its key counted");
  must(!isAdmin(gh("github:1"), {}), "an unset list admitted someone");
  must(!isAdmin({ email: "anonymous (UNPROTECTED)", name: null, username: null, picture: null, source: "anonymous" }, env), "anonymous");
  must(!isAdmin(null, env), "nobody");
});

function store() {
  const rows = new Map<string, ModelOverride>();
  return {
    rows,
    overrides: {
      async effective() { return null; },
      async list() { return [...rows.values()]; },
      async put(o: ModelOverride) { rows.set(`${o.tenantId}/${o.agentId}`, o); },
      async remove(t: string, a: string) { return rows.delete(`${t}/${a}`); },
    },
  };
}
const GW = "https://gateway.ai.cloudflare.com/v1/acct/antiproton/compat";
const ENV = {
  MODEL_PROVIDERS: [
    { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
    { id: "cloudflare", baseUrl: GW, auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
  ],
  DEEPSEEK_API_KEY: "dk-secret", AI_GATEWAY_TOKEN: "gt-secret",
};
const call = async (method: string, body: unknown, s = store(), env: Record<string, unknown> = ENV) => {
  const r = await adminModels(method, body, "github:1", { overrides: s.overrides, providers: providersFrom(env), defaults: { model: "deepseek-flash" }, now: () => 7 });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, text };
};

await check("a choice per scope is kept with its provider and who set it, listed, and removed; the default and the providers are said, with no secret", async () => {
  const s = store();
  must((await call("PUT", { scope: "tenant", tenantId: "t1", provider: "cloudflare", model: "anthropic/claude-sonnet-5" }, s)).status === 200, "tenant");
  const agent = await call("PUT", { scope: "agent", tenantId: "t1", agentId: "a1", provider: "cloudflare", model: "openai/gpt-5" }, s);
  must(agent.status === 200 && agent.body.provider === "cloudflare" && agent.body.setBy === "github:1" && agent.body.setAt === 7, JSON.stringify(agent));
  // No provider named is the default one, so a client written before providers keeps working.
  const dep = await call("PUT", { scope: "deployment", model: "deepseek-v4-pro" }, s);
  must(dep.status === 200 && dep.body.provider === "deepseek", JSON.stringify(dep));
  // A row written before providers existed lists as the provider that serves it.
  s.rows.set("legacy/", { tenantId: "legacy", agentId: "", provider: null, model: "deepseek-flash", setBy: "x", setAt: 1 });
  const got = await call("GET", undefined, s);
  must(got.body.overrides.length === 4 && got.body.overrides.find((o: any) => o.tenantId === "legacy").provider === "deepseek", JSON.stringify(got.body.overrides));
  must(JSON.stringify(got.body.default) === '{"provider":"deepseek","model":"deepseek-flash","endpoint":"api.deepseek.com"}', JSON.stringify(got.body.default));
  must(JSON.stringify(got.body.providers.map((p: any) => [p.id, p.endpoint, p.modelFormat, p.available]))
    === '[["deepseek","api.deepseek.com","model",true],["cloudflare","gateway.ai.cloudflare.com","vendor/model",true]]', JSON.stringify(got.body.providers));
  must(!/dk-secret|gt-secret/.test(got.text), "a secret value is in the listing");
  must((await call("DELETE", { scope: "tenant", tenantId: "t1" }, s)).status === 204 && s.rows.size === 3, "delete");
  must((await call("DELETE", { scope: "tenant", tenantId: "t1" }, s)).status === 404, "a second delete found something");
});

await check("a model must be named the way its provider names models, under a provider the deployment declares and can call", async () => {
  for (const [body, why] of [
    [{ scope: "tenant", tenantId: "t", provider: "cloudflare", model: "deepseek-flash" }, "an unprefixed model under cloudflare"],
    [{ scope: "tenant", tenantId: "t", provider: "cloudflare", model: "openai/" }, "a vendor with no model"],
    [{ scope: "tenant", tenantId: "t", provider: "deepseek", model: "deepseek/deepseek-flash" }, "a prefixed model under deepseek"],
    [{ scope: "tenant", tenantId: "t", model: "anthropic/claude-sonnet-5" }, "a prefixed model under the default provider"],
    [{ scope: "tenant", tenantId: "t", provider: "openrouter", model: "openai/gpt-5" }, "an unknown provider"],
    [{ scope: "tenant", tenantId: "t", provider: 3, model: "m" }, "a provider that is not a name"],
  ] as const) {
    const r = await call("PUT", body);
    must(r.status === 422, `${why}: ${r.status} ${r.text}`);
  }
  const s = store();
  const { AI_GATEWAY_TOKEN: _, ...noToken } = ENV;
  const off = await call("PUT", { scope: "tenant", tenantId: "t", provider: "cloudflare", model: "openai/gpt-5" }, s, noToken);
  must(off.status === 422 && off.body.error.code === "unavailable" && /AI_GATEWAY_TOKEN not set/.test(off.body.error.message) && s.rows.size === 0, off.text);
  const listed = await call("GET", undefined, s, noToken);
  must(listed.body.providers.find((p: any) => p.id === "cloudflare").available === false, "an unavailable provider was listed as available");
});

await check("a deployment without MODEL_PROVIDERS offers DeepSeek alone", async () => {
  const env = { DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk", AI_GATEWAY_TOKEN: "gt" };
  const got = await call("GET", undefined, store(), env);
  must(got.body.providers.map((p: any) => p.id).join() === "deepseek" && got.body.default.endpoint === "api.deepseek.com", JSON.stringify(got.body));
  must((await call("PUT", { scope: "tenant", tenantId: "t", provider: "cloudflare", model: "openai/gpt-5" }, store(), env)).status === 422, "a provider the deployment does not declare was accepted");
  must((await call("PUT", { scope: "tenant", tenantId: "t", model: "deepseek-v4-pro" }, store(), env)).status === 200, "the default provider was refused");
});

await check("a scope names exactly what it covers, and a model is a name, not anything else", async () => {
  for (const [body, why] of [
    [{ scope: "deployment", tenantId: "t", model: "m" }, "deployment with a tenant"],
    [{ scope: "tenant", model: "m" }, "tenant without one"],
    [{ scope: "tenant", tenantId: "t", agentId: "a", model: "m" }, "tenant with an agent"],
    [{ scope: "agent", tenantId: "t", model: "m" }, "agent without its id"],
    [{ scope: "everyone", model: "m" }, "an unknown scope"],
    [{ scope: "tenant", tenantId: "t", model: "a b" }, "a model with a space"],
    [{ scope: "tenant", tenantId: "t", model: "" }, "an empty model"],
  ] as const) {
    const r = await call("PUT", body);
    must(r.status === 422, `${why}: ${r.status}`);
  }
  must((await call("PUT", { scope: "tenant", tenantId: "t", model: "m", key: "sk" })).status === 400, "an unknown field was accepted");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
