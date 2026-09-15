/**
 * When an idle container is released, and when its agent is told first.
 *
 * A box is billed for every second it exists, so leaving one for an agent that
 * may come back is a real cost. But the agent is the one who knows whether it
 * is coming back (tygg, 2026-09-15): the box may be taken automatically, the
 * agent is told a few minutes before, it may postpone the release by a time it
 * chooses within the mount's limit, and it is not bothered again until that
 * time is nearly up.
 *
 * Three quantities:
 *
 *   maxMs          idle this long, and the box is released — unless the agent
 *                  postponed it.
 *   warnMs         how long before the release the agent is told. Once per
 *                  release time: a warning is a model turn, and one the agent
 *                  has already answered (or ignored) is not worth another.
 *                  Zero means no warning at all (Agents API sessions, where a
 *                  warning would be a turn nobody asked for in the user's
 *                  conversation).
 *   postponedUntil the agent's own `quiet`, already capped by the mount when it
 *                  was written (run9's `maxQuietMinutes`). It moves the release
 *                  itself. There is no total cap: each postponement is a call
 *                  the agent chose to make.
 *
 * Using the box moves `lastUsedAt`, and with it the release time, so a box in
 * use is never taken and never warned about.
 */

export interface IdleInput {
  /** When the box was last actually used. Always set on live state; see run9. */
  lastUsedAt: number;
  /** The instant the agent asked to keep the box until, or 0. Already capped where it was written. */
  postponedUntil?: number;
  /** The release time a warning was already sent for, or 0. */
  warnedFor: number;
  now: number;
  warnMs: number;
  maxMs: number;
}

export type IdleAction =
  /** Take the box: it has been idle past its release time. */
  | { do: "release"; idleMs: number }
  /** Tell the agent the box is about to go. `wakeInMs` is 0: the warning's turn has to run now. */
  | { do: "warn"; releaseAt: number; idleMs: number; untilReleaseMs: number; wakeInMs: number }
  /** Nothing to say yet. */
  | { do: "wait"; wakeInMs: number };

/** When the box goes: the idle ceiling, or the agent's postponement if that is later. */
export function releaseAt(i: Pick<IdleInput, "lastUsedAt" | "postponedUntil" | "maxMs">): number {
  return Math.max(i.lastUsedAt + i.maxMs, i.postponedUntil ?? 0);
}

export function idleDecision(i: IdleInput): IdleAction {
  const at = releaseAt(i);
  const idleMs = i.now - i.lastUsedAt;
  if (i.now >= at) return { do: "release", idleMs };
  // Already told about this release time: stay quiet until it arrives. A postponement or a use moves `at`,
  // and a new release time earns one new warning.
  if (i.warnedFor === at) return { do: "wait", wakeInMs: Math.max(1, at - i.now) };
  const warnAt = at - Math.max(0, i.warnMs);
  if (i.warnMs > 0 && i.now >= warnAt) {
    // Wake now. The warning is a message the agent has to answer, and posting it only marks the session: its
    // turn runs on the next wake. Scheduling that wake for the release time (as this once did) meant the agent
    // read its warning when the box was already due to go, and could not postpone anything (production,
    // 2026-09-15: a reminder posted at 11:47:21 sat unread until the 12:07:21 alarm). The pass after the
    // warning finds it recorded and waits for the release.
    return { do: "warn", releaseAt: at, idleMs, untilReleaseMs: at - i.now, wakeInMs: 0 };
  }
  return { do: "wait", wakeInMs: Math.max(1, (i.warnMs > 0 ? warnAt : at) - i.now) };
}

/**
 * What the warning says.
 *
 * The two tool names are passed in rather than built here. A model-facing
 * name is decided over the whole catalogue — the alias is sanitised and a
 * collision takes a numeric suffix — so a second derivation is right only
 * until it is not, and the way it fails is silent: `alias__release` with a
 * collision elsewhere names another mount's tool, which resolves and calls
 * the wrong thing (Piper, Dora, 2026-09-12). A withheld tool has no address in
 * the catalogue at all, so a `null` here is the fact that the model was not
 * offered it, and the warning does not tell it to call something it cannot.
 */
export function warningText(
  alias: string,
  names: { release: string | null; quiet: string | null },
  idleMs: number,
  untilReleaseMs: number,
  maxPostponeMinutes: number | null,
): string {
  const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));
  const keep = names.quiet
    ? `To keep it, call \`${names.quiet}\` with how many more minutes you need`
      + (maxPostponeMinutes ? ` (at most ${maxPostponeMinutes})` : "")
      + `; you will not be told again until shortly before then. `
    : "";
  const done = names.release
    ? `If you are done with it, call \`${names.release}\` — it can save files out in the same call.`
    : "";
  return `The container on the \`${alias}\` mount has been idle for ${mins(idleMs)} minutes and will be released `
    + `in ${mins(untilReleaseMs)} minutes, with anything not saved in it. `
    + keep + done;
}
