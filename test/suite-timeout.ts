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
import { execFileSync, spawnSync } from "node:child_process";
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

/** suite_run_bounded on its own: what it returned, what it said, and how long it took. */
function bounded(limit: number, script: string) {
  const out = join(dir, `out-${++n}`);
  const started = Date.now();
  const r = spawnSync("bash", ["-c",
    '. cf/scripts/suite-verdict.sh; status=0; suite_run_bounded "$1" "$2" bash "$3" || status=$?; ' +
    'echo "status=$status timed_out=${SUITE_TIMED_OUT:-0} leftover=${SUITE_LEFTOVER:-0}"', "t", String(limit), out, script],
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
  if (r.said !== "status=0 timed_out=0 leftover=0") throw new Error(`a passing suite read as ${r.said}`);
  if (!r.out.includes("3 passed")) throw new Error(`its output was not kept: ${JSON.stringify(r.out)}`);
  if (r.seconds > 10) throw new Error(`a suite that ends at once took ${r.seconds}s under a 30 s limit`);
});

check("a suite that fails keeps its own status, and a 124 of its own is not a TIMEOUT", () => {
  const r3 = bounded(30, fake("exit 3").script);
  if (r3.said !== "status=3 timed_out=0 leftover=0") throw new Error(`a failing suite read as ${r3.said}`);
  // timeout(1) uses 124 to mean "timed out"; here the verdict is a flag, so a
  // suite's own exit status cannot be mistaken for one.
  const r124 = bounded(30, fake("exit 124").script);
  if (r124.said !== "status=124 timed_out=0 leftover=0") throw new Error(`exit 124 read as ${r124.said}`);
});

check("a suite that passes but leaves a process behind does not leave it to the next run", () => {
  const f = fake('sleep 300 & echo $! >> "$PIDS"\necho "  1 passed, 0 failed"');
  const r = bounded(30, f.script);
  if (r.said !== "status=0 timed_out=0 leftover=0") throw new Error(`read as ${r.said}`);
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
