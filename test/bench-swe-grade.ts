/**
 * SWE-bench grading (bench/swebench/grade.ts), the part both runners share.
 *
 * The grading script is run for real, by bash, in a scratch git repository standing in for /testbed, with a
 * `pytest` on the PATH that reports from the files it finds. That is the only way to check what the script
 * resets: the old one ran `git checkout -- $(git diff --name-only -- '*test*')`, whose pattern crosses `/`,
 * so it threw away an agent's real fix in any source file whose path contains `test` (all of pytest's own
 * source, django's test client). The scratch repository below has such a file. The parsers are checked on logs shaped
 * like each test runner's, and the verdict on more tests than the old 12-per-side cap ran.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  gradeCommand, gradeFromLog, modifiedFiles, parseTestLog, readBoxFile, reinstallCommand, settleShell, testCommand,
  testDirectives, GRADE_LOG, REINSTALL_FAILED, START, END, type GradedInstance,
} from "../bench/swebench/grade.ts";
import { gunzipSync } from "node:zlib";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const TEST_PATCH = [
  "diff --git a/testing/test_python.py b/testing/test_python.py",
  "--- a/testing/test_python.py",
  "+++ b/testing/test_python.py",
  "@@ -1,2 +1,3 @@",
  " def test_old():",
  "     pass",
  "+# the official test",
  "diff --git a/testing/test_new.py b/testing/test_new.py",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/testing/test_new.py",
  "@@ -0,0 +1 @@",
  "+def test_new(): pass",
  "",
].join("\n");

await check("modifiedFiles: what the test patch modifies, not what it creates, and never a hunk line", () => {
  must(show(modifiedFiles(TEST_PATCH)) === show(["testing/test_python.py"]), show(modifiedFiles(TEST_PATCH)));
  const tricky = "diff --git a/t/a.py b/t/a.py\n--- a/t/a.py\n+++ b/t/a.py\n@@ -1 +1 @@\n--- a/not/a/header.py\n+x\n";
  must(show(modifiedFiles(tricky)) === show(["t/a.py"]), `a removed line was read as a header: ${show(modifiedFiles(tricky))}`);
});

await check("testDirectives and testCommand: the repository's own runner, django by module", () => {
  must(show(testDirectives({ repo: "pytest-dev/pytest", test_patch: TEST_PATCH })) === show(["testing/test_python.py", "testing/test_new.py"]), "pytest directives");
  const dj = "diff --git a/tests/admin_views/tests.py b/tests/admin_views/tests.py\ndiff --git a/tests/admin_views/fixture.json b/tests/admin_views/fixture.json\n";
  must(show(testDirectives({ repo: "django/django", test_patch: dj })) === show(["admin_views.tests"]), show(testDirectives({ repo: "django/django", test_patch: dj })));
  must(testCommand("django/django", "3.2").startsWith("./tests/runtests.py"), "django");
  must(testCommand("django/django", "1.9") === "./tests/runtests.py --verbosity 2", "django 1.9");
  must(testCommand("sympy/sympy", "1.12").includes("bin/test -C --verbose"), "sympy");
  must(testCommand("sphinx-doc/sphinx", "7.2").startsWith("tox --current-env"), "sphinx");
  let threw = false;
  try { testCommand("someone/else", "1.0"); } catch { threw = true; }
  must(threw, "an unknown repository got a guessed command");
});

/** A scratch /testbed: a git repository at a base commit, with a fake `pytest` that reports from the files. */
function testbed() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "swe-grade-"));
  const repo = join(dir, "testbed"), bin = join(dir, "bin");
  mkdirSync(join(repo, "src/_pytest"), { recursive: true });
  mkdirSync(join(repo, "testing"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, "src/_pytest/python.py"), "BROKEN\n");
  writeFileSync(join(repo, "testing/test_python.py"), "def test_old():\n    pass\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" }).toString().trim();
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  // F2P passes only when the fix is in place and the official test is there; P2P always passes.
  writeFileSync(join(bin, "pytest"), [
    "#!/bin/sh",
    "if grep -q FIXED src/_pytest/python.py && grep -q 'the official test' testing/test_python.py; then",
    "  echo 'PASSED testing/test_python.py::test_fix'; else echo 'FAILED testing/test_python.py::test_fix - AssertionError'; fi",
    "echo 'PASSED testing/test_python.py::test_old'",
    "[ -f testing/test_new.py ] && echo 'PASSED testing/test_new.py::test_new'",
    "exit 0",
  ].join("\n"));
  chmodSync(join(bin, "pytest"), 0o755);
  return { dir, repo, bin, base, git };
}

