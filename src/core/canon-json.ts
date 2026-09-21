/**
 * Stable serialisation, so two values compare by content rather than by the
 * order their keys happened to be written in.
 *
 * It lives here because three call sites need the SAME answer and one of them
 * is in another process. `bench/tau2/cf.ts` hashes the database it expects and
 * compares that hash to `dbHash`, which the Worker computed with its own copy
 * (`cf/src/index.ts`): `dbMatch` is an equality between two serialisations
 * made by two implementations on two machines. Every published τ² reading has
 * rested on that agreement, with nothing checking it.
 *
 * There were three line-for-line copies. One carried a note saying the copies
 * had to agree, and it named the wrong pair — `bench/tau2/run.ts`, which never
 * talks to the Worker — so the one sentence written to prevent this pointed
 * away from the place it mattered.
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
