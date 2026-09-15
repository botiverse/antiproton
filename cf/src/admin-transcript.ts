/**
 * `GET /admin/transcript` (operator token only): one agent's whole conversation, payloads included. It is
 * what the console's trajectory tab shows the agent's owner, for an operator asked to look at it (task #19);
 * /admin/diagnose keeps six events at 220 characters.
 *
 * Everything that can refuse is decided here, before any object is opened: opening one runs its constructor,
 * which writes its schema. The object's half reads only and answers null for an agent or conversation it
 * does not hold, so a mistyped id is a 404 and not a new default conversation.
 */
import { isOperator } from "./auth.ts";
import { agentObjectName } from "./object-name.ts";

export interface TranscriptSource {
  /** Null when the object holds no such agent, or that agent no such conversation. Never creates either. */
  adminTranscript(tenantId: string, agentId: string, taskId: string): Promise<unknown | null>;
}

/**
 * Every answer from this route, refusals included, is never stored by a cache. The route returns a person's
 * whole conversation, and its authority is a custom header that HTTP caches neither treat as authorization
 * nor key on; not being cached must not rest on a deployment's defaults (Ada, #336). No `Vary` on the token:
 * that would make the secret a cache key.
 */
function answer(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export async function adminTranscript(
  request: Request,
  token: string | undefined,
  open: (tenantId: string, agentId: string) => TranscriptSource,
): Promise<Response> {
  // No token configured refuses too: the older /admin routes open then, for a local dev server.
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
  const transcript = await open(tenantId, agentId).adminTranscript(tenantId, agentId, taskId);
  if (transcript === null) {
    return answer({ error: `no such agent or conversation: ${tenantId}/${agentId} ${taskId}` }, 404);
  }
  return answer(transcript, 200);
}
