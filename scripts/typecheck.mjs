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

const BASELINE = "typecheck-baseline.txt";
const out = spawnSync("npx", ["tsc", "-p", "tsconfig.json", "--pretty", "false"], { encoding: "utf8" });
const text = (out.stdout ?? "") + (out.stderr ?? "");
const sig = (l) => l.replace(/^([^(]+)\(\d+,\d+\): (error TS\d+: .*)$/, "$1: $2");
const now = [...new Set(text.split("\n").filter((l) => /error TS\d+/.test(l)).map(sig))].sort();
if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, now.join("\n") + "\n");
  console.log(`baseline written: ${now.length} signatures`);
  process.exit(0);
}
const base = new Set(existsSync(BASELINE) ? readFileSync(BASELINE, "utf8").split("\n").filter(Boolean) : []);
const fresh = now.filter((s) => !base.has(s));
const gone = [...base].filter((s) => !now.includes(s));
console.log(`typecheck: ${now.length} error signature(s), ${base.size} in baseline, ${fresh.length} new, ${gone.length} cleared`);
for (const s of fresh) console.log(`  NEW  ${s}`);
if (gone.length) console.log(`  (${gone.length} baseline entries no longer occur; run with --update to drop them)`);
process.exit(fresh.length ? 1 : 0);
