/**
 * The order a run visits its (task, trial) pairs — and why that is a switch rather than a constant.
 *
 * Every τ² record of MORE THAN ONE TRIAL whose `order` is absent or `trial-major` walks trials on the
 * outside — trial 1 of every task, then trial 2, then trial 3 (`[1×8, 2×8, 3×8]` in the eight-task rounds
 * we run). That makes a row's trial number and its position in the run the SAME NUMBER
 * (`row = (trial - 1) * tasks + taskIndex`), so no quantity computed from those records can separate "the
 * second attempt at a task" from "later in the run". More records in that order add no information about
 * the difference; only a run in a different order does.
 *
 * Said that way on purpose, and every qualifier in it is load-bearing. It names what refutes it — a record
 * whose `order` is `task-major` must NOT have that shape — where the first version claimed something about
 * every record ever published, which the first task-major record made false the moment it was anchored,
 * and that record is the one this switch produced. `τ²` and `more than one trial` are there because the
 * manifest holds a SWE-bench record with no trial numbers at all and a one-trial τ² record, and the
 * version of this sentence without those two words was false about both.
 *
 * The number of such records is deliberately left out: it grows, and nothing in the
 * sentence depends on it.
 *
 * Checked over the published records rather than asserted: for every JSON on report/runs/manifest.tsv
 * with `bench == "tau2-retail"`, `trials > 1` and `order` absent or `trial-major`, the row order equals
 * `[1×tasks, 2×tasks, …]`. 29 records, 0 counterexamples, on master aae6862.
 *
 * Two things a reader redoing that check needs, because both cost me a wrong answer first. Take the task
 * count from the record's own `tasks` array: in a row, `id` is the τ² task and `taskId` is unique per ROW,
 * so a distinct count over `taskId` returns the number of ROWS (24 where there are 8 tasks) and reports
 * every record as a counterexample. And fetch them from the bucket: no record is tracked in this
 * repository (report/runs/ tracks only README.md and manifest.tsv), so a scan of the working copy reads
 * whatever untracked files a local run happened to leave there. report/runs/README.md has the address.
 *
 * So the plan is built here, once, and named in the record. `task-major` runs a task's trials back to back,
 * which is what breaks the identity: trial 2 and 3 are no longer always in the run's second half.
 * Randomising was considered and rejected — it turns both explanations into noise instead of separating
 * them.
 */

/**
 * What the first task-major run (2026-09-20, `tau2-order_tm-mu9i1fxl`) showed about the DESIGN, which
 * outlives what it showed about the question: `task-major` changes what a position in the run MEANS.
 * Thirds of the run are now thirds of the TASK LIST, not trial 1 / 2 / 3, which is exactly the point — trial
 * and position stop being one variable. The cost is that each cell gets smaller: a task's three trials sit
 * together, so the run says more about within-task trends and less about a column mean. One round of it had
 * a single informative pair. Choose `task-major` to separate the two variables, not to measure either
 * one precisely, and expect to need several rounds for anything else.
 */
export type RunOrder = "trial-major" | "task-major";

export const RUN_ORDERS: RunOrder[] = ["trial-major", "task-major"];

/**
 * An unknown name is refused rather than defaulted: a run whose order silently fell back to the old one,
 * and whose record then says the old one, is indistinguishable from a run that was never re-ordered.
 */
export function runOrder(name: string | undefined): RunOrder {
  const value = name ?? "trial-major";
  if ((RUN_ORDERS as string[]).includes(value)) return value as RunOrder;
  throw new Error(`ORDER must be one of ${RUN_ORDERS.join(", ")} (got ${JSON.stringify(value)})`);
}

/** The pairs in the order they will be run. `trials` counts from 1. */
export function runPlan<T>(tasks: readonly T[], trials: number, order: RunOrder): Array<{ task: T; trial: number }> {
  const plan: Array<{ task: T; trial: number }> = [];
  if (order === "task-major") {
    for (const task of tasks) for (let trial = 1; trial <= trials; trial++) plan.push({ task, trial });
  } else {
    for (let trial = 1; trial <= trials; trial++) for (const task of tasks) plan.push({ task, trial });
  }
  return plan;
}
