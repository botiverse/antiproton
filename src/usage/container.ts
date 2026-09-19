/**
 * Time a mount holds something that is billed for existing, by the hour.
 *
 * A container is charged for every second it exists, not per call — the mount's
 * own words (`MountActivity.billing`). So the quantity is an interval, like the
 * object's own active time and unlike a token count, and the same two problems
 * come with it: the interval has to be cut at hour boundaries, and a pass that
 * runs every turn must not count a second twice.
 *
 * What it reads is the plugin contract, not any plugin: `activity.live` for what
 * a mount is holding now and `usage[]` for what it has finished
 * (src/plugins/types.ts). A watermark per box says how far that box has been
 * counted, so a box alive across ten turns is counted once, in the hours it was
 * actually alive.
 *
 * The resource id is `sandbox.container` because containers are the only thing
 * any plugin holds this way today, and the ledger's key is the plugin's name —
 * so a second plugin that starts holding something appears under its own key,
 * and if that ever happens the id is the thing to rename (with a line in
 * report/runs' style saying when it changed, because a renamed resource is a
 * different series).
 *
 * The other side of this seam — that a real run9 box makes the contract look the
 * way the tests assume — cannot be checked here: the tests feed `MountActivity`
 * themselves, so they prove our reading of the contract and not run9's
 * behaviour. `~/tmp/container-billing-probe.sh` drives one real box through a
 * full worker under `wrangler dev --local` and prints what it saw, because a
 * date and a build say the probe ran and only the values say it found what this
 * file assumes.
 *
 * Last run 2026-09-18 on master 461ac02 (cf/ identical to prod ab951c9):
 *   box       h-demo-u-automation-mu7ed0st-mu7ej2m9, the id run9 also lists
 *   startedAt 1789762748957 (run9's own created_at is 0.5s earlier)
 *   endedAt   1789762996360, reported in `usage[]` (length 1, uses 1) in the
 *             pass after the release, with `activity.live` back to null
 *   ledger    247.403 seconds = (endedAt - startedAt) / 1000, to the ms, plus a
 *             separate `execs` row for the one command
 * A later run that disagrees says WHICH side moved: a different shape means run9
 * changed, a different total means this file did.
 */
import { appendUsage, msByHour, type UsageRow } from "./outbox.ts";
import type { SqlHost } from "../store/pi-storage.ts";

type Sql = SqlHost["sql"];

const WATERMARK = "CREATE TABLE IF NOT EXISTS usage_held(box_id TEXT PRIMARY KEY, through INTEGER NOT NULL, uses INTEGER NOT NULL)";
const KEEP_MARKS_MS = 7 * 86_400_000;

/** What a mount is holding or has held. `endedAt: null` means still alive. */
export interface HeldBox {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** How many times it was used, when the mount counts that. */
  uses?: number;
}

/** How far one box has been counted: to when, and how many uses of it. */
export interface HeldMark { through: number; uses: number }

/**
 * Rows for what is new, and the watermarks to store.
 *
 * A live box is counted up to `now`; a finished one up to `endedAt`. Seconds are
 * fractional on purpose: rounding each hour to a whole second would make the
 * parts stop adding up to the life of the box.
 *
 * A box whose watermark is already past its end contributes nothing. A clock
 * that went backwards — `now` before the watermark — contributes nothing rather
 * than a negative second, for the reason the active-time watermark has: what is
 * in the ledger was billed.
 */
