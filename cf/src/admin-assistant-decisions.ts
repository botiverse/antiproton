/**
 * `GET /admin/assistant-decisions` (operator token only): one personal assistant's private record of what its checks
 * decided (src/store/assistant-decisions.ts), noted in [from, to), newest first. For measuring empty, repeated and
 * missed messages, and for answering an owner's "why didn't you tell me X".
 *
 * The refusals decidable from the request come first (admin-read.ts), before any object is opened. Every read is
 * audited before it is made (cf/src/read-audit.ts), and always as a personal assistant's: a reason is required and a
 * read whose row cannot be written is refused, since every row here holds what the assistant read of its owner's Raft,
 * whether or not the agent is still someone's assistant. The object's half reads only (`readAssistantDecisions`) and
 * answers null for an agent it does not hold.
 */
import { answer, operatorTarget } from "./admin-read.ts";
import { auditRead, readReason, type ReadAudit } from "./read-audit.ts";

export const ASSISTANT_DECISIONS_ROUTE = "/admin/assistant-decisions";
/** The range when `from` is not given: the retention, 30 days. */
const DEFAULT_SPAN_MS = 30 * 24 * 3_600_000;

export interface AssistantDecisionsSource {
  /** Null when the object holds no such agent. Writes nothing. */
  adminAssistantDecisions(tenantId: string, agentId: string, from: number, to: number): Promise<unknown[] | null>;
}

/** A time given as epoch milliseconds or an ISO date; null when absent, NaN when it is neither. */
function timeOf(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  return Date.parse(raw);
}

export async function adminAssistantDecisions(
  request: Request,
  token: string | undefined,
  open: (tenantId: string, agentId: string) => AssistantDecisionsSource,
  audit: ReadAudit | null = null,
  now = Date.now(),
): Promise<Response> {
  const target = operatorTarget(request, token);
  if (target instanceof Response) return target;
  const { tenantId, agentId } = target;
  const url = new URL(request.url);
  const to = timeOf(url.searchParams.get("to")) ?? now;
  const from = timeOf(url.searchParams.get("from")) ?? to - DEFAULT_SPAN_MS;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return answer({ error: "from and to are epoch milliseconds or ISO times, from not after to" }, 400);
  }
  const refused = await auditRead(audit, {
    route: ASSISTANT_DECISIONS_ROUTE, tenantId, agentId, session: null, tokenKind: "operator", tokenLabel: null,
    reason: readReason(request), assistant: true,
  });
  if (refused) return answer(await refused.json(), refused.status);
  const records = await open(tenantId, agentId).adminAssistantDecisions(tenantId, agentId, from, to);
  if (records === null) return answer({ error: `no such agent: ${tenantId}/${agentId}` }, 404);
  return answer({ tenantId, agentId, from, to, records }, 200);
}
