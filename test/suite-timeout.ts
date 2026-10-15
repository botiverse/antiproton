/**
 * A suite that never ends is refused, and leaves nothing running
 * (cf/scripts/suite-verdict.sh, question 3; #766).
 *
 * Both gates read only an exit status, so a hung suite used to produce no
 * verdict at all: the gate did not end, nothing went red, and the deploy window
 * passed. Asked here of fake suites under a limit of one second: one that
 * sleeps past it, one whose child would hang, one that ignores TERM, one that
 * passes and one that fails. The orphan checks look for the processes the fake
 * suites started, by the pids they wrote down, because a leftover `wrangler
 * dev` holds its port and a later run can read that server's answer.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const dir = mkdtempSync(join(tmpdir(), "suite-timeout-"));
let n = 0;
/** A fake suite: a bash script whose body is `body`; `$PIDS` is a file it writes the pids it starts to. */
function fake(body: string) {
  const id = ++n;
  const script = join(dir, `fake-${id}.sh`), pids = join(dir, `pids-${id}`);
  writeFileSync(script, `PIDS=${JSON.stringify(pids)}\necho $$ >> "$PIDS"\n${body}\n`);
  return { script, pids };
}

/** Alive means running: a zombie has ended and only waits to be reaped. */
function alive(pid: number) {
  try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}
function pidsOf(file: string) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}
function noneLeft(file: string, what: string) {
  const pids = pidsOf(file);
  if (pids.length === 0) throw new Error(`${what}: the fake suite recorded no pids, so nothing was checked`);
  const left = pids.filter(alive);
  if (left.length) {
    // Killed by pid, the ones this test started, so a failing run does not leave them either.
    for (const p of left) try { process.kill(p, "SIGKILL"); } catch { /* gone meanwhile */ }
    throw new Error(`${what}: still running afterwards: ${left.join(", ")}`);
  }
}

/**
 * suite_run_bounded on its own: what it returned, what it said, and how long it
 * took. `prelude` runs first in the same shell (a caller's `set -m`, say).
 */
function bounded(limit: number | string, script: string, prelude = "") {
  const out = join(dir, `out-${++n}`);
  const started = Date.now();
  const r = spawnSync("bash", ["-c",
    `${prelude}\n. cf/scripts/suite-verdict.sh; status=0; suite_run_bounded "$1" "$2" bash "$3" || status=$?; ` +
    'echo "status=$status timed_out=${SUITE_TIMED_OUT:-0} err=${SUITE_ERROR:-}"', "t", String(limit), out, script],
    { encoding: "utf8", timeout: 20_000 });
  const seconds = (Date.now() - started) / 1000;
  return { said: r.stdout.trim(), out: existsSync(out) ? readFileSync(out, "utf8") : "", seconds };
}

check("a suite still running at its limit is a TIMEOUT, and is ended", () => {
  const f = fake("sleep 300");
  const r = bounded(1, f.script);
  if (!/timed_out=1/.test(r.said)) throw new Error(`a suite sleeping past its limit was not timed out: ${r.said}`);
  if (r.seconds > 20) throw new Error(`it took ${r.seconds}s to end a suite with a 1 s limit`);
  noneLeft(f.pids, "the suite");
});

check("what the suite started is ended with it, even if it would outlive it", () => {
  // The shape of a DO suite: a server in the background, a wait in the foreground.
  const f = fake('sleep 300 & echo $! >> "$PIDS"\nwait');
  const r = bounded(1, f.script);
  if (!/timed_out=1/.test(r.said)) throw new Error(`not timed out: ${r.said}`);
  if (pidsOf(f.pids).length < 2) throw new Error("the fake suite did not record its child");
  noneLeft(f.pids, "the suite and its child");
});

check("a grandchild whose parent has already exited is ended too", () => {
  // Re-parented, so no walk from the suite finds it; only its process group
  // still says where it came from. npx -> wrangler -> workerd can leave this.
  const f = fake('( sleep 300 & echo $! >> "$PIDS" )\nsleep 300');
  const r = bounded(1, f.script);
  if (!/timed_out=1/.test(r.said)) throw new Error(`not timed out: ${r.said}`);
  if (pidsOf(f.pids).length < 2) throw new Error("the fake suite did not record its grandchild");
  noneLeft(f.pids, "the suite and its orphaned grandchild");
});

