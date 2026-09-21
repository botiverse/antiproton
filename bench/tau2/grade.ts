/**
 * How τ² decides whether the agent performed the actions the task asked for.
 *
 * Both runners grade with this, and that is the point: they used to hold their
 * own copies and had already drifted. `bench/tau2/cf.ts` compared arguments
 * with the set-aware serialiser below; `bench/tau2/run.ts` still compared them
 * positionally, which is the behaviour the comment below was written to
 * correct. The same trial could therefore score `actionMatch` differently
 * depending on which runner ran it, silently (@Rex found the duplication,
 * 2026-09-21; the drift was in the half he had not opened).
 */
import { canonJson } from "../../src/core/canon-json.ts";

/**
 * How two write actions compare: by name and by arguments, where an array of
 * primitives is a set.
 *
 * `canonJson` keeps array order because a database hash must — a list in the
 * domain is a list. A request's `item_ids` is not: `return_delivered_order_items`
 * over the same three items in a different order is the same action, and the
 * database agreed (db=ok) on every trial the positional comparison failed. The
 * grader was asserting something the task does not require, three times in one
 * matrix. Arrays of objects keep their order; only primitive arrays are sorted.
 */
export const canonArgs = (v: unknown): string => {
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) {
    return `[${[...v].map((x) => JSON.stringify(x)).sort().join(",")}]`;
  }
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonArgs).join(",")}]`;
  return `{${Object.keys(v as object).sort()
    .map((k) => `${JSON.stringify(k)}:${canonArgs((v as any)[k])}`).join(",")}}`;
};

/** Every expected write was performed, by name and by arguments. */
export const actionMatch = (
  expected: Array<{ name: string; args: unknown }>,
  performed: Array<{ name: string; args: unknown }>,
): boolean =>
  expected.every((e) => performed.some((p) => p.name === e.name && canonArgs(p.args) === canonArgs(e.args)));

export { canonJson };
