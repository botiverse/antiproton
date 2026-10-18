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
import { appendUsage, msByHour, payerKey, type UsageRow } from "./outbox.ts";
import { secretRefKind } from "../runtime/secrets.ts";
import type { SqlHost } from "../store/pi-storage.ts";

type Sql = SqlHost["sql"];

const WATERMARK = "CREATE TABLE IF NOT EXISTS usage_held(box_id TEXT PRIMARY KEY, through INTEGER NOT NULL, uses INTEGER NOT NULL)";
const KEEP_MARKS_MS = 7 * 86_400_000;

/**
 * One stretch of time a mount held a box: from `startedAt`, and `endedAt: null` while it still runs.
 *
 * A stretch, not a box: a box the idle lease switched off is started again under the same id, so one id can
 * have several of these (src/plugins/sandbox.ts records one per compute session). They follow one another and
 * never overlap, because one box runs one session at a time.
 */
export interface HeldBox {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** How many times it was used, when the mount counts that. */
  uses?: number;
  /**
   * The kind of credential the box was created under (`MountUsage.credentialRef`), which decides who pays for it;
   * absent when the mount did not record one, and then the mount's current credential decides.
   */
  credentialRef?: string;
}

/**
 * How far one box has been counted: to when, and how many uses of the session that instant falls in.
 *
 * Per box rather than per session, because a box's sessions come one after another: an instant names the
 * session it is in, and every session that ended before it has been counted whole.
 */
export interface HeldMark { through: number; uses: number }

/**
 * Rows for what is new, and the watermarks to store.
 *
 * A live session is counted up to `now`; a finished one up to `endedAt`. Seconds are
 * fractional on purpose: rounding each hour to a whole second would make the
 * parts stop adding up to the life of the box.
 *
 * A box's sessions are walked oldest first against its one watermark: a session that ended before the
 * watermark contributes nothing, the one the watermark falls in contributes what is after it, and a later one
 * all of itself. A clock that went backwards — `now` before the watermark — contributes nothing rather
 * than a negative second, for the reason the active-time watermark has: what is
 * in the ledger was billed.
 */
export function heldRows(
  base: { tenantId: string; agentId: string },
  /** The ledger key: one for every session, or each session's own (whose account it is on). */
  keyOf: string | ((box: HeldBox) => string),
  boxes: readonly HeldBox[],
  counted: ReadonlyMap<string, HeldMark>,
  now: number,
): { rows: UsageRow[]; marks: Array<{ id: string; mark: HeldMark }> } {
  const rows: UsageRow[] = [];
  const marks = new Map<string, HeldMark>();
  for (const box of [...boxes].sort((a, b) => a.startedAt - b.startedAt)) {
    const had = marks.get(box.id) ?? counted.get(box.id);
    const to = box.endedAt ?? now;
    if (had && had.through > to) continue;
    // The watermark is inside this session when it is past its start; at or before the start, this session
    // is one nothing has counted yet, and neither have its uses.
    const inside = had !== undefined && had.through > box.startedAt;
    const from = inside ? had.through : box.startedAt;
    // Held time is booked to the hours the BOX EXISTED, not the hour we counted it. A box held since
    // last week therefore writes rows for last week's hours the first time a pass sees it, and the
    // ledger's first hour for sandbox.container can predate this code (on 2026-09-20 the production
    // tenant's was 09-13, three days before container accounting shipped). That is the reading being
    // right, not the meter being wrong: the hours are when the tenant was holding the box. It also means
    // this resource's first recorded hour says nothing about when billing began. The usage page does not
    // explain that: nothing there claims when billing started, so a sentence about it would answer a
    // question no reader has asked. It belongs where the decision is made, which is here.
    const parts = msByHour(from, to);
    const total = Math.max(0, Math.floor(box.uses ?? 0));
    const uses = Math.max(0, total - (inside ? had.uses : 0));
    if (!parts.length && !uses) continue;
    const key = typeof keyOf === "string" ? keyOf : keyOf(box);
    for (const { hour, ms } of parts) {
      rows.push({ at: hour, ...base, resource: "sandbox.container", key, quantity: ms / 1000, unit: "seconds" });
    }
    if (uses) {
      // Uses land in the hour the session was last seen in, which is where the
      // seconds that go with them are: the mount counts them, it does not date
      // them. They share the resource id with the seconds and differ only by
      // `unit`, so anything totalling this resource has to filter by unit — a
      // sum over both is wrong by exactly the number of commands, which looks
      // like a billing bug and is not one (it read 248.403 for a 247.403s box).
      const at = parts.at(-1)?.hour ?? Math.floor(to / 3_600_000) * 3_600_000;
      rows.push({ at, ...base, resource: "sandbox.container", key, quantity: uses, unit: "execs" });
    }
    marks.set(box.id, { through: Math.max(to, had?.through ?? to), uses: Math.max(total, inside ? had.uses : 0) });
  }
  return { rows, marks: [...marks].map(([id, mark]) => ({ id, mark })) };
}

