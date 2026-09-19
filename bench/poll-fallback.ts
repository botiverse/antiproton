/**
 * A missed push must not become a stall (Vera, 2026-09-15).
 *
 * The runners wait for a turn's answer on the object's event socket. In one trial of an 8x3 τ² run the
 * agent answered 19 seconds into the turn and the runner never received that push: it waited out its
 * 300-second timeout and scored the task `agent_stalled`. The object had finished; only the delivery was
 * lost. So while waiting, a runner also asks `/bench/poll` now and then, and takes the answer from there
 * when the push did not bring it.
 *
 * The one thing poll must never do is end a turn with the previous turn's answer: between a new message and
 * the object starting on it, poll still reports idle with the last answer. An answer counts only if the model
 * replied after the latest message, and after anything the socket already delivered.
 */

export type PollDecision =
  | { kind: "answer"; text: string; seq: number }
  | { kind: "failed"; seq: number }
  | null;

export function decideFromPoll(
  poll: { status?: string; answer?: string | null; events?: Array<{ sequence: number; kind: string }> },
  seenSeq: number,
): PollDecision {
  if (poll?.status !== "idle") return null;
  const events = poll.events ?? [];
  const last = (kind: string) => events.reduce((m, e) => (e.kind === kind && e.sequence > m ? e.sequence : m), -1);
  const lastMessage = last("message");
  const lastFailed = last("model.failed");
  if (lastFailed > lastMessage && lastFailed > seenSeq) return { kind: "failed", seq: lastFailed };
  const lastResponse = last("model.response");
  if (!poll.answer || lastResponse <= lastMessage || lastResponse <= seenSeq) return null;
  return { kind: "answer", text: String(poll.answer), seq: lastResponse };
}

/**
 * Why a turn that ran out of time had no answer, read from one last poll at the deadline (Vera, 2026-09-16).
 *
 * `agent_stalled` alone cannot tell an agent that stopped from a delivery that failed twice, and the record is
 * all a later reader has. So the runner asks once more and names what the object says:
 *   still_running        the object is still on the turn: the agent really is slow or stuck;
 *   answer_undelivered   the object answered and neither the socket nor the poll brought it: a delivery fault;
 *   model_failed         the model call failed and that event reached neither the socket nor a poll in time;
 *   idle_without_answer  the object is idle with no reply after the latest message;
 *   unknown              the last poll itself failed, so nothing is claimed.
 *
 * `model_failed` is here because the runner's own checks can miss it by up to one poll interval: the wait
 * ends a turn as soon as the socket reports `model.failed` (bench/tau2/cf.ts:210) or a periodic poll decides
 * `failed` (cf.ts:191), but a failure that lands between the last such poll and the deadline is seen only by
 * this final poll. `decideFromPoll` names it, so reading only its `answer` case filed a failed model call
 * under `idle_without_answer` — a cause that blames the agent for stopping when the model call is what
 * broke, and the published record keeps no poll, so nobody can tell the two apart afterwards.
 */
export type StallCause = "still_running" | "answer_undelivered" | "model_failed" | "idle_without_answer" | "unknown";

export function stallCause(
  poll: { status?: string; answer?: string | null; events?: Array<{ sequence: number; kind: string }> } | null,
  seenSeq: number,
): StallCause {
  if (!poll || typeof poll.status !== "string") return "unknown";
  if (poll.status !== "idle") return "still_running";
  // Each of the decision's kinds means something different about who stopped, so each gets its own name;
  // no decision at all is the only one that reads as "idle with nothing to show".
  switch (decideFromPoll(poll, seenSeq)?.kind) {
    case "answer": return "answer_undelivered";
    case "failed": return "model_failed";
    default: return "idle_without_answer";
  }
}
