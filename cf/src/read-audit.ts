/**
 * Who read an agent's conversation, and why: one row per read in D1 (`admin_read_audit`, migration 0026), never in the
 * Workers log, which drops lines. The audited routes are the ones that return what an agent was told or said:
 * `/admin/transcript`, the `/agent/*` reads, the console's `/ui/transcript`, and the provisioning eval `transcript` and
 * `model-input`. A row is metadata only — the route, the agent, the conversation, what kind of credential read it and
 * its label, the reason the caller gave — never the content.
 *
 * A personal assistant's conversation holds what it read of its owner's Raft (src/plugins/raft-assistant.ts), which is
 * the owner's and nobody else's, so its reads are stricter: a reason is required (400 without one), and a read whose row
 * cannot be written is refused (closed). Any other agent's read records a reason when one is given, and goes ahead when
 * the row cannot be written, with an error logged: those reads are the operator's and the console owner's own
 * debugging of their own agent, and a D1 outage must not take that away; the audit is what is lost, and the log says so.
 */

export interface ReadAuditRow {
  route: string;
  tenantId: string;
  agentId: string;
  session: string | null;
  /** `automation`, `operator`, `viewer`, `console` or `provider`: which door the credential came through. */
  tokenKind: string;
  /** Who, as far as the credential says (an email, a provider credential's id); never a secret. */
  tokenLabel: string | null;
  reason: string | null;
  assistant: boolean;
  outcome: "read" | "refused";
}

export interface ReadAudit {
  record(row: ReadAuditRow, at: number): Promise<void>;
}

type D1Like = { prepare(q: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };

export function d1ReadAudit(db: D1Like): ReadAudit {
  return {
    async record(r, at) {
      await db.prepare(
        "INSERT INTO admin_read_audit (at, route, tenant_id, agent_id, session, token_kind, token_label, reason, assistant, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(at, r.route, r.tenantId, r.agentId, r.session, r.tokenKind, r.tokenLabel, r.reason, r.assistant ? 1 : 0, r.outcome).run();
    },
  };
}

export const READ_REASON_HEADER = "x-read-reason";
export const READ_REASON_MAX = 500;

/** The reason a caller gave: `reason=` in the query, else the `X-Read-Reason` header; trimmed, cut, null when empty. */
export function readReason(request: Request): string | null {
  const raw = new URL(request.url).searchParams.get("reason") ?? request.headers.get(READ_REASON_HEADER) ?? "";
  const said = raw.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  return said ? said.slice(0, READ_REASON_MAX) : null;
}

/**
 * The gate in front of an audited read: null to go ahead, or the response that refuses it. An assistant's read needs a
 * reason and a written row; another agent's read is recorded when it can be (the module comment says why).
 */
export async function auditRead(
  audit: ReadAudit | null, row: Omit<ReadAuditRow, "outcome">, now = Date.now(),
): Promise<Response | null> {
  if (row.assistant && !row.reason) {
    return Response.json({
      error: "this agent is a personal assistant: say why you are reading its conversation, with reason= or the X-Read-Reason header",
      code: "read_reason_required",
    }, { status: 400 });
  }
  try {
    if (!audit) throw new Error("no audit store is configured");
    await audit.record({ ...row, outcome: "read" }, now);
  } catch (e) {
    console.error(`the read of ${row.route} for ${row.tenantId}/${row.agentId} could not be audited:`, e);
    if (row.assistant) {
      return Response.json({ error: "this read could not be audited, so it is refused: the agent is a personal assistant", code: "read_audit_failed" }, { status: 503 });
    }
  }
  return null;
}

/** A refused attempt, recorded as such when it can be; a failure to record it changes nothing, the read was refused. */
export async function auditRefused(audit: ReadAudit | null, row: Omit<ReadAuditRow, "outcome">, now = Date.now()): Promise<void> {
  try { await audit?.record({ ...row, outcome: "refused" }, now); }
  catch (e) { console.error(`the refused read of ${row.route} for ${row.tenantId}/${row.agentId} could not be audited:`, e); }
}
