/**
 * SWE-bench Verified, against a real Durable Object.
 *
 * The in-process runner (`run.ts`) drives `PiAgent` over node:sqlite. That is
 * a loop nobody deploys: the object owns the storage and the queue owns the
 * model call, and neither is present in-process. The standing rule for this
 * project is that benchmarks run on the serverless version, so they measure
 * what ships and leave a transcript behind. τ² moved first (`tau2/cf.ts`);
 * this is SWE-bench following it.
 *
 * The agent runs inside the object with a real machine mounted (run9), the
 * model call goes through the production queue, and the transcript stays in
 * the object where the console can read it. Grading is SWE-bench's own —
 * apply the official test patch, run the failing tests, require the passing
 * ones to still pass — executed *by this runner* through the object, in the
 * same container the agent worked in, before the runner hands the container
 * back. The object holds the container open across the agent's finish for
 * exactly that reason, and never offers the agent the tools that would
 * destroy the evidence (withheld.ts). The grading itself is grade.ts: the
 * repository's own test command, every FAIL_TO_PASS and PASS_TO_PASS test.
 *
 * What only this runner can report: how long the object itself was billed,
 * and how much of the wall clock the container existed for.
 *
 *   N=1 node bench/swebench/cf.ts
 *   N=10 OBJ=swe2 node bench/swebench/cf.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { ratesFromEnv, meterLine, type Meter } from "../meter.ts";
import { beginRun, driverCommit, recordRun, teeRun, workerBuild } from "../record.ts";
import { stallAtDeadline, type StallEvidence } from "../poll-fallback.ts";
import { benchEngine, objectsShape, sumActivity, taskObject } from "../objects.ts";
import { SANDBOX_ALIAS } from "../../src/plugins/sandbox.ts";
import { waitForAnswer, type WaitDeps } from "./wait.ts";
import { gradeCommand, gradeFromLog, gradeLogFrom, settleShell, type GradedInstance, type ShellAnswer } from "./grade.ts";

for (const l of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

// The custom hostname sits behind Cloudflare Access, which answers a benchmark
// run with a login redirect. The workers.dev address is the same Worker and the
// same objects without the interactive gate; the endpoints that spend money are
// guarded there by `x-harness-token` instead.
const BASE = process.env.BENCH_BASE ?? "https://antiproton.botiverse.workers.dev";
const TOKEN = process.env.HARNESS_AUTOMATION_TOKEN ?? "";
const N = Number(process.env.N ?? 1);
const OFFSET = Number(process.env.OFFSET ?? 0);
/** Wall clock per instance for the agent phase. pi's harness stops when the
 *  model stops asking for tools, so the guard that matters is time. */
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 900_000);
const TRACE = process.env.TRACE === "1";
/** Each run gets its own object, so one run's meter is never read as another's. */
const OBJ = process.env.OBJ ?? "swe1";
// Which kernel runs the agent, and so whether each instance needs an object of its own (bench/objects.ts).
const ENGINE = benchEngine(process.env.ENGINE);
const OBJECTS = objectsShape(ENGINE, process.env.OBJECTS);
/** The object an instance runs in: the run's own, or the instance's (OBJECTS=per-task, and always on pd). */
const objOf = (taskId: string) => taskObject(OBJ, OBJECTS, taskId);
const withObj = (path: string, obj = OBJ) => path + (path.includes("?") ? "&" : "?") + `obj=${obj}`;

interface Instance extends GradedInstance {
  problem_statement: string; patch: string;
}

