/**
 * `GET /admin/diagnose` (operator token only): what an agent's object holds about its state, for an operator
 * looking into why an agent stopped or misbehaved. The refusals decidable from the request come first
 * (admin-read.ts), before any object is opened; the object's half (diagnose-read.ts) reads only and answers
 * null for an agent or conversation it does not hold.
 */
import { answer, operatorTarget } from "./admin-read.ts";

export interface DiagnosisSource {
  /** Null when the object holds no such agent, or that agent no such conversation. Writes nothing. */
  diagnose(tenantId: string, agentId: string, taskId: string): Promise<unknown | null>;
}

export async function adminDiagnose(
  request: Request,
  token: string | undefined,
  open: (tenantId: string, agentId: string) => DiagnosisSource,
): Promise<Response> {
  const target = operatorTarget(request, token);
  if (target instanceof Response) return target;
  const { tenantId, agentId, taskId } = target;
  const report = await open(tenantId, agentId).diagnose(tenantId, agentId, taskId);
  if (report === null) {
    return answer({ error: `no such agent or conversation: ${tenantId}/${agentId} ${taskId}` }, 404);
  }
  return answer(report, 200);
}
