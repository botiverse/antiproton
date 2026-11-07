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

/** A code is a machine token (`policy_denied`, `NOT_FOUND`); anything else is not written as one. */
const OUTCOME_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Where an approved call's run leaves its hold, and its `outcome`: metadata only, never what the tool gave back or
 * said. The summary is shown on Raft's card to whoever decided (the agent's owner, or a server owner or admin), who need
 * not be able to see what the call read or where it wrote — a message held for unread messages quotes them, a read
 * returns a channel's content, an error can carry a response body — so it is the status, the error's code, and for a
 * call that asked before acting, the reason it asked (`asked`), and nothing else, for every tool alike (Raft contract,
 * slock #13438). The full result goes to the agent only, in its notice (`approvedNotice`).
 */
export function approvalOutcome(result: ToolResult, asked?: string): { state: "executed" | "failed"; summary: string } {
  if (result.status === "succeeded") return { state: "executed", summary: "succeeded; the result went to the agent" };
  if (result.status === "running") return { state: "executed", summary: "started in the background; its result goes to the agent when it ends" };
  const raw = "error" in result && result.error ? result.error.code : "";
  const code = OUTCOME_CODE.test(raw) ? raw : raw ? "error" : "no error given";
  if (code === "asked_before_acting") {
    const why = asked && OUTCOME_CODE.test(asked) ? ` (${asked})` : "";
    return { state: "failed", summary: `${result.status}: asked_before_acting${why}; nothing was done` };
  }
  return { state: "failed", summary: `${result.status}: ${code}` };
}

/** An approved call, after it was run: its status and, bounded, what it gave back. */
export function approvedNotice(a: ApprovalRecord, result: ToolResult): string {
  const who = deciderWords(a.decidedBy, a.approver);
  if (result.status === "succeeded") return `${head(a, `approved by ${who} and run: succeeded`)}\n${bounded(result.result)}`;
  if (result.status === "running") {
    return `${head(a, `approved by ${who} and started in the background`)}\nIts result arrives in a notice of its own when it ends.`;
  }
  const error = "error" in result && result.error ? `${result.error.code}: ${result.error.message}` : "no error was given";
  if (result.status === "rejected" || result.status === "cancelled") return `${head(a, `approved by ${who}, but not run: ${result.status}`)}\n${bounded(error)}`;
  return `${head(a, `approved by ${who} and run: ${result.status}`)}\n${bounded(error)}`;
}

export function deniedNotice(a: ApprovalRecord): string {
  return `${head(a, `denied by ${deciderWords(a.decidedBy, a.approver)}`)}\nNothing was run. Do not call it again unless the person asks you to.`;
}

/**
 * Worded from what Raft reported of the card when the hold expired (`ApprovalRecord.delivery`), since an expiry is
 * nobody's refusal and the agent should know which silence it was: it reached an approver who did not decide; it reached nobody, because Raft had nobody to send it to; or it
 * is not known which. The second is said only on a recorded `no_recipient`, never inferred from silence. Written once,
 * at expiry: a report that lands later updates the record, not this notice.
 */
export function expiredNotice(a: Pick<ApprovalRecord, "operationId" | "mountAlias" | "tool" | "createdAt" | "expiresAt" | "delivery">): string {
  const ms = a.expiresAt === null ? null : a.expiresAt - a.createdAt;
  const span = ms === null ? null : ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} hours` : `${Math.max(1, Math.round(ms / 60_000))} minutes`;
  const within = span === null ? "" : ` within ${span}`;
  const again = "If it still matters you may call it again, which asks for a new approval.";
  const what = a.delivery?.outcome === "delivered"
    ? `It reached an approver, but nobody decided${within}, so it expired and nothing was run. ${again}`
    : a.delivery?.outcome === "no_recipient"
      ? `It never reached any approver, because Raft had nobody to send it to, so it expired${span === null ? "" : ` after ${span}`} and nothing was run. ` +
        `${again} That one reaches nobody either unless Raft has someone to send it to by then.`
      : `Nobody decided${within}, so it expired and nothing was run; whether it reached an approver is not known. ${again}`;
  // The call may be hours old and long out of the agent's mind (holds already waiting when expiry arrived get their
  // deadline then, and expire together), so the notice says when it was made.
  return `${head(a, "expired")}\nYou made this call at ${new Date(a.createdAt).toISOString()}. ${what}`;
}

/** A decided call whose notice was never written (the object stopped while it ran): what is still true to say. */
export function unknownOutcomeNotice(a: ApprovalRecord): string {
  return `${head(a, `${a.state} by ${deciderWords(a.decidedBy, a.approver)}`)}\n` +
    (a.state === "approved" ? "It was run, but its result was not recorded; check before calling it again." : "Nothing was run.");
}
