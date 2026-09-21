/**
 * The τ² grader's two serialisers, and the one difference between them.
 *
 * There used to be three line-for-line copies of the stable serialiser — one
 * in the Worker, one in each runner — and a note saying they had to agree that
 * lived only on the copy nobody edits. They had already drifted where it
 * counts: `bench/tau2/cf.ts` compared a write action's arguments as sets,
 * `bench/tau2/run.ts` compared them positionally, so the same trial could
 * score `actionMatch` two ways depending on which runner ran it (@Rex found
 * the duplication, 2026-09-21).
 *
 * These cases pin what each function claims, including the one place they are
 * deliberately different — because a variant whose deviation is not written
 * down is indistinguishable from a copy that drifted.
 */
import { canonJson } from "../src/core/canon-json.ts";
import { canonArgs, actionMatch } from "../bench/tau2/grade.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

check("the same content in a different key order is the same string", () => {
  const a = canonJson({ b: 1, a: { d: 4, c: 3 } });
  const b = canonJson({ a: { c: 3, d: 4 }, b: 1 });
  if (a !== b) throw new Error(`key order changed the serialisation:\n  ${a}\n  ${b}`);
});

check("a list stays a list: array order is part of the value", () => {
  // A database whose rows moved IS a different database, and the object's
  // dbHash rests on that.
  if (canonJson([1, 2, 3]) === canonJson([3, 2, 1])) {
    throw new Error("canonJson sorted an array, so two different databases would hash the same");
  }
});

check("an argument list of primitives is a set", () => {
  // `return_delivered_order_items` over the same three items in a different
  // order is the same action — the database agreed (db=ok) on every trial the
  // positional comparison failed.
  const a = canonArgs({ order_id: "#1", item_ids: ["c", "a", "b"] });
  const b = canonArgs({ order_id: "#1", item_ids: ["a", "b", "c"] });
  if (a !== b) throw new Error(`the same three items in a different order compared unequal:\n  ${a}\n  ${b}`);
});

check("an array of objects still keeps its order", () => {
  // The set rule is narrow on purpose: only primitives.
  const a = canonArgs([{ x: 1 }, { x: 2 }]);
  const b = canonArgs([{ x: 2 }, { x: 1 }]);
  if (a === b) throw new Error("canonArgs sorted an array of objects, which is wider than the rule it states");
});

check("the two serialisers differ ONLY where the deviation is written down", () => {
  // Anything without a primitive array must serialise identically, or the
  // variant has become a second implementation rather than one exception.
  for (const v of [
    null, 3, "s", true, { b: 1, a: 2 }, { a: { d: [{ z: 1 }, { y: 2 }] } },
    [{ x: 1 }, { x: 2 }], { nested: { deep: { k: "v" } } },
  ]) {
    if (canonJson(v) !== canonArgs(v)) {
      throw new Error(`they disagree on a value with no primitive array: ${JSON.stringify(v)}\n  ${canonJson(v)}\n  ${canonArgs(v)}`);
    }
  }
});

check("actionMatch accepts the same action written in a different item order", () => {
  const expected = [{ name: "return_delivered_order_items", args: { order_id: "#1", item_ids: ["a", "b", "c"] } }];
  const performed = [{ name: "return_delivered_order_items", args: { order_id: "#1", item_ids: ["c", "b", "a"] } }];
  if (!actionMatch(expected, performed)) {
    throw new Error("the grader asserted an ordering the task does not require — this is the case that failed three times in one matrix");
  }
});

check("actionMatch still rejects a different argument", () => {
  const expected = [{ name: "return_delivered_order_items", args: { order_id: "#1", item_ids: ["a", "b"] } }];
  if (actionMatch(expected, [{ name: "return_delivered_order_items", args: { order_id: "#1", item_ids: ["a", "z"] } }])) {
    throw new Error("a different item set passed, so the set rule swallowed a real difference");
  }
  if (actionMatch(expected, [{ name: "cancel_pending_order", args: { order_id: "#1", item_ids: ["a", "b"] } }])) {
    throw new Error("a different tool name passed");
  }
  if (actionMatch(expected, [])) throw new Error("an empty performed list passed");
});

console.log(`\n  τ² grading\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
