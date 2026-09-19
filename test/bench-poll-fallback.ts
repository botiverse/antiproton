/**
 * The runners' poll fallback takes a turn's answer when the push was lost, and never a previous turn's answer.
 *
 * Every fixture here is built by `benchPollBody`, the function the Worker answers `/bench/poll` with, because
 * the fixtures used to invent a field (`events`) the endpoint has never sent: the decision therefore always
 * came out null on the wire while these tests stayed green. A fixture that cannot be built by the producer is
 * not a fixture of anything.
 */
import { benchPollBody, type PollEvent } from "../src/bench/poll-body.ts";
import { causeFromEvidence, decideFromPoll, stallAtDeadline, stallCause, stallEvidence, type Poll } from "../bench/poll-fallback.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const said = (text: string) => ({ text });
const turn: PollEvent[] = [
  { sequence: 4, kind: "message" },
  { sequence: 28, kind: "model.response", payload: said("Which item?") },
  { sequence: 37, kind: "message" },
  { sequence: 61, kind: "model.response", payload: said("One moment.") },
  { sequence: 71, kind: "tool.result" },
  { sequence: 193, kind: "model.response", payload: said("Your exchange has been submitted.") },
];
/** The body the endpoint would answer with, for these events. */
const wire = (events: PollEvent[], running = false): Poll => benchPollBody(events, running);

await check("the lost final answer is taken from poll (the stalled trial: answered at seq 193, socket stopped at 71)", () => {
  const d = decideFromPoll(wire(turn), 71);
  assert(d?.kind === "answer" && d.text.startsWith("Your exchange") && d.seq === 193, `decision: ${JSON.stringify(d)}`);
});

await check("a previous turn's answer is never taken: a new message with no reply after it yet", () => {
  // The cursor is behind (71, as after a reconnect), so only the message guard can refuse the stale answer at 193.
  const d = decideFromPoll(wire([...turn, { sequence: 210, kind: "message" }]), 71);
  assert(d === null, `a stale answer ended the new turn: ${JSON.stringify(d)}`);
});

await check("nothing while the object is still running, or once the socket already delivered that answer", () => {
  assert(decideFromPoll(wire(turn, true), 71) === null, "a running turn was treated as answered");
  assert(decideFromPoll(wire(turn), 193) === null, "an answer the socket delivered was taken again");
});

