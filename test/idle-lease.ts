/**
 * The release schedule, as arithmetic.
 *
 * The properties that cost money or trust if they are wrong: a box in use is
 * never taken, the agent is told once before its box goes, `quiet` postpones
 * the release itself, and a postponed agent is not bothered
 * again until its new release time is near.
 */
import { heldDecision, idleDecision, releaseAt, scheduleOf, spanText, warningText } from "../src/runtime/idle-lease.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const MIN = 60_000;
const MAX = 30 * MIN;          // released after thirty idle minutes
const WARN = 5 * MIN;          // told five minutes before
const base = { lastUsedAt: 1_000_000, warnedFor: 0, warnMs: WARN, maxMs: MAX };
const ceiling = base.lastUsedAt + MAX;

check("a box in use is left alone, and the wake is when the warning is due", () => {
  const d = idleDecision({ ...base, now: base.lastUsedAt + MIN });
  if (d.do !== "wait") throw new Error(`expected wait, got ${d.do}`);
  must(d.wakeInMs === MAX - WARN - MIN, `wake should be the warning time, got ${d.wakeInMs}`);
});

check("five minutes before the release the agent is told once, and the object wakes at once to run that turn", () => {
  const d = idleDecision({ ...base, now: ceiling - WARN });
  if (d.do !== "warn") throw new Error(`expected a warning, got ${JSON.stringify(d)}`);
  must(d.releaseAt === ceiling && d.untilReleaseMs === WARN, `warning: ${JSON.stringify(d)}`);
  // Posting the warning only marks the session; the object must wake now for the agent to read it while it can
  // still postpone. A wake at the release time is how a production reminder sat unread for twenty minutes.
  must(d.wakeInMs === 0, `the warning's turn must run now, but the wake is in ${d.wakeInMs} ms`);
  // One millisecond earlier there is nothing to say.
  must(idleDecision({ ...base, now: ceiling - WARN - 1 }).do === "wait", "a warning came early");
});

check("an agent already told about this release time is not told again before it", () => {
  const d = idleDecision({ ...base, warnedFor: ceiling, now: ceiling - MIN });
  if (d.do !== "wait") throw new Error(`a second warning for the same release time, got ${JSON.stringify(d)}`);
  must(d.wakeInMs === MIN, `the wake is the release time, got ${d.wakeInMs}`);
});

check("at the release time the box is taken", () => {
  const d = idleDecision({ ...base, warnedFor: ceiling, now: ceiling });
  if (d.do !== "release") throw new Error(`expected release, got ${JSON.stringify(d)}`);
  must(d.idleMs === MAX, "the release says how long it had been idle");
  // Even an agent never warned (the warning was not sent) loses the box at its release time.
  must(idleDecision({ ...base, now: ceiling + 1 }).do === "release", "an unwarned box outlived its release time");
});

check("quiet postpones the release itself, and the agent is left alone until just before the new time", () => {
  const postponedUntil = ceiling - WARN + 20 * MIN;       // at the warning, the agent asked for twenty more minutes
  must(releaseAt({ ...base, postponedUntil }) === postponedUntil, "the postponement did not become the release time");
  const atOldCeiling = idleDecision({ ...base, warnedFor: ceiling, postponedUntil, now: ceiling });
  if (atOldCeiling.do !== "wait") throw new Error(`the box was taken at the old ceiling: ${JSON.stringify(atOldCeiling)}`);
  must(atOldCeiling.wakeInMs === postponedUntil - WARN - ceiling, `no warning before the new time's warning, got ${atOldCeiling.wakeInMs}`);
  const warned = idleDecision({ ...base, warnedFor: ceiling, postponedUntil, now: postponedUntil - WARN });
  if (warned.do !== "warn") throw new Error(`the new release time earned no warning: ${JSON.stringify(warned)}`);
  must(warned.releaseAt === postponedUntil, `warned about the wrong time: ${JSON.stringify(warned)}`);
  must(idleDecision({ ...base, warnedFor: postponedUntil, postponedUntil, now: postponedUntil }).do === "release",
    "the postponed box was not taken when its own time came");
});

