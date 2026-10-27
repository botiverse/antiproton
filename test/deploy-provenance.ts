/**
 * The deploy gate deploys the tree its suites ran on, or nothing.
 *
 * On 2026-10-27 a `git pull` in the shared checkout moved HEAD while
 * `verify-and-deploy.sh` was running the suites, and both the provenance line
 * and `deploy.sh` read HEAD afterwards: a commit no suite had run on shipped,
 * stamped as verified. Asked here of the real gate script in a repository built
 * for the purpose, with a suite that moves or dirties the checkout while it
 * runs, the Durable Object suites and the typecheck stubbed, and `deploy.sh`
 * replaced by one that only writes down what it was asked to deploy. No
 * network: origin is a bare repository beside it, and the commit production
 * runs is stated (ANTIPROTON_LIVE_BUILD).
 *
 * Then `deploy.sh` itself, which is handed the gated commit and refuses a HEAD
 * that is not it, with `npx` stubbed so nothing reaches wrangler.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const here = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "deploy-provenance-"));
let n = 0;
const gitIn = (repo: string) => (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();

/** A repository holding the real gate scripts and stubs for everything slow or live; pushed to a bare origin. */
function fixture() {
  const base = join(scratch, `f${++n}`), repo = join(base, "repo"), origin = join(base, "origin.git");
  mkdirSync(join(repo, "cf/scripts"), { recursive: true });
  mkdirSync(join(repo, "test"));
  for (const f of ["verify-and-deploy.sh", "deploy-guard.sh", "suite-verdict.sh"]) {
    copyFileSync(join(here, "cf/scripts", f), join(repo, "cf/scripts", f));
  }
  // The deploy, replaced: it writes down the commit it was handed, its arguments and a value from the secrets file.
  writeFileSync(join(repo, "cf/scripts/deploy.sh"),
    'printf "%s|%s|%s\\n" "${ANTIPROTON_DEPLOY_COMMIT:-unset}" "$*" "${FIXTURE_SECRET:-unset}" > "$DEPLOY_LOG"\n');
  // Every DO suite the gate names, as a suite that passes.
  const gate = readFileSync(join(here, "cf/scripts/verify-and-deploy.sh"), "utf8");
  const doSuites = [...gate.matchAll(/^run_suite \S+ bash (test\/\S+\.sh)$/gm)].map((m) => m[1]);
  if (doSuites.length === 0) throw new Error("found no DO suites in verify-and-deploy.sh; the fixture would not match the gate");
  for (const s of doSuites) writeFileSync(join(repo, s), 'echo "1 passed, 0 failed"\n');
  // The one node suite: does what MID says to the checkout while the gate is running, then passes.
  writeFileSync(join(repo, "test/mid.ts"), [
    'import { execFileSync } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const mid = process.env.MID ?? "";',
    'if (mid === "commit") { writeFileSync("moved.txt", "pulled\\n"); execFileSync("git", ["add", "moved.txt"]); execFileSync("git", ["commit", "-qm", "pulled"]); }',
    'if (mid === "untracked") writeFileSync("stray-untracked.txt", "x\\n");',
    'if (mid === "tracked") writeFileSync("a.txt", "changed\\n");',
    'if (process.env.RAN) writeFileSync(process.env.RAN, "ran\\n");',
    'console.log("1 passed, 0 failed");',
  ].join("\n") + "\n");
  writeFileSync(join(repo, "package.json"),
    JSON.stringify({ type: "module", scripts: { typecheck: "echo 'typecheck: 0 errors, 0 new'" } }) + "\n");
  writeFileSync(join(repo, "a.txt"), "one\n");
  const git = gitIn(repo);
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  git("add", "-A"); git("commit", "-qm", "one");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "master");
  const env = join(base, "antiproton.env");
  writeFileSync(env, "FIXTURE_SECRET=from-the-env-file\n");
  return { base, repo, git, env, log: join(base, "deploy.log"), ran: join(base, "ran"), sha: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}

