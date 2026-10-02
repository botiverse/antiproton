/**
 * When the agent's object wakes next, decided at the end of an alarm pass.
 *
 * A pass is not exclusive: input (a message, a delivered hook, an answer) can land in the object while
 * the pass is between awaits, and it asks for a wake. The pass then ends by setting its own next time, or
 * deleting the alarm when it found nothing to do; either one replaced the wake the input asked for, and
 * the input sat unread until something else woke the object (a bench turn stalled 305 s this way,
 * 2026-09-29 19:06Z). So every wake is asked for through one method that writes it down (index.ts
 * `#wake`), and the pass keeps what was asked while it ran. Written down rather than inferred from the
 * alarm's time: a time can be told from the pass's own watchdog only while a pass is much shorter than
 * the watchdog's thirty seconds.
 *
 *   asked    the earliest wake asked for since the pass began, or null
 *   planned  when the pass itself wants to run again, or null for "idle"
 *
 * Returns the time to arm, or null to delete the alarm.
 */
export function nextAlarm(asked: number | null, planned: number | null): number | null {
  if (asked === null) return planned;
  return planned === null ? asked : Math.min(asked, planned);
}

/**
 * When a delivered model answer should wake a `pd` object (src/runtime/durable-agent.ts), given the alarm
 * already pending. pi-durable reads the answer at the `pollAt` its checkpoint fixed, and the park that
 * closed the harness armed the alarm for exactly that time; a wake now would reopen the harness only to
 * find the poll still ahead and park again. So: no wake while an alarm is pending, and now when none is
 * (nothing else would come back for the answer). A pi085 object wakes now, as it always has; the caller
 * does not ask this for one.
 */
export function pdDeliveryWake(pendingAlarm: number | null, now: number): number | null {
  return pendingAlarm === null ? now : null;
}
