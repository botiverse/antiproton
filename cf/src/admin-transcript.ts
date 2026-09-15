/**
 * `GET /admin/transcript` (operator token only): one agent's whole conversation, payloads included. It is
 * what the console's trajectory tab shows the agent's owner, for an operator asked to look at it (task #19).
 *
 * The refusals decidable from the request come first (admin-read.ts), before any object is opened. The
 * object's half reads only and answers null for an agent or conversation it does not hold, so a mistyped id
 * is a 404 and not a new default conversation.
 */
import { answer, operatorTarget } from "./admin-read.ts";

export interface TranscriptSource {
  /** Null when the object holds no such agent, or that agent no such conversation. Never creates either. */
  adminTranscript(tenantId: string, agentId: string, taskId: string): Promise<unknown | null>;
}

export async function adminTranscript(
  request: Request,
  token: string | undefined,
  open: (tenantId: string, agentId: string) => TranscriptSource,
): Promise<Response> {
  const target = operatorTarget(request, token);
  if (target instanceof Response) return target;
  const { tenantId, agentId, taskId } = target;
  const transcript = await open(tenantId, agentId).adminTranscript(tenantId, agentId, taskId);
  if (transcript === null) {
    return answer({ error: `no such agent or conversation: ${tenantId}/${agentId} ${taskId}` }, 404);
  }
  return answer(transcript, 200);
}