function gate(f: ReturnType<typeof fixture>, mid: string) {
  const r = spawnSync("bash", [join(f.repo, "cf/scripts/verify-and-deploy.sh")], {
    encoding: "utf8", timeout: 120_000,
    // HOME is the fixture's, so a gate that ignored ANTIPROTON_ENV_FILE would fail to read ~/.secrets rather than read the real one.
    env: { ...process.env, HOME: f.base, MID: mid, RAN: f.ran, DEPLOY_LOG: f.log, ANTIPROTON_ENV_FILE: f.env, ANTIPROTON_LIVE_BUILD: f.sha },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * The next step a refusal names. Never a cleaning command: the ignored files in
 * a checkout include credentials (.dev.vars, .secrets), and `git clean -x`
 * deletes them.
 */
function safeAdvice(out: string) {
  if (!out.includes("cf/scripts/deploy-pinned.sh")) throw new Error(`the refusal does not name deploy-pinned.sh:\n${out}`);
  if (/git clean|clean -[a-z]*x|-fdx|\s-x\b/.test(out)) throw new Error(`the refusal suggests a cleaning that deletes ignored credential files:\n${out}`);
}

check("a checkout left alone deploys, and deploy.sh is handed the commit the suites ran on", () => {
  const f = fixture();
  const r = gate(f, "");
  if (r.status !== 0) throw new Error(`the control run failed (${r.status}):\n${r.out}`);
  if (!existsSync(f.log)) throw new Error(`deploy.sh was never called:\n${r.out}`);
  const [commit, , secret] = readFileSync(f.log, "utf8").trim().split("|");
  if (commit !== f.sha) throw new Error(`deploy.sh was handed ${commit}, not the gated ${f.sha}`);
  if (secret !== "from-the-env-file") throw new Error(`the secrets were not read from ANTIPROTON_ENV_FILE: ${secret}`);
  const lines = r.out.split("\n").filter((l) => l.startsWith(`gate: ${f.sha} (tree ${f.tree}) at `));
  if (lines.length < 2) throw new Error(`the provenance line was printed ${lines.length} time(s), not first and last:\n${r.out}`);
  // Each with the time it was read, so the log shows the two readings bracket the deploy.
  const at = lines.map((l) => /at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)$/.exec(l)?.[1]);
  if (at.some((t) => !t) || at[0]! > at[at.length - 1]!) throw new Error(`the provenance lines carry no ordered UTC time: ${JSON.stringify(lines)}`);
  if (r.out.indexOf(lines[lines.length - 1]) > r.out.indexOf("--- all green; deploying ---")) throw new Error("the last provenance line comes after the deploy started");
});

check("HEAD moved during the suites: refused, naming both commits and trees, and nothing deployed", () => {
  const f = fixture();
  const r = gate(f, "commit");
  const moved = f.git("rev-parse", "HEAD"), movedTree = f.git("rev-parse", "HEAD^{tree}");
  if (moved === f.sha) throw new Error("the fixture's suite did not move HEAD; nothing was tested");
  if (r.status === 0) throw new Error(`the gate exited 0:\n${r.out}`);
  if (existsSync(f.log)) throw new Error(`deploy.sh was called: ${readFileSync(f.log, "utf8")}`);
  const want = `refusing to deploy: the suites ran on ${f.sha} (tree ${f.tree}) but HEAD is now ${moved} (tree ${movedTree})`;
  if (!r.out.includes(want)) throw new Error(`the refusal does not name both:\n${r.out}`);
  safeAdvice(r.out);
});

check("an untracked file appeared during the suites, HEAD unchanged: refused, naming the file, and nothing deployed", () => {
  // The suite loop is a glob, and an untracked file can be imported into the
  // bundle: the tree that ran is then one git never stored, whatever HEAD says.
  const f = fixture();
  const r = gate(f, "untracked");
  if (f.git("rev-parse", "HEAD") !== f.sha) throw new Error("HEAD moved; this case is about the working tree alone");
  if (r.status === 0) throw new Error(`the gate exited 0:\n${r.out}`);
  if (existsSync(f.log)) throw new Error(`deploy.sh was called: ${readFileSync(f.log, "utf8")}`);
  if (!r.out.includes("refusing to deploy") || !r.out.includes("someone modified this checkout during the gate")) {
    throw new Error(`no refusal for the modified checkout:\n${r.out}`);
  }
  if (!/^\s+\?\? stray-untracked\.txt$/m.test(r.out)) throw new Error(`the refusal does not name the file:\n${r.out}`);
  safeAdvice(r.out);
});

check("a tracked file changed during the suites, HEAD unchanged: refused, and nothing deployed", () => {
  const f = fixture();
  const r = gate(f, "tracked");
  if (r.status === 0) throw new Error(`the gate exited 0:\n${r.out}`);
  if (existsSync(f.log)) throw new Error(`deploy.sh was called: ${readFileSync(f.log, "utf8")}`);
  if (!/^\s+M a\.txt$/m.test(r.out)) throw new Error(`the refusal does not name the file:\n${r.out}`);
});

check("a checkout already dirty is refused before any suite runs", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "left-behind.txt"), "x\n");
  const r = gate(f, "");
  if (r.status === 0) throw new Error(`the gate exited 0:\n${r.out}`);
  if (existsSync(f.ran)) throw new Error("a suite ran on a tree no commit names");
  if (existsSync(f.log)) throw new Error("deploy.sh was called");
  if (!/^\s+\?\? left-behind\.txt$/m.test(r.out)) throw new Error(`the refusal does not name the file:\n${r.out}`);
  safeAdvice(r.out);
});

