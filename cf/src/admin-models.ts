/**
 * `/admin/models`: which model the operator's account serves, for the deployment, a tenant or one agent
 * (0013_model_overrides.sql). For the admin area of the console; the caller has already been found to
 * be an admin (auth.ts isAdmin), and this decides nothing about who.
 *
 *   GET                       → { default: { model, endpoint }, gateway, overrides: [...] }
 *   PUT    { scope, tenantId?, agentId?, model }  → the row as kept
 *   DELETE { scope, tenantId?, agentId? }         → 204, or 404 when there was none
 *
 * A choice takes effect on the agent's next run, when its binding is found stale and bound again. The
 * model is a gateway name (`provider/model`) or a bare DeepSeek one; no key is involved here.
 */
import type { ModelOverrides } from "./control-plane.ts";

export interface AdminModelsDeps {
  overrides: ModelOverrides;
  /** The deployment's default model and endpoint (HARNESS_MODEL, DEEPSEEK_BASE_URL). */
  defaults: { model: string; baseUrl: string };
  now(): number;
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,127}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export async function adminModels(method: string, body: unknown, actor: string, deps: AdminModelsDeps): Promise<Response> {
  if (method === "GET") {
    const endpoint = new URL(deps.defaults.baseUrl).host;
    return Response.json({
      default: { model: deps.defaults.model, endpoint },
      gateway: endpoint === "gateway.ai.cloudflare.com",
      overrides: await deps.overrides.list(),
    }, { headers: { "cache-control": "no-store" } });
  }
  if (method !== "PUT" && method !== "DELETE") return refuse(405, "method", "GET, PUT or DELETE");
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !["scope", "tenantId", "agentId", "model"].includes(k));
  if (unknown) return refuse(400, "unknown_field", `unknown field ${unknown}`);
  const where = scopeOf(b);
  if (typeof where === "string") return refuse(422, "invalid", where);
  if (method === "DELETE") {
    return (await deps.overrides.remove(where.tenantId, where.agentId))
      ? new Response(null, { status: 204 })
      : refuse(404, "not_found", "no choice at that scope");
  }
  if (typeof b.model !== "string" || !MODEL.test(b.model)) {
    return refuse(422, "invalid", "model is a gateway name like anthropic/claude-sonnet-5, or a bare DeepSeek model");
  }
  const row = { ...where, model: b.model, setBy: actor, setAt: deps.now() };
  await deps.overrides.put(row);
  return Response.json(row);
}

function scopeOf(b: Record<string, unknown>): { tenantId: string; agentId: string } | string {
  const t = typeof b.tenantId === "string" ? b.tenantId : "";
  const a = typeof b.agentId === "string" ? b.agentId : "";
  switch (b.scope) {
    case "deployment":
      return t || a ? "a deployment choice names no tenant or agent" : { tenantId: "", agentId: "" };
    case "tenant":
      return ID.test(t) && !a ? { tenantId: t, agentId: "" } : "a tenant choice names a tenantId and no agentId";
    case "agent":
      return ID.test(t) && ID.test(a) ? { tenantId: t, agentId: a } : "an agent choice names its tenantId and agentId";
    default:
      return "scope is deployment, tenant or agent";
  }
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}
