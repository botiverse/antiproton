/**
 * When to ask about a container that is sitting there, and when to take it.
 *
 * A box is billed for every second it exists, so leaving one for an agent that
 * may come back is a real cost. The answer is neither "release after every
 * pass" (which is what the code did, and it makes the tool descriptions' "the
 * container persists between calls" false) nor "keep it until asked" (which
 * bills for a box nobody will touch again). It is: keep it, ask the agent, and
 * take it anyway at a ceiling the agent cannot move.
 *
 * Three quantities, and each answers a different question:
 *
 *   afterMs   how long idle before the FIRST reminder. Each reminder costs a
 *             model turn, so this is a price comparison rather than a taste:
 *             below it, reminding costs more than the seconds it saves.
 *   maxMs     the absolute ceiling on idleness. `quiet` cannot defer it; that
 *             is the whole difference between a lever the agent holds and a
 *             property the operator holds.
 *   quietUntil the agent's own request, already capped by the mount when it
 *             was written (run9's `maxQuietMinutes`). It moves the reminders,
 *             never the ceiling.
 *
 * Reminders escalate — the gap doubles — because an agent that has not
 * answered twice is unlikely to answer the third one sooner, and each one is
 * a turn. So they fall at lastUsedAt + T, + 3T, + 7T … which is the cumulative
 * sum of T, 2T, 4T.
 */

export interface IdleInput {
  /** When the box was last actually used. Always set on live state; see run9. */
  lastUsedAt: number;
  /** The agent's deferral, or 0. Already capped where it was written. */
  quietUntil?: number;
  /** How many reminders this box has already had. */
  sent: number;
  now: number;
  afterMs: number;
  maxMs: number;
}

export type IdleAction =
  /** Take the box: it has been idle longer than the operator allows. */
  | { do: "release"; idleMs: number }
  /** Ask the agent, then come back later. */
  | { do: "nudge"; nth: number; idleMs: number; wakeInMs: number }
  /** Nothing to say yet. */
  | { do: "wait"; wakeInMs: number };

/** The instant the nth reminder (1-based) is due, measured from last use. */
export function nudgeDueAt(lastUsedAt: number, afterMs: number, nth: number): number {
  return lastUsedAt + (2 ** nth - 1) * afterMs;
}

export function idleDecision(i: IdleInput): IdleAction {
  const idleMs = i.now - i.lastUsedAt;
  const ceiling = i.lastUsedAt + i.maxMs;
  // The ceiling first, and without consulting `quietUntil`: a deferral the
  // agent asked for is a request about reminders, not about the box's life.
  if (i.now >= ceiling) return { do: "release", idleMs };

  const quietUntil = i.quietUntil ?? 0;
  const due = Math.max(nudgeDueAt(i.lastUsedAt, i.afterMs, i.sent + 1), quietUntil);
  if (i.now >= due) {
    const nth = i.sent + 1;
    const next = Math.min(Math.max(nudgeDueAt(i.lastUsedAt, i.afterMs, nth + 1), quietUntil), ceiling);
    return { do: "nudge", nth, idleMs, wakeInMs: Math.max(1, next - i.now) };
  }
  return { do: "wait", wakeInMs: Math.max(1, Math.min(due, ceiling) - i.now) };
}

/**
 * What the reminder says.
 *
 * The two tool names are passed in rather than built here. A model-facing
 * name is decided over the whole catalogue — the alias is sanitised and a
 * collision takes a numeric suffix — so a second derivation is right only
 * until it is not, and the way it fails is silent: `alias__release` with a
 * collision elsewhere names another mount's tool, which resolves and calls
 * the wrong thing (Piper, Dora, 2026-09-12).
 *
 * Reading them does more than make them correct. A withheld tool has no
 * address in the catalogue at all — withholding is applied before names are
 * qualified — so a `null` here is the fact that the model was not offered it,
 * which a built name could not have seen.
 *
 * No configuration reaches that today, and the one that looks closest cannot:
 * the SWE benchmark withholds `release` so the agent cannot destroy the box
 * its grader is about to read, and the same decision sets `autoRelease:
 * false`, which turns this whole path off. The two flags are one requirement
 * written twice, so a run that reminds while withholding would be somebody
 * changing both. What the `null` does buy is the case that would be silent
 * rather than loud: a built name under a collision resolves to another
 * mount's tool and calls the wrong thing, while a read one is absent and the
 * type says so here rather than downstream.
 */
export function nudgeText(
  alias: string,
  names: { release: string | null; quiet: string | null },
  idleMs: number,
  untilReleaseMs: number,
): string {
  const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));
  const call = names.release && names.quiet
    ? `Call \`${names.release}\` to free it — it can save files out in the same call — or \`${names.quiet}\` if you are coming back to it. `
    : names.release
      ? `Call \`${names.release}\` to free it — it can save files out in the same call. `
      : "";
  return `The container on the \`${alias}\` mount has been idle for ${mins(idleMs)} minutes and is billed for every second. `
    + call
    + `If nothing is done it is released in ${mins(untilReleaseMs)} minutes, and anything not saved goes with it.`;
}
