/**
 * pass^k, and the two things a run can mean by it.
 *
 * τ²-bench's pass^k asks: if k of a task's trials were drawn at random, would
 * all k pass? Averaged over tasks, that is an order-free property of the run,
 * and at k=1 it is exactly the share of trials that passed.
 *
 * What this runner computed until now was a different thing under that name:
 * the task's FIRST k trials in run order. The two agree only at k = trials.
 * Two τ² runs on 2026-09-18 had the same 22 of 24 trials passing, with two
 * failures in two different tasks, and read as pass^1 87.5% and 100.0% — the
 * whole distance was which trial index the failures happened to land on. The
 * comment over that code said pass^1 "averages over every run", which is the
 * metric below and not what the code did.
 *
 * So each one is named for what it counts, and the ambiguous name is gone. The
 * first-k reading is kept because it answers a real question — did it work on
 * the first try, and the try after that — but it cannot be compared across
 * runs, and its name now says why.
 */

/** One trial. `id` names the task, so a task's trials are the rows that share it. */
export type TrialRow = { id: string | number; reward: number };

/** A task's trials in the order the run produced them, tasks in first-seen order. */
function byTask(rows: readonly TrialRow[]): TrialRow[][] {
  const out = new Map<string, TrialRow[]>();
  for (const r of rows) {
    const key = String(r.id);
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return [...out.values()];
}

/** C(n, k) for the small n a trial count has. 0 when k > n. */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c;
}

/**
 * τ²-bench's pass^k: the chance that k trials drawn from one task all pass,
 * averaged over the tasks that have at least k trials. Order-free, so two runs
 * are comparable. `rate` is a share of tasks, not a count, because a task with
 * 2 of 3 trials passing contributes 1/3 at k=2 rather than 0 or 1.
 */
export function passAllKTrials(rows: readonly TrialRow[], k: number): { rate: number; tasks: number } {
  let sum = 0, tasks = 0;
  for (const trials of byTask(rows)) {
    if (trials.length < k) continue;
    tasks += 1;
    const passed = trials.filter((r) => r.reward).length;
    sum += choose(passed, k) / choose(trials.length, k);
  }
  return { rate: tasks ? sum / tasks : 0, tasks };
}

/**
 * Tasks whose first k trials in run order all passed. A within-run reading:
 * across runs it moves with where the failures fell, not with how good the run
 * was, which is why it is not pass^k and is not named as if it were.
 */
export function passFirstKTrials(rows: readonly TrialRow[], k: number): { passed: number; tasks: number } {
  let passed = 0, tasks = 0;
  for (const trials of byTask(rows)) {
    if (trials.length < k) continue;
    tasks += 1;
    if (trials.slice(0, k).every((r) => r.reward)) passed += 1;
  }
  return { passed, tasks };
}

/** Both readings for k = 1..trials, keyed by k, as the record carries them. */
export function passRecord(rows: readonly TrialRow[], trials: number) {
  const ks = [...Array(trials)].map((_, i) => i + 1);
  return {
    passAllKTrials: Object.fromEntries(ks.map((k) => [k, passAllKTrials(rows, k)])),
    passFirstKTrials: Object.fromEntries(ks.map((k) => [k, passFirstKTrials(rows, k)])),
  };
}

/**
 * The lines both runners print, here rather than in each of them: the two
 * copies of this tally had already drifted apart — one carried a label, the
 * other none — and a label is the part a reader takes the meaning from.
 */
export function passLines(rows: readonly TrialRow[], trials: number): string[] {
  const out: string[] = [];
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  if (trials > 1) {
    for (let k = 1; k <= trials; k++) {
      const { rate, tasks } = passAllKTrials(rows, k);
      out.push(`  pass^${k} = ${pct(rate)}   (any ${k} of a task's trials, all passing; ${tasks} tasks)`);
    }
    for (let k = 1; k <= trials; k++) {
      const { passed, tasks } = passFirstKTrials(rows, k);
      out.push(`  first ${k} = ${passed}/${tasks} = ${pct(tasks ? passed / tasks : 0)}` +
        `   (the task's first ${k} trials in run order — within this run only)`);
    }
  }
  const won = rows.filter((r) => r.reward).length;
  out.push(`  trials  = ${won}/${rows.length} = ${pct(rows.length ? won / rows.length : 0)}` +
    `   (every trial; equals pass^1 above)`);
  return out;
}
