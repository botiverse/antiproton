/**
 * The parts of the `approvals` table both stores share (src/store/sqlite.ts, src/store/durable-object.ts): the columns
 * added after the table first shipped, what a row reads as, and the one rule for whether a decision may land.
 */
import type { ApprovalRecord, ApprovalState, DecidedBy } from "../core/types.ts";

/** How long a hold waits for a decision before it is denied as `expired`, unless the deployment says otherwise. */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Columns added to an existing `approvals` table, each with what has to be written once when it is added. The
 * follow-ups run only when their ALTER succeeded, which happens exactly once per table: a table made with the column
 * (CREATE TABLE below) or already altered refuses the ALTER and skips them.
 *
 * - `expires_at`: a hold from before expiry existed gets its creation plus the default TTL, so it ends like a new one.
 * - `told_at`: a decision made before the agent was told of decisions is marked told, so an upgrade does not announce
 *   old outcomes to an agent that has moved on.
 * - `published_state`: likewise for the provider; a hold still pending is published like a new one.
 * - `run_at`: an `approved` row from when approving ran the call at once has run; it is ended as its operation ended.
 */
export const APPROVAL_ALTERS: ReadonlyArray<{ alter: string; then: string[] }> = [
  { alter: "ALTER TABLE approvals ADD COLUMN expires_at INTEGER",
    then: [`UPDATE approvals SET expires_at = created_at + ${DEFAULT_APPROVAL_TTL_MS} WHERE state = 'pending' AND expires_at IS NULL`] },
  { alter: "ALTER TABLE approvals ADD COLUMN decided_by TEXT", then: [] },
  { alter: "ALTER TABLE approvals ADD COLUMN notice TEXT", then: [] },
  { alter: "ALTER TABLE approvals ADD COLUMN told_at INTEGER",
    then: ["UPDATE approvals SET told_at = COALESCE(decided_at, created_at) WHERE state != 'pending' AND told_at IS NULL"] },
  // The state last published to the provider that made the agent (cf/src/approvals.ts `publishApprovals`). A decision
  // from before publishing existed is not announced; a hold still pending is, so it gets its card.
  { alter: "ALTER TABLE approvals ADD COLUMN published_state TEXT",
    then: ["UPDATE approvals SET published_state = state WHERE state != 'pending'"] },
  // An approval used to run its call before the decision returned, so an `approved` row from then has already run:
  // it is given the end its operation reached, marked as run, and published and told as it was. Left `approved`, the
  // run pass (`ToolGateway.runApproved`) would run it a second time.
  { alter: "ALTER TABLE approvals ADD COLUMN run_at INTEGER",
    then: [`UPDATE approvals SET
        state = CASE WHEN (SELECT o.status FROM operations o WHERE o.tenant_id = approvals.tenant_id AND o.operation_id = approvals.operation_id) = 'succeeded'
          THEN 'executed' ELSE 'failed' END,
        run_at = COALESCE(decided_at, created_at)
      WHERE state = 'approved'`,
      "UPDATE approvals SET published_state = state WHERE published_state IS NOT NULL"] },
  { alter: "ALTER TABLE approvals ADD COLUMN outcome TEXT", then: [] },
];

/**
 * Run APPROVAL_ALTERS through a store's own exec, each ALTER and its follow-ups in one transaction: an ALTER that
 * throws is a column already there, and a follow-up that throws takes its ALTER back with it, so the next open adds
 * the column and runs the follow-up again rather than leaving a column whose rows were never brought to it.
 */
export function migrateApprovals(exec: (q: string) => void, tx: (fn: () => void) => void) {
  for (const { alter, then } of APPROVAL_ALTERS) {
    try { tx(() => { exec(alter); for (const q of then) exec(q); }); } catch { /* already present, or taken back */ }
  }
}

/** The columns of a table made today: the same set APPROVAL_ALTERS brings an older one to. */
export const APPROVAL_COLUMNS = `tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL, mount_alias TEXT NOT NULL, tool TEXT NOT NULL,
  request TEXT NOT NULL, state TEXT NOT NULL, approver TEXT, decided_at INTEGER,
  created_at INTEGER NOT NULL, expires_at INTEGER, decided_by TEXT, notice TEXT, told_at INTEGER, published_state TEXT, run_at INTEGER, outcome TEXT,
  PRIMARY KEY (tenant_id, operation_id)`;

export function mapApproval(r: any): ApprovalRecord {
  return {
    tenantId: r.tenant_id, operationId: r.operation_id, agentId: r.agent_id,
    taskId: r.task_id, mountAlias: r.mount_alias, tool: r.tool,
    request: JSON.parse(r.request), state: r.state, approver: r.approver ?? null,
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    decidedBy: r.decided_by == null ? null : JSON.parse(r.decided_by) as DecidedBy,
    outcome: r.outcome == null ? null : JSON.parse(r.outcome) as { summary: string },
    runAt: r.run_at == null ? null : Number(r.run_at),
  };
}

/**
 * Why a decision may not land on this row now, or null when it may. Decided once: a row that is not pending keeps its
 * first decision. A person's decision on a hold past its deadline is refused as `expired` even before the sweep has
 * written it, so a late click never runs a call the agent was about to be told had expired. An expiry before the
 * deadline is refused as `not_due`.
 */
export function decisionProblem(r: { state: string; expires_at?: number | null }, decision: "approved" | "denied" | "expired", now: number):
  null | "already_decided" | "expired" | "not_due" {
  if (r.state !== "pending") return "already_decided";
  const due = r.expires_at != null && Number(r.expires_at) <= now;
  if (decision === "expired") return due ? null : "not_due";
  return due ? "expired" : null;
}

/** What a decision outcome reads as to its caller (StorageAdapter.decideApproval). */
export type DecideOutcome =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_decided" | "expired" | "not_due"; record: ApprovalRecord };

/** A row the agent has not been told of yet, with the notice its end wrote (null only for a row from before notices). */
export type UntoldApproval = ApprovalRecord & { notice: string | null };

/** The states a decision ends in once nothing more will happen to it: what the agent is told of. */
export const FINAL_STATES = ["denied", "expired", "executed", "failed"] as const;