check("a child that moved to a session of its own is ended too", () => {
  // Out of the group, so only the walk of the tree at the limit can find it.
  const f = fake('setsid sleep 300 & echo $! >> "$PIDS"\nwait');
  const r = bounded(1, f.script);
  if (!/timed_out=1/.test(r.said)) throw new Error(`not timed out: ${r.said}`);
  noneLeft(f.pids, "the suite and its detached child");
});

check("a suite that ignores TERM is killed anyway", () => {
  const f = fake('trap "" TERM\nsleep 300 & echo $! >> "$PIDS"\nwait');
  const r = bounded(1, f.script);
  if (!/timed_out=1/.test(r.said)) throw new Error(`not timed out: ${r.said}`);
  noneLeft(f.pids, "a suite ignoring TERM");
});

check("a suite that passes is untouched, and is not made to wait for the limit", () => {
  const f = fake('echo "  3 passed, 0 failed"');
  const r = bounded(30, f.script);
  if (r.said !== "status=0 timed_out=0 err=") throw new Error(`a passing suite read as ${r.said}`);
  if (!r.out.includes("3 passed")) throw new Error(`its output was not kept: ${JSON.stringify(r.out)}`);
  if (r.seconds > 10) throw new Error(`a suite that ends at once took ${r.seconds}s under a 30 s limit`);
});

check("a suite that fails keeps its own status, and a 124 of its own is not a TIMEOUT", () => {
  const r3 = bounded(30, fake("exit 3").script);
  if (r3.said !== "status=3 timed_out=0 err=") throw new Error(`a failing suite read as ${r3.said}`);
  // timeout(1) uses 124 to mean "timed out"; here the verdict is a flag, so a
  // suite's own exit status cannot be mistaken for one.
  const r124 = bounded(30, fake("exit 124").script);
  if (r124.said !== "status=124 timed_out=0 err=") throw new Error(`exit 124 read as ${r124.said}`);
});

check("a suite that passes but leaves a process behind does not leave it to the next run", () => {
  const f = fake('sleep 300 & echo $! >> "$PIDS"\necho "  1 passed, 0 failed"');
  const r = bounded(30, f.script);
  if (r.said !== "status=0 timed_out=0 err=") throw new Error(`read as ${r.said}`);
  noneLeft(f.pids, "a passing suite's leftover");
});

check("the limit: 600 s by default, GATE_SUITE_LIMIT for all, GATE_SUITE_LIMIT_<name> for one", () => {
  const limit = (name: string, env: Record<string, string> = {}) =>
    execFileSync("bash", ["-c", '. cf/scripts/suite-verdict.sh; suite_limit "$1"', "t", name],
      { encoding: "utf8", env: { PATH: process.env.PATH!, ...env } }).trim();
  if (limit("durable-drive-do") !== "600") throw new Error(`default is ${limit("durable-drive-do")}`);
  if (limit("auth", { GATE_SUITE_LIMIT: "90" }) !== "90") throw new Error("GATE_SUITE_LIMIT was not used");
  const env = { GATE_SUITE_LIMIT: "90", GATE_SUITE_LIMIT_durable_drive_do: "1200" };
  if (limit("durable-drive-do", env) !== "1200") throw new Error("a per-suite limit was not used");
  if (limit("pd-tools-do", env) !== "90") throw new Error("a per-suite limit leaked to another suite");
});

/**
 * Each gate's own `run_suite`, cut out of the script and run on a fake suite,
 * so this asks what the gate prints and does rather than what the helper
 * returns. Cut from `run_suite() {` to the first line that is only `}`.
 *
 * The harness never runs under `set -e`, though verify-and-deploy.sh does: under
 * it, a run_suite that merely returned non-zero would stop the harness too, and
 * a refusal the gate no longer makes would still read as one. Without it, the
 * only way the lines after the call go missing is the gate's own `exit`. Those
 * lines are `after run_suite: rc=...`, which reports what it returned, and
 * `WOULD DEPLOY`, which stands for everything the deploy gate does after its
 * suites.
 */
