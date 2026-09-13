#!/usr/bin/env node
// A ratchet, not a gate on zero: the tree carries type errors that predate the
// check, so the rule is "no new ones". Each error is reduced to a signature
// without a line number (file, code, message), so a change that moves lines
// does not trip it and a change that adds an error does.
//
// The baseline is a list of unread findings, not a list of things to ignore:
// its first hour on master, one entry (TS2783, a spread overwriting `keys`)
// turned out to be a tool that had never returned what it promised. So
// `--update` means "I have read these and they are understood", never "let
// it through", and the count is the length of a debt, not a health figure.
// An entry that stops occurring is reported so the debt can shrink.
//
// Two programs, each with its own baseline. One program carried both
// runtimes' globals, and whichever type package loaded second decided what
// `Buffer` or `WebSocket` meant for all of it — `src/store/artifacts.ts`'s
// TS2554 was that, not the code. A signature is only meaningful against the
// program that produced it, so each program is compared with its own file,
// and a signature one program stops reporting can never read as NEW in the
// other. src/** is compiled by both (the worker imports it) and may appear in
// both baselines; that is the same code judged under two sets of globals.
//
//   npm run typecheck                        both programs
//   npm run typecheck -- --update            rewrite both baselines
//   npm run typecheck -- --update worker     rewrite one
//
// The last line is the total, and says ", 0 new" only when every program does
// and the boundary below holds: cf/scripts/verify-and-deploy.sh reads nothing
// else.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PROGRAMS = [
  { name: "node", config: "tsconfig.node.json", baseline: "typecheck-baseline.node.txt" },
  { name: "worker", config: "tsconfig.worker.json", baseline: "typecheck-baseline.worker.txt" },
];
const ROOTS = ["src", "test", "bench", "cf/src"];

/**
 * The signatures in the baseline file, with anything after ` #` dropped.
 *
 * An entry can now carry the reason it is still there — some of them are not
 * debts. `test/pi-agent.ts`'s TS2367 is a correct comparison of two literal
 * types, so "fixing" it would weaken a test that is right; that is a decision
 * worth writing beside the line rather than in someone's memory (Rex,
 * 2026-09-12).
 *
 * The comparison stays exact on the signature itself, because a baseline that
 * matched loosely would stop reporting the thing it exists to report. A
 * comment does not survive `--update`, which rewrites the file — and that is
 * the right moment to decide again whether the reason still holds.
 *
 * Exported, and the run below is guarded, so this can be tested: a rule inside
 * a script that only runs from the command line is a rule nothing checks.
 */
export function baselineSignatures(text) {
  return text
    .split("\n")
    .map((l) => l.split(" #")[0].trim())
    .filter(Boolean);
}

/**
 * The reason written beside each signature, by signature.
 *
 * Reasons used to be dropped by `--update`, on the argument that rewriting the
 * file is the moment to decide again whether a reason still holds. The first
 * real `--update` disproved it: an unrelated entry was retired and both reasons
 * went with it, unremarked, while both were still true — one of them cody's
 * diagnosis of a build problem nobody has fixed. Nothing prompted anyone,
 * because a thing that vanishes prompts nobody.
 *
 * So `--update` carries them and says which ones it carried. That keeps the
 * re-reading it was supposed to force — it is now something you see rather than
 * something you were meant to remember — and stops the file losing the only
 * copy of why an entry is not a debt.
 */
export function baselineReasons(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const at = line.indexOf(" #");
    if (at < 0) continue;
    const sig = line.slice(0, at).trim();
    const why = line.slice(at + 2).trim();
    if (sig && why) out.set(sig, why);
  }
  return out;
}

