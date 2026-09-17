/**
 * Two tallies of how trials ended, each named for the set it counts.
 *
 * The record used to carry one field, `endings`, built from the failing rows
 * only. Read from the JSON the name says "how the run ended", so on 2026-09-17
 * a reading of one run took "5 rows ended in transfer" (all rows) and "3
 * transfer" (failing rows) for the same number and reported a threefold rise
 * that was not there. Both counts were right; only the name was silent about
 * which rows it had counted.
 *
 * So the record carries both, and each name carries its set. The failing tally
 * also splits a stall by its cause, which the all-rows one deliberately does
 * not: the cause answers "why did this failure have no answer", a question a
 * passing row does not raise.
 */

export type EndedRow = { reward: number; ended?: string; stall?: string };

/** Every trial by how it ended, passing ones included. `stall` is not part of the key. */
export function endingsAllRows(rows: readonly EndedRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = String(r.ended);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Only the trials that scored 0, keyed `ended` or `ended (cause)` when a stall named its cause. */
export function failingRowsByEndingAndCause(rows: readonly EndedRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.reward) continue;
    const key = r.stall ? `${r.ended} (${r.stall})` : String(r.ended);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