function gateRunSuite(script: string, prelude: string, suite: string, env: Record<string, string> = {}) {
  const lines = readFileSync(script, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("run_suite() {"));
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (start < 0 || end < 0) throw new Error(`${script}: no run_suite() { ... } to test`);
  if (/set -[a-z]*e/.test(prelude)) throw new Error("the harness must not run under set -e: it would supply the refusal itself");
  const fn = lines.slice(start, end + 1).join("\n");
  const r = spawnSync("bash", ["-c",
    `${prelude}\n. cf/scripts/suite-verdict.sh\n${fn}\nrun_suite fake-suite bash "$1"\nrc=$?\n` +
    `echo "after run_suite: rc=$rc fails=\${fails:-} timeouts=\${timeouts:-}"\necho "WOULD DEPLOY"`,
    "gate", suite], { encoding: "utf8", timeout: 20_000, env: { ...process.env, ...env } });
  // An unbound variable or a syntax error also ends a shell with status 1, which would look like a refusal.
  if (r.stderr.trim()) throw new Error(`the harness itself complained: ${JSON.stringify(r.stderr)}`);
  return r;
}
const BRANCH = "set -u; fails=0; timeouts=0";
const DEPLOY = "set -uo pipefail";  // verify-and-deploy.sh's own, minus -e (see above)

check("the branch gate prints TIMEOUT, apart from FAIL, and counts it as a refusal", () => {
  const f = fake('echo "the last line before it hung"\nsleep 300');
  const r = gateRunSuite("cf/scripts/gate.sh", BRANCH, f.script, { GATE_SUITE_LIMIT_fake_suite: "1" });
  if (!/^fake-suite +TIMEOUT \(still running after 1s; killed\)$/m.test(r.stdout)) throw new Error(`no TIMEOUT line: ${JSON.stringify(r.stdout)}`);
  if (/\bFAIL\b/.test(r.stdout)) throw new Error(`a timeout was also called FAIL: ${JSON.stringify(r.stdout)}`);
  if (!r.stdout.includes("the last line before it hung")) throw new Error("the suite's own last lines were not shown");
  // The branch gate goes on to the next suite and refuses at the end, so the
  // line after the call must be there, and must carry the count.
  if (!/^after run_suite: rc=\d+ fails=1 timeouts=1$/m.test(r.stdout)) throw new Error(`not counted as a refusal: ${JSON.stringify(r.stdout)}`);
  noneLeft(f.pids, "the branch gate's timed-out suite");
  // And `fails` is what the exit code is made of.
  if (!/\n\[ "\$fails" -eq 0 \]\n?$/.test(readFileSync("cf/scripts/gate.sh", "utf8"))) {
    throw new Error("gate.sh no longer exits on `[ \"$fails\" -eq 0 ]`: a counted TIMEOUT may not refuse");
  }
});

check("the branch gate's pass and fail are what they were", () => {
  const ok = gateRunSuite("cf/scripts/gate.sh", BRANCH, fake('echo "  4 passed, 0 failed"').script);
  if (!/^fake-suite +ok \(4\)$/m.test(ok.stdout) || !/^after run_suite: rc=\d+ fails=0 timeouts=0$/m.test(ok.stdout)) throw new Error(`a pass read as ${JSON.stringify(ok.stdout)}`);
  const bad = gateRunSuite("cf/scripts/gate.sh", BRANCH, fake('echo "  1 passed, 1 failed"\nexit 1').script);
  if (!/^fake-suite +FAIL$/m.test(bad.stdout) || !/^after run_suite: rc=\d+ fails=1 timeouts=0$/m.test(bad.stdout)) throw new Error(`a fail read as ${JSON.stringify(bad.stdout)}`);
  const empty = gateRunSuite("cf/scripts/gate.sh", BRANCH, fake('echo "  0 passed, 0 failed"').script);
  if (!/FAIL \(asserted nothing\)/.test(empty.stdout) || !/fails=1 timeouts=0$/m.test(empty.stdout)) throw new Error(`an empty suite read as ${JSON.stringify(empty.stdout)}`);
});

/** The deploy gate refused: it exited 1 from inside run_suite, so nothing after the call ran. */
function refused(r: ReturnType<typeof gateRunSuite>, what: string) {
  if (r.status !== 1) throw new Error(`${what}: the deploy gate's status was ${r.status}, not its own exit 1: ${JSON.stringify(r.stdout)}`);
  if (r.stdout.includes("after run_suite")) throw new Error(`${what}: run_suite returned instead of exiting: ${JSON.stringify(r.stdout)}`);
  if (r.stdout.includes("WOULD DEPLOY")) throw new Error(`${what}: the deploy step was reached`);
}

