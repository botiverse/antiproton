/**
 * The trace rows the store writes at its own seams, built here so the two
 * store implementations (src/store/durable-object.ts, src/store/sqlite.ts)
 * write the same row from the same facts and neither carries its own copy of
 * the mapping.
 *
 * A row is written where the fact it joins back to is committed, inside the
 * same transaction, from the values that transaction read — never from a
 * later read of the record (a span whose numbers came from somewhere else
 * joins correctly and is still wrong; the recorder asserts the arithmetic).
 */
import type { OperationStatus } from "../core/types.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TraceRow, TraceVerdict } from "./outbox.ts";

/**
 * `completeOperation` is also how the gateway says "running" (a progress
 * update, not an end), so a tool.call span closes only on a terminal status.
 * `unknown` is terminal — the harness lost the outcome — and reads as failed:
 * the call did not deliver, and no later fact will say it did.
 */
export function operationEnded(status: OperationStatus): boolean {
  // A switch, not a boolean chain, so that adding a status is a compile error
  // here as well as in operationVerdict: "is this an end" is the judgement the
  // gateway's deny path (and any new status) has to answer, and a chain would
  // answer it silently with false.
  switch (status) {
    case "succeeded": case "failed": case "cancelled": case "unknown": return true;
    case "pending": case "running": return false;
  }
}

export function operationVerdict(status: OperationStatus): TraceVerdict {
  switch (status) {
    case "succeeded": return "ok";
    case "cancelled": return "cancelled";
    case "failed": case "unknown": return "failed";
    // Not an end; callers ask operationEnded first. Named so the switch stays
    // exhaustive when a status is added.
    case "pending": case "running": return "failed";
  }
}

/** The tool.call row for an operation that just ended. */
export function toolCallRow(op: {
  tenantId: string; agentId: string; taskId: string; operationId: string;
  mountAlias: string; tool: string; status: OperationStatus;
  createdAt: number; endedAt: number; callId?: string | null;
}): TraceRow {
  return {
    at: op.endedAt, tenantId: op.tenantId, agentId: op.agentId,
    kind: "tool.call", spanId: op.operationId,
    status: op.status, verdict: operationVerdict(op.status),
    ms: Math.max(0, op.endedAt - op.createdAt),
    attrs: { tool: op.tool, mount: op.mountAlias, task: op.taskId, ...(op.callId ? { callId: op.callId } : {}) },
  };
}

/** The approval.wait row for a decision that just landed. */
export function approvalRow(a: {
  tenantId: string; agentId: string; taskId: string; operationId: string;
  mountAlias: string; tool: string; decision: "approved" | "denied"; approver: string;
  createdAt: number; decidedAt: number;
}): TraceRow {
  return {
    at: a.decidedAt, tenantId: a.tenantId, agentId: a.agentId,
    kind: "approval.wait", spanId: a.operationId,
    status: a.decision, verdict: a.decision === "approved" ? "ok" : "blocked",
    ms: Math.max(0, a.decidedAt - a.createdAt),
    attrs: { tool: a.tool, mount: a.mountAlias, task: a.taskId, approver: a.approver },
  };
}

/**
 * A model call's span closes when its answer is committed as an entry. The
 * answer carries the job id it came from (src/model/pi-bridge.ts, `jobId`),
 * so the row joins back to `pi_model_jobs` by that id; the placeholder and
 * any poll entries carry "deferred"/"pending" and are not ends.
 */
export function answerEnded(stopReason: AssistantMessage["stopReason"]): boolean {
  return stopReason === "stop" || stopReason === "length" || stopReason === "toolUse"
    || stopReason === "error" || stopReason === "aborted";
}

/**
 * `length` is a reply that was cut off but said something — usable, and the
 * harness tells the model so — so it reads as ok with the raw reason kept in
 * `status`; a reply that was cut off and said nothing arrives as `error`.
 */
export function answerVerdict(stopReason: AssistantMessage["stopReason"]): TraceVerdict {
  switch (stopReason) {
    case "stop": case "length": case "toolUse": return "ok";
    case "error": return "failed";
    case "aborted": return "cancelled";
    // Not ends; callers ask answerEnded first. Named so the switch stays
    // exhaustive when pi adds a reason.
    case "pending": case "deferred": return "failed";
  }
}

/** The model.call row for an answer that just landed as an entry. */
export function modelCallRow(m: {
  tenantId: string; agentId: string; jobId: string; stopReason: AssistantMessage["stopReason"];
  model: string; at: number; createdAt?: number | null; answeredAt?: number | null;
}): TraceRow {
  const ms = typeof m.createdAt === "number" && typeof m.answeredAt === "number"
    ? Math.max(0, m.answeredAt - m.createdAt) : undefined;
  return {
    at: m.at, tenantId: m.tenantId, agentId: m.agentId,
    kind: "model.call", spanId: m.jobId,
    status: m.stopReason, verdict: answerVerdict(m.stopReason),
    ...(ms === undefined ? {} : { ms }),
    attrs: { model: m.model },
  };
}