/**
 * The sessions a mount report describes, live one first.
 *
 * One per session, not one per box: a woken box is the same id as the sessions it finished before it was
 * switched off, and each of those is time it was held. A session is its box id and its start.
 *
 * A mount can report the same session twice — alive in `activity` and finished in
 * `usage` — in the pass where it ended between the two reads, and a switched-off
 * box stays in `activity` under the start of the session its switch-off ended.
 * The finished record wins, because it has the end.
 */
export function boxesOf(
  report: {
    activity?: {
      live?: { id: string; startedAt: number; credentialRef?: string } | null;
      /** Held but set aside (`MountActivity.aside`): still alive and billed, so counted like `live`. */
      aside?: ReadonlyArray<{ id: string; startedAt: number; credentialRef?: string }>;
    } | null;
    usage?: ReadonlyArray<{ id: string; startedAt: number; endedAt: number; uses?: number; credentialRef?: string }>;
  } | null | undefined,
): HeldBox[] {
  const out = new Map<string, HeldBox>();
  const session = (v: { id: string; startedAt: number }) => JSON.stringify([v.id, v.startedAt]);
  const under = (v: { credentialRef?: unknown }) => typeof v.credentialRef === "string" ? { credentialRef: v.credentialRef } : {};
  const live = report?.activity?.live;
  if (live) out.set(session(live), { id: live.id, startedAt: live.startedAt, endedAt: null, ...under(live) });
  for (const a of report?.activity?.aside ?? []) out.set(session(a), { id: a.id, startedAt: a.startedAt, endedAt: null, ...under(a) });
  for (const s of report?.usage ?? []) {
    out.set(session(s), { id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, ...(s.uses === undefined ? {} : { uses: s.uses }), ...under(s) });
  }
  return [...out.values()];
}

/**
 * Whether a box spends the tenant's own account: the credential it was created under when the mount recorded that,
 * and the mount's current one (`mountOwn`) only for a box recorded without it. Not the mount's alone: a tenant can
 * put a key of their own over the operator's seeded reference while a box made on our account is still alive, and
 * from then on the mount's reference names their account — every later pass would book our box as theirs, priced 0
 * (#818).
 */
export function boxIsOwn(box: Pick<HeldBox, "credentialRef">, mountOwn: boolean): boolean {
  return box.credentialRef === undefined ? mountOwn : box.credentialRef === "agent";
}

/**
 * Rows marking a pass whose mount records could not be fully read.
 *
 * `MountActivity.unreadable` is a predicate, not a quantity: the scalar mixes
 * rows, sessions and environments, and the three are not commensurable with
 * the seconds a reader would stand next to them — a corrupt environment
 * contributes no missing seconds at all, a corrupt session that session's,
 * and one corrupt top-level row can hide a live box's entire history. The
 * number is therefore never printed; presence is the signal, one row per
 * pass per mount, whatever the scalar said.
 *
 * The marker is written at record time, into the same table the seconds go
 * to, because a flag computed at read time would describe "now" while
 * certifying historical windows it knows nothing about — a window that was
 * damaged and later healed would read as complete, which is worse than
 * unread. `at` is the pass's own hour: the marker has no interval of its
 * own, it says this hour's record is the damaged one.
 *
 * The key is the plugin, like every other row this resource writes: the
 * alias is not in scope where rows are written, and a second keying scheme
 * in the same column would split one mount-kind in two under GROUP BY.
 * Which mount was damaged is diagnose's question — its mountReports are
 * alias-keyed and read the live field.
 */
