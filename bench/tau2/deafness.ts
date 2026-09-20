/**
 * Deliberate deafness, so the recovery path can be OBSERVED rather than waited for.
 *
 * Three rounds and 72 trials produced no stall at all, and `answer_undelivered` cannot be waited for: the
 * runner polls every 20 seconds, so every lost push has about fifteen chances to be picked up before the
 * deadline. The only way that name ever appears in a record is if a round is made deaf on purpose
 * (Vera, 2026-09-20). `model_failed` is the opposite case and is NOT injected anywhere: it needs a real
 * model call to fail after the last message, and that arrives on its own.
 *
 *   socket   the socket's answer is ignored; the polls still run, so the fallback should recover the turn.
 *            Expect `delivered.poll` above zero and an ordinary ending — that is the fallback observed
 *            working for the first time, and it produces no new stall cause.
 *   all      the polls are ignored too, so the deadline arrives holding an answer nobody read. Expect
 *            `agent_stalled (answer_undelivered)`, a name no record has ever carried.
 *
 * Named for what it does, not for the story it tells: `all` is not "a lost push", it is both ears shut,
 * and a switch whose name overstates it would be read as evidence of something it never tested.
 */

export type Deafness = "socket" | "all";

/** The setting, or undefined. A value that is neither is refused rather than read as off. */
export function readDeafness(value: string | undefined): Deafness | undefined {
  if (value === undefined || value === "socket" || value === "all") return value;
  // Off is the dangerous reading of a typo: the round would look ordinary and its record would say nothing
  // was injected — exactly true, and exactly misleading about what the round tested.
  throw new Error(`IGNORE_ANSWERS must be "socket" or "all" (got ${JSON.stringify(value)})`);
}

/**
 * One hole per round, so everything after it stays comparable with an ordinary round. `spend()` is called
 * when the turn it applied to has ended, however it ended.
 */
export function deafnessBudget(setting: Deafness | undefined) {
  let left = setting ? 1 : 0;
  return {
    setting,
    deaf(to: "socket" | "poll") {
      if (!setting || left <= 0) return false;
      return to === "socket" || setting === "all";
    },
    spend() { if (left > 0) left -= 1; },
    left() { return left; },
  };
}