export function heldRows(
  base: { tenantId: string; agentId: string },
  key: string,
  boxes: readonly HeldBox[],
  counted: ReadonlyMap<string, HeldMark>,
  now: number,
): { rows: UsageRow[]; marks: Array<{ id: string; mark: HeldMark }> } {
  const rows: UsageRow[] = [];
  const marks: Array<{ id: string; mark: HeldMark }> = [];
  for (const box of boxes) {
    const had = counted.get(box.id);
    const from = Math.max(box.startedAt, had?.through ?? box.startedAt);
    const to = box.endedAt ?? now;
    const parts = msByHour(from, to);
    const uses = Math.max(0, Math.floor(box.uses ?? 0) - (had?.uses ?? 0));
    if (!parts.length && !uses) continue;
    for (const { hour, ms } of parts) {
      rows.push({ at: hour, ...base, resource: "sandbox.container", key, quantity: ms / 1000, unit: "seconds" });
    }
    if (uses) {
      // Uses land in the hour the box was last seen in, which is where the
      // seconds that go with them are: the mount counts them, it does not date
      // them. They share the resource id with the seconds and differ only by
      // `unit`, so anything totalling this resource has to filter by unit — a
      // sum over both is wrong by exactly the number of commands, which looks
      // like a billing bug and is not one (it read 248.403 for a 247.403s box).
      const at = parts.at(-1)?.hour ?? Math.floor(to / 3_600_000) * 3_600_000;
      rows.push({ at, ...base, resource: "sandbox.container", key, quantity: uses, unit: "execs" });
    }
    marks.push({ id: box.id, mark: { through: Math.max(to, had?.through ?? to), uses: Math.max(Math.floor(box.uses ?? 0), had?.uses ?? 0) } });
  }
  return { rows, marks };
}

/**
 * The boxes a mount report describes, live one first.
 *
 * A mount can report the same box twice — alive in `activity` and finished in
 * `usage` — in the pass where it ended between the two reads. The finished
 * record wins, because it has the end.
 */
export function boxesOf(
  report: { activity?: { live?: { id: string; startedAt: number } | null } | null; usage?: ReadonlyArray<{ id: string; startedAt: number; endedAt: number; uses?: number }> } | null | undefined,
): HeldBox[] {
  const out = new Map<string, HeldBox>();
  const live = report?.activity?.live;
  if (live) out.set(live.id, { id: live.id, startedAt: live.startedAt, endedAt: null });
  for (const s of report?.usage ?? []) {
    out.set(s.id, { id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, ...(s.uses === undefined ? {} : { uses: s.uses }) });
  }
  return [...out.values()];
}

/**
 * Append what every mount has held since the last pass, and remember it.
 * Returns one line per mount that contributed, for a caller that wants to say
 * what happened.
 *
 * `reports` is what the console is handed (`MountReports`): the mount's own
 * answer about what it is holding and what it has finished. A mount that
 * reports nothing is not asked to explain itself — it simply has no rows.
 *
 * Watermarks for boxes this report no longer mentions are dropped once they are
 * a week old. A box that has left the mount's bounded session window cannot
 * come back (ids are per box, and the window only drops), so the row is dead
 * weight; the week is slack for a mount that reports late rather than a claim
 * about anything.
 */
export function countHeldTime(
  sql: Sql,
  reports: Record<string, { plugin: string; report: unknown }>,
  base: { tenantId: string; agentId: string },
  now = Date.now(),
): Array<{ key: string; rows: number }> {
  sql.exec(WATERMARK);
  const counted = new Map<string, HeldMark>(sql.exec("SELECT box_id, through, uses FROM usage_held").toArray()
    .map((r: any) => [String(r.box_id), { through: Number(r.through), uses: Number(r.uses) }]));
  const seen = new Set<string>();
  const out: Array<{ key: string; rows: number }> = [];
  for (const { plugin, report } of Object.values(reports)) {
    const boxes = boxesOf(report as any);
    for (const b of boxes) seen.add(b.id);
    const { rows, marks } = heldRows(base, plugin, boxes, counted, now);
    if (rows.length) appendUsage(sql, rows);
    for (const { id, mark } of marks) {
      sql.exec(
        "INSERT INTO usage_held(box_id, through, uses) VALUES (?, ?, ?) " +
        "ON CONFLICT(box_id) DO UPDATE SET through = excluded.through, uses = excluded.uses",
        id, Math.round(mark.through), Math.round(mark.uses));
    }
    if (rows.length) out.push({ key: plugin, rows: rows.length });
  }
  for (const [id, mark] of counted) {
    if (!seen.has(id) && mark.through < now - KEEP_MARKS_MS) sql.exec("DELETE FROM usage_held WHERE box_id = ?", id);
  }
  return out;
}
