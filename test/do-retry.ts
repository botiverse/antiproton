/** When a Durable Object call may be tried once more (cf/src/do-retry.ts). */
import { objectMoved } from "../cf/src/do-retry.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

check("Cloudflare's retryable flag, or the object moving, and nothing else", () => {
  must(objectMoved(Object.assign(new Error("x"), { retryable: true })), "retryable");
  must(objectMoved(new Error("cannot access storage because object has moved to a different machine")), "moved");
  must(!objectMoved(new Error("no such hook")), "an ordinary error was retried");
  must(!objectMoved(new Error("expected: object has moved to a different machine")), "a message that only mentions it was retried");
  must(!objectMoved(Object.assign(new Error("x"), { retryable: false })), "retryable false");
  must(!objectMoved(null) && !objectMoved("moved"), "not an error");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
