/**
 * The two things the deploy gate asks of a suite besides its exit code: that it
 * asserted something, and that it is still there (cf/scripts/suite-verdict.sh).
 *
 * Asked of the shell functions directly, so a change to either rule goes red
 * here rather than being discovered as a suite that died quietly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const sh = (script: string, input = "", ...args: string[]) =>
  execFileSync("bash", ["-c", `. cf/scripts/suite-verdict.sh; ${script}`, "verdict", ...args],
    { encoding: "utf8", input }).trim();
const count = (output: string) => sh("suite_passed_count", output);

check("an empty run reports zero passes, which the gate refuses", () => {
  if (count("\n  The ledger\n  ────\n  0 passed, 0 failed\n") !== "0") throw new Error("an empty suite did not read as 0");
});

check("both count forms read, coloured or not", () => {
  const forms: Array<[string, string]> = [
    ["  58 passed, 0 failed", "58"],
    ["5/5 passed", "5"],
    ["\x1b[32m  12 passed, 0 failed\x1b[0m", "12"],
  ];
  for (const [out, want] of forms) {
    const got = count(out);
    if (got !== want) throw new Error(`${JSON.stringify(out)} read as ${JSON.stringify(got)}, not ${want}`);
  }
});

check("a count inside a case's text is not the suite's verdict", () => {
  // A suite with no summary line whose case says "3 passed attempts" asserted
  // nothing; an unanchored match read it as three passes (Piper).
  if (count("  \x1b[32m✓\x1b[0m the retry path stops after 3 passed attempts\n") !== "") {
    throw new Error("a case's text was read as a pass count");
  }
});

check("a suite that reports no count reads as nothing, not as a pass", () => {
  if (count("all good\n") !== "") throw new Error("a missing count was read as a number");
});

check("the last count wins, so an earlier summary cannot mask the verdict", () => {
  if (count("  3 passed, 0 failed\n...\n  0 passed, 0 failed\n") !== "0") throw new Error("an earlier count was used");
});

check("a suite production is guarded by and that has gone is refused, by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "suites-"));
  const previous = join(dir, "previous.txt");
  writeFileSync(previous, "alpha\nbeta\n");
  const problems = sh('suite_removals "$@"', "", previous, join(dir, "none.txt"), "the base", "alpha");
  if (!problems.includes("suite removed: beta")) throw new Error(`a removal went unnamed: ${JSON.stringify(problems)}`);
  if (problems.includes("alpha")) throw new Error("a suite still present was reported");
});

check("a removal named in the acknowledged list passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "suites-"));
  const previous = join(dir, "previous.txt");
  const acknowledged = join(dir, "removed.txt");
  writeFileSync(previous, "alpha\nbeta\n");
  writeFileSync(acknowledged, "# why it went\nbeta\n");
  const problems = sh('suite_removals "$@"', "", previous, acknowledged, "the base", "alpha");
  if (problems !== "") throw new Error(`an acknowledged removal was refused: ${problems}`);
});

check("a new suite costs nothing: only disappearance is refused", () => {
  // The loop already runs every test/*.ts, so refusing an unlisted new suite
  // would protect nothing and tax every new file (Piper).
  const dir = mkdtempSync(join(tmpdir(), "suites-"));
  const previous = join(dir, "previous.txt");
  writeFileSync(previous, "alpha\n");
  const problems = sh('suite_removals "$@"', "", previous, join(dir, "none.txt"), "the base", "alpha", "gamma");
  if (problems !== "") throw new Error(`a new suite was refused: ${problems}`);
});

console.log(`\n  Suite verdict\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
