/**
 * The signal that work has been backgrounded, and why it is not a shape.
 *
 * A tool's result is arbitrary `Json`, so any agreed key can occur in real
 * data: a result that happened to carry `background` would be read as a job
 * that does not exist — rarely, silently, and in a way no test of the happy
 * path would find. `instanceof` cannot be produced by data, which is the whole
 * reason this is a class (Piper, cody, 2026-09-14).
 */
import { Backgrounded, backgrounded } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

check("一个后台信号认得出来,而且带着句柄", () => {
  const b = backgrounded({ boxId: "b1", execId: "e1" }, "still running");
  if (!(b instanceof Backgrounded)) throw new Error("the sentinel is not recognisable");
  if (JSON.stringify(b.handle) !== JSON.stringify({ boxId: "b1", execId: "e1" })) {
    throw new Error(`the handle did not survive: ${JSON.stringify(b.handle)}`);
  }
  if (b.note !== "still running") throw new Error(`the note did not survive: ${b.note}`);
});

check("数据【伪造不出】这个信号 —— 这就是它不是形状的理由", () => {
  // The case the class exists for: a tool returns a perfectly ordinary result
  // that happens to look like the agreed shape. Under a shape check this would
  // be taken for a job; under `instanceof` it cannot be.
  const looksLikeIt: unknown = { handle: { boxId: "b1", execId: "e1" }, note: "still running" };
  if (looksLikeIt instanceof Backgrounded) throw new Error("data was accepted as the signal");

  const alsoLooksLikeIt: unknown = { background: { handle: { boxId: "b1" } } };
  if (alsoLooksLikeIt instanceof Backgrounded) throw new Error("the old shape was accepted as the signal");

  // and JSON cannot round-trip into it either, which is how a result arrives
  // from storage or the wire
  const throughJson: unknown = JSON.parse(JSON.stringify(backgrounded({ boxId: "b1" })));
  if (throughJson instanceof Backgrounded) throw new Error("a JSON copy was accepted as the signal");
});

check("note 可以省", () => {
  const b = backgrounded({ boxId: "b1" });
  if (b.note !== undefined) throw new Error(`an unasked-for note appeared: ${b.note}`);
});

console.log(`\n  Backgrounded: a signal data cannot forge\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
