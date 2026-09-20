/**
 * The run order, which is a switch because trial number and position in the run were the same number in
 * every record published before it (bench/tau2/plan.ts).
 */
import { RUN_ORDERS, runOrder, runPlan } from "../bench/tau2/plan.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const shape = (order: Parameters<typeof runPlan>[2]) =>
  runPlan(["a", "b", "c"], 3, order).map((p) => `${p.task}${p.trial}`).join(" ");

await check("the default order is the one every published record used, unchanged", () => {
  // [1xN, 2xN, 3xN]: this is what makes a row's trial and its position the same number, and every record
  // on the manifest has exactly this shape. Changing it by accident would make the new runs incomparable
  // with all of them.
  assert(runOrder(undefined) === "trial-major", `no ORDER given: ${runOrder(undefined)}`);
  assert(shape("trial-major") === "a1 b1 c1 a2 b2 c2 a3 b3 c3", shape("trial-major"));
});

await check("task-major runs a task's trials back to back, which is what breaks the identity", () => {
  // The point of the switch: trial 2 and 3 are no longer always in the run's second half, so "the second
  // attempt" and "later in the run" stop being the same thing.
  assert(shape("task-major") === "a1 a2 a3 b1 b2 b3 c1 c2 c3", shape("task-major"));
  const plan = runPlan(["a", "b", "c"], 3, "task-major");
  const firstHalf = plan.slice(0, Math.floor(plan.length / 2)).filter((p) => p.trial === 3).length;
  assert(firstHalf > 0, "no third trial ran in the first half of the run, so the order changed nothing");
});

await check("both orders run every pair exactly once", () => {
  for (const order of RUN_ORDERS) {
    const plan = runPlan(["a", "b", "c"], 3, order);
    assert(plan.length === 9, `${order}: ${plan.length} pairs`);
    assert(new Set(plan.map((p) => `${p.task}${p.trial}`)).size === 9, `${order}: a pair ran twice or not at all`);
  }
});

await check("an unknown order is refused, not defaulted", () => {
  // A run whose order silently fell back, and whose record then names the old one, cannot be told from a
  // run that was never re-ordered.
  let threw = "";
  try { runOrder("task_major"); } catch (e) { threw = String((e as Error).message); }
  assert(threw.includes("ORDER must be one of"), `a typo was accepted: ${JSON.stringify(threw)}`);
  assert(threw.includes("task_major"), `the message does not say what was given: ${threw}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