await check("the grading script keeps the agent's fix and resets only the files the test patch modifies", () => {
  const tb = testbed();
  try {
    // The agent fixed the source and also edited the test file the official patch modifies.
    writeFileSync(join(tb.repo, "src/_pytest/python.py"), "FIXED\n");
    writeFileSync(join(tb.repo, "testing/test_python.py"), "def test_old():\n    pass\n# the agent's own edit\n");
    const inst: GradedInstance = {
      instance_id: "pytest-dev__pytest-1", repo: "pytest-dev/pytest", version: "8.0", base_commit: tb.base,
      test_patch: TEST_PATCH,
      FAIL_TO_PASS: show(["testing/test_python.py::test_fix"]),
      PASS_TO_PASS: show(["testing/test_python.py::test_old", "testing/test_new.py::test_new"]),
    };
    const log = join(tb.dir, "grade.log");
    const cmd = gradeCommand(inst, tb.repo).replaceAll(GRADE_LOG, log);
    const out = execFileSync("bash", ["-c", cmd], { env: { ...process.env, PATH: `${tb.bin}:${process.env.PATH}`, HOME: tb.dir } }).toString();
    must(/log_gz_bytes=\d+/.test(out), `the script printed ${out}`);
    const text = gunzipSync(readFileSync(`${log}.gz`)).toString("utf8");
    must(readFileSync(join(tb.repo, "src/_pytest/python.py"), "utf8") === "FIXED\n", "the agent's fix was reverted");
    const report = gradeFromLog(inst, text);
    must(report.resolved, `not resolved: ${show(report)}\n${text}`);
  } finally { rmSync(tb.dir, { recursive: true, force: true }); }
});

await check("a spec whose install is not editable is reinstalled before the tests; an editable one is not", () => {
  const inst = (repo: string, version: string): GradedInstance => ({
    instance_id: "x", repo, version, base_commit: "b", test_patch: TEST_PATCH, FAIL_TO_PASS: "[]", PASS_TO_PASS: "[]",
  });
  // Every SWE-bench Verified repo@version whose install is not editable (constants/python.py at v4.1.0).
  const reinstalled: Array<[string, string, string]> = [
    ["django/django", "1.11", "python setup.py install"], ["django/django", "2.2", "python setup.py install"],
    ...["1.1", "2.0", "2.3", "2.4", "2.9", "2.26", "2.27"].map((v): [string, string, string] =>
      ["psf/requests", v, "python -m pip install --no-index --no-build-isolation ."]),
  ];
  for (const [repo, version, cmd] of reinstalled) {
    must(reinstallCommand(repo, version) === cmd, `${repo}@${version}: ${reinstallCommand(repo, version)}`);
    const script = gradeCommand(inst(repo, version));
    const at = script.indexOf(`( ${cmd} ) || echo '${REINSTALL_FAILED}'`);
    must(at >= 0 && at < script.indexOf("git apply") && at < script.indexOf("git checkout"),
      `${repo}@${version}: no reinstall before the reset and the tests:\n${script}`);
  }
  for (const [repo, version] of [["django/django", "3.0"], ["django/django", "4.2"], ["sympy/sympy", "1.12"],
    ["astropy/astropy", "5.1"], ["scikit-learn/scikit-learn", "1.3"], ["matplotlib/matplotlib", "3.7"]]) {
    must(reinstallCommand(repo!, version!) === null, `${repo}@${version} is editable and was given ${reinstallCommand(repo!, version!)}`);
    must(!gradeCommand(inst(repo!, version!)).includes("install"), `${repo}@${version}: the script installs`);
  }
  // A reinstall that failed grades nothing rather than grading the image's copy.
  const r = gradeFromLog({ ...inst("django/django", "2.2"), FAIL_TO_PASS: show(["t"]) }, `${REINSTALL_FAILED}\n${START}\n${END}\n`);
  must(!r.resolved && r.error === REINSTALL_FAILED, show(r));
});