await check("a failed model call after the latest message ends the turn as failed", () => {
  const d = decideFromPoll(wire([{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.failed" }]), 4);
  assert(d?.kind === "failed" && d.seq === 9, `decision: ${JSON.stringify(d)}`);
});

await check("a model call that failed at the deadline is named as that, not as an agent that went idle", () => {
  // The very poll the decision test above calls `failed`: the runner's earlier checks can miss it by up to
  // one poll interval, so the deadline's poll is the only place it is seen, and naming it
  // `idle_without_answer` there would blame the agent for what the model call did.
  const got = stallCause(wire([{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.failed" }]), 4);
  assert(got === "model_failed", `a failure at the deadline: ${got}`);
});

await check("a failure from the previous turn leaves this one an agent that went idle", () => {
  // The new name must not swallow the old one: a `model.failed` older than the latest message belongs to
  // the turn before this one, which says nothing about why this turn has no answer.
  const got = stallCause(wire([{ sequence: 9, kind: "model.failed" }, { sequence: 12, kind: "message" }]), 4);
  assert(got === "idle_without_answer", `a failure from the previous turn: ${got}`);
});

await check("a timed-out turn names what the object says: running, answered but undelivered, idle, or unknown", () => {
  const cases: Array<[string, ReturnType<typeof stallCause>]> = [
    [stallCause(wire(turn, true), 71), "still_running"],
    [stallCause(wire(turn), 71), "answer_undelivered"],
    [stallCause(wire([...turn, { sequence: 210, kind: "message" }]), 193), "idle_without_answer"],
    [stallCause(wire([{ sequence: 4, kind: "message" }]), 4), "idle_without_answer"],
    [stallCause(null, 71), "unknown"],
    [stallCause({} as Poll, 71), "unknown"],
  ];
  cases.forEach(([got, want], i) => assert(got === want, `case ${i}: ${got}, expected ${want}`));
});

await check("a poll with no sequences in it decides nothing, rather than deciding by their absence", () => {
  // The shape every deployment sent until this change: a status, a count and an answer, and no order at all.
  // Read as -1s it would lose every comparison and name `idle_without_answer` with confidence out of no data,
  // which is exactly what the first real stalled row recorded.
  const old = { status: "idle", entries: 12, answer: "Your exchange has been submitted." } as Poll;
  assert(stallCause(old, 218) === "unknown", `an old body: ${stallCause(old, 218)}`);
  assert(decideFromPoll(old, 218) === null, "an answer was taken from a body that could not say when it happened");
  // And the current body does carry them, so the case above is about old deployments, not about this one.
  assert(stallEvidence(wire(turn), 71).last?.response === 193, "the endpoint's own body has no sequences");
});

// The record keeps the evidence, not the poll, so everything below re-decides from what a record would hold:
// `JSON.parse(JSON.stringify(...))` is the trip the value actually makes on its way to a reader.
const recorded = (poll: Poll | null, seen: number) =>
  causeFromEvidence(JSON.parse(JSON.stringify(stallEvidence(poll, seen))));

await check("a poll that never answered is kept as a claim about nothing, not as a status", () => {
  assert(recorded(null, 71) === "unknown", "a failed poll");
  assert(recorded(wire(turn, true), 71) === "still_running", "still on the turn");
});

await check("the evidence keeps the sequence numbers, because the order is the whole criterion", () => {
  // Identical kinds, opposite order. A record that kept only kinds could not tell these apart, and they are
  // the two cases the cause exists to separate.
  const after = recorded(wire([{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.failed" }]), 4);
  const before = recorded(wire([{ sequence: 9, kind: "model.failed" }, { sequence: 12, kind: "message" }]), 4);
  assert(after === "model_failed", `a failure after the message: ${after}`);
  assert(before === "idle_without_answer", `a failure before the message: ${before}`);
});

await check("an answer the socket had already delivered is not an undelivered one", () => {
  // Same poll, two histories: what the runner had already seen is the only difference, so the evidence has to
  // carry it or a delivered answer reads as a lost one.
  const events: PollEvent[] = [{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.response", payload: said("done") }];
  const seenIt = recorded(wire(events), 9);
  const missedIt = recorded(wire(events), 0);
  assert(seenIt === "idle_without_answer", `the socket had it: ${seenIt}`);
  assert(missedIt === "answer_undelivered", `the socket missed it: ${missedIt}`);
});

await check("the deadline reading keeps what it decided from", () => {
  // Both runners ask this the same way, so it is asked in one place: two copies of the three lines is how a
  // cause and a decision came apart before (#415).
  const body = wire([{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.failed" }]);
  return stallAtDeadline(async () => body, 4).then((got) => {
    assert(got.stall === "model_failed", `a poll that answered: ${got.stall}`);
    assert(got.stallWhy.last?.failed === 9, "the cause came back without the evidence it was read from");
  });
});

await check("a poll that fails, or none at all, claims nothing rather than an idle agent", () => {
  // A request that failed and a deployment that said nothing both end as `unknown`, and the evidence says so
  // with a null status — the row must not read as though the object was seen idle.
  return Promise.all([
    stallAtDeadline(async () => { throw new Error("the poll did not answer"); }, 4),
    stallAtDeadline(async () => null, 4),
  ]).then(([threw, empty]) => {
    assert(threw.stall === "unknown" && threw.stallWhy.status === null, `a poll that threw: ${threw.stall}`);
    assert(empty.stall === "unknown" && empty.stallWhy.status === null, `no poll at all: ${empty.stall}`);
  });
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
