/**
 * The two ending tallies count two different sets of rows, and each is tested
 * on the input where a single-set reading gets it wrong: a trial that ended in
 * `transfer` and still passed. Counting it is right for one tally and wrong for
 * the other, so a function that served both would go red here.
 */
import { endingsAllRows, failingRowsByEndingAndCause } from "../bench/tau2/endings.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const eq = (got: unknown, want: unknown, msg: string) =>
  assert(JSON.stringify(got) === JSON.stringify(want), `${msg}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

// The 18:53Z τ² run, whose two readings disagreed: 24 rows, 6 of them failures.
const run = [
  ...Array.from({ length: 16 }, () => ({ reward: 1, ended: "stop" })),
  ...Array.from({ length: 2 }, () => ({ reward: 1, ended: "transfer" })),
  ...Array.from({ length: 3 }, () => ({ reward: 0, ended: "stop" })),
  ...Array.from({ length: 3 }, () => ({ reward: 0, ended: "transfer" })),
];

await check("a passing row counts in the all-rows tally and not in the failing one", () => {
  const passed = [{ reward: 1, ended: "transfer" }];
  eq(endingsAllRows(passed), { transfer: 1 }, "all rows");
  eq(failingRowsByEndingAndCause(passed), {}, "failing rows");
});

await check("the run that was misread: 5 rows ended in transfer, 3 of those failed", () => {
  eq(endingsAllRows(run), { stop: 19, transfer: 5 }, "all rows");
  eq(failingRowsByEndingAndCause(run), { stop: 3, transfer: 3 }, "failing rows");
  const all = endingsAllRows(run);
  assert(Object.values(all).reduce((a, b) => a + b, 0) === run.length, "the all-rows tally must count every row");
});

await check("a stall's cause is part of the failing key, and never of the all-rows key", () => {
  const rows = [{ reward: 0, ended: "agent_stalled", stall: "answer_undelivered" }];
  eq(failingRowsByEndingAndCause(rows), { "agent_stalled (answer_undelivered)": 1 }, "failing rows");
  eq(endingsAllRows(rows), { agent_stalled: 1 }, "all rows");
});

await check("two stalls of different causes stay apart; the same cause adds up", () => {
  const rows = [
    { reward: 0, ended: "agent_stalled", stall: "answer_undelivered" },
    { reward: 0, ended: "agent_stalled", stall: "still_running" },
    { reward: 0, ended: "agent_stalled", stall: "still_running" },
  ];
  eq(failingRowsByEndingAndCause(rows),
    { "agent_stalled (answer_undelivered)": 1, "agent_stalled (still_running)": 2 }, "failing rows");
  eq(endingsAllRows(rows), { agent_stalled: 3 }, "all rows");
});

await check("a failing row with no cause keeps the bare ending as its key (records before the cause existed)", () => {
  eq(failingRowsByEndingAndCause([{ reward: 0, ended: "agent_stalled" }]), { agent_stalled: 1 }, "failing rows");
});

await check("neither tally invents a row for an empty run", () => {
  eq(endingsAllRows([]), {}, "all rows");
  eq(failingRowsByEndingAndCause([]), {}, "failing rows");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