await check("the pytest parser, and a verdict over every test, not the first 12 of each side", () => {
  const p2p = Array.from({ length: 30 }, (_, i) => `t.py::test_p${i}`);
  const log = [START, "PASSED t.py::test_f", ...p2p.map((t, i) => (i === 20 ? `FAILED ${t} - boom` : `PASSED ${t}`)), END].join("\n");
  const inst: GradedInstance = {
    instance_id: "x", repo: "pytest-dev/pytest", version: "8.0", base_commit: "b", test_patch: "",
    FAIL_TO_PASS: show(["t.py::test_f"]), PASS_TO_PASS: show(p2p),
  };
  const r = gradeFromLog(inst, log);
  must(!r.resolved && show(r.passToPass.failed) === show(["t.py::test_p20"]) && r.passToPass.passed === 29, show(r));
  // A test the log never mentions failed: silence is not a pass.
  const missing = gradeFromLog({ ...inst, PASS_TO_PASS: show(["t.py::test_gone"]) }, log);
  must(!missing.resolved && missing.passToPass.failed[0] === "t.py::test_gone", show(missing));
  const unapplied = gradeFromLog(inst, ">>>>> Patch Apply Failed\n");
  must(!unapplied.resolved && unapplied.error === ">>>>> Patch Apply Failed", show(unapplied));
});

await check("the django parser: same-line, next-line and failing results", () => {
  const log = [START,
    "test_a (admin_views.tests.T) ... ok",
    "test_b (admin_views.tests.T) ... some output",
    "ok",
    "test_c (admin_views.tests.T) ... FAIL",
    "test_d (admin_views.tests.T) ... skipped 'no db'",
    END].join("\n");
  const m = parseTestLog("django/django", log);
  must(m["test_a (admin_views.tests.T)"] === "PASSED" && m["test_b (admin_views.tests.T)"] === "PASSED"
    && m["test_c (admin_views.tests.T)"] === "FAILED" && m["test_d (admin_views.tests.T)"] === "SKIPPED", show(m));
});

await check("the sympy parser", () => {
  const log = [START, "test_ok ok", "test_bad F", "test_err E", END].join("\n");
  const m = parseTestLog("sympy/sympy", log);
  must(m.test_ok === "PASSED" && m.test_bad === "FAILED" && m.test_err === "ERROR", show(m));
});

