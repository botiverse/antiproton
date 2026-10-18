/**
 * Container time: an interval charged for existing, counted once.
 *
 * The inputs that matter: a box alive across several passes (the same seconds
 * must not be charged twice), a box that ends between two passes (its tail is
 * the part after the watermark), and the hour a long-lived box crosses.
 */
import { boxesOf, boxIsOwn, countHeldTime, heldReports, heldRows, heldUnreadableRows, type HeldMark } from "../src/usage/container.ts";
import { pendingUsage, HOUR_MS } from "../src/usage/outbox.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { activityOf, sessionOf, usageOf } from "../src/plugins/sandbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const eq = (got: unknown, want: unknown, msg: string) =>
  must(JSON.stringify(got) === JSON.stringify(want), `${msg}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
const base = { tenantId: "t", agentId: "a" };
const H0 = Date.parse("2026-09-18T10:00:00Z");
const marks = (of: Record<string, HeldMark>) => new Map(Object.entries(of));
const secs = (rows: ReturnType<typeof heldRows>["rows"]) =>
  rows.filter((r) => r.unit === "seconds").map((r) => [(r.at - H0) / 60_000, r.quantity]);

check("a live box is counted up to now, and the next pass only adds what is new", () => {
  const live = [{ id: "b1", startedAt: H0 + 60_000, endedAt: null }];
  const first = heldRows(base, "sandbox", live, new Map(), H0 + 120_000);
  eq(secs(first.rows), [[0, 60]], "one minute of it so far");
  eq(first.marks, [{ id: "b1", mark: { through: H0 + 120_000, uses: 0 } } ], "the watermark is where counting stopped");
  const second = heldRows(base, "sandbox", live, marks({ b1: { through: H0 + 120_000, uses: 0 } }), H0 + 180_000);
  eq(secs(second.rows), [[0, 60]], "the next minute, not the whole life");
});

check("a box that ended is counted to its end, and then never again", () => {
  const ended = [{ id: "b1", startedAt: H0, endedAt: H0 + 300_000, uses: 4 }];
  const at = marks({ b1: { through: H0 + 120_000, uses: 1 } });
  const got = heldRows(base, "sandbox", ended, at, H0 + 600_000);
  eq(secs(got.rows), [[0, 180]], "the tail after the watermark, not to now");
  eq(got.rows.filter((r) => r.unit === "execs").map((r) => r.quantity), [3], "and the uses it had not reported");
  const again = heldRows(base, "sandbox", ended, marks({ b1: { through: H0 + 300_000, uses: 4 } }), H0 + 900_000);
  eq(again.rows, [], "a finished box with nothing new is silent");
});

check("a box alive across an hour boundary splits at it", () => {
  const live = [{ id: "b1", startedAt: H0 + 59 * 60_000, endedAt: null }];
  const got = heldRows(base, "sandbox", live, new Map(), H0 + HOUR_MS + 60_000);
  eq(got.rows.filter((r) => r.unit === "seconds").map((r) => [r.at, r.quantity]),
    [[H0, 60], [H0 + HOUR_MS, 60]], "a minute in each hour");
  eq(got.rows.reduce((a, r) => a + (r.unit === "seconds" ? r.quantity : 0), 0), 120, "and the parts are the whole");
});

check("seconds stay fractional, so the parts keep adding up to the life", () => {
  const got = heldRows(base, "sandbox", [{ id: "b1", startedAt: H0, endedAt: H0 + 1500 }], new Map(), H0 + 9_000);
  eq(secs(got.rows), [[0, 1.5]], "1.5 seconds, not 1 and not 2");
});

check("a clock that went backwards charges nothing", () => {
  const got = heldRows(base, "sandbox", [{ id: "b1", startedAt: H0, endedAt: null }],
    marks({ b1: { through: H0 + 600_000, uses: 0 } }), H0 + 60_000);
  eq(got.rows, [], "no negative second, and no row");
});

check("the box list comes from the mount's own report, and a finished record wins", () => {
  // The pass where a box ended between the two reads sees it twice: alive in
  // `activity`, finished in `usage`. The finished one has the end.
  const report = {
    activity: { live: { id: "b1", startedAt: H0 } },
    usage: [{ id: "b1", startedAt: H0, endedAt: H0 + 60_000, uses: 2 }, { id: "b0", startedAt: H0 - HOUR_MS, endedAt: H0 - 60_000 }],
  };
  eq(boxesOf(report), [
    { id: "b1", startedAt: H0, endedAt: H0 + 60_000, uses: 2 },
    { id: "b0", startedAt: H0 - HOUR_MS, endedAt: H0 - 60_000 },
  ], "one entry per box, the finished record kept");
  eq(boxesOf({ activity: { live: null }, usage: [] }), [], "a mount holding nothing has no boxes");
  eq(boxesOf(null), [], "and neither has a mount that did not report");
});

check("the pass where a box ends has nothing live, so the finished half is the half that closes it", () => {
  // Rex, #402: a live-gated read would look like a saving and would lose the
  // last hours of every box, because the ending pass is exactly the pass with
  // `live === null`. Kept as a check so the saving cannot be made by mistake.
  const report = { activity: { live: null }, usage: [{ id: "b1", startedAt: H0, endedAt: H0 + 2 * HOUR_MS, uses: 3 }] };
  eq(boxesOf(report).map((b) => [b.id, b.endedAt]), [["b1", H0 + 2 * HOUR_MS]], "the box is in the report with its end");
  const got = heldRows(base, "sandbox", boxesOf(report), marks({ b1: { through: H0 + HOUR_MS, uses: 1 } }), H0 + 3 * HOUR_MS);
  eq(got.rows.filter((r) => r.unit === "seconds").map((r) => [(r.at - H0) / HOUR_MS, r.quantity]), [[1, 3600]],
    "and its last hour is charged in the pass where nothing is live");
});

check("against a real table: two mounts, ten passes, each second charged once", () => {
  const host = sqliteHost();
  const reports = (live: boolean, now: number) => ({
    box: { plugin: "sandbox", report: { activity: { live: live ? { id: "b1", startedAt: H0 } : null }, usage: live ? [] : [{ id: "b1", startedAt: H0, endedAt: now, uses: 7 }] } },
    gh: { plugin: "github", report: { activity: { live: null }, usage: [] } },
  });
  let now = H0 + 60_000;
  for (let i = 0; i < 10; i++, now += 60_000) countHeldTime(host.sql, reports(true, now), base, now);
  countHeldTime(host.sql, reports(false, now), base, now);
  const rows = pendingUsage(host.sql, 0);
  const seconds = rows.filter((r) => r.unit === "seconds").reduce((a, r) => a + r.quantity, 0);
  eq(seconds, (now - H0) / 1000, `every second once: ${seconds} of ${(now - H0) / 1000}`);
  eq(rows.filter((r) => r.unit === "execs").reduce((a, r) => a + r.quantity, 0), 7, "and the uses once");
  must(rows.every((r) => r.key === "sandbox"), "a mount that holds nothing writes nothing");
  const after = countHeldTime(host.sql, reports(false, now), base, now + 60_000);
  eq(after, [], "a pass after the box is gone adds nothing");
  eq(pendingUsage(host.sql, 0).length, rows.length, "and no row appeared");
});

check("a watermark for a box nobody mentions is dropped only when it is a week old", () => {
  const host = sqliteHost();
  const none = { m: { plugin: "sandbox", report: { activity: { live: null }, usage: [] } } };
  countHeldTime(host.sql, { m: { plugin: "sandbox", report: { activity: { live: { id: "old", startedAt: H0 } }, usage: [] } } }, base, H0 + 1000);
  const left = () => host.sql.exec("SELECT box_id FROM usage_held").toArray().length;
  countHeldTime(host.sql, none, base, H0 + 6 * 86_400_000);
  eq(left(), 1, "six days on, the row stays");
  countHeldTime(host.sql, none, base, H0 + 8 * 86_400_000);
  eq(left(), 0, "eight days on, it is gone");
});

check("a mount whose records do not read is marked with a predicate, not a count", () => {
  // The scalar mixes rows, sessions and environments, and the three are not
  // commensurable with the seconds a reader would stand next to them: a
  // corrupt environment contributes no missing seconds, a corrupt session
  // that session's, one corrupt row possibly a whole live box. So the field
  // is never printed as a number; presence is the signal, one row per pass.
  eq(heldUnreadableRows(base, "sandbox", { unreadable: 3 }, H0 + 60_000).map((r) => [r.at, r.resource, r.key, r.quantity, r.unit]),
    [[H0, "sandbox.container", "sandbox", 1, "unreadable"]], "one marker, quantity 1, whatever the scalar said");
  eq(heldUnreadableRows(base, "sandbox", { unreadable: 0 }, H0), [], "zero is nothing");
  eq(heldUnreadableRows(base, "sandbox", undefined, H0), [], "and so is the field's absence");
  eq(heldUnreadableRows(base, "sandbox", null, H0), [], "in both spellings");
});

check("against a real table: the marker is written where the seconds are not, and beside them where they are", () => {
  const host = sqliteHost();
  countHeldTime(host.sql, { m: { plugin: "sandbox", report: { activity: { live: null, unreadable: 3 }, usage: [] } } }, base, H0 + 60_000);
  eq(pendingUsage(host.sql, 0).map((r) => [r.unit, r.quantity]), [["unreadable", 1]], "no boxes, so no seconds, but the damage is on record");
  countHeldTime(host.sql, { m: { plugin: "sandbox", report: { activity: { live: { id: "b1", startedAt: H0 }, unreadable: 2 }, usage: [] } } }, base, H0 + 120_000);
  const rows = pendingUsage(host.sql, 0);
  eq(rows.filter((r) => r.unit === "seconds").map((r) => r.quantity), [120], "the live box is counted as usual");
  eq(rows.filter((r) => r.unit === "unreadable").map((r) => [r.at, r.quantity]),
    [[H0, 1], [H0, 1]], "one marker per pass, not per unreadable record");
});

// ---- whose account a box is on (#818) --------------------------------------------------------------------------

/** One pass over one sandbox mount, as the agent object makes it: the plugin's own report, and whether the mount's
 *  credential is the tenant's now (heldReports' `own`). */
const pass = (host: ReturnType<typeof sqliteHost>, report: unknown, mountOwn: boolean, now: number) =>
  countHeldTime(host.sql, { sandbox: { plugin: "sandbox", report, own: mountOwn } }, base, now);
const keysOf = (host: ReturnType<typeof sqliteHost>) =>
  [...new Set(pendingUsage(host.sql, 0).filter((r) => r.unit === "seconds").map((r) => r.key))].sort();

check("a box made on the operator's account keeps the operator's label after the tenant's own key goes on the mount", () => {
  const host = sqliteHost();
  // The plugin's record of a box created under the seeded operator reference.
  const box = { boxId: "b-ops", createdAt: H0, lastUsedAt: H0, execs: 1, saved: [], credentialRef: "operator" as const };
  const report = (now: number, ended: boolean) => ({
    activity: ended ? activityOf(null) : activityOf(box),
    usage: ended ? usageOf({ ...box, boxId: "", sessions: [sessionOf(box, now)] }) : [],
  });
  pass(host, report(H0 + 60_000, false), false, H0 + 60_000);
  // The key is swapped: the mount's reference is the tenant's from here on. The box is still on our account.
  pass(host, report(H0 + 120_000, false), true, H0 + 120_000);
  pass(host, report(H0 + 180_000, true), true, H0 + 240_000);
  eq(keysOf(host), ["sandbox"], "every second of the operator's box is the operator's, before and after the swap");
  eq(pendingUsage(host.sql, 0).filter((r) => r.unit === "seconds").reduce((a, r) => a + r.quantity, 0), 180, "all of its life, once");
});

check("a box made on the tenant's own key is own:, even if the mount has gone back to the operator's account", () => {
  const host = sqliteHost();
  const box = { boxId: "b-own", createdAt: H0, lastUsedAt: H0, credentialRef: "agent" as const };
  pass(host, { activity: activityOf(box), usage: [] }, true, H0 + 60_000);
  pass(host, { activity: activityOf(box), usage: [] }, false, H0 + 120_000);
  eq(keysOf(host), ["own:sandbox"], "the tenant's box is the tenant's");
});

check("one mount can hold both, and each box is labelled by its own; a box recorded before the field follows the mount", () => {
  const host = sqliteHost();
  const ops = { id: "b-ops", startedAt: H0, endedAt: H0 + 60_000, credentialRef: "operator" };
  const own = { id: "b-own", startedAt: H0, endedAt: H0 + 60_000, credentialRef: "agent" };
  const old = { id: "b-old", startedAt: H0, endedAt: H0 + 60_000 };
  pass(host, { activity: null, usage: [ops, own, old] }, true, H0 + 120_000);
  const by = (key: string) => pendingUsage(host.sql, 0).filter((r) => r.unit === "seconds" && r.key === key).reduce((a, r) => a + r.quantity, 0);
  eq([by("sandbox"), by("own:sandbox")], [60, 120], "the operator's box under sandbox; the tenant's and the unrecorded one under own:");
});

check("the plugin carries the creating credential through every shape it reports a box in", () => {
  const box = { boxId: "b", createdAt: H0, lastUsedAt: H0, credentialRef: "operator" as const };
  eq(activityOf(box).live?.credentialRef, "operator", "a running box");
  eq(activityOf({ ...box, parkedAt: H0 + 1 } as any).live?.credentialRef, "operator", "a switched-off box");
  eq(sessionOf(box, H0 + 1).credentialRef, "operator", "the session its release records");
  eq(usageOf({ ...box, sessions: [sessionOf(box, H0 + 1)] })[0]?.credentialRef, "operator", "and the usage it is counted from");
  eq(boxesOf({ activity: activityOf(box) })[0]?.credentialRef, "operator", "which the counter reads");
  eq("credentialRef" in (activityOf({ ...box, credentialRef: "nonsense" } as any).live ?? {}), false, "a value that is not a kind is not passed on");
});

check("a box made under an environment reference is ours, never the tenant's own, whatever the mount holds now (S7)", () => {
  // An environment reference is the deployment's configuration, so its account is the deployment's: the same
  // label as the operator's reference, "sandbox", and never "own:sandbox", which would price it 0 to the tenant.
  const host = sqliteHost();
  const box = { boxId: "b-env", createdAt: H0, lastUsedAt: H0, credentialRef: "env" as const };
  pass(host, { activity: activityOf(box), usage: [] }, true, H0 + 60_000);
  eq(keysOf(host), ["sandbox"], "an env box under a mount that now holds the tenant's key");
  eq(boxIsOwn({ credentialRef: "env" }, true), false, "the judgement itself");
  // And the mount-level fallback agrees: an env reference on the mount is not the tenant's (`heldReports`).
  eq(heldReports([{ alias: "sandbox", plugin: "sandbox", secretRef: "env:RUN9_KEYS" }], { sandbox: {} }).sandbox?.own, false, "the mount's own mark");
});

check("a set-aside box keeps being counted as held, under the account it was made on, until it is gone (F2)", () => {
  const host = sqliteHost();
  // The agent's new machine is the tenant's; the set-aside box was made on the operator's account.
  const report = (aside: unknown[]) => ({ activity: { live: null, aside }, usage: [] });
  pass(host, report([{ id: "b-old", startedAt: H0, since: H0, credentialRef: "operator" }]), true, H0 + 60_000);
  pass(host, report([{ id: "b-old", startedAt: H0, since: H0, credentialRef: "operator" }]), true, H0 + 120_000);
  eq(keysOf(host), ["sandbox"], "the operator's box, under the operator's key, though the mount is the tenant's now");
  eq(pendingUsage(host.sql, 0).filter((r) => r.unit === "seconds").reduce((a, r) => a + r.quantity, 0), 120, "every second, once");
});

// ---- one box id, several sessions: the idle lease switches a box off and a command wakes it ------------------

check("a woken box is one id with several sessions, and the report keeps each one", () => {
  const report = {
    // Running again since H0+20m; switched off once before, at H0+10m.
    activity: { live: { id: "b1", startedAt: H0 + 20 * 60_000 } },
    usage: [{ id: "b1", startedAt: H0, endedAt: H0 + 10 * 60_000, uses: 2 }],
  };
  eq(boxesOf(report).map((b) => [b.startedAt, b.endedAt]), [[H0 + 20 * 60_000, null], [H0, H0 + 10 * 60_000]],
    "the running session and the finished one, not one box");
  // Switched off: the record still names the box under the start of the session that just ended.
  const parked = { activity: { live: { id: "b1", startedAt: H0 + 20 * 60_000 } }, usage: [{ id: "b1", startedAt: H0 + 20 * 60_000, endedAt: H0 + 30 * 60_000 }, ...report.usage] };
  eq(boxesOf(parked).map((b) => [b.startedAt, b.endedAt]), [[H0 + 20 * 60_000, H0 + 30 * 60_000], [H0, H0 + 10 * 60_000]],
    "a switched-off box is its finished sessions, and is not running");
});

check("sessions are counted in time order whatever order the mount lists them in", () => {
  const s1 = { id: "b1", startedAt: H0, endedAt: H0 + 60_000, uses: 2 };
  const s2 = { id: "b1", startedAt: H0 + 120_000, endedAt: H0 + 180_000, uses: 3 };
  for (const order of [[s1, s2], [s2, s1]]) {
    const got = heldRows(base, "sandbox", order, new Map(), H0 + 600_000);
    eq(secs(got.rows), [[0, 60], [0, 60]], "both sessions, and not the gap");
    eq(got.rows.filter((r) => r.unit === "execs").map((r) => r.quantity), [2, 3], "each session's uses");
    eq(got.marks, [{ id: "b1", mark: { through: H0 + 180_000, uses: 3 } }], "one watermark, at the newest session");
    const again = heldRows(base, "sandbox", order, marks({ b1: got.marks[0]!.mark }), H0 + 900_000);
    eq(again.rows, [], "and a second pass adds nothing");
  }
});

check("a watermark the box-at-a-time meter left behind is read without counting anything twice", () => {
  // That meter kept only a box's oldest session, so its watermark sits at that session's end with its uses.
  const s1 = { id: "b1", startedAt: H0, endedAt: H0 + 60_000, uses: 2 };
  const s2 = { id: "b1", startedAt: H0 + 120_000, endedAt: H0 + 180_000, uses: 3 };
  const live = { id: "b1", startedAt: H0 + 240_000, endedAt: null };
  const got = heldRows(base, "sandbox", [live, s2, s1], marks({ b1: { through: H0 + 60_000, uses: 2 } }), H0 + 300_000);
  eq(secs(got.rows), [[0, 60], [0, 60]], "the sessions it missed, and none of the one it counted");
  eq(got.rows.filter((r) => r.unit === "execs").map((r) => r.quantity), [3], "and only the missed session's uses");
});

check("a session that starts at the instant the watermark stands is a new one, with all of its uses", () => {
  // The previous session was counted to its end, and the box woke in that same millisecond.
  const s2 = { id: "b1", startedAt: H0 + 60_000, endedAt: H0 + 120_000, uses: 3 };
  const got = heldRows(base, "sandbox", [s2], marks({ b1: { through: H0 + 60_000, uses: 2 } }), H0 + 300_000);
  eq(secs(got.rows), [[0, 60]], "all of its time");
  eq(got.rows.filter((r) => r.unit === "execs").map((r) => r.quantity), [3], "and its own uses, not less the last session's");
});

check("against a real table: one box under two payer keys in one pass is still counted once", () => {
  const host = sqliteHost();
  // A session recorded before the credential was, beside the running one that records it: two keys, one box.
  const report = { activity: { live: { id: "b1", startedAt: H0 + 120_000, credentialRef: "operator" } }, usage: [{ id: "b1", startedAt: H0, endedAt: H0 + 60_000 }] };
  pass(host, report, true, H0 + 180_000);
  pass(host, report, true, H0 + 240_000);
  eq(pendingUsage(host.sql, 0).filter((r) => r.unit === "seconds").reduce((a, r) => a + r.quantity, 0), 60 + 120, "each session once");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
