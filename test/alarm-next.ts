/**
 * The end of an alarm pass (cf/src/alarm-next.ts): a wake input asked for during the pass survives the
 * pass's own decision, and the pass's own watchdog does not.
 */
import { nextAlarm } from "../cf/src/alarm-next.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const T = 1_790_000_000_000;

check("idle, and nothing asked during the pass: the watchdog is taken back", () => {
  must(nextAlarm(T + 30_000, T + 30_000, null) === null, "an idle pass kept its own watchdog");
  must(nextAlarm(T + 30_000, T + 30_400, null) === null, "a watchdog storage rounded was taken for input");
});

check("idle, but a message arrived during the pass: its wake stays (the 2026-09-29 19:06Z stall)", () => {
  must(nextAlarm(T + 30_000, T + 2_000, null) === T + 2_000, "the message's wake was deleted");
});

check("the pass has its own time: the earlier of the two", () => {
  must(nextAlarm(T + 30_000, T + 2_000, T + 120_000) === T + 2_000, "a later plan replaced the input's wake");
  must(nextAlarm(T + 30_000, T + 30_000, T + 120_000) === T + 120_000, "the watchdog outlived the plan");
  must(nextAlarm(T + 30_000, null, T + 50) === T + 50, "a plan with no alarm left");
});

check("a pass that armed no watchdog keeps whatever is there", () => {
  must(nextAlarm(null, T + 5_000, null) === T + 5_000 && nextAlarm(null, null, null) === null, "no watchdog");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
