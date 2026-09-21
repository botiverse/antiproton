/**
 * Stable serialisation, so two values compare by content rather than by the
 * order their keys happened to be written in.
 *
 * It lives here because three call sites need the SAME answer and one of them
 * is in the Worker: the object hashes a benchmark database with it
 * (`cf/src/index.ts`) and the two τ² runners compare databases with it. They
 * used to hold three line-for-line copies, and only one carried a note saying
 * the copies had to agree — on the side nobody edits. The copy that had been
 * changed three times did not know it was a copy (@Rex, 2026-09-21).
 *
 * Arrays keep their order here on purpose: a list in the domain is a list, and
 * a database whose rows moved is a different database. Where order is NOT part
 * of the claim — a write action's arguments — the τ² grader uses its own
 * serialiser (`bench/tau2/grade.ts`) and says why there.
 */
export function canonJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonJson).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonJson((v as any)[k])}`).join(",")}}`;
}
