/**
 * `GET /admin/memory-shadow` (operator token only): one agent's memory subagent shadow runs (src/store/memory-shadow.ts),
 * due in [from, to), newest first: the memory document around each of the agent's direct writes, the request, the
 * subagent's proposed edits and what they would have come to. The only read of that table, for comparing the subagent
 * with the agent before it becomes the only writer.
 *
 * The same gate as `/admin/assistant-decisions` (cf/src/admin-assistant-decisions.ts), deliberately: the refusals
 * decidable from the request come first (admin-read.ts), before any object is opened, and every read is audited before
 * it is made (cf/src/read-audit.ts), always as a personal assistant's: a reason is required and a read whose row cannot
 * be written is refused, since every row holds the owner's memory. The object's half reads only (`readMemoryShadow`)
 * and answers null for an agent it does not hold.
 */
import { answer, operatorTarget } from "./admin-read.ts";
import { auditRead, readReason, type ReadAudit } from "./read-audit.ts";

export const MEMORY_SHADOW_ROUTE = "/admin/memory-shadow";
/** The range when `from` is not given: the retention, 7 days. */
const DEFAULT_SPAN_MS = 7 * 24 * 3_600_000;

export interface MemoryShadowSource {
  /** Null when the object holds no such agent. Writes nothing. */
  adminMemoryShadow(tenantId: string, agentId: string, from: number, to: number): Promise<unknown[] | null>;
}

/** A time given as epoch milliseconds or an ISO date; null when absent, NaN when it is neither. */
function timeOf(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  return Date.parse(raw);
}

export async function adminMemoryShadow(
  request: Request,
  token: string | undefined,
  open: (tenantId: string, agentId: string) => MemoryShadowSource,
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
    route: MEMORY_SHADOW_ROUTE, tenantId, agentId, session: null, tokenKind: "operator", tokenLabel: null,
    reason: readReason(request), assistant: true,
  });
  if (refused) return answer(await refused.json(), refused.status);
  const records = await open(tenantId, agentId).adminMemoryShadow(tenantId, agentId, from, to);
  if (records === null) return answer({ error: `no such agent: ${tenantId}/${agentId}` }, 404);
  return answer({ tenantId, agentId, from, to, records }, 200);
}
