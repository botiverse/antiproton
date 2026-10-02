/**
 * Every Durable Object suite (`test/*-do.sh`) runs in both gates.
 *
 * The gates list those suites by hand, unlike the node suites they discover from
 * `test/*.ts`, so a new one could be written, pass on the branch, and never run
 * again. Three did exactly that (pd-cancel, pd-writes, pd-compaction).
 */
import { readdirSync, readFileSync } from "node:fs";

const scripts = ["cf/scripts/gate.sh", "cf/scripts/verify-and-deploy.sh"];
const suites = readdirSync("test").filter((f) => f.endsWith("-do.sh")).map((f) => f.slice(0, -3));
let failed = 0;
for (const script of scripts) {
  const text = readFileSync(script, "utf8");
  for (const suite of suites) {
    if (!text.includes(`run_suite ${suite} bash test/${suite}.sh`)) {
      console.log(`  ✗ ${script} does not run ${suite}`);
      failed++;
    }
  }
}
if (suites.length === 0) { console.log("  ✗ found no test/*-do.sh at all: the check is looking in the wrong place"); failed++; }
const passed = failed === 0 ? suites.length * scripts.length : 0;
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
