/**
 * The object's active time: a union, not a sum, and counted once.
 *
 * The inputs that matter are the ones where the two differ — overlapping and
 * nested spans — and the one where a second pass could count an hour twice.
 */
import { busySpans, countActiveTime, newActiveMs, unionMs, unionMsByHour, HOUR_MS } from "../src/usage/active.ts";
import { pendingUsage } from "../src/usage/outbox.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const eq = (got: unknown, want: unknown, msg: string) =>
  must(JSON.stringify(got) === JSON.stringify(want), `${msg}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
const span = (at: number, ms: number, kind = "alarm") => ({ at, ms, kind });
const H0 = Date.parse("2026-09-18T10:00:00Z");

check("overlapping spans are counted once, which is the whole point", () => {
  // The real case that made this a union: two alarms interleaving at await
  // points. Summed they are 180s inside a 120s window.
  const spans = [span(H0, 120_000), span(H0 + 60_000, 60_000)];
  eq(unionMs(spans), 120_000, "union");
  must(spans.reduce((a, s) => a + s.ms, 0) === 180_000, "and the sum is what it must not report");
});

check("a nested span adds nothing, and a gap is not filled", () => {
  eq(unionMs([span(H0, 100), span(H0 + 20, 30)]), 100, "nested");
  eq(unionMs([span(H0, 100), span(H0 + 500, 100)]), 200, "two apart");
  eq(unionMs([span(H0, 100), span(H0 + 100, 100)]), 200, "touching, counted once each");
});

check("offload spans are not the object being busy", () => {
  const spans = [span(H0, 1000, "alarm"), span(H0, 30_000, "offload_rtt")];
  eq(busySpans(spans).map((s) => s.kind), ["alarm"], "kinds kept");
  eq(unionMs(busySpans(spans)), 1000, "the model call the queue holds is not this object's time");
});

check("a span crossing an hour belongs to both hours, for its part in each", () => {
  const spans = [span(H0 + HOUR_MS - 10_000, 30_000)];
  eq(unionMsByHour(spans), [{ hour: H0, ms: 10_000 }, { hour: H0 + HOUR_MS, ms: 20_000 }], "split at the boundary");
});

check("the hours always add up to the union of the same spans", () => {
  // Any grouping that did not would put time in the ledger that the object
  // never spent, or lose time it did.
  const cases = [
    [span(H0, 120_000), span(H0 + 60_000, 60_000)],
    [span(H0 - 5 * HOUR_MS, 7 * HOUR_MS)],
    [span(H0, 1), span(H0 + HOUR_MS * 3, 2), span(H0 + HOUR_MS * 3 + 1, 5)],
    [span(H0 + HOUR_MS - 1, 2)],
  ];
  for (const spans of cases) {
    const byHour = unionMsByHour(spans).reduce((a, h) => a + h.ms, 0);
    eq(byHour, unionMs(spans), `hours vs union for ${JSON.stringify(spans)}`);
  }
});

check("a second pass over an unchanged hour counts nothing", () => {
  const byHour = [{ hour: H0, ms: 5_000 }];
  const first = newActiveMs(byHour, new Map());
  eq(first, [{ hour: H0, ms: 5_000, total: 5_000 }], "first pass");
  eq(newActiveMs(byHour, new Map([[H0, 5_000]])), [], "second pass, nothing new");
});

check("an hour that grew contributes only the growth", () => {
  eq(newActiveMs([{ hour: H0, ms: 9_000 }], new Map([[H0, 5_000]])),
    [{ hour: H0, ms: 4_000, total: 9_000 }], "the difference, and the new watermark");
});

check("an hour that came back smaller is left alone, never negative", () => {
  // The object's activity table can be cleared (a bench reset, an operator).
  // What is already in the ledger is what was billed; counting cannot undo it.
  eq(newActiveMs([{ hour: H0, ms: 1_000 }], new Map([[H0, 8_000]])), [], "nothing, and no negative row");
});

check("several hours in one pass, each with its own watermark", () => {
  const byHour = [{ hour: H0, ms: 3_000 }, { hour: H0 + HOUR_MS, ms: 7_000 }];
  eq(newActiveMs(byHour, new Map([[H0, 3_000]])),
    [{ hour: H0 + HOUR_MS, ms: 7_000, total: 7_000 }], "the settled hour is skipped, the open one is not");
});

check("nothing measured produces no rows at all", () => {
  eq(unionMsByHour([]), [], "no hours");
  eq(newActiveMs([], new Map()), [], "no rows");
  eq(unionMs([span(H0, 0), span(H0, -5)]), 0, "a zero or negative span covers nothing");
});

check("against a real table: the pass appends one row an hour and never twice", () => {
  const host = sqliteHost();
  host.sql.exec("CREATE TABLE IF NOT EXISTS do_activity(at INTEGER, ms INTEGER, kind TEXT)");
  const add = (at: number, ms: number, kind = "alarm") =>
    host.sql.exec("INSERT INTO do_activity VALUES (?,?,?)", at, ms, kind);
  const now = H0 + 30 * 60_000;
  // Two overlapping spans in this hour, one in the hour before, and an offload
  // span that is not this object's time.
  add(H0 - HOUR_MS + 1000, 2000);
  add(H0, 120_000);
  add(H0 + 60_000, 60_000);
  add(H0, 300_000, "offload_rtt");
  const first = countActiveTime(host.sql, { tenantId: "t", agentId: "a" }, now);
  eq(first, [{ hour: H0 - HOUR_MS, ms: 2000 }, { hour: H0, ms: 120_000 }], "one row per hour, union not sum");
  const rows = pendingUsage(host.sql, 0);
  eq(rows.map((r) => [r.at, r.resource, r.key, r.quantity, r.unit]),
    [[H0 - HOUR_MS, "object.active", "", 2000, "ms"], [H0, "object.active", "", 120_000, "ms"]],
    "the outbox rows carry the hour they measure");

  eq(countActiveTime(host.sql, { tenantId: "t", agentId: "a" }, now), [], "a second pass with nothing new appends nothing");
  must(pendingUsage(host.sql, 0).length === 2, "and no extra row appeared");

  // The hour's union so far is [H0, H0+120s]. A span inside it is already paid
  // for; one past it is new time, and only the new part is appended.
  add(H0 + 30_000, 30_000);
  eq(countActiveTime(host.sql, { tenantId: "t", agentId: "a" }, now), [], "a span inside one already counted adds nothing");
  add(H0 + 10 * 60_000, 60_000);
  eq(countActiveTime(host.sql, { tenantId: "t", agentId: "a" }, now), [{ hour: H0, ms: 60_000 }], "growth only");

  host.sql.exec("DELETE FROM do_activity");
  eq(countActiveTime(host.sql, { tenantId: "t", agentId: "a" }, now), [], "a cleared table takes nothing back");
  must(pendingUsage(host.sql, 0).length === 3, "three rows in total, none of them negative");
});

check("a span that started hours ago and ended now is counted, in every hour it crossed", () => {
  // Rex, reviewing #400: `at` is when the handler STARTED. A two-hour handler
  // that began three hours ago is entirely outside a bound on `at` and entirely
  // inside the time it has to be counted for, so bounding by the start loses
  // all of it and moves no watermark — nothing would reveal the omission.
  const host = sqliteHost();
  host.sql.exec("CREATE TABLE IF NOT EXISTS do_activity(at INTEGER, ms INTEGER, kind TEXT)");
  const h = (n: number) => H0 + n * HOUR_MS;
  const now = h(5) + 10 * 60_000;
  host.sql.exec("INSERT INTO do_activity VALUES (?,?,?)", h(3) + 5_000, 2 * HOUR_MS, "alarm");
  const got = countActiveTime(host.sql, { tenantId: "t", agentId: "a" }, now);
  eq(got, [
    { hour: h(3), ms: HOUR_MS - 5_000 },
    { hour: h(4), ms: HOUR_MS },
    { hour: h(5), ms: 5_000 },
  ], "every hour the span crossed, including the two before the read bound");
  eq(got.reduce((a, r) => a + r.ms, 0), 2 * HOUR_MS, "and the parts are the whole span");

  // The same span on a later pass: the hours it touched are older than the read
  // bound, so their watermarks have to be loaded by the hours the spans reach,
  // not by the bound — otherwise an unloaded watermark reads as zero and the
  // hour is counted again in full.
  eq(countActiveTime(host.sql, { tenantId: "t", agentId: "a" }, now), [], "a second pass counts none of it again");
  const total = pendingUsage(host.sql, 0).reduce((a, r) => a + r.quantity, 0);
  eq(total, 2 * HOUR_MS, "the outbox holds the span once");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
