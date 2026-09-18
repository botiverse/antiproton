/**
 * The two pass readings are tested on the input where they disagree: the same
 * trials, reordered. τ²-bench's pass^k cannot move when only the order moves;
 * the first-k reading must, because that is the whole of what it reports.
 *
 * The rows below are the two real runs of 2026-09-18, which had the same 24
 * trials, the same 22 passing, and two failures in two different tasks — and
 * read as pass^1 87.5% and 100.0% under the old single field.
 */
import { passAllKTrials, passFirstKTrials, passLines, passRecord } from "../bench/tau2/passk.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const eq = (got: unknown, want: unknown, msg: string) =>
  assert(JSON.stringify(got) === JSON.stringify(want), `${msg}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
const near = (got: number, want: number, msg: string) =>
  assert(Math.abs(got - want) < 1e-9, `${msg}: ${got}, expected ${want}`);

/** Eight tasks, three trials each; `fail` says which trial index of that task scored 0. */
function run(failures: Array<[task: number, trial: number]>) {
  const rows: Array<{ id: number; reward: number }> = [];
  for (let task = 0; task < 8; task++) {
    for (let trial = 0; trial < 3; trial++) {
      rows.push({ id: task, reward: failures.some(([t, i]) => t === task && i === trial) ? 0 : 1 });
    }
  }
  return rows;
}
const failedFirstTrial = run([[4, 0], [5, 1]]);   // the 00:53Z shape: failures early
const failedLastTrial = run([[4, 2], [5, 2]]);    // the 06:53Z shape: failures last

await check("pass^k does not move when only the order of a task's trials moves", () => {
  for (const k of [1, 2, 3]) {
    const a = passAllKTrials(failedFirstTrial, k), b = passAllKTrials(failedLastTrial, k);
    near(a.rate, b.rate, `pass^${k} differs between two runs with the same trials`);
  }
  near(passAllKTrials(failedFirstTrial, 1).rate, 22 / 24, "pass^1 is the share of trials that passed");
  near(passAllKTrials(failedFirstTrial, 2).rate, (6 + 2 / 3) / 8, "pass^2 over 8 tasks, two of them 2-of-3");
  near(passAllKTrials(failedFirstTrial, 3).rate, 6 / 8, "pass^3 is the tasks that passed every trial");
});

await check("the first-k reading does move, and that is what it is for", () => {
  eq(passFirstKTrials(failedFirstTrial, 1), { passed: 7, tasks: 8 }, "first 1, failures early");
  eq(passFirstKTrials(failedLastTrial, 1), { passed: 8, tasks: 8 }, "first 1, failures last");
  eq(passFirstKTrials(failedFirstTrial, 2), { passed: 6, tasks: 8 }, "first 2, failures early");
  eq(passFirstKTrials(failedLastTrial, 2), { passed: 8, tasks: 8 }, "first 2, failures last");
});

await check("at k = every trial the two readings are the same number", () => {
  for (const rows of [failedFirstTrial, failedLastTrial]) {
    const { rate, tasks } = passAllKTrials(rows, 3);
    const first = passFirstKTrials(rows, 3);
    near(rate, first.passed / first.tasks, "k = trials must agree");
    assert(tasks === first.tasks, "both count the same tasks");
  }
});

await check("a task with fewer than k trials is counted by neither", () => {
  const rows = [{ id: 0, reward: 1 }, { id: 1, reward: 1 }, { id: 1, reward: 0 }];
  eq(passAllKTrials(rows, 2).tasks, 1, "tasks at k=2");
  eq(passFirstKTrials(rows, 2).tasks, 1, "tasks at k=2");
  eq(passAllKTrials(rows, 4), { rate: 0, tasks: 0 }, "no task has 4 trials");
});

await check("the record carries both readings, keyed by k, and no `passAtK`", () => {
  const rec = passRecord(failedLastTrial, 3) as Record<string, unknown>;
  eq(Object.keys(rec).sort(), ["passAllKTrials", "passFirstKTrials"], "record fields");
  assert(!("passAtK" in rec), "the ambiguous name must not come back");
  eq(Object.keys(rec.passAllKTrials as object), ["1", "2", "3"], "keyed by k");
  eq((rec.passFirstKTrials as any)["1"], { passed: 8, tasks: 8 }, "first 1 of the 06:53Z shape");
});

await check("pass^1 and the trial line agree only when the trial counts are equal", () => {
  // One task with 2 of 3, one with 0 of 1: the rows say 2/4 = 50.0%, pass^1
  // averages each task's own share and says 33.3%. The line's note has to hold
  // this case, because nothing stops a run from having a short task.
  const uneven = [
    { id: 0, reward: 1 }, { id: 0, reward: 1 }, { id: 0, reward: 0 },
    { id: 1, reward: 0 },
  ];
  near(passAllKTrials(uneven, 1).rate, 1 / 3, "pass^1 averages per task");
  near(uneven.filter((r) => r.reward).length / uneven.length, 1 / 2, "the trial line is over rows");
  const line = passLines(uneven, 3).find((l) => /^ {2}trials /.test(l));
  assert(line !== undefined && /not comparable to pass\^1/.test(line), `uneven note: ${line}`);
  const even = passLines(failedLastTrial, 3).find((l) => /^ {2}trials /.test(l));
  assert(even !== undefined && /when every task has the same trial count/.test(even), `even note: ${even}`);
});

await check("every printed line says which trials it counted", () => {
  const lines = passLines(failedLastTrial, 3);
  assert(lines.some((l) => /pass\^1 = 91\.7%/.test(l)), `pass^1 line: ${lines.join(" | ")}`);
  assert(lines.some((l) => /first 1 = 8\/8/.test(l)), `first-1 line: ${lines.join(" | ")}`);
  for (const l of lines) assert(/\(.*\)/.test(l), `a line with no note saying what it counted: ${l}`);
  assert(!lines.some((l) => /averaged/.test(l)), "the label that was false must not return");
});

await check("one trial each: pass^1 is the pass rate and nothing claims more", () => {
  const rows = [{ id: 0, reward: 1 }, { id: 1, reward: 0 }];
  near(passAllKTrials(rows, 1).rate, 0.5, "pass^1");
  const lines = passLines(rows, 1);
  eq(lines.length, 1, "a single-trial run prints only the trial line");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
