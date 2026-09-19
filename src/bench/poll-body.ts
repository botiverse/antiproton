/**
 * What `/bench/poll` answers, in one place, because the runner decides with it.
 *
 * The endpoint used to return `{status, entries, answer}` — the event list it built was reduced to a COUNT —
 * while `bench/poll-fallback.ts` decided from `poll.events`, a field the endpoint has never sent. So the
 * fallback added on 2026-09-15 to stop a lost push becoming a stall could not fire: across all 25 published
 * records, 43 polls came back and `delivered.poll` is 0 in every one of them. The unit tests were green the
 * whole time, because their fixtures invented the `events` field the wire does not carry.
 *
 * It lives under src/ rather than beside the endpoint because both programs must read it: the Worker builds
 * the body, and the runner and its tests — checked in the node program — read and rebuild it.
 *
 * So the body is built here, by the one function both sides use: the Worker returns it, and the runner's
 * tests build their fixtures with it. A fixture can no longer have a shape the endpoint never sends.
 *
 * What the decision needs is not the events but the order: the highest sequence per kind it compares. Those
 * are computed here rather than shipped whole, because a poll happens every 20 seconds per task and a
 * transcript is not a thing to send back each time. `tail` is the last few events as they were, for a reader
 * of a stalled row who wants to see what else was there.
 */

/** The part of a projected event this contract reads (cf/src/pi-view.ts's `ViewEvent` is one). */
export interface PollEvent {
  sequence: number;
  kind: string;
  payload?: Record<string, unknown> | unknown;
}

export const POLL_TAIL = 5;

export interface BenchPollBody {
  status: "running" | "idle";
  /** How many entries the transcript has — kept because it is what the runner's logs have always printed. */
  entries: number;
  /** The last answer, when the object is idle: what a lost push would have delivered. */
  answer: string | null;
  /** The highest sequence for each kind the decision compares; -1 when that kind is not there. */
  last: { message: number; response: number; failed: number };
  tail: Array<{ seq: number; kind: string }>;
}

export function benchPollBody(events: readonly PollEvent[], running: boolean): BenchPollBody {
  const last = (kind: string) => events.reduce((m, e) => (e.kind === kind && e.sequence > m ? e.sequence : m), -1);
  const answered = [...events].reverse()
    .find((e) => e.kind === "model.response" && !(e.payload as { toolCalls?: unknown } | undefined)?.toolCalls);
  return {
    status: running ? "running" : "idle",
    entries: events.length,
    answer: running ? null : ((answered?.payload as { text?: unknown } | undefined)?.text as string ?? null),
    last: { message: last("message"), response: last("model.response"), failed: last("model.failed") },
    tail: events.slice(-POLL_TAIL).map((e) => ({ seq: e.sequence, kind: e.kind })),
  };
}
