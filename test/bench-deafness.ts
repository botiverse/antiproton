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

import { deafnessBudget, readDeafness } from "../bench/tau2/deafness.ts";

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
import { decideFromPoll, causeFromEvidence, stallEvidence } from "../bench/poll-fallback.ts";
import { benchPollBody } from "../src/bench/poll-body.ts";

const turn = [
  { sequence: 4, kind: "message" },
  { sequence: 9, kind: "model.response", payload: { text: "the answer" } },
];

check("an ignored answer must not move the cursor, or the fallback is told it was delivered", () => {
  const body = benchPollBody(turn, false);
  // What the runner does when it heard nothing: the cursor still points before the answer.
  const deafSeen = 4;
  const d = decideFromPoll(body, deafSeen);
  assert(d?.kind === "answer", `with the cursor left alone the fallback still sees the answer: ${JSON.stringify(d)}`);
  assert(causeFromEvidence(stallEvidence(body, deafSeen)) === "answer_undelivered",
    "the deadline reading is not the name this injection exists to produce");

  // And what a runner that ignored the answer but advanced the cursor anyway would produce:
  const movedSeen = 9;
  assert(decideFromPoll(body, movedSeen) === null, "the fixture does not model the defeat at all");
  assert(causeFromEvidence(stallEvidence(body, movedSeen)) === "idle_without_answer",
    "moving the cursor past an ignored answer should produce the wrong name — that is why it must not move");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