check("the deploy gate refuses a TIMEOUT: it says so, as TIMEOUT alone, and exits before deploying", () => {
  const f = fake("sleep 300");
  const r = gateRunSuite("cf/scripts/verify-and-deploy.sh", DEPLOY, f.script, { GATE_SUITE_LIMIT_fake_suite: "1" });
  if (!/^fake-suite +TIMEOUT \(still running after 1s; killed\)$/m.test(r.stdout)) throw new Error(`no TIMEOUT line: ${JSON.stringify(r.stdout)}`);
  // A TIMEOUT that does not exit falls through to the FAIL of a non-zero
  // status, which refuses too, but under the wrong name.
  if (/\bFAIL\b/.test(r.stdout)) throw new Error(`the TIMEOUT did not refuse by itself; FAIL did: ${JSON.stringify(r.stdout)}`);
  refused(r, "a TIMEOUT");
  noneLeft(f.pids, "the deploy gate's timed-out suite");
});

check("the deploy gate's pass and fail are what they were", () => {
  const ok = gateRunSuite("cf/scripts/verify-and-deploy.sh", DEPLOY, fake('echo "  2 passed, 0 failed"').script);
  if (ok.status !== 0 || !/^fake-suite +ok \(2\)$/m.test(ok.stdout)) throw new Error(`a pass read as ${JSON.stringify(ok.stdout)}`);
  if (!/^after run_suite: rc=0 /m.test(ok.stdout) || !ok.stdout.includes("WOULD DEPLOY")) throw new Error(`a pass did not go on to deploy: ${JSON.stringify(ok.stdout)}`);
  const bad = gateRunSuite("cf/scripts/verify-and-deploy.sh", DEPLOY, fake("exit 1").script);
  if (!/^fake-suite +FAIL$/m.test(bad.stdout)) throw new Error(`a fail read as ${JSON.stringify(bad.stdout)}`);
  refused(bad, "a FAIL");
  const empty = gateRunSuite("cf/scripts/verify-and-deploy.sh", DEPLOY, fake('echo "  0 passed, 0 failed"').script);
  if (!/FAIL \(asserted nothing/.test(empty.stdout)) throw new Error(`an empty suite read as ${JSON.stringify(empty.stdout)}`);
  refused(empty, "an empty suite");
});

check("a limit that is not a whole number of seconds is refused, and the suite is not run unbounded", () => {
  // `sleep abc` fails at once, which used to end the watchdog and leave the
  // suite with no limit at all.
  for (const bad of ["abc", "1.5", "1.5x", "0", "-1", " 5", "", "99999999"]) {
    const f = fake("sleep 300");
    const r = bounded(bad, f.script);
    if (!/^status=[1-9]\d* timed_out=0 err=limit '.*' is not a whole number/.test(r.said)) throw new Error(`limit ${JSON.stringify(bad)} read as ${r.said}`);
    if (pidsOf(f.pids).length) { noneLeft(f.pids, "x"); throw new Error(`limit ${JSON.stringify(bad)}: the suite was run anyway`); }
    if (r.seconds > 10) throw new Error(`limit ${JSON.stringify(bad)} took ${r.seconds}s to refuse`);
  }
  const problem = (env: Record<string, string>) => spawnSync("bash", ["-c", ". cf/scripts/suite-verdict.sh; suite_limits_problem"],
    { encoding: "utf8", env: { PATH: process.env.PATH!, ...env } });
  const bad = problem({ GATE_SUITE_LIMIT: "600", GATE_SUITE_LIMIT_pd_tools_do: "1.5x" });
  if (bad.status === 0 || !bad.stdout.includes("GATE_SUITE_LIMIT_pd_tools_do=1.5x")) throw new Error(`a bad per-suite limit was not named: ${JSON.stringify(bad.stdout)}`);
  if (bad.stdout.includes("GATE_SUITE_LIMIT=600")) throw new Error("a good limit was reported as bad");
  const good = problem({ GATE_SUITE_LIMIT: "600", GATE_SUITE_LIMIT_x: "1200" });
  if (good.status !== 0 || good.stdout) throw new Error(`good limits were refused: ${JSON.stringify(good.stdout)}`);
});

check("the branch gate refuses a bad limit before it runs anything", () => {
  // GATE_BASE names nothing, so if the limit check were gone the gate would
  // stop at the next refusal, with that one's message, rather than run suites.
  const r = spawnSync("bash", ["cf/scripts/gate.sh"], { encoding: "utf8", timeout: 20_000,
    env: { ...process.env, GATE_SUITE_LIMIT: "10m", GATE_BASE: "refs/heads/no-such-base-for-this-test" } });
  if (r.status === 0 || !r.stdout.includes("refusing: GATE_SUITE_LIMIT=10m")) throw new Error(`gate.sh with GATE_SUITE_LIMIT=10m: ${JSON.stringify(r.stdout.slice(-400))}`);
});

check("a watchdog lost while the suite runs ends the suite and is an error, not a pass", () => {
  // The suite's siblings are the watchdog; killing it (or only its sleep) used
  // to leave the suite running with no limit, to be read as passed whenever it
  // ended. The limit here is far beyond the test's own 20 s.
  for (const how of ["kill -KILL -- -$w $w", "kill -KILL $(pgrep -P $w)"]) {
    const f = fake(`sleep 0.5\nfor w in $(pgrep -P $PPID); do [ $w = $$ ] || ${how}; done\nsleep 300 & echo $! >> "$PIDS"\nwait`);
    const r = bounded(600, f.script);
    if (!/^status=[1-9]\d* timed_out=0 err=its time limit was lost/.test(r.said)) throw new Error(`after \`${how}\`: ${JSON.stringify(r.said)}`);
    noneLeft(f.pids, `the suite after \`${how}\``);
  }
});

check("a caller with job control on (set -m) still gets the suite watched", () => {
  // Under `set -m` each background job leads its own group, so setsid forks and
  // returns at once: status 0, no output, and the suite running unwatched.
  const f = fake("sleep 300 & echo $! >> \"$PIDS\"\nwait");
  const r = bounded(1, f.script, "set -m");
  if (!/^status=\d+ timed_out=1 err=$/.test(r.said)) throw new Error(`under set -m a hung suite read as ${JSON.stringify(r.said)}`);
  noneLeft(f.pids, "a hung suite under set -m");
  const ok = bounded(30, fake('sleep 0.5; echo "  3 passed, 0 failed"; exit 0').script, "set -m");
  if (ok.said !== "status=0 timed_out=0 err=" || !ok.out.includes("3 passed")) throw new Error(`under set -m a passing suite read as ${JSON.stringify(ok.said)} ${JSON.stringify(ok.out)}`);
  const bad = bounded(30, fake("sleep 0.5; exit 3").script, "set -m");
  if (bad.said !== "status=3 timed_out=0 err=") throw new Error(`under set -m a failing suite read as ${JSON.stringify(bad.said)}`);
});

check("interrupting the gate (INT, TERM, HUP) ends the suite and its watchdog, with the signal's status", () => {
  // In a session of its own the suite no longer gets the terminal's ^C. The
  // runner is started under `set -m` so it keeps the default handling of INT,
  // which a non-interactive shell otherwise ignores in a background job.
  for (const [sig, want] of [["INT", 130], ["TERM", 143], ["HUP", 129]] as const) {
    // It records its siblings too (the watchdog) and their children (its sleep).
    const f = fake('sleep 300 & echo $! >> "$PIDS"\nsleep 0.3\nfor p in $(pgrep -P $PPID); do echo $p; pgrep -P $p; done >> "$PIDS"\nwait');
    const r = spawnSync("bash", ["-c",
      'set -m; bash -c \'. cf/scripts/suite-verdict.sh; suite_run_bounded 600 /dev/null bash "$1"; echo "returned instead of exiting"\' r "$1" & r=$!\n' +
      `sleep 1.5; kill -${sig} $r; wait $r; echo "rc=$?"`, "t", f.script], { encoding: "utf8", timeout: 20_000 });
    if (!new RegExp(`^rc=${want}$`, "m").test(r.stdout)) throw new Error(`${sig}: ${JSON.stringify(r.stdout)}`);
    // bash reports a job it reaps after a KILL by printing its command — here the watchdog's whole script.
    if (r.stderr.includes("suite_descendants")) throw new Error(`${sig}: the watchdog's script was dumped: ${JSON.stringify(r.stderr.slice(0, 200))}`);
    if (pidsOf(f.pids).length < 4) throw new Error(`${sig}: the fake recorded too few pids to check: ${pidsOf(f.pids).join(",")}`);
    noneLeft(f.pids, `the suite and watchdog after ${sig}`);
  }
});

/**
 * A gate's typecheck lines, cut out from `limit=$(suite_limit typecheck)` to
 * the `case "$tc"` line, run with a fake `npm` first on PATH. The same
 * sentinels as gateRunSuite, for the same reason.
 */
function gateTypecheck(script: string, prelude: string, npm: string, env: Record<string, string> = {}) {
  const lines = readFileSync(script, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("limit=$(suite_limit typecheck)"));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('case "$tc"'));
  if (start < 0 || end < 0) throw new Error(`${script}: no typecheck block to test`);
  const bin = join(dir, `bin-${++n}`);
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash\n${npm}\n`, { mode: 0o755 });
  const r = spawnSync("bash", ["-c",
    `${prelude}\n. cf/scripts/suite-verdict.sh\n${lines.slice(start, end + 1).join("\n")}\n` +
    `echo "after typecheck: fails=\${fails:-} timeouts=\${timeouts:-}"\necho "WOULD DEPLOY"`],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
  if (r.stderr.trim()) throw new Error(`the harness itself complained: ${JSON.stringify(r.stderr)}`);
  return r;
}
const CLEAN = 'echo "typecheck: 9 error signature(s) in 2 programs, 9 in baseline, 0 new, 0 cleared"';

check("the typecheck is under the limit too, in both gates, and refused like a suite", () => {
  const hang = gateTypecheck("cf/scripts/verify-and-deploy.sh", DEPLOY, "sleep 300", { GATE_SUITE_LIMIT_typecheck: "1" });
  if (!/^typecheck: TIMEOUT \(still running after 1s; killed\)$/m.test(hang.stdout)) throw new Error(`deploy gate: ${JSON.stringify(hang.stdout)}`);
  if (hang.status !== 1 || hang.stdout.includes("after typecheck") || hang.stdout.includes("WOULD DEPLOY")) throw new Error(`the deploy gate went on after a typecheck TIMEOUT: ${JSON.stringify(hang.stdout)}`);
  const bad = gateTypecheck("cf/scripts/verify-and-deploy.sh", DEPLOY, CLEAN, { GATE_SUITE_LIMIT_typecheck: "abc" });
  if (!/^typecheck: FAIL \(limit 'abc'/m.test(bad.stdout) || bad.status !== 1 || bad.stdout.includes("WOULD DEPLOY")) throw new Error(`deploy gate, bad limit: ${JSON.stringify(bad.stdout)}`);
  const ok = gateTypecheck("cf/scripts/verify-and-deploy.sh", DEPLOY, CLEAN);
  if (ok.status !== 0 || !ok.stdout.includes("WOULD DEPLOY")) throw new Error(`deploy gate, clean typecheck: ${JSON.stringify(ok.stdout)}`);

  const bhang = gateTypecheck("cf/scripts/gate.sh", BRANCH, "sleep 300", { GATE_SUITE_LIMIT_typecheck: "1" });
  if (!/^typecheck: TIMEOUT \(still running after 1s; killed\)$/m.test(bhang.stdout) || !/^after typecheck: fails=1 timeouts=1$/m.test(bhang.stdout)) throw new Error(`branch gate: ${JSON.stringify(bhang.stdout)}`);
  const bbad = gateTypecheck("cf/scripts/gate.sh", BRANCH, CLEAN, { GATE_SUITE_LIMIT_typecheck: "abc" });
  if (!/^typecheck: FAIL \(limit 'abc'/m.test(bbad.stdout) || !/^after typecheck: fails=1 timeouts=0$/m.test(bbad.stdout)) throw new Error(`branch gate, bad limit: ${JSON.stringify(bbad.stdout)}`);
  const bok = gateTypecheck("cf/scripts/gate.sh", BRANCH, CLEAN);
  if (!/^after typecheck: fails=0 timeouts=0$/m.test(bok.stdout)) throw new Error(`branch gate, clean typecheck: ${JSON.stringify(bok.stdout)}`);
});

check("both gates refuse a bad limit from inside run_suite too", () => {
  const b = gateRunSuite("cf/scripts/gate.sh", BRANCH, fake('echo "  1 passed, 0 failed"').script, { GATE_SUITE_LIMIT_fake_suite: "abc" });
  if (!/^fake-suite +FAIL \(limit 'abc'/m.test(b.stdout) || !/fails=1 timeouts=0$/m.test(b.stdout)) throw new Error(`branch gate: ${JSON.stringify(b.stdout)}`);
  const d = gateRunSuite("cf/scripts/verify-and-deploy.sh", DEPLOY, fake('echo "  1 passed, 0 failed"').script, { GATE_SUITE_LIMIT_fake_suite: "abc" });
  if (!/^fake-suite +FAIL \(limit 'abc'/m.test(d.stdout)) throw new Error(`deploy gate: ${JSON.stringify(d.stdout)}`);
  refused(d, "a bad limit");
});

check("await_answer: one deadline for start and run, and an HTTP error is an answer, not a retry", () => {
  // A server of the test's own: /hang accepts and never answers, /fail is a
  // spec that threw (500), /ok answers. test/local-worker.sh is sourced with
  // PORT set, so it starts nothing.
  const portFile = join(dir, "port");
  const server = spawn(process.execPath, ["-e", `
    const s = require("http").createServer((q, r) => {
      if (q.url === "/fail") { r.statusCode = 500; r.end("the spec threw"); }
      else if (q.url === "/ok") r.end('{"passed":1}');
    });
    s.listen(0, "127.0.0.1", () => require("fs").writeFileSync(${JSON.stringify(portFile)}, String(s.address().port)));
  `], { stdio: "ignore" });
  try {
    for (let i = 0; i < 100 && !existsSync(portFile); i++) execFileSync("sleep", ["0.1"]);
    const port = readFileSync(portFile, "utf8").trim();
    const ask = (path: string, runLimit: number, start: number) => {
      const t = Date.now();
      const r = spawnSync("bash", ["-c", `. test/local-worker.sh; await_answer "$1" "$2" "$3" "$4"; echo "rc=$?"`,
        "t", path, join(dir, "answer"), String(runLimit), String(start)],
        { encoding: "utf8", timeout: 20_000, env: { ...process.env, PORT: port } });
      return { out: r.stdout, seconds: (Date.now() - t) / 1000 };
    };
    // Deadline 1 + 2 = 3 s. Per-try timeouts summed without a deadline would be far longer.
    const hang = ask("/hang", 2, 1);
    if (!/^rc=1$/m.test(hang.out) || hang.seconds > 8) throw new Error(`a hung worker: ${JSON.stringify(hang.out)} after ${hang.seconds}s`);
    // A 500 stops at once although the deadline is 21 s away.
    const fail = ask("/fail", 20, 1);
    if (!/^rc=1$/m.test(fail.out) || !fail.out.includes("HTTP 500") || !fail.out.includes("the spec threw") || fail.seconds > 6) {
      throw new Error(`an HTTP error: ${JSON.stringify(fail.out)} after ${fail.seconds}s`);
    }
    const ok = ask("/ok", 20, 1);
    if (!/^rc=0$/m.test(ok.out) || readFileSync(join(dir, "answer"), "utf8") !== '{"passed":1}') throw new Error(`an answer: ${JSON.stringify(ok.out)}`);
  } finally { server.kill("SIGKILL"); }
});

// Whatever a failing case left, by the pids the fake suites wrote down, so a
// red run (or a sabotaged helper) does not leave sleepers behind.
// The first pid of each is the fake suite itself, which leads its own group, so
// the group is killed too: it holds the children that wrote nothing down.
for (let i = 1; i <= n; i++) {
  const pids = pidsOf(join(dir, `pids-${i}`));
  if (pids[0]) try { process.kill(-pids[0], "SIGKILL"); } catch { /* no such group */ }
  for (const p of pids) if (alive(p)) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
}

console.log(`\n  Suite time limit\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
