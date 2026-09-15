/**
 * The event stream waits for the object's change notices, with a timeout only as a fallback (task #17).
 */
import { watchChanges } from "../cf/src/agents-api/watch.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

function fakeSocket() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    addEventListener(type: string, l: () => void) { (listeners[type] ??= []).push(l); },
    emit(type: string) { for (const l of listeners[type] ?? []) l(); },
  };
}
/** A timer that never fires unless told to, so a test can tell "woken by a change" from "timed out". */
function manualTimer() {
  const pending: Array<() => void> = [];
  return { timer: (_ms: number) => new Promise<void>((r) => pending.push(r)), fire: () => pending.splice(0).forEach((r) => r()) };
}

await check("a change wakes the wait at once, without the fallback timer", async () => {
  const s = fakeSocket(); const t = manualTimer();
  const w = watchChanges(s as any, t.timer);
  const waiting = w.next(60_000);
  setTimeout(() => s.emit("message"), 5);
  assert((await waiting) === "changed", "the wait did not end on the change");
});

await check("a change that arrived during a read is not lost: the next wait returns at once", async () => {
  const s = fakeSocket(); const t = manualTimer();
  const w = watchChanges(s as any, t.timer);
  s.emit("message");
  s.emit("message");
  assert((await w.next(60_000)) === "changed", "a change before the wait was lost");
  const second = w.next(60_000);
  let settled = false;
  second.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert(!settled, "two notices before one read were counted as two changes to wait for");
  t.fire();
  assert((await second) === "timeout", "without a new change the wait should fall back to the timer");
});

await check("with no change the fallback timer ends the wait; a closed socket reports closed", async () => {
  const s = fakeSocket(); const t = manualTimer();
  const w = watchChanges(s as any, t.timer);
  const waiting = w.next(1000);
  t.fire();
  assert((await waiting) === "timeout", "the fallback did not end the wait");
  s.emit("close");
  assert(w.closed, "a closed socket still reads open");
  const after = w.next(1000);
  t.fire();
  assert((await after) === "closed", "a wait on a closed socket did not say so");
});

await check("closing the watch hangs up the socket", async () => {
  let hungUp = 0;
  const s = { ...fakeSocket(), close() { hungUp++; } };
  const w = watchChanges(s as any, manualTimer().timer);
  w.close(); w.close();
  assert(hungUp === 1 && w.closed, `close called ${hungUp} times, closed=${w.closed}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
