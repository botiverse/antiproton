/**
 * The deliberate deafness switch: `IGNORE_ANSWERS` exists so the recovery path can be OBSERVED, and the
 * thing worth pinning is that its name matches what it does — `socket` shuts one ear, `all` shuts both,
 * and anything else is refused rather than quietly treated as off (Vera, 2026-09-20).
 */
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

import { deafnessBudget, hearPollDecision, hearSocketEvent, readDeafness } from "../bench/tau2/deafness.ts";

/** The runner's own reading, not a copy of it: one implementation, or the test drifts from the runner. */
const deafness = (value: string | undefined) => deafnessBudget(readDeafness(value));

check("unset changes nothing: both ears hear, every turn", () => {
  const d = deafness(undefined);
  assert(!d.deaf("socket") && !d.deaf("poll"), "a round with no switch ignored something");
});

check("`socket` shuts one ear, so the poll can still recover the turn", () => {
  const d = deafness("socket");
  assert(d.deaf("socket"), "the socket's answer was heard anyway");
  assert(!d.deaf("poll"), "the poll was shut too, which is the other setting");
});

check("`all` shuts both, which is what leaves an answer unread at the deadline", () => {
  const d = deafness("all");
  assert(d.deaf("socket") && d.deaf("poll"), "an ear stayed open, so the deadline would not hold an answer");
});

check("exactly one hole per round, so the rest of the round stays comparable", () => {
  const d = deafness("all");
  assert(d.deaf("socket"), "the first turn was not affected");
  d.spend();
  assert(!d.deaf("socket") && !d.deaf("poll") && d.left() === 0, "a second turn was also made deaf");
});

check("a value that is neither is refused, not read as off", () => {
  // Off would be the dangerous reading: a typo would produce an ordinary-looking round whose record says
  // nothing was injected, which is exactly true and exactly misleading.
  let threw = "";
  try { deafness("drop_push"); } catch (e) { threw = String((e as Error).message); }
  assert(threw.includes("IGNORE_ANSWERS must be"), `a typo was accepted: ${JSON.stringify(threw)}`);
  assert(threw.includes("drop_push"), `the message does not say what was given: ${threw}`);
});

// The property the whole injection rests on: pretending not to have heard an answer has to include the
// CURSOR. `decideFromPoll`/`verdictFromEvidence` decide by `response > seen`, so a runner that ignores an
// answer but still advances `seen` past it tells the fallback the answer was already delivered — the
// deadline then reads `idle_without_answer`, and the round produces the wrong name while looking fine.
// Modelled here with the real decision function rather than a description of it.
import { causeFromEvidence, stallEvidence } from "../bench/poll-fallback.ts";
import { benchPollBody } from "../src/bench/poll-body.ts";

const turn = [
  { sequence: 4, kind: "message" },
  { sequence: 9, kind: "model.response", payload: { text: "the answer" } },
];

check("an ignored answer must not move the cursor — asked of the runner's own decision", () => {
  // @Vera reversed the fix and this case stayed green, because it used to assert that `decideFromPoll`
  // reacts to two hard-coded cursors — true, and not the runner's behaviour. So the ordering is a
  // function now, and the case calls it: with the runner deaf, the answer is ignored AND no cursor comes
  // back; reverse the order inside `hearSocketEvent` and this goes red.
  const answer = { kind: "model.response", id: 9, payload: { text: "the answer" } };
  const deaf = hearSocketEvent(answer, true);
  assert(deaf.kind === "ignored", `a deaf runner did something with the answer: ${JSON.stringify(deaf)}`);
  assert(!("seen" in deaf), `the cursor travelled with an ignored answer: ${JSON.stringify(deaf)}`);

  const heard = hearSocketEvent(answer, false);
  assert(heard.kind === "answer" && heard.seen === 9 && heard.text === "the answer", `hearing it: ${JSON.stringify(heard)}`);

  // Other events still move it, deaf or not: a reconnect resumes from there.
  const other = { kind: "tool.result", id: 7, payload: {} };
  for (const d of [true, false]) {
    const h = hearSocketEvent(other, d);
    assert(h.kind === "advance" && h.seen === 7, `an ordinary event with deaf=${d}: ${JSON.stringify(h)}`);
  }

  // And the poll side, which had the same ordering.
  const ignored = hearPollDecision({ kind: "answer", text: "x", seq: 9 }, true);
  assert(ignored.kind === "ignored", `a deaf runner took the poll's answer: ${JSON.stringify(ignored)}`);
  const failed = hearPollDecision({ kind: "failed", seq: 9 }, true);
  assert(failed.kind === "failed" && failed.seen === 9, "a model failure was swallowed by deafness");
});

check("what the fallback then reads, with the real decision functions", () => {
  // The consequence of the case above, end to end: cursor left alone => the deadline sees an answer
  // nobody took; cursor moved => it reads as delivered and the name is wrong.
  const body = benchPollBody(turn, false);
  assert(causeFromEvidence(stallEvidence(body, 4)) === "answer_undelivered", "the name this injection exists for");
  assert(causeFromEvidence(stallEvidence(body, 9)) === "idle_without_answer", "the defeat it must avoid");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
