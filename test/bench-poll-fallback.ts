/**
 * The runners' poll fallback takes a turn's answer when the push was lost, and never a previous turn's answer.
 */
import { decideFromPoll, stallCause } from "../bench/poll-fallback.ts";

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

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