check("a postponement that ends before the release time changes nothing", () => {
  const d = idleDecision({ ...base, postponedUntil: base.lastUsedAt + 10 * MIN, now: ceiling });
  must(d.do === "release", `a shorter postponement kept the box: ${JSON.stringify(d)}`);
});

check("using the box starts everything again: the clock is the last use, and a new warning is owed", () => {
  const used = ceiling - MIN;                                // came back a minute before the release
  const d = idleDecision({ ...base, lastUsedAt: used, warnedFor: ceiling, now: used + MIN });
  if (d.do !== "wait") throw new Error(`expected wait, got ${JSON.stringify(d)}`);
  must(d.wakeInMs === MAX - WARN - MIN, `a used box starts again, got ${d.wakeInMs}`);
  must(idleDecision({ ...base, lastUsedAt: used, warnedFor: ceiling, now: used + MAX - WARN }).do === "warn",
    "the new release time earned no warning");
});

check("with no warning configured the box is simply released at its time", () => {
  const quiet = { ...base, warnMs: 0 };
  const before = idleDecision({ ...quiet, now: ceiling - MIN });
  if (before.do !== "wait") throw new Error(`a warning was sent with warnings off: ${JSON.stringify(before)}`);
  must(before.wakeInMs === MIN, `the wake is the release time, got ${before.wakeInMs}`);
  must(idleDecision({ ...quiet, now: ceiling }).do === "release", "not released at its time");
});

