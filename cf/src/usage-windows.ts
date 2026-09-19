/**
 * Which windows the usage view offers, and how long each one is.
 *
 * One home, because two lists of the same windows disagree invisibly on both
 * sides: the page would offer a window its own parser then refuses ("window is
 * one of …", from the control that offered it), and the retention guard would
 * go on comparing KEEP_HOURLY_DAYS against a list the page no longer uses.
 * That second one is not hypothetical — Rex added a 90d window to the page's
 * list and the guard stayed green (2026-09-19), which is the failure the guard
 * exists to prevent.
 *
 * No one-hour window: the ledger is hourly, so it would be a single bar. The
 * last bar of the day view answers "the last hour".
 */
export const DAY_MS = 86_400_000;

/** Window name to its span. The parser reads it; the page offers its keys. */
export const USAGE_WINDOWS: Record<string, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };

/** The options the page shows, in the order it shows them. */
export const WINDOW_NAMES = Object.keys(USAGE_WINDOWS);
