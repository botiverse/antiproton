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

export async function adminTranscript(
  request: Request,
  token: string | undefined,
  open: (tenantId: string, agentId: string) => TranscriptSource,
): Promise<Response> {
  // No token configured refuses too: the older /admin routes open then, for a local dev server.
  if (!isOperator(token, request.headers.get("x-harness-token"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (request.method !== "GET") return Response.json({ error: "GET" }, { status: 405, headers: { allow: "GET" } });
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenantId") ?? "demo";
  // Asked for by name, never defaulted: a missing id used to become the agent "null".
  const agentId = url.searchParams.get("agentId") ?? "";
  const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
  try {
    agentObjectName(tenantId, agentId);
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message ?? e) }, { status: 400 });
  }
  const transcript = await open(tenantId, agentId).adminTranscript(tenantId, agentId, taskId);
  if (transcript === null) {
    return Response.json({ error: `no such agent or conversation: ${tenantId}/${agentId} ${taskId}` }, { status: 404 });
  }
  return Response.json(transcript);
}
