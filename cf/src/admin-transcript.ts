/**
 * `GET /admin/transcript` (operator token only): one agent's whole conversation, payloads included. It is
 * what the console's trajectory tab shows the agent's owner, for an operator asked to look at it (task #19).
 *
 * The refusals decidable from the request come first (admin-read.ts), before any object is opened. The
 * object's half reads only and answers null for an agent or conversation it does not hold, so a mistyped id
 * is a 404 and not a new default conversation.
 */
import { answer, operatorTarget } from "./admin-read.ts";
import { auditRead, readReason, type ReadAudit } from "./read-audit.ts";

export interface TranscriptSource {
  /** Null when the object holds no such agent, or that agent no such conversation. Never creates either. */
  adminTranscript(tenantId: string, agentId: string, taskId: string): Promise<unknown | null>;
  /** Whether the agent is someone's personal assistant, whose reads need a reason (cf/src/read-audit.ts). */
  isAssistantAgent(tenantId: string, agentId: string): Promise<boolean>;
}

/**
 * Every read is audited before it is made (cf/src/read-audit.ts): a personal assistant's needs a `reason` and a row
 * written, or it is refused.
 */
export async function adminTranscript(
  request: Request,
  token: string | undefined,
  open: (tenantId: string, agentId: string) => TranscriptSource,
  audit: ReadAudit | null = null,
): Promise<Response> {
  const target = operatorTarget(request, token);
  if (target instanceof Response) return target;
  const { tenantId, agentId, taskId } = target;
  const source = open(tenantId, agentId);
  const refused = await auditRead(audit, {
    route: "/admin/transcript", tenantId, agentId, session: taskId, tokenKind: "operator", tokenLabel: null,
    reason: readReason(request), assistant: (await source.isAssistantAgent(tenantId, agentId)) === true,
  });
  if (refused) return answer(await refused.json(), refused.status);
  const transcript = await source.adminTranscript(tenantId, agentId, taskId);
  if (transcript === null) {
    return answer({ error: `no such agent or conversation: ${tenantId}/${agentId} ${taskId}` }, 404);
  }
  return answer(transcript, 200);
}