/** tsc's output reduced to sorted, unique signatures: no line, no column. */
export function signatures(output) {
  const sig = (l) => l.replace(/^([^(]+)\(\d+,\d+\): (error TS\d+: .*)$/, "$1: $2");
  return [...new Set(output.split("\n").filter((l) => /error TS\d+/.test(l)).map(sig))].sort();
}

/**
 * One program's signatures against that program's baseline text, and nothing
 * else. It is given one baseline on purpose: the rule that a clearance in one
 * program cannot be a NEW in the other is kept by never letting the two meet.
 */
export function compare(now, baselineText) {
  const base = new Set(baselineSignatures(baselineText));
  return { base, fresh: now.filter((s) => !base.has(s)), gone: [...base].filter((s) => !now.includes(s)) };
}

/**
 * What is wrong with where the files landed, given each program's files and
 * roots (name -> { files, roots }, repo-relative paths; a root is a file the
 * config's `include` names, the rest arrived by import) and every .ts under
 * the checked directories.
 *
 * Splitting one program into two made three new ways to be silently wrong,
 * and a ratchet that reports "0 new" through any of them is lying:
 *  - a file in neither program is checked by nothing, and nothing says so —
 *    the exclude list in one config and the include list in the other only
 *    agree while someone keeps them agreeing;
 *  - a cf/src file in the node program is checked without worker globals,
 *    which is how a test that imports cf/src and was not moved shows up;
 *  - a file both configs name as a root turns one error into two NEWs, and
 *    one fix into two clearances, which is the sign the boundary is wrong.
 * A file one program names and the other only imports is shared code judged
 * under both sets of globals, and belongs in both: all of src/** that cf/src
 * reaches, and the few bench/ and test/ helpers cf/src imports itself.
 * It also catches tsc not running at all, or its --explainFiles text changing
 * shape: a program with no roots puts every file in "neither", where an empty
 * error list would have read as clean.
 */
export function boundary(programs, sources) {
  const problems = [];
  const names = Object.keys(programs);
  for (const n of names) {
    if (!programs[n].roots.size) problems.push(`${n}: no root files, so tsc did not run or --explainFiles changed shape`);
  }
  for (const f of sources) {
    const where = names.filter((n) => programs[n].files.has(f));
    const rootOf = names.filter((n) => programs[n].roots.has(f));
    if (!where.length) problems.push(`${f}: in neither program, so nothing checks it`);
    else if (f.startsWith("cf/src/") && programs.node?.files.has(f)) {
      problems.push(`${f}: in the node program, without worker globals; whatever imports it belongs in tsconfig.worker.json`);
    } else if (rootOf.length > 1) {
      problems.push(`${f}: a root of ${rootOf.join(" and ")}, so one error in it would count twice`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) !== process.argv[1]) {
  // Imported, not run: the caller wants the helpers above and not a type check.
} else {
const results = PROGRAMS.map((p) => {
  // --explainFiles rather than --listFiles because it says why each file is
  // there: a repo-relative path at column 0, then indented reasons, and a root
  // is one whose reason is the config's include. Error lines carry "error TS"
  // and their continuations are indented, so neither reads as a file.
  // The explanation runs past spawnSync's default 1 MB buffer, which cut it off
  // mid-list the first time this ran; the boundary check below is what said so.
  const out = spawnSync("npx", ["tsc", "-p", p.config, "--pretty", "false", "--explainFiles"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.error) {
    // A truncated or missing output still parses, into fewer errors than there
    // are; so a failure to run is a failure, and the line says nothing of "new".
    console.log(`typecheck: tsc -p ${p.config} did not complete (${out.error.code ?? out.error.message}), not compared`);
    process.exit(1);
  }
  const text = (out.stdout ?? "") + (out.stderr ?? "");
  const files = new Set(), roots = new Set();
  let current = null;
  for (const l of text.split("\n")) {
    if (l && !l.startsWith(" ") && !/error TS\d+/.test(l)) {
      current = l.startsWith("../") || l.startsWith("/") || l.includes("node_modules/") ? null : l;
      if (current) files.add(current);
    } else if (current && /^\s+(Matched by include pattern|Part of 'files' list)/.test(l)) roots.add(current);
  }
  return { ...p, now: signatures(text), files, roots };
});
const sources = ROOTS.flatMap((r) => (existsSync(r) ? readdirSync(r, { recursive: true }).map((f) => `${r}/${f}`) : []))
  .filter((f) => f.endsWith(".ts") && !f.includes("node_modules"));
const problems = boundary(Object.fromEntries(results.map((r) => [r.name, r])), sources);
const broken = () => {
  for (const p of problems) console.log(`  BOUNDARY ${p}`);
  // Deliberately without ", 0 new": the deploy gate greps the last line for
  // it, and a boundary that is wrong means the counts above mean nothing.
  console.log(`typecheck: program boundary broken, ${problems.length} problem(s), not compared`);
  process.exit(1);
};

const at = process.argv.indexOf("--update");
if (at >= 0) {
  // A baseline written from a broken boundary would record the wrong program's
  // errors as understood.
  if (problems.length) broken();
  const named = process.argv.slice(at + 1).filter((a) => !a.startsWith("-"));
  const unknown = named.filter((n) => !PROGRAMS.some((p) => p.name === n));
  if (unknown.length) {
    console.log(`typecheck: no program named ${unknown.join(", ")} (there are ${PROGRAMS.map((p) => p.name).join(", ")})`);
    process.exit(1);
  }
  for (const r of results) {
    if (named.length && !named.includes(r.name)) continue;
    const kept = existsSync(r.baseline) ? baselineReasons(readFileSync(r.baseline, "utf8")) : new Map();
    const carried = r.now.filter((s) => kept.has(s));
    writeFileSync(r.baseline, r.now.map((s) => (kept.has(s) ? `${s} # ${kept.get(s)}` : s)).join("\n") + "\n");
    console.log(`baseline written (${r.name}, ${r.baseline}): ${r.now.length} signatures`);
    // Named, because the point of carrying a reason forward is that somebody
    // sees it again. A reason whose signature is gone is not carried, and that
    // is the one worth noticing: it was explaining something that no longer
    // happens — in this program; the other program's file is its own.
    for (const s of carried) console.log(`  KEPT ${s} # ${kept.get(s)}`);
    for (const [s, why] of kept) if (!r.now.includes(s)) console.log(`  DROPPED ${s} # ${why}`);
  }
  process.exit(0);
}

let total = 0, based = 0, fresh = 0, gone = 0;
for (const r of results) {
  const c = compare(r.now, existsSync(r.baseline) ? readFileSync(r.baseline, "utf8") : "");
  console.log(`typecheck ${r.name}: ${r.now.length} error signature(s), ${c.base.size} in baseline, ${c.fresh.length} new, ${c.gone.length} cleared`);
  for (const s of c.fresh) console.log(`  NEW  ${s}`);
  // Named, not counted. An entry that stops occurring may be carrying a reason
  // someone wrote next to it, and a reason whose signature is gone has to be
  // read again rather than dropped with it — otherwise it outlives the thing it
  // explained (Rex, 2026-09-12). Naming them is also what makes "the cause was
  // diagnosed correctly" checkable: a real fix clears the signature it aimed at,
  // and a wrong one clears something else.
  for (const s of c.gone) console.log(`  GONE ${s}`);
  if (c.gone.length) console.log(`  (${c.gone.length} no longer occur; run with --update ${r.name} once their reasons have been re-read)`);
  total += r.now.length; based += c.base.size; fresh += c.fresh.length; gone += c.gone.length;
}
if (problems.length) broken();
console.log(`typecheck: ${total} error signature(s) in ${results.length} programs, ${based} in baseline, ${fresh} new, ${gone} cleared`);
process.exit(fresh ? 1 : 0);
}
