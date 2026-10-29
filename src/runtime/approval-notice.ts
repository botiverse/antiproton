/**
 * What an agent is told once a call it made was decided: approved and run (with what it gave back), denied, or
 * expired with nobody deciding. Delivered as a message at the agent's next step (cf/src/runtime.ts `#tellApprovals`),
 * the way a background job's ending is (src/runtime/background-jobs.ts `completionMessage`), so the agent never polls.
 */
import type { ApprovalRecord, DecidedBy } from "../core/types.ts";
import type { ToolResult } from "../core/tools.ts";

/** How much of a run's result the notice carries: enough to act on, never a transcript's worth. */
export const NOTICE_RESULT_MAX = 1_500;

/** Who decided, in words an agent can repeat to a person. */
export function deciderWords(by: DecidedBy | null, approver: string | null): string {
  if (by?.via === "raft") {
    return by.role === "agent_owner" ? "your owner in Raft" : by.role === "server_owner" ? "the Raft server's owner" : "a Raft server admin";
  }
  if (by?.via === "console") return `${by.approver} on the antiproton console`;
  return approver ? approver : "a person";
}

function bounded(v: unknown): string {
  let text: string;
  try { text = typeof v === "string" ? v : JSON.stringify(v ?? null); } catch { text = String(v); }
  return text.length > NOTICE_RESULT_MAX ? `${text.slice(0, NOTICE_RESULT_MAX)}… (${text.length - NOTICE_RESULT_MAX} more characters not shown)` : text;
}

const head = (a: Pick<ApprovalRecord, "operationId" | "mountAlias" | "tool">, what: string) =>
  `[approval ${a.operationId} — ${a.mountAlias}.${a.tool} — ${what}; a notice from the harness, not a message from the user]`;

/** Where an approved call's run leaves its hold, and what it gave back, bounded: the hold's `outcome`. */
export function approvalOutcome(result: ToolResult): { state: "executed" | "failed"; summary: string } {
  if (result.status === "succeeded") return { state: "executed", summary: bounded(result.result) };
  if (result.status === "running") return { state: "executed", summary: "started in the background; its result goes to the agent when it ends" };
  const error = "error" in result && result.error ? `${result.error.code}: ${result.error.message}` : `${result.status}, with no error given`;
  return { state: "failed", summary: bounded(`${result.status}: ${error}`) };
}

/** An approved call, after it was run: its status and, bounded, what it gave back. */
export function approvedNotice(a: ApprovalRecord, result: ToolResult): string {
  const who = deciderWords(a.decidedBy, a.approver);
  if (result.status === "succeeded") return `${head(a, `approved by ${who} and run: succeeded`)}\n${bounded(result.result)}`;
  if (result.status === "running") {
    return `${head(a, `approved by ${who} and started in the background`)}\nIts result arrives in a notice of its own when it ends.`;
  }
  const error = "error" in result && result.error ? `${result.error.code}: ${result.error.message}` : "no error was given";
  if (result.status === "rejected") return `${head(a, `approved by ${who}, but not run: rejected`)}\n${bounded(error)}`;
  return `${head(a, `approved by ${who} and run: ${result.status}`)}\n${bounded(error)}`;
}

export function deniedNotice(a: ApprovalRecord): string {
  return `${head(a, `denied by ${deciderWords(a.decidedBy, a.approver)}`)}\nNothing was run. Do not call it again unless the person asks you to.`;
}

export function expiredNotice(a: Pick<ApprovalRecord, "operationId" | "mountAlias" | "tool" | "createdAt" | "expiresAt">): string {
  const ms = a.expiresAt === null ? null : a.expiresAt - a.createdAt;
  const within = ms === null ? "" : ms >= 3_600_000 ? ` within ${Math.round(ms / 3_600_000)} hours` : ` within ${Math.max(1, Math.round(ms / 60_000))} minutes`;
  // The call may be hours old and long out of the agent's mind (holds already waiting when expiry arrived get their
  // deadline then, and expire together), so the notice says when it was made.
  return `${head(a, "expired")}\nYou made this call at ${new Date(a.createdAt).toISOString()}. ` +
    `Nobody decided${within}, so it was denied as expired and nothing was run. ` +
    "If it still matters you may call it again, which asks for a new approval.";
}

/** A decided call whose notice was never written (the object stopped while it ran): what is still true to say. */
export function unknownOutcomeNotice(a: ApprovalRecord): string {
  return `${head(a, `${a.state} by ${deciderWords(a.decidedBy, a.approver)}`)}\n` +
    (a.state === "approved" ? "It was run, but its result was not recorded; check before calling it again." : "Nothing was run.");
}
