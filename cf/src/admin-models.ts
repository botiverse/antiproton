/**
 * `/admin/models`: which provider and model the operator's account serves, for the deployment, a tenant or one
 * agent (0013_model_overrides.sql, 0014_model_override_provider.sql). For the admin area of the console; the
 * caller has already been found to be an admin (auth.ts isAdmin), and this decides nothing about who.
 *
 *   GET                                          → { default: { provider, model, endpoint }, providers: [...], overrides: [...] }
 *   PUT    { scope, tenantId?, agentId?, provider?, model }  → the row as kept
 *   DELETE { scope, tenantId?, agentId? }                    → 204, or 404 when there was none
 *
 * A choice takes effect on the agent's next run, when its binding is found stale and bound again. The provider
 * is one the deployment declares (src/model/providers.ts), DEFAULT_PROVIDER when not named; the model is that
 * provider's name for it. No key is involved here, and none is listed: a provider says only whether its
 * secrets are set.
 */
import type { ModelOverrides } from "./control-plane.ts";
import { DEFAULT_PROVIDER, modelProblem, providerStatus, type ModelProviders } from "../../src/model/providers.ts";

export interface AdminModelsDeps {
  overrides: ModelOverrides;
  /** The deployment's providers (MODEL_PROVIDERS, else DeepSeek alone). */
  providers: ModelProviders;
  /** The deployment's default model (HARNESS_MODEL), under DEFAULT_PROVIDER. */
  defaults: { model: string };
  now(): number;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export async function adminModels(method: string, body: unknown, actor: string, deps: AdminModelsDeps): Promise<Response> {
  if (method === "GET") {
    const providers = providerStatus(deps.providers);
    return Response.json({
      default: { provider: DEFAULT_PROVIDER, model: deps.defaults.model, endpoint: providers.find((p) => p.id === DEFAULT_PROVIDER)?.endpoint ?? "" },
      providers,
      ...(deps.providers.error ? { providersError: deps.providers.error } : {}),
      // A row from before providers existed is shown as what serves it.
      overrides: (await deps.overrides.list()).map((o) => ({ ...o, provider: o.provider ?? DEFAULT_PROVIDER })),
    }, { headers: { "cache-control": "no-store" } });
  }
  if (method !== "PUT" && method !== "DELETE") return refuse(405, "method", "GET, PUT or DELETE");
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !["scope", "tenantId", "agentId", "provider", "model"].includes(k));
  if (unknown) return refuse(400, "unknown_field", `unknown field ${unknown}`);
  const where = scopeOf(b);
  if (typeof where === "string") return refuse(422, "invalid", where);
  if (method === "DELETE") {
    return (await deps.overrides.remove(where.tenantId, where.agentId))
      ? new Response(null, { status: 204 })
      : refuse(404, "not_found", "no choice at that scope");
  }
  if (b.provider !== undefined && typeof b.provider !== "string") return refuse(422, "invalid", "provider is a provider's id");
  const provider = (b.provider as string | undefined) || DEFAULT_PROVIDER;
  if (typeof b.model !== "string") return refuse(422, "invalid", "model is the provider's name for it");
  const problem = modelProblem(deps.providers, { provider, model: b.model });
  if (problem) return refuse(422, "invalid", problem);
  // A provider without its secrets is declared but not offered: a choice of it would only fail at the call.
  const status = providerStatus(deps.providers).find((p) => p.id === provider)!;
  if (!status.available) return refuse(422, "unavailable", `provider ${provider} is not available: ${status.missing.join(", ")} not set`);
  const row = { ...where, provider, model: b.model, setBy: actor, setAt: deps.now() };
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