check("the warning carries the names it was given, the time left, and the postponement limit", () => {
  // Deliberately NOT `alias__tool`: a collision takes a numeric suffix, and a warning that rebuilt the
  // string would name another mount's tool.
  const t = warningText("node", { release: "node__release2", postpone: "node__quiet2" },
    "billed for every second it exists, not per call", 25 * MIN, 5 * MIN, 60);
  must(t.includes("`node__release2`") && t.includes("`node__quiet2`"), `the given names must be the ones printed: ${t}`);
  must(!/node__release`/.test(t), "it must not print a name it derived itself");
  must(/idle for 25 minutes/.test(t) && /released in 5 minutes/.test(t), `both durations must be stated: ${t}`);
  must(/at most 60/.test(t), `the postponement limit must be stated: ${t}`);
  must(/not be told again/.test(t), `it must say the agent will be left alone: ${t}`);
  must(/billed for every second it exists/.test(t), `the plugin's own sentence about the cost must be in it: ${t}`);
  must(t.startsWith("[a notice from the harness, not a message from the user]"), `it must say whose message it is: ${t.slice(0, 80)}`);
});

check("the warning says nothing about containers", () => {
  // The schedule is the framework's and the noun is the plugin's (tygg, 2026-09-22). This is the assertion
  // that keeps it that way: a mount holding a seat, an index or a lease is warned in this same sentence, and
  // the only description of what is held is the plugin's `billing`.
  const t = warningText("node", { release: "node__release", postpone: null }, "billed per hour of the seat",
    25 * MIN, 5 * MIN, null);
  must(!/container|box|sandbox|machine|files/i.test(t), `the framework must not name one plugin's thing: ${t}`);
  must(/billed per hour of the seat/.test(t), "the plugin's sentence is what describes it");
});

check("a mount that offers no tools still gets a warning that is true", () => {
  const t = warningText("node", { release: null, postpone: null }, null, 25 * MIN, 5 * MIN, null);
  must(!/call `/.test(t), `nothing to call, so it must not say to call anything: ${t}`);
  must(/released in 5 minutes/.test(t), "the consequence still holds");
  // No `billing`: the sentence has to read as a sentence without it. Both ways of getting that wrong, because
  // the first draft of this case asserted only the dangling dash and stayed green when the clause was made
  // unconditional — the hole reads ` — null.`, which no punctuation check sees.
  must(!/null|undefined/.test(t), `an absent billing sentence must not be printed: ${t}`);
  must(!/— \./.test(t) && !/ \. /.test(t), `a mount with no billing sentence must not leave a dangling separator: ${t}`);
});

check("a held thing's own schedule wins where it reports one, and a broken one falls back", () => {
  const deploy = { warnMs: 5 * MIN, maxMs: MAX };
  const silent = scheduleOf({ warnMs: 0 }, deploy);
  must(silent.warnMs === 0 && silent.maxMs === MAX, `warnMs 0 must mean no warning at the deployment's limit: ${JSON.stringify(silent)}`);
  const own = scheduleOf({ maxMs: 7 * 24 * 60 * MIN, warnMs: 24 * 60 * MIN }, deploy);
  must(own.maxMs === 7 * 24 * 60 * MIN && own.warnMs === 24 * 60 * MIN, `its own numbers: ${JSON.stringify(own)}`);
  const none = scheduleOf(undefined, deploy);
  must(none.maxMs === MAX && none.warnMs === 5 * MIN, "no lease is the deployment's schedule");
  // NaN or a zero ceiling would make every pass a release; it is not a schedule.
  const broken = scheduleOf({ maxMs: Number.NaN, warnMs: -1 }, deploy);
  must(broken.maxMs === MAX && broken.warnMs === 5 * MIN, `a broken lease must fall back: ${JSON.stringify(broken)}`);
  must(scheduleOf({ maxMs: 0 }, deploy).maxMs === MAX, "a zero ceiling must fall back");
  // A silent schedule is silent through the decision, too: no warning, then the release at the limit.
  const quiet = idleDecision({ lastUsedAt: base.lastUsedAt, warnedFor: 0, now: ceiling - MIN, ...silent });
  must(quiet.do === "wait", `warnMs 0 still warned: ${JSON.stringify(quiet)}`);
});

check("the decision for a held thing uses the schedule it reports", () => {
  const deploy = { warnMs: WARN, maxMs: MAX };
  const at = { warnedFor: 0, now: ceiling - MIN };
  must(heldDecision({ lastUsedAt: base.lastUsedAt }, at, deploy).do === "warn", "no lease: the deployment's warning");
  must(heldDecision({ lastUsedAt: base.lastUsedAt, lease: { warnMs: 0 } }, at, deploy).do === "wait", "warnMs 0: silent");
  must(heldDecision({ lastUsedAt: base.lastUsedAt, lease: { warnMs: 0 } }, { warnedFor: 0, now: ceiling }, deploy).do === "release",
    "silent, and still taken at the deployment's limit");
  const long = { maxMs: 7 * 24 * 60 * MIN, warnMs: 24 * 60 * MIN };
  must(heldDecision({ lastUsedAt: base.lastUsedAt, lease: long }, { warnedFor: 0, now: ceiling }, deploy).do === "wait",
    "its own longer limit holds past the deployment's");
  const d = heldDecision({ lastUsedAt: base.lastUsedAt, lease: long }, { warnedFor: 0, now: base.lastUsedAt + 6 * 24 * 60 * MIN + MIN }, deploy);
  must(d.do === "warn", `warned a day before its own limit: ${JSON.stringify(d)}`);
});

check("durations are said in the unit a person reads them in", () => {
  must(spanText(5 * MIN) === "5 minutes" && spanText(MIN) === "1 minute", `minutes: ${spanText(5 * MIN)}, ${spanText(MIN)}`);
  must(spanText(90 * MIN) === "90 minutes", spanText(90 * MIN));
  must(spanText(24 * 60 * MIN) === "24 hours", spanText(24 * 60 * MIN));
  must(spanText(7 * 24 * 60 * MIN) === "7 days", `a week is not 10080 minutes: ${spanText(7 * 24 * 60 * MIN)}`);
});

check("a held thing's own consequence and advice replace the generic sentence", () => {
  const t = warningText("node", { release: "node__release", postpone: "node__quiet" }, "stopped: only its disk is kept",
    6 * 24 * 60 * MIN, 24 * 60 * MIN, 10080,
    { consequence: "the stopped seat and its notes will be deleted", advice: "Copy the notes out first." });
  must(/idle for 6 days, and the stopped seat and its notes will be deleted in 24 hours/.test(t), `consequence: ${t}`);
  must(!/will be released/.test(t), `the generic sentence stayed: ${t}`);
  must(/Copy the notes out first\. To keep it/.test(t), `advice before the postponement: ${t}`);
  const plain = warningText("node", { release: null, postpone: null }, null, 25 * MIN, 5 * MIN, null, {});
  must(/what it is holding will be released in 5 minutes\./.test(plain), `without one the generic sentence: ${plain}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
