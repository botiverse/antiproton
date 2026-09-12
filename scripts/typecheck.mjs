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
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASELINE = "typecheck-baseline.txt";

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
if (process.argv[1] && fileURLToPath(import.meta.url) !== process.argv[1]) {
  // Imported, not run: the caller wants the helpers above and not a type check.
} else {
const out = spawnSync("npx", ["tsc", "-p", "tsconfig.json", "--pretty", "false"], { encoding: "utf8" });
const text = (out.stdout ?? "") + (out.stderr ?? "");
const sig = (l) => l.replace(/^([^(]+)\(\d+,\d+\): (error TS\d+: .*)$/, "$1: $2");
const now = [...new Set(text.split("\n").filter((l) => /error TS\d+/.test(l)).map(sig))].sort();
if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, now.join("\n") + "\n");
  console.log(`baseline written: ${now.length} signatures`);
  process.exit(0);
}
const base = new Set(existsSync(BASELINE) ? baselineSignatures(readFileSync(BASELINE, "utf8")) : []);
const fresh = now.filter((s) => !base.has(s));
const gone = [...base].filter((s) => !now.includes(s));
console.log(`typecheck: ${now.length} error signature(s), ${base.size} in baseline, ${fresh.length} new, ${gone.length} cleared`);
for (const s of fresh) console.log(`  NEW  ${s}`);
// Named, not counted. An entry that stops occurring may be carrying a reason
// someone wrote next to it, and a reason whose signature is gone has to be
// read again rather than dropped with it — otherwise it outlives the thing it
// explained (Rex, 2026-09-12). Naming them is also what makes "the cause was
// diagnosed correctly" checkable: a real fix clears the signature it aimed at,
// and a wrong one clears something else.
for (const s of gone) console.log(`  GONE ${s}`);
if (gone.length) console.log(`  (${gone.length} no longer occur; run with --update once their reasons have been re-read)`);
process.exit(fresh.length ? 1 : 0);
}
