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
