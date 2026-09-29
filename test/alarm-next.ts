/**
 * The end of an alarm pass (cf/src/alarm-next.ts): a wake asked for during the pass survives the pass's
 * own decision; with none asked, the pass's own plan (or idle) stands.
 */
import { nextAlarm } from "../cf/src/alarm-next.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const T = 1_790_000_000_000;

check("idle, and nothing asked during the pass: the alarm goes", () => {
  must(nextAlarm(null, null) === null, "an idle pass kept an alarm");
});

check("idle, but a message arrived during the pass: its wake stays (the 2026-09-29 19:06Z stall)", () => {
  must(nextAlarm(T + 2_000, null) === T + 2_000, "the message's wake was deleted");
  // However long the pass ran: a wake asked at its thirtieth second is kept like any other.
  must(nextAlarm(T + 30_000, null) === T + 30_000, "a wake asked late in a long pass was lost");
});

check("the pass has its own time: the earlier of the two", () => {
  must(nextAlarm(T + 2_000, T + 120_000) === T + 2_000, "a later plan replaced the input's wake");
  must(nextAlarm(T + 200_000, T + 120_000) === T + 120_000, "a later ask delayed the plan");
  must(nextAlarm(null, T + 50) === T + 50, "the plan alone");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
