/**
 * Who administers the deployment (auth.ts isAdmin) and `/admin/models` (cf/src/admin-models.ts): which
 * model the operator's account serves per scope, validated by scope, kept with who set it.
 */
import { adminModels } from "../cf/src/admin-models.ts";
import { isAdmin, type Viewer } from "../cf/src/auth.ts";
import type { ModelOverride } from "../cf/src/control-plane.ts";

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
const call = async (method: string, body: unknown, s = store(), baseUrl = "https://api.deepseek.com") => {
  const r = await adminModels(method, body, "github:1", { overrides: s.overrides, defaults: { model: "deepseek-flash", baseUrl }, now: () => 7 });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};

await check("a choice per scope is kept with who set it, listed, and removed; the deployment default and gateway are said", async () => {
  const s = store();
  must((await call("PUT", { scope: "tenant", tenantId: "t1", model: "anthropic/claude-sonnet-5" }, s)).status === 200, "tenant");
  const agent = await call("PUT", { scope: "agent", tenantId: "t1", agentId: "a1", model: "openai/gpt-5" }, s);
  must(agent.status === 200 && agent.body.setBy === "github:1" && agent.body.setAt === 7, JSON.stringify(agent));
  must((await call("PUT", { scope: "deployment", model: "deepseek/deepseek-flash" }, s)).status === 200, "deployment");
  const got = await call("GET", undefined, s, "https://gateway.ai.cloudflare.com/v1/acct/antiproton/compat");
  must(got.body.overrides.length === 3 && got.body.gateway === true && got.body.default.model === "deepseek-flash", JSON.stringify(got.body));
  must((await call("DELETE", { scope: "tenant", tenantId: "t1" }, s)).status === 204 && s.rows.size === 2, "delete");
  must((await call("DELETE", { scope: "tenant", tenantId: "t1" }, s)).status === 404, "a second delete found something");
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
