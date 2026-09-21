/**
 * Stable serialisation, so two values compare by content rather than by the
 * order their keys happened to be written in.
 *
 * TWO call sites MUST agree, and they are not in the same process.
 * `bench/tau2/cf.ts` hashes the database it expects and compares that hash to
 * the `dbHash` the Worker computed with its own copy (`cf/src/index.ts`):
 * `dbMatch` is an equality between two serialisations made by two
 * implementations on two machines. Every published τ² reading has
 * rested on that agreement, with nothing checking it.
 *
 * A THIRD call site uses it for a different reason. `bench/tau2/run.ts`
 * computes both sides itself, so it only needs to agree with ITSELF — but two
 * runners whose scores are compared have to grade alike, and that half had
 * already drifted (see `bench/tau2/grade.ts`). Saying "three must agree" would
 * flatten those two reasons into one, and flattening is how the note this
 * replaces came to name the wrong pair.
 *
 * There were three line-for-line copies. One carried a note saying the copies
 * had to agree, and it named the wrong pair — `bench/tau2/run.ts`, which never
 * talks to the Worker — so the one sentence written to prevent this pointed
 * away from the place it mattered.
 *
 * WHY ONLY THIS FUNCTION LIVES HERE. The file is compiled by BOTH typecheck
 * programs — `tsconfig.node.json` reaches it through `src/**`, and the worker
 * program reaches it through `cf/src/index.ts`'s import (measured with
 * `npx tsc -p tsconfig.<node|worker>.json --listFiles | grep canon-json`: one
 * hit each). So it may use nothing that exists in only one of the two
 * runtimes, and it uses nothing at all beyond `JSON.stringify` and
 * `Object.keys`.
 *
 * That is why the HASH stayed behind on both sides even though
 * `sha256(canonJson(db))` now reads the same in both places: the Worker hashes
 * with `crypto.subtle.digest` (async) and the runner with node's `createHash`
 * (sync). Sharing the whole phrase would require this module to know both
 * runtimes, which it cannot (@Nova, 2026-09-21 — and that change would look
 * exactly like the one this file is). Move the serialiser here; leave the
 * hash where its API lives.
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
