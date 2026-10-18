/**
 * How τ² decides whether the agent performed the actions the task asked for.
 *
 * Both runners grade with this, and that is the point: they used to hold their
 * own copies and had already drifted. `bench/tau2/cf.ts` compared arguments
 * with the set-aware serialiser below; `bench/tau2/run.ts` still compared them
 * positionally, which is the behaviour the comment below was written to
 * correct. The same trial could therefore score `actionMatch` differently
 * depending on which runner ran it, silently.
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

/**
 * Which expected write had no performed write with the same name *and* arguments — the actual criterion —
 * with both sides shown, for a runner's log. The match is on the arguments, not the names, so a line that
 * printed only names could show `expected [X] performed [X]` next to act=NO and look like the grader is broken.
 */
export function argDiff(expected: Array<{ name: string; args: unknown }>, performed: Array<{ name: string; args: unknown }>): string[] {
  const out: string[] = [];
  for (const e of expected) {
    const same = performed.filter((p) => p.name === e.name);
    if (same.some((p) => canonArgs(p.args) === canonArgs(e.args))) continue;
    out.push(`${e.name} expected ${canonArgs(e.args).slice(0, 160)}`);
    for (const p of same) out.push(`${" ".repeat(e.name.length)} performed ${canonArgs(p.args).slice(0, 160)}`);
    if (!same.length) out.push(`${" ".repeat(e.name.length)} performed (nothing by that name)`);
  }
  return out;
}

export { canonJson };

/**
 * Which rule a record's `reward` follows, written into every record so a series can be split where it changed.
 * Records without the field were scored `dbMatch && actionMatch` on every task (report/runs/README.md).
 */
export const REWARD_RULE = "reward_basis";

/** The components τ² can list in a task's `reward_basis` (tau2 `RewardType`, src/tau2/data_model/tasks.py). */
const COMPONENTS = new Set(["DB", "ENV_ASSERTION", "ACTION", "COMMUNICATE", "NL_ASSERTION"]);

/** τ²'s default when a task lists none: the original τ-bench's pair. */
const DEFAULT_BASIS = ["DB", "COMMUNICATE"];

export interface Graded {
  reward: 0 | 1;
  /** The task's `reward_basis`, as the reward was computed over it. */
  rewardBasis: string[];
  /**
   * Listed components this grader has no judge for, with criteria present, so they could not count either way.
   * Present only when non-empty: a reward that stood on fewer components than τ² would use says which.
   */
  unjudged?: string[];
}

/**
 * The reward τ² gives a task: the AND of the components its `reward_basis` lists, and of no others.
 *
 * Upstream multiplies only the listed components into the reward and runs the rest for diagnostics
 * (tau2-bench `evaluate_simulation`, src/tau2/evaluator/evaluator.py). Every retail task here lists
 * `["DB", "NL_ASSERTION"]` or `["DB"]`, so `actionMatch` does not decide one of them: an agent whose write
 * carried an argument the tool ignores still left the database the task asked for, and τ² passes it.
 * `actionMatch` stays on the row as a diagnostic.
 *
 * A component with nothing to check is satisfied, as upstream's evaluators return 1.0 when their criteria are
 * empty or null ("No nl_assertions to evaluate", evaluator_nl_assertions.py). NL_ASSERTION with assertions
 * needs an LLM judge, and COMMUNICATE and ENV_ASSERTION need the transcript or the environment; this grader
 * has none of those, so such a component is named in `unjudged` rather than passed or failed silently.
 * An unknown component throws, as upstream raises on a basis it did not evaluate.
 */
export function rewardOf(task: any, m: { dbMatch: boolean; actionMatch: boolean }): Graded {
  const ec = task?.evaluation_criteria ?? {};
  const basis: string[] = Array.isArray(ec.reward_basis) ? ec.reward_basis.map(String) : DEFAULT_BASIS;
  const unknown = basis.filter((b) => !COMPONENTS.has(b));
  if (unknown.length) throw new Error(`task ${task?.id}: reward_basis lists ${unknown.join(", ")}, which this grader does not know`);
  const has = (v: unknown) => Array.isArray(v) && v.length > 0;
  let ok = true;
  const unjudged: string[] = [];
  for (const b of basis) {
    if (b === "DB") ok &&= m.dbMatch;
    else if (b === "ACTION") ok &&= m.actionMatch;
    else if (has(ec[{ NL_ASSERTION: "nl_assertions", COMMUNICATE: "communicate_info", ENV_ASSERTION: "env_assertions" }[b]!])) unjudged.push(b);
  }
  return { reward: ok ? 1 : 0, rewardBasis: basis, ...(unjudged.length ? { unjudged } : {}) };
}
