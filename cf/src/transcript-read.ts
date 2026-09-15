/**
 * One conversation as a person is shown it, and the operator's read-only way to it.
 *
 * `transcriptEvents` and `approvalsByOp` are the shape the console's trajectory
 * tab draws; the console (uiTranscript) and the operator (/admin/transcript) both
 * build through them, so what an operator reads is what the owner sees.
 *
 * `readTranscript` is read-only by construction rather than by care. It takes the
 * object's SQL handle and issues SELECTs, nothing else: no AgentRuntime, whose
 * `agent()` re-pins mounts and whose harness reconciles the session's tools and
 * model; no store, whose `init` runs its migrations; no pi storage object, whose
 * constructor creates tables (Ada, #336). A table that is not there reads as empty.
 * What it cannot give is whether a turn is running: that is the lane's state, read
 * through the harness, so the operator's read leaves `busy` out rather than guess.
 */
import type { Entry } from "@earendil-works/pi-agent-core/harness/session";
import { entriesToEvents } from "./pi-view.ts";
import { maskRawRefs } from "../../src/store/refs.ts";
import { failedRuns } from "../../src/runtime/pi-agent.ts";
import { piTables, MAIN_SESSION, type SqlHost } from "../../src/store/pi-storage.ts";

type Sql = SqlHost["sql"];

export interface TranscriptEvents {
  total: number;
  shown: number;
  // `any` for the reason given on UiTranscript: the RPC rule cannot place `unknown`.
  events: Array<{ sequence: number; kind: string; payload: any; createdAt: number }>;
  byOp: Record<string, { state: string; approver: string | null; tool: string; request: any }>;
}

/** The fields of an approval the trajectory shows beside the call it held. */
export interface ApprovalMark {
  operationId: string; state: string; approver: string | null; mountAlias: string; tool: string; request: any;
}

/**
 * A conversation's entries, with runs that failed before their first model call
 * (which leave no entry, only pi's outcome record) in sequence, and references
 * masked: a stored tool result written before references changed shape still
 * names the bucket, tenant and agent (tygg, 2026-09-14). `tail` > 0 keeps the last ones.
 */
export function transcriptEvents(
  entries: Entry[], sql: Sql, session: string, owner: { tenantId: string; agentId: string }, tail: number,
): Pick<TranscriptEvents, "total" | "shown" | "events"> {
  const failed = failedRuns(sql, session).map((f) => ({
    sequence: f.seq, kind: "model.failed",
    payload: { error: `${f.code}: ${f.message}`, operationId: f.operationId, at: f.at } as Record<string, unknown>,
  }));
  const all = [...entriesToEvents(entries), ...failed].sort((a, b) => a.sequence - b.sequence);
  const events = (tail > 0 ? all.slice(-tail) : all).map((e) => ({
    sequence: e.sequence, kind: e.kind,
    payload: JSON.parse(maskRawRefs(JSON.stringify(e.payload), owner)) as typeof e.payload,
    createdAt: Number((e.payload as any)?.at ?? 0),
  }));
  return { total: all.length, shown: events.length, events };
}

/** Approvals keyed by operation, so a held call shows where it happened and who signed it. */
export function approvalsByOp(approvals: ApprovalMark[]): TranscriptEvents["byOp"] {
  const byOp: TranscriptEvents["byOp"] = {};
  for (const a of approvals) {
    byOp[a.operationId] = { state: a.state, approver: a.approver ?? null, tool: `${a.mountAlias}.${a.tool}`, request: a.request };
  }
  return byOp;
}

function hasTable(sql: Sql, name: string): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name).toArray().length > 0;
}

/**
 * The conversation `taskId` of this object's agent, or null when the object holds
 * no such agent or the agent no such conversation. `t_<agentId>` is the agent's
 * main session, as the console's own lookup has it; any other id must be a task
 * of this agent.
 */
export function readTranscript(sql: Sql, tenantId: string, agentId: string, taskId: string): TranscriptEvents | null {
  if (!hasTable(sql, "owner")) return null;
  const owner = sql.exec("SELECT tenant_id, agent_id FROM owner WHERE k='self'").toArray()[0] as any;
  if (!owner || owner.tenant_id !== tenantId || owner.agent_id !== agentId) return null;
  let session = MAIN_SESSION;
  if (taskId !== `t_${agentId}`) {
    const task = hasTable(sql, "tasks")
      ? sql.exec("SELECT agent_id FROM tasks WHERE tenant_id=? AND task_id=?", tenantId, taskId).toArray()[0] as any
      : undefined;
    if (!task || task.agent_id !== agentId) return null;
    session = taskId;
  }
  const t = piTables(session);
  const entries = hasTable(sql, t.entries)
    ? (sql.exec(`SELECT body FROM ${t.entries} ORDER BY seq ASC`).toArray() as any[]).map((r) => JSON.parse(String(r.body)) as Entry)
    : [];
  const approvals: ApprovalMark[] = hasTable(sql, "approvals")
    ? (sql.exec(
      "SELECT operation_id, state, approver, mount_alias, tool, request FROM approvals WHERE tenant_id=? ORDER BY created_at ASC",
      tenantId).toArray() as any[]).map((r) => ({
      operationId: String(r.operation_id), state: String(r.state), approver: r.approver ?? null,
      mountAlias: String(r.mount_alias), tool: String(r.tool), request: JSON.parse(String(r.request)),
    }))
    : [];
  return { ...transcriptEvents(entries, sql, session, { tenantId, agentId }, 0), byOp: approvalsByOp(approvals) };
}