await check("settleShell: a backgrounded command is polled to its output; one past the deadline is a timeout", async () => {
  let clock = 0, polls = 0;
  const first = { status: "running", background: { alias: "sandbox", handle: { execId: "e1" } } };
  const done = await settleShell(first, async () => (++polls < 3 ? { done: false } : { done: true, result: { output: "real output" } }),
    { deadlineAt: 100_000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  must(done.status === "succeeded" && done.result.output === "real output" && polls === 3, show(done));
  clock = 0;
  const late = await settleShell(first, async () => ({ done: false }), { deadlineAt: 12_000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  must(late.status === "failed" && late.error?.code === "grading_timeout", show(late));
  const plain = { status: "succeeded", result: { output: "x" } };
  must(await settleShell(plain, async () => { throw new Error("polled a finished call"); }, { deadlineAt: 0 }) === plain, "a finished call was polled");
});

await check("settleShell: a command that ended failed is `failed`, its result kept, polled or not", async () => {
  let clock = 0;
  const opts = { deadlineAt: 100_000, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  const first = { status: "running", background: { alias: "sandbox", handle: { execId: "e1" } } };
  const nonzero = await settleShell(first, async () => ({ done: true, result: { state: "failed", exitCode: 2, output: "boom" } }), opts);
  must(nonzero.status === "failed" && nonzero.error?.code === "command_failed" && nonzero.result?.output === "boom"
    && /exit code 2/.test(nonzero.error.message ?? ""), show(nonzero));
  const killed = await settleShell(first, async () => ({ done: true, result: { state: "killed", exitCode: null } }), opts);
  must(killed.status === "failed" && killed.error?.code === "command_failed", show(killed));
  const direct = await settleShell({ status: "succeeded", result: { state: "succeeded", exitCode: 1 } }, async () => ({ done: false }), opts);
  must(direct.status === "failed" && direct.error?.code === "command_failed", show(direct));
  const ok = await settleShell(first, async () => ({ done: true, result: { state: "succeeded", exitCode: 0, output: "fine" } }), opts);
  must(ok.status === "succeeded" && ok.result.output === "fine", show(ok));
});

await check("settleShell: a poll that throws is retried with backoff; one that keeps throwing ends the wait", async () => {
  let clock = 0, polls = 0;
  const waits: number[] = [];
  const opts = { deadlineAt: 1_000_000, intervalMs: 1_000, now: () => clock, sleep: async (ms: number) => { waits.push(ms); clock += ms; } };
  const first = { status: "running", background: { alias: "sandbox", handle: { execId: "e1" } } };
  const flaky = await settleShell(first, async () => {
    if (++polls <= 2) throw new Error("fetch failed");
    return { done: true, result: { state: "succeeded", exitCode: 0, output: "real output" } };
  }, opts);
  must(flaky.status === "succeeded" && flaky.result.output === "real output" && polls === 3, show(flaky));
  must(show(waits) === show([1_000, 2_000, 4_000]), `the waits were ${show(waits)}, not backing off`);
  // The retries are counted in a row: errors spread between good polls never add up to giving up.
  const script = ["throw", "throw", "wait", "throw", "throw", "wait", "throw", "throw", "done"];
  polls = 0;
  const spread = await settleShell(first, async () => {
    const step = script[polls++];
    if (step === "throw") throw new Error("fetch failed");
    return step === "done" ? { done: true, result: { state: "succeeded", exitCode: 0, output: "late" } } : { done: false };
  }, opts);
  must(spread.status === "succeeded" && spread.result.output === "late", `${show(spread)} after ${polls} polls`);
  polls = 0;
  const down = await settleShell(first, async () => { polls++; throw new Error("fetch failed"); }, opts);
  must(down.status === "failed" && down.error?.code === "poll_failed" && polls === 4 && /fetch failed/.test(down.error.message ?? ""),
    `${show(down)} after ${polls} polls`);
});

await check("readBoxFile reads a file whole in pieces, and a piece that comes back short fails the read", async () => {
  const file = Buffer.from(Array.from({ length: 30_000 }, (_, i) => i % 251));
  const serve = (cut: boolean) => async (cmd: string) => {
    if (cmd.startsWith("wc -c")) return `${file.length}\n`;
    const m = /tail -c \+(\d+) .* head -c (\d+)/.exec(cmd)!;
    const piece = file.subarray(Number(m[1]) - 1, Number(m[1]) - 1 + Number(m[2]));
    return (cut ? piece.subarray(0, 100) : piece).toString("base64");
  };
  must((await readBoxFile(serve(false), "/f", 12_000)).equals(file), "the file came back different");
  let threw = false;
  try { await readBoxFile(serve(true), "/f", 12_000); } catch { threw = true; }
  must(threw, "a cut piece was accepted");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passedN = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passedN} passed, ${results.length - passedN} failed\n`);
process.exit(results.length > 0 && passedN === results.length ? 0 : 1);
