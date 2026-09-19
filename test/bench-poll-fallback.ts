/**
 * The runners' poll fallback takes a turn's answer when the push was lost, and never a previous turn's answer.
 */
import { causeFromEvidence, decideFromPoll, stallCause, stallEvidence } from "../bench/poll-fallback.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const turn = [
  { sequence: 4, kind: "message" },
  { sequence: 28, kind: "model.response" },
  { sequence: 37, kind: "message" },
  { sequence: 61, kind: "model.response" },
  { sequence: 71, kind: "tool.result" },
  { sequence: 193, kind: "model.response" },
];

await check("the lost final answer is taken from poll (the stalled trial: answered at seq 193, socket stopped at 71)", () => {
  const d = decideFromPoll({ status: "idle", answer: "Your exchange has been submitted.", events: turn }, 71);
  assert(d?.kind === "answer" && d.text.startsWith("Your exchange") && d.seq === 193, `decision: ${JSON.stringify(d)}`);
});

await check("a previous turn's answer is never taken: a new message with no reply after it yet", () => {
  // The cursor is behind (71, as after a reconnect), so only the message guard can refuse the stale answer at 193.
  const events = [...turn, { sequence: 210, kind: "message" }];
  const d = decideFromPoll({ status: "idle", answer: "Your exchange has been submitted.", events }, 71);
  assert(d === null, `a stale answer ended the new turn: ${JSON.stringify(d)}`);
});

await check("nothing while the object is still running, or once the socket already delivered that answer", () => {
  assert(decideFromPoll({ status: "running", answer: null, events: turn }, 71) === null, "a running turn was treated as answered");
  assert(decideFromPoll({ status: "idle", answer: "x", events: turn }, 193) === null, "an answer the socket delivered was taken again");
});

await check("a failed model call after the latest message ends the turn as failed", () => {
  const events = [{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.failed" }];
  const d = decideFromPoll({ status: "idle", answer: null, events }, 4);
  assert(d?.kind === "failed" && d.seq === 9, `decision: ${JSON.stringify(d)}`);
});

await check("a model call that failed at the deadline is named as that, not as an agent that went idle", () => {
  // The very poll the decision test above calls `failed`: the runner's earlier checks can miss it by up to
  // one poll interval, so the deadline's poll is the only place it is seen, and naming it
  // `idle_without_answer` there would blame the agent for what the model call did.
  const events = [{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.failed" }];
  const got = stallCause({ status: "idle", answer: null, events }, 4);
  assert(got === "model_failed", `a failure at the deadline: ${got}`);
});

await check("a failure from the previous turn leaves this one an agent that went idle", () => {
  // The new name must not swallow the old one: a `model.failed` older than the latest message belongs to
  // the turn before this one, which says nothing about why this turn has no answer.
  const events = [{ sequence: 9, kind: "model.failed" }, { sequence: 12, kind: "message" }];
  const got = stallCause({ status: "idle", answer: null, events }, 4);
  assert(got === "idle_without_answer", `a failure from the previous turn: ${got}`);
});

await check("a timed-out turn names what the object says: running, answered but undelivered, idle, or unknown", () => {
  const cases: Array<[string, ReturnType<typeof stallCause>]> = [
    [stallCause({ status: "running", answer: "old", events: turn }, 71), "still_running"],
    [stallCause({ status: "idle", answer: "Your exchange has been submitted.", events: turn }, 71), "answer_undelivered"],
    [stallCause({ status: "idle", answer: "Your exchange has been submitted.", events: [...turn, { sequence: 210, kind: "message" }] }, 193), "idle_without_answer"],
    [stallCause({ status: "idle", answer: null, events: [{ sequence: 4, kind: "message" }] }, 4), "idle_without_answer"],
    [stallCause(null, 71), "unknown"],
    [stallCause({} as any, 71), "unknown"],
  ];
  cases.forEach(([got, want], i) => assert(got === want, `case ${i}: ${got}, expected ${want}`));
});

// The record keeps the evidence, not the poll, so everything below re-decides from what a record would hold:
// `JSON.parse(JSON.stringify(...))` is the trip the value actually makes on its way to a reader.
const recorded = (poll: Parameters<typeof stallEvidence>[0], seen: number) =>
  causeFromEvidence(JSON.parse(JSON.stringify(stallEvidence(poll, seen))));

await check("a poll that never answered is kept as a claim about nothing, not as a status", () => {
  assert(recorded(null, 71) === "unknown", "a failed poll");
  assert(recorded({ status: "running", answer: "old", events: turn }, 71) === "still_running", "still on the turn");
});

await check("the evidence keeps the sequence numbers, because the order is the whole criterion", () => {
  // Identical kinds, opposite order. A record that kept only kinds could not tell these apart, and they are
  // the two cases the cause exists to separate.
  const after = recorded({ status: "idle", answer: null, events: [{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.failed" }] }, 4);
  const before = recorded({ status: "idle", answer: null, events: [{ sequence: 9, kind: "model.failed" }, { sequence: 12, kind: "message" }] }, 4);
  assert(after === "model_failed", `a failure after the message: ${after}`);
  assert(before === "idle_without_answer", `a failure before the message: ${before}`);
});

await check("an answer the socket had already delivered is not an undelivered one", () => {
  // Same poll, two histories: what the runner had already seen is the only difference, so the evidence has to
  // carry it or a delivered answer reads as a lost one.
  const events = [{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.response" }];
  const seenIt = recorded({ status: "idle", answer: "Your exchange has been submitted.", events }, 9);
  const missedIt = recorded({ status: "idle", answer: "Your exchange has been submitted.", events }, 0);
  assert(seenIt === "idle_without_answer", `the socket had it: ${seenIt}`);
  assert(missedIt === "answer_undelivered", `the socket missed it: ${missedIt}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
