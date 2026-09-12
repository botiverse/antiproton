/**
 * The idle schedule, as arithmetic.
 *
 * The interesting properties are the ones that cost money if they are wrong:
 * a box in use is never taken, `quiet` moves reminders but not the ceiling,
 * and the reminders thin out rather than repeating at a fixed price.
 */
import { idleDecision, nudgeDueAt, nudgeText } from "../src/runtime/idle-lease.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const T = 10 * 60_000;          // first reminder after ten minutes idle
const MAX = 4 * 3600_000;       // ceiling: four hours
const base = { lastUsedAt: 1_000_000, sent: 0, afterMs: T, maxMs: MAX };

check("a box in use is left alone, and the wake is when the first reminder is due", () => {
  const d = idleDecision({ ...base, now: base.lastUsedAt + 60_000 });
  if (d.do !== "wait") throw new Error(`expected wait, got ${d.do}`);
  must(d.wakeInMs === T - 60_000, `wake should be the remainder of T, got ${d.wakeInMs}`);
});

check("the first reminder is due at T, the second at 3T, the third at 7T", () => {
  must(nudgeDueAt(0, T, 1) === T && nudgeDueAt(0, T, 2) === 3 * T && nudgeDueAt(0, T, 3) === 7 * T,
    "the gaps between reminders must double: T, 2T, 4T");
  const first = idleDecision({ ...base, now: base.lastUsedAt + T });
  if (first.do !== "nudge") throw new Error(`expected the first reminder, got ${JSON.stringify(first)}`);
  must(first.nth === 1 && first.wakeInMs === 2 * T, `first reminder, then 2T: ${JSON.stringify(first)}`);
  const second = idleDecision({ ...base, sent: 1, now: base.lastUsedAt + 3 * T });
  if (second.do !== "nudge") throw new Error(`expected the second reminder, got ${JSON.stringify(second)}`);
  must(second.nth === 2 && second.wakeInMs === 4 * T, `second reminder, then 4T: ${JSON.stringify(second)}`);
});

check("quiet defers the reminder and nothing else", () => {
  const quietUntil = base.lastUsedAt + 90 * 60_000;
  const d = idleDecision({ ...base, quietUntil, now: base.lastUsedAt + T });
  if (d.do !== "wait") throw new Error(`a deferred box must not be reminded, got ${d.do}`);
  must(d.wakeInMs === quietUntil - (base.lastUsedAt + T), "the wake follows the deferral");
  // And the reminder that was deferred is still the FIRST one: quiet does not
  // spend the agent's reminders, it moves them.
  const after = idleDecision({ ...base, quietUntil, now: quietUntil });
  if (after.do !== "nudge") throw new Error(`expected a reminder after quiet, got ${JSON.stringify(after)}`);
  must(after.nth === 1, `quiet moves reminders rather than spending them, got ${after.nth}`);
});

check("quiet cannot defer the ceiling: past it the box is taken however long the agent asked for", () => {
  const d = idleDecision({ ...base, quietUntil: base.lastUsedAt + 10 * MAX, sent: 3, now: base.lastUsedAt + MAX });
  if (d.do !== "release") throw new Error(`the ceiling must not be deferrable, got ${JSON.stringify(d)}`);
  must(d.idleMs === MAX, "the release says how long it had been idle");
  // One millisecond before it, the box is still the agent's.
  const before = idleDecision({ ...base, quietUntil: base.lastUsedAt + 10 * MAX, sent: 3, now: base.lastUsedAt + MAX - 1 });
  must(before.do === "wait", `just under the ceiling is not a release, got ${before.do}`);
});

check("a wake never lands past the ceiling, so the last thing that happens is the release", () => {
  const d = idleDecision({ ...base, sent: 8, now: base.lastUsedAt + MAX - 1000 });
  if (d.do !== "wait") throw new Error(`expected wait, got ${JSON.stringify(d)}`);
  must(d.wakeInMs === 1000, `the wake must stop at the ceiling, got ${d.wakeInMs}`);
});

check("using the box resets everything: the clock is the last use, not the first", () => {
  const used = base.lastUsedAt + 5 * T;              // the agent came back
  const d = idleDecision({ ...base, lastUsedAt: used, sent: 0, now: used + 60_000 });
  if (d.do !== "wait") throw new Error(`expected wait, got ${JSON.stringify(d)}`);
  must(d.wakeInMs === T - 60_000, `a used box starts again, got ${d.wakeInMs}`);
});

check("the reminder carries the names it was given, not names it built", () => {
  // The caller reads these from the list the model was offered. Here they are
  // deliberately NOT `alias__tool`: a collision takes a numeric suffix, and a
  // reminder that rebuilt the string would name another mount's tool.
  const t = nudgeText("node", { release: "node__release2", quiet: "node__quiet2" }, 12 * 60_000, 30 * 60_000);
  must(t.includes("`node__release2`") && t.includes("`node__quiet2`"), `the given names must be the ones printed: ${t}`);
  must(!/node__release`/.test(t), "it must not print a name it derived itself");
  must(/12 minutes/.test(t) && /30 minutes/.test(t), `both durations must be stated: ${t}`);
  must(/not saved goes with it/.test(t), "it must say what is lost");
});

check("a mount that offers no release tool still gets a reminder that is true", () => {
  const t = nudgeText("node", { release: null, quiet: null }, 5 * 60_000, 10 * 60_000);
  must(!/Call `/.test(t), `nothing to call, so it must not say to call anything: ${t}`);
  must(/released in 10 minutes/.test(t), "the consequence still holds");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
