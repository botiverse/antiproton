/**
 * When the agent's object wakes next, decided at the end of an alarm pass.
 *
 * A pass is not exclusive: input (a message, a delivered hook, an answer) can land in the object while
 * the pass is between awaits, and it asks for a wake with `setAlarm(now)`. The pass then ends by setting
 * its own next time, or deleting the alarm when it found nothing to do; either one replaced the wake the
 * input asked for, and the input sat unread until something else woke the object (a bench turn stalled
 * 305 s this way, 2026-09-29 19:06Z). So the pass keeps any alarm it did not set itself: the watchdog it
 * armed at its start is the only one it may take back.
 *
 *   watchdog  the time the pass armed at its start, or null when it armed none
 *   current   what the alarm reads now, at the end of the pass
 *   planned   when the pass itself wants to run again, or null for "idle"
 *
 * Returns the time to arm, or null to delete the alarm.
 */
export function nextAlarm(watchdog: number | null, current: number | null, planned: number | null): number | null {
  // Within a second counts as the watchdog, should storage round what it keeps: input asks for "now",
  // thirty seconds earlier than the watchdog, so the two cannot be mistaken for each other.
  const asked = current !== null && (watchdog === null || Math.abs(current - watchdog) > 1_000) ? current : null;
  if (asked === null) return planned;
  return planned === null ? asked : Math.min(asked, planned);
}
