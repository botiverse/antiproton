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
check("a suite's name and its verdict never touch, whatever it is called", () => {
  // `printf "%-22s"` pads but does not truncate, so a 22-character name filled
  // the field exactly and the verdict was printed against it —
  // `identity-in-the-recordok (5)`. Five suites are that long today, and
  // @Vera's `grep "^<name> "` found none of them while re-running the gate,
  // which nearly became "the gate is missing four suites" (2026-09-20).
  // Asked of the LONGEST name in the repo plus one that is longer than any,
  // so the rule holds for whatever is added next rather than for today's list.
  const names = execFileSync("bash", ["-c", 'for f in test/*.ts; do basename "$f" .ts; done'],
    { encoding: "utf8" }).trim().split("\n");
  const longest = names.reduce((a, b) => (b.length > a.length ? b : a));
  for (const n of [...names, "a-suite-name-far-longer-than-any-field-width"]) {
    const line = sh(`suite_name "$1"; echo "ok (3)"`, "", n);
    if (!new RegExp(`^${n} `).test(line)) {
      throw new Error(`${n} (${n.length} chars) printed as ${JSON.stringify(line)}: nothing can find it by name`);
    }
  }
  // And the padding is still doing its job for the ordinary case.
  const short = sh(`suite_name "$1"; echo "ok (3)"`, "", "auth");
  if (!/^auth {19}ok \(3\)$/.test(short)) throw new Error(`the column stopped aligning: ${JSON.stringify(short)}`);
  if (longest.length < 22) throw new Error("no name is long enough to exercise the boundary any more; keep the synthetic one");
});

check("the gate's output names the tree it measured", () => {
  // The verdicts are facts about one tree and used to name none, so the name
  // had to come from whoever copied them out — from memory, while the branch
  // moved (2026-09-20: two gate results posted for a PR whose head had already
  // advanced). Asked here on a repository built for the purpose, so the test
  // does not depend on the state of the one it runs in.
  const repo = mkdtempSync(join(tmpdir(), "prov-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A"); git("commit", "-qm", "one");
  const sha = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");

  const provenance = () => execFileSync("bash",
    ["-c", `. "$1/cf/scripts/suite-verdict.sh"; cd "$2"; gate_provenance`, "p", process.cwd(), repo],
    { encoding: "utf8" }).trim();

  const clean = provenance();
  if (clean !== `gate: ${sha} (tree ${tree})`) throw new Error(`a clean tree printed ${JSON.stringify(clean)}`);

  // Dirty is the case that most needs saying: what ran is a tree git never
  // stored, so the line must refuse to give it HEAD's name as if it were one.
  writeFileSync(join(repo, "a.txt"), "two\n");
  const dirty = provenance();
  if (!/UNCOMMITTED CHANGES/.test(dirty)) throw new Error(`a dirty tree printed ${JSON.stringify(dirty)}`);
  if (dirty === clean) throw new Error("a dirty tree reported exactly what the clean one did");
  if (new RegExp(`\\(tree ${tree}\\)$`).test(dirty)) {
    throw new Error(`a dirty run claimed to be tree ${tree}, which is a tree it is not`);
  }
});

check("both gates say it, so neither can print numbers with no subject", () => {
  // One of them is the only record of what was verified before a deploy.
  for (const f of ["cf/scripts/gate.sh", "cf/scripts/verify-and-deploy.sh"]) {
    const src = execFileSync("cat", [f], { encoding: "utf8" });
    if (!/^\s*gate_provenance\s*$/m.test(src)) throw new Error(`${f} does not call gate_provenance`);
  }
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
