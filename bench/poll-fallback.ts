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

import type { BenchPollBody } from "../src/bench/poll-body.ts";

export type PollDecision =
  | { kind: "answer"; text: string; seq: number }
  | { kind: "failed"; seq: number }
  | null;

/**
 * What the runner has in hand: the endpoint's body, with every field optional because a deployment older
 * than src/bench/poll-body.ts answers without the sequences, and a request can fail outright. Typed from the
 * Worker's own contract so that a change there has to be answered here rather than read as an absent field —
 * an absent field is exactly what went unnoticed for four days.
 */
export type Poll = Partial<BenchPollBody>;

/**
 * What the criterion below reads, and the only thing it reads (Vera, 2026-09-19).
 *
 * A stalled row used to record its cause and nothing else, so the question "was this really an idle agent, or
 * a model call that failed inside the runner's blind window?" could not be answered from a record at all —
 * the poll that decided it was gone. This is that poll, reduced to the values the decision uses: a status, a
 * boolean for whether there was an answer at all, and **the sequence numbers**, because the whole criterion is
 * whether an event came after the latest message and after what the socket had already delivered. Kinds
 * without their sequences would say what happened but not in which order, which is not enough to re-decide.
 *
 * `tail` is the last few events as the endpoint sent them, for the reader who wants to see what else was
 * there; the decision never looks at it. The answer's text is deliberately absent: the runner needs it, a record of why
 * a turn had no answer does not.
 */
export interface StallEvidence {
  /** The poll's status, or null when the poll itself failed — the case that claims nothing. */
  status: string | null;
  /** What the socket had already delivered when the deadline came. */
  seen: number;
  /** Whether the poll carried an answer at all, without carrying the answer. */
  answer: boolean;
  /**
   * The highest sequence for each kind the criterion reads, as the endpoint gave them — or null when it gave
   * none. Null is not "nothing happened": it is "this deployment did not say", and the two must not share a
   * value, because a missing sequence reads as -1 and -1 loses every comparison, which names a cause with
   * confidence out of no data at all.
   */
  last: { message: number; response: number; failed: number } | null;
  tail: Array<{ seq: number; kind: string }>;
}

export function stallEvidence(poll: Poll | null, seenSeq: number): StallEvidence {
  const known = !!poll && typeof poll.status === "string";
  return {
    status: known ? String(poll!.status) : null,
    seen: seenSeq,
    answer: known ? !!poll!.answer : false,
    last: known && poll!.last ? { ...poll!.last } : null,
    tail: (known ? poll!.tail : undefined) ?? [],
  };
}

/**
 * The one criterion, reading only the evidence.
 *
 * Both readers go through here — the runner, which needs the answer's text, and the record's cause, which
 * needs a name — because a second hand-written copy of this rule is exactly how the cause came to disagree
 * with the decision in the first place (#415). One implementation, and its input is the thing a record keeps.
 */
export function verdictFromEvidence(ev: StallEvidence): { kind: "answer" | "failed"; seq: number } | null {
  if (ev.status !== "idle" || !ev.last) return null;
  const { message, response, failed } = ev.last;
  if (failed > message && failed > ev.seen) return { kind: "failed", seq: failed };
  if (!ev.answer || response <= message || response <= ev.seen) return null;
  return { kind: "answer", seq: response };
}

export function decideFromPoll(poll: Poll, seenSeq: number): PollDecision {
  const v = verdictFromEvidence(stallEvidence(poll, seenSeq));
  if (!v) return null;
  return v.kind === "failed" ? { kind: "failed", seq: v.seq } : { kind: "answer", text: String(poll.answer), seq: v.seq };
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

export function stallCause(poll: Poll | null, seenSeq: number): StallCause {
  return causeFromEvidence(stallEvidence(poll, seenSeq));
}

/**
 * The same name, from the evidence a record kept — so a reader months later re-decides rather than trusting
 * the word that was written down.
 */
export function causeFromEvidence(ev: StallEvidence): StallCause {
  if (ev.status === null) return "unknown";
  if (ev.status !== "idle") return "still_running";
  // A poll that did not carry the sequences cannot say which of the three happened, and saying
  // `idle_without_answer` anyway is the shape this whole seam got wrong: a name that is right by arithmetic
  // (-1 loses every comparison) rather than by evidence.
  if (!ev.last) return "unknown";
  // Each of the criterion's kinds means something different about who stopped, so each gets its own name;
  // no verdict at all is the only one that reads as "idle with nothing to show".
  switch (verdictFromEvidence(ev)?.kind) {
    case "answer": return "answer_undelivered";
    case "failed": return "model_failed";
    default: return "idle_without_answer";
  }
}
