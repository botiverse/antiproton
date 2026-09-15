/**
 * What the operator's read routes share: who may ask, what may be asked for,
 * and how every answer is sent. `/admin/transcript` and `/admin/diagnose` both
 * name any agent, and both return what that agent holds, so neither may answer
 * differently from the other on any of this.
 */
import { isOperator } from "./auth.ts";
import { agentObjectName } from "./object-name.ts";

/**
 * Every answer from an operator read, refusals included, is never stored by a cache. These routes return a
 * person's data, and their authority is a custom header that HTTP caches neither treat as authorization nor
 * key on; not being cached must not rest on a deployment's defaults (Ada, #336). No `Vary` on the token:
 * that would make the secret a cache key.
 */
export function answer(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export interface OperatorTarget { tenantId: string; agentId: string; taskId: string }

/**
 * The refusals that can be decided from the request alone, before any object
 * is opened (opening one runs its constructor, which writes its schema): 401
 * without the operator's token, 405 for anything but GET, 400 for an agent
 * that is not named or cannot name an object. Whether that agent, or that
 * conversation, exists can only be answered by the object, so a 404 is the
 * object half's (Ada, #336).
 */
export function operatorTarget(request: Request, token: string | undefined): OperatorTarget | Response {
  // No token configured refuses too: the older /admin routes opened then, for a local dev server.
  if (!isOperator(token, request.headers.get("x-harness-token"))) {
    return answer({ error: "unauthorized" }, 401);
  }
  if (request.method !== "GET") return answer({ error: "GET" }, 405, { allow: "GET" });
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenantId") ?? "demo";
  // Asked for by name, never defaulted: a missing id used to become the agent "null".
  const agentId = url.searchParams.get("agentId") ?? "";
  const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
  try {
    agentObjectName(tenantId, agentId);
  } catch (e) {
    return answer({ error: String((e as Error)?.message ?? e) }, 400);
  }
  return { tenantId, agentId, taskId };
}