export function heldUnreadableRows(
  base: { tenantId: string; agentId: string },
  key: string,
  activity: { unreadable?: number } | null | undefined,
  now: number,
): UsageRow[] {
  if (!activity?.unreadable) return [];
  return [{ at: Math.floor(now / 3_600_000) * 3_600_000, ...base, resource: "sandbox.container", key, quantity: 1, unit: "unreadable" }];
}

/**
 * The mount reports `countHeldTime` reads, named by mount and marked with whose account the mount's credential is
 * on now: the agent's own sealed one (secretRefKind "agent") spends the tenant's run9 account; the operator's
 * reference (`operator:run9`) or an environment one spends ours. That mark is the fallback: a box that records the
 * credential it was created under is judged by that (`boxIsOwn`). A report for a mount no longer listed is left out.
 */
export function heldReports(
  mounts: ReadonlyArray<{ alias: string; plugin: string; secretRef: string | null }>,
  reports: Record<string, unknown>,
): Record<string, { plugin: string; report: unknown; own: boolean }> {
  const byAlias = new Map(mounts.map((m) => [m.alias, m]));
  const named: Record<string, { plugin: string; report: unknown; own: boolean }> = {};
  for (const [alias, report] of Object.entries(reports)) {
    const m = byAlias.get(alias);
    if (m) named[alias] = { plugin: m.plugin, report, own: secretRefKind(m.secretRef) === "agent" };
  }
  return named;
}

/**
 * Append what every mount has held since the last pass, and remember it.
 * Returns one line per mount that contributed, for a caller that wants to say
 * what happened.
 *
 * `reports` is what the console is handed (`MountReports`): the mount's own
 * answer about what it is holding and what it has finished. A mount that
 * reports nothing is not asked to explain itself — it simply has no rows.
 * A mount whose records partly do not read writes no boxes either, and is
 * represented by the marker rows (heldUnreadableRows): seconds it cannot
 * see are seconds it cannot count.
 *
 * Watermarks for boxes this report no longer mentions are dropped once they are
 * a week old. A box that has left the mount's bounded session window cannot
 * come back (ids are per box, and the window only drops), so the row is dead
 * weight; the week is slack for a mount that reports late rather than a claim
 * about anything.
 */
export function countHeldTime(
  sql: Sql,
  reports: Record<string, { plugin: string; report: unknown; own?: boolean }>,
  base: { tenantId: string; agentId: string },
  now = Date.now(),
): Array<{ key: string; rows: number }> {
  sql.exec(WATERMARK);
  const counted = new Map<string, HeldMark>(sql.exec("SELECT box_id, through, uses FROM usage_held").toArray()
    .map((r: any) => [String(r.box_id), { through: Number(r.through), uses: Number(r.uses) }]));
  const seen = new Set<string>();
  const out: Array<{ key: string; rows: number }> = [];
  for (const { plugin, report, own } of Object.values(reports)) {
    const boxes = boxesOf(report as any);
    for (const b of boxes) seen.add(b.id);
    // A box on the tenant's own credential is theirs to pay for: kept, under a key that says so (`payerKey`).
    // Whose it is, box by box (`boxIsOwn`): one mount can hold a box on our account beside one on theirs.
    // All of a mount's sessions go through one walk whatever their keys, because a box's sessions share one
    // watermark and have to be walked in time order.
    const { rows, marks } = heldRows(base, (b) => payerKey(plugin, boxIsOwn(b, own === true)), boxes, counted, now);
    // The marker has no box, so it goes under the mount's key.
    const marker = heldUnreadableRows(base, payerKey(plugin, own === true), (report as any)?.activity ?? null, now);
    if (rows.length || marker.length) appendUsage(sql, [...rows, ...marker]);
    for (const { id, mark } of marks) {
      sql.exec(
        "INSERT INTO usage_held(box_id, through, uses) VALUES (?, ?, ?) " +
        "ON CONFLICT(box_id) DO UPDATE SET through = excluded.through, uses = excluded.uses",
        id, Math.round(mark.through), Math.round(mark.uses));
    }
    const byKey = new Map<string, number>();
    for (const r of [...rows, ...marker]) byKey.set(r.key, (byKey.get(r.key) ?? 0) + 1);
    for (const [key, n] of byKey) out.push({ key, rows: n });
  }
  for (const [id, mark] of counted) {
    if (!seen.has(id) && mark.through < now - KEEP_MARKS_MS) sql.exec("DELETE FROM usage_held WHERE box_id = ?", id);
  }
  return out;
}