check("the listing of a dirty tree stops at 20 paths and counts the rest", () => {
  // On purpose: thousands of stray files would bury the refusal they explain.
  const f = fixture();
  for (let i = 1; i <= 21; i++) writeFileSync(join(f.repo, `stray-${String(i).padStart(2, "0")}.txt`), "x\n");
  const out = execFileSync("bash", ["-c", `. "$1/cf/scripts/suite-verdict.sh"; cd "$2"; gate_dirty_files`, "t", here, f.repo], { encoding: "utf8" });
  const paths = out.split("\n").filter((l) => /^\s+\?\? stray-\d\d\.txt$/.test(l));
  if (paths.length !== 20) throw new Error(`listed ${paths.length} paths, not 20:\n${out}`);
  if (!/^\s+and 1 more$/m.test(out)) throw new Error(`no "and 1 more":\n${out}`);
  if (out.includes("stray-21.txt")) throw new Error(`the 21st path was listed:\n${out}`);
});

/** A repository holding the real deploy.sh and suite-verdict.sh, with `npx` stubbed to write down its arguments. */
function deployFixture() {
  const base = join(scratch, `d${++n}`), repo = join(base, "repo"), bin = join(base, "bin");
  mkdirSync(join(repo, "cf/scripts"), { recursive: true }); mkdirSync(bin);
  for (const f of ["deploy.sh", "suite-verdict.sh"]) copyFileSync(join(here, "cf/scripts", f), join(repo, "cf/scripts", f));
  const log = join(base, "npx.log");
  writeFileSync(join(bin, "npx"), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(log)}\n`);
  chmodSync(join(bin, "npx"), 0o755);
  const git = gitIn(repo);
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  git("add", "-A"); git("commit", "-qm", "one");
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "b.txt"), "two\n"); git("add", "-A"); git("commit", "-qm", "two");
  const run = (pinned?: string) => {
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete env.ANTIPROTON_DEPLOY_COMMIT;
    if (pinned) env.ANTIPROTON_DEPLOY_COMMIT = pinned;
    const r = spawnSync("bash", [join(repo, "cf/scripts/deploy.sh")], { encoding: "utf8", env, timeout: 30_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, npx: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };
  return { repo, git, first, head: git("rev-parse", "HEAD"), run };
}

check("deploy.sh stamps the commit it is handed, and refuses one that is not HEAD", () => {
  const d = deployFixture();
  const wrong = d.run(d.first);
  if (wrong.status === 0 || wrong.npx) throw new Error(`a pinned commit that is not HEAD reached wrangler (${wrong.status}): ${wrong.npx}`);
  if (!wrong.out.includes(`asked to deploy ${d.first} but HEAD is ${d.head}`)) throw new Error(`the refusal does not name both:\n${wrong.out}`);
  const right = d.run(d.head);
  if (right.status !== 0) throw new Error(`the gated commit was refused (${right.status}):\n${right.out}`);
  if (!right.npx.includes(`wrangler deploy --var GIT_COMMIT:${d.head.slice(0, 7)}`)) throw new Error(`wrangler was not given the gated commit: ${right.npx}`);
});

check("deploy.sh refuses an untracked file outside cf/, src/ and test/, and names it", () => {
  // Its check used to cover those three directories only; the gates' covers the repository.
  const d = deployFixture();
  mkdirSync(join(d.repo, "docs")); writeFileSync(join(d.repo, "docs/stray.md"), "x\n");
  const r = d.run();
  if (r.status === 0 || r.npx) throw new Error(`a dirty tree reached wrangler (${r.status}): ${r.npx}`);
  if (!/^\s+\?\? docs\/$/m.test(r.out) && !/^\s+\?\? docs\/stray\.md$/m.test(r.out)) throw new Error(`the refusal does not name the file:\n${r.out}`);
  safeAdvice(r.out);
});

console.log(`\n  Deploy provenance\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