async function api(path: string, init: RequestInit = {}, timeoutMs = 120_000, obj = OBJ): Promise<any> {
  const r = await fetch(BASE + withObj(path, obj), {
    ...init,
    headers: { "x-harness-token": TOKEN, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const post = (path: string, body: unknown, timeoutMs?: number, obj = OBJ) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, timeoutMs, obj);

// ------------------------------------------------------------------ instances

const res = await fetch(
  "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified" +
  `&config=default&split=test&offset=${OFFSET}&length=${N}`,
);
// The dataset server rate-limits and answers with an HTML page; a benchmark
// that cannot fetch its instances should say so, not raise a syntax error.
const raw = await res.text();
let rows: any;
try { rows = JSON.parse(raw); }
catch {
  console.error(`\n  could not load SWE-bench instances: HTTP ${res.status}, ` +
    `${raw.slice(0, 120).replace(/\s+/g, " ")}\n  (the dataset server rate-limits; try again shortly)\n`);
  process.exit(1);
}
const instances: Instance[] = rows.rows.map((r: any) => r.row);

/** The image SWE-bench publishes for an instance: repo, dependencies, test
 *  runner, all in place. */
const imageFor = (id: string) =>
  `docker.io/swebench/sweb.eval.x86_64.${id.replace("__", "_1776_")}:latest`;

const POLICY = `
You are fixing a bug in a Python repository checked out at /testbed.
Use the ${SANDBOX_ALIAS} mount's shell tool to explore and edit it — that is a real machine with git, python and the test suite.
Work in small steps: read the failing code first, then make the smallest change that fixes it.
Do not modify test files; the graders supply their own.
When the fix is in place, say so and stop.
`.trim();

// ------------------------------------------------------------ waiting

// The wait itself, and why it ends where it does, is wait.ts.
const seen = new Map<string, number>();
const failed = new Map<string, string>();
const waitDeps: WaitDeps = {
  socketUrl: (taskId, after) => BASE.replace(/^http/, "ws") + withObj(
    `/bench/events?tenantId=bench&agentId=b_${taskId}&after=${after}`, objOf(taskId)),
  // The token goes on the upgrade too: /bench/* is gated (task #15), and a
  // refused upgrade reaches a WebSocket client only as close 1006 with no body,
  // which this runner then scored as a stalled agent.
  headers: { "x-harness-token": TOKEN },
  poll: (taskId) => api(`/bench/poll?taskId=${taskId}`, {}, undefined, objOf(taskId)),
  seen, failed,
};

// ------------------------------------------------------------ one instance

/** How long one grading command may run: SWE-bench's own harness allows 1,800 s per instance. */
const GRADE_DEADLINE_MS = Number(process.env.GRADE_DEADLINE_MS ?? 1_800_000);

/** A shell command in the agent's container, run by the runner, and its finished answer. A command that
 *  outlives the sandbox's grace window comes back `running`; it is polled until it ends (grade.ts
 *  `settleShell`), so grading reads the output and not an empty string. */
const shell = async (taskId: string, command: string): Promise<ShellAnswer> => {
  const deadlineAt = Date.now() + GRADE_DEADLINE_MS;
  const first: ShellAnswer = await post("/bench/swe/shell", { taskId, command }, 360_000, objOf(taskId));
  return settleShell(first, (bg) => post("/bench/swe/job", { taskId, alias: bg.alias, handle: bg.handle }, undefined, objOf(taskId)),
    { deadlineAt });
};
/** The output of a command that must succeed; anything else is the grade's error, not an empty output. */
const shellOut = async (taskId: string, command: string): Promise<string> => {
  const r = await shell(taskId, command);
  if (r.status !== "succeeded") throw new Error(`grading command ${r.status}: ${r.error?.message ?? JSON.stringify(r.error ?? null)}`);
  return String(r.result?.output ?? "");
};

/** What the run record keeps of a grade: both verdicts, the counts, and the first few failing names. */
function gradeRecord(r: ReturnType<typeof gradeFromLog>, diff: string) {
  return {
    resolved: r.resolved, failToPass: r.failToPass.failed.length === 0, passToPass: r.passToPass.failed.length === 0, diff,
    f2p: { total: r.failToPass.total, passed: r.failToPass.passed, failed: r.failToPass.failed.length, firstFailed: r.failToPass.failed.slice(0, 5) },
    p2p: { total: r.passToPass.total, passed: r.passToPass.passed, failed: r.passToPass.failed.length, firstFailed: r.passToPass.failed.slice(0, 5) },
    ...(r.error ? { gradeError: r.error } : {}),
  };
}

async function runOne(inst: Instance) {
  const t0 = Date.now();
  const taskId = `${inst.instance_id.replace(/[^A-Za-z0-9._-]/g, "_")}_${Date.now().toString(36)}`.slice(0, 58);
  const obj = objOf(taskId);
  const started = await post("/bench/swe/start", {
    taskId,
    policy: POLICY,
    image: imageFor(inst.instance_id),
    workdir: "/testbed",
    shape: "2c4g",
    timeoutMs: 300_000,
    // The image's toolchain lives in a conda env that `sh -lc` never enters.
    shell: "/bin/bash",
    shellPrefix: "source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && ",
    offload: true,
    // The object defaults to "none". NETWORK=open reproduces the contaminated
    // condition on purpose, and the record says which one ran.
    ...(process.env.NETWORK ? { network: process.env.NETWORK } : {}),
    // Named only when it is not the default, so a pi085 run sends what it always sent.
    ...(ENGINE === "pi085" ? {} : { engine: ENGINE }),
  }, undefined, obj);
  // What the object says it runs, not what was asked: an older Worker ignores `engine` and answers without one.
  const engine = started?.engine ?? (ENGINE === "pi085" ? "pi085" : null);
  if (engine !== ENGINE) throw new Error(`asked for ${ENGINE}, the object runs ${engine ?? "an engine it did not name"}`);
  const network = String(started?.network ?? "open");
  if (TRACE) console.log(`    started ${JSON.stringify(started)}`);

  // Everything after this point must release the container, whatever happens
  // in between: a box that outlives its run is billed for existing, and this
  // benchmark starts one per instance.
  let grade: any = { failToPass: false, passToPass: false, diff: "" };
  let agentSeconds = 0, answered: string | null = null;
  // Why a turn ran out of time, and what that was read from. This runner used to record the word
  // `agent_stalled` and nothing else: it held the evidence for one call and threw it away, so a stall here
  // could not be told from a lost delivery afterwards (Vera, 2026-09-19).
  let stall: string | undefined, stallWhy: StallEvidence | undefined;
  /** What ending the agent's part stopped: its turn, its jobs, and any job that could not be confirmed stopped. */
  let finish: any;
  try {
    await post("/bench/say", { taskId,
      text: `Fix this issue in the repository at /testbed.\n\n${inst.problem_statement.slice(0, 6000)}` }, undefined, obj);
    answered = await waitForAnswer(taskId, t0 + BUDGET_MS, waitDeps);
    if (answered === null && !failed.has(taskId)) {
      ({ stall, stallWhy } = await stallAtDeadline(() => api(`/bench/poll?taskId=${taskId}`, {}, undefined, obj), seen.get(taskId) ?? 0));
    }
    agentSeconds = Math.round((Date.now() - t0) / 1000);
    // The agent's part ends here whether it answered or ran out of budget: its turn is cancelled, its jobs
    // stopped, and nothing it does from now on reaches the machine (cf/src/index.ts `benchSweFinish`). Before
    // grading, so a stalled agent cannot edit the tree while it is graded.
    finish = await post("/bench/swe/finish", { taskId }, undefined, obj).catch((e) => ({ error: String((e as Error)?.message ?? e).slice(0, 200) }));
    if (TRACE) console.log(`    agent > ${(answered ?? "(no answer)").replace(/\s+/g, " ").slice(0, 160)}`);

    // Grade with SWE-bench's own criterion, in the box the agent worked in (grade.ts): every FAIL_TO_PASS
    // and PASS_TO_PASS test, from one run of the repository's own test command over the test patch's files.
    const diff = (await shellOut(taskId, "cd /testbed && git diff --stat | tail -3").catch(() => "")).trim().split("\n").pop() ?? "";
    try {
      const graded = await shell(taskId, gradeCommand(inst));
      const report = gradeFromLog(inst, await gradeLogFrom(graded, (c) => shellOut(taskId, c)));
      grade = gradeRecord(report, diff);
    } catch (e) {
      grade = { ...grade, diff, gradeError: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  } finally {
    const release: any = await post("/bench/swe/release", { taskId }, undefined, obj).catch((e) => ({ failed: [{ alias: SANDBOX_ALIAS, error: String(e) }] }));
    for (const f of release?.failed ?? []) {
      console.log(`      \x1b[31mrelease failed: ${f.alias}: ${f.error}\x1b[0m`);
    }
  }

  // Read after release: the container's session is written into the mount's
  // connection state when the box is handed back, so the meter outlives it.
  // And after the agent was stopped (finish, release), so the model calls and
  // tokens are all of the task's, not those up to the moment it answered.
  if (finish?.error) console.log(`      \x1b[31mfinish failed: ${finish.error}\x1b[0m`);
  const stats: any = await api(`/bench/swe/stats?taskId=${taskId}&wallMs=${Date.now() - t0}`, {}, undefined, obj);
  // What the object was billed for this instance alone, the runner's grading
  // shown apart: the activity log is per object and keeps every kind, so the
  // window since this instance started is this instance.
  const act: any = await api(`/bench/activity?since=${t0}`, {}, undefined, obj).catch(() => null);
  const gradingMs = (act?.byKind ?? []).filter((k: any) => (k.kind === "benchSweShell" || k.kind === "benchSweJob"))
    .reduce((a: number, k: any) => a + Number(k.ms), 0);
  const objectMs = Number(act?.activeMs ?? 0);
  return {
    id: inst.instance_id, taskId, engine, object: `bench-${obj}`,
    // Per task, the run's activity is the sum of its objects' (bench/objects.ts), so each one's is kept.
    ...(OBJECTS === "per-task" ? { activity: act } : {}),
    resolved: grade.resolved === true,
    ...grade,
    seconds: Math.round((Date.now() - t0) / 1000), agentSeconds,
    ended: answered ? "answered" : failed.has(taskId) ? `model: ${failed.get(taskId)}`.slice(0, 60) : "agent_stalled",
    stall, stallWhy, finish,
    network, modelTurns: stats.modelTurns, toolTurns: stats.toolTurns, toolErrors: stats.toolErrors ?? null, byTool: stats.byTool ?? {},
    calls: stats.usage?.calls ?? 0, prompt: stats.usage?.prompt ?? 0, out: stats.usage?.out ?? 0,
    cached: stats.usage?.cached ?? 0, meter: stats.meter as Meter | undefined,
    objectMs, gradingMs,
  };
}

// ------------------------------------------------------------ the run

if (OBJECTS === "shared") await api("/bench/activity/reset", { method: "POST" }).catch(() => {});

// Before the first line of output: the log path has to exist while there is
// still something to write to it.
const run = beginRun("swebench", OBJ);
teeRun(run);
console.log(`\n  SWE-bench Verified — ${instances.length} instance(s), inside the deployed object, container network ${process.env.NETWORK ?? "none"}` +
  `, engine ${ENGINE}\n  on ${BASE} ${OBJECTS === "shared" ? `object bench-${OBJ}` : `one object per instance, bench-${OBJ}-<task>`}\n  ${"─".repeat(80)}`);
const out: any[] = [];
const t0Run = Date.now();
const RATES = ratesFromEnv();
for (const inst of instances) {
  console.log(`  ${inst.instance_id}  (${inst.repo})`);
  let r: any;
  try { r = await runOne(inst); }
  catch (e) {
    r = { id: inst.instance_id, engine: ENGINE, resolved: false, error: (e as Error).message.slice(0, 200),
          seconds: 0, calls: 0, prompt: 0, out: 0, cached: 0, byTool: {} };
  }
  out.push(r);
  const mark = r.resolved ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const tools = Object.entries(r.byTool ?? {})
    .sort((a: any, b: any) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(" ");
  const cachePct = r.prompt ? Math.round((r.cached / r.prompt) * 100) : 0;
  console.log(`  ${mark} ${r.seconds}s  ${r.calls} model calls  ${r.prompt} tok (${cachePct}% cached)` +
    (tools ? `  [${tools}]` : "") + (r.diff ? `  diff: ${r.diff}` : "") +
    (r.ended && r.ended !== "answered" ? `  ended: ${r.ended}` : "") +
    (r.error ? `  ERROR ${r.error}` : ""));
  if (r.meter) console.log(`      ${meterLine(r.meter, RATES)}`);
  if (r.objectMs) {
    console.log(`      object billed ${(r.objectMs / 1000).toFixed(1)}s = ` +
      `${r.seconds ? Math.round((r.objectMs / 1000 / r.seconds) * 100) : 0}% of wall` +
      (r.gradingMs ? ` (${(r.gradingMs / 1000).toFixed(1)}s of it grading)` : ""));
  }
  if (r.f2p) {
    console.log(`      graded: FAIL_TO_PASS ${r.f2p.passed}/${r.f2p.total}, PASS_TO_PASS ${r.p2p.passed}/${r.p2p.total}` +
      (r.f2p.firstFailed.length ? `  first failing: ${[...r.f2p.firstFailed, ...r.p2p.firstFailed].slice(0, 3).join(", ")}` : ""));
  }
  if (r.gradeError) console.log(`      \x1b[31mnot graded: ${r.gradeError}\x1b[0m`);
}

const solved = out.filter((r) => r.resolved).length;
const totals = out.reduce((a: any, r: any) => {
  for (const [n, c] of Object.entries(r.byTool ?? {})) a.tools[n] = (a.tools[n] ?? 0) + (c as number);
  return { ...a, prompt: a.prompt + (r.prompt ?? 0), cached: a.cached + (r.cached ?? 0) };
}, { prompt: 0, cached: 0, tools: {} as Record<string, number> });
const wall = out.reduce((a, r) => a + (r.seconds ?? 0), 0);
console.log(`  ${"─".repeat(80)}\n  resolved ${solved}/${out.length}   ${wall}s total   ` +
  `${totals.prompt} prompt tokens ` +
  `(${totals.prompt ? Math.round((totals.cached / totals.prompt) * 100) : 0}% served from cache)\n` +
  `  tools: ${Object.entries(totals.tools).sort((a: any, b: any) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`).join("  ") || "(none)"}`);

/**
 * What the object was billed for — the number the in-process runner could not
 * produce. Grading is the runner's work and is reported apart from the agent's,
 * because it is the object awaiting a test suite, not the loop.
 */
const act = OBJECTS === "shared"
  ? await api("/bench/activity").catch(() => null)
  : sumActivity(out.map((r: any) => r.activity));
if (act) {
  const grading = (act.byKind ?? []).filter((k: any) => (k.kind === "benchSweShell" || k.kind === "benchSweJob"))
    .reduce((a: number, k: any) => a + Number(k.ms), 0);
  console.log(`  object billed ${(act.activeMs / 1000).toFixed(1)}s of ${wall}s wall ` +
    `(${wall ? Math.round((act.activeMs / 1000 / wall) * 100) : 0}%)` +
    (grading ? `, of which ${(grading / 1000).toFixed(1)}s is this runner grading` : ""));
}
const recorded = recordRun(run, {
  bench: "swebench-verified", base: BASE, build: await workerBuild(BASE), driver: driverCommit(), object: OBJECTS === "shared" ? `bench-${OBJ}` : `bench-${OBJ}-<task>`, engine: ENGINE, objects: OBJECTS, offset: OFFSET, n: instances.length,
  network: out.map((r: any) => r.network).find(Boolean) ?? null,
  startedAt: new Date(t0Run).toISOString(), results: out, totals, activity: act,
});
console.log(`  recorded ${recorded}`);
console.log();
