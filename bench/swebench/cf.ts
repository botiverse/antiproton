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
 * exactly that reason, and never offers the agent the tool that would
 * destroy the evidence (`node.release`).
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
import { driverCommit, recordRun, workerBuild } from "../record.ts";
import { decideFromPoll } from "../poll-fallback.ts";

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
const withObj = (path: string) => path + (path.includes("?") ? "&" : "?") + `obj=${OBJ}`;

interface Instance {
  instance_id: string; repo: string; base_commit: string;
  problem_statement: string; patch: string; test_patch: string;
  FAIL_TO_PASS: string; PASS_TO_PASS: string;
}

async function api(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<any> {
  const r = await fetch(BASE + withObj(path), {
    ...init,
    headers: { "x-harness-token": TOKEN, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const post = (path: string, body: unknown, timeoutMs?: number) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);

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
Use node.shell to explore and edit it — that is a real machine with git, python and the test suite.
Work in small steps: read the failing code first, then make the smallest change that fixes it.
Do not modify test files; the graders supply their own.
When the fix is in place, say so and stop.
`.trim();

// ------------------------------------------------------------ waiting

/**
 * The agent phase is over when the model replies with text and no tool call —
 * the same rule the object applies, read from the same event stream the
 * console reads, over the hibernation-API socket the console uses. Polling
 * would measure the poller: every poll wakes the object and is billed.
 *
 * Reconnects rather than gives up: a socket dropped mid-turn is not an agent
 * that stalled, and the cursor means a reconnect resumes rather than replays.
 */
const seen = new Map<string, number>();
const failed = new Map<string, string>();

async function waitForAnswer(taskId: string, deadline: number): Promise<string | null> {
  while (Date.now() < deadline) {
    const answer = await oneSocket(taskId, deadline);
    if (answer !== null) return answer;
    if (failed.has(taskId)) return null;
  }
  return null;
}

function oneSocket(taskId: string, deadline: number): Promise<string | null> {
  // The token goes on the upgrade too: /bench/* is gated (task #15), and a
  // refused upgrade reaches a WebSocket client only as close 1006 with no body,
  // which this runner then scored as a stalled agent (Vera, 2026-09-14).
  const ws = new (WebSocket as any)(BASE.replace(/^http/, "ws") + withObj(
    `/bench/events?tenantId=bench&agentId=b_${taskId}&after=${seen.get(taskId) ?? 0}`), { headers: { "x-harness-token": TOKEN } }) as WebSocket;
  return new Promise<string | null>((resolve) => {
    let done = false;
    const stop = (v: string | null) => {
      if (done) return;
      done = true;
      clearInterval(keepalive); clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      resolve(v);
    };
    const keepalive = setInterval(() => {
      try { ws.send("ping"); } catch { /* closing */ }
      // A lost push must not become a stall: the object may have answered already (bench/poll-fallback.ts).
      void api(`/bench/poll?taskId=${taskId}`).then((poll: any) => {
        const d = decideFromPoll(poll, seen.get(taskId) ?? 0);
        if (!d) return;
        seen.set(taskId, d.seq);
        if (d.kind === "failed") { failed.set(taskId, "the model call failed (seen by poll after a lost push)"); stop(null); }
        else stop(d.text);
      }).catch(() => { /* the socket or the next tick will do */ });
    }, 20_000);
    const timer = setTimeout(() => stop(null), Math.max(0, deadline - Date.now()));
    ws.onerror = () => stop(null);
    ws.onclose = () => stop(null);
    ws.onmessage = (ev: MessageEvent) => {
      let e: any;
      try { e = JSON.parse(String(ev.data)); } catch { return; }
      if (e.kind === "pong") return;
      if (e.kind === "model.failed") {
        failed.set(taskId, String(e.payload?.error ?? "the model call failed"));
        stop(null);
        return;
      }
      if (typeof e.id === "number") seen.set(taskId, e.id);
      if (e.kind === "model.response" && !e.payload?.toolCalls && e.payload?.text) {
        stop(String(e.payload.text));
      }
    };
  });
}

// ------------------------------------------------------------ one instance

/** A shell command in the agent's container, run by the runner. Long: the
 *  test suite of a real repository is behind it, so the timeout is the
 *  mount's own (300 s) plus the trip. */
const shell = (taskId: string, command: string) =>
  post("/bench/swe/shell", { taskId, command }, 360_000);

async function runOne(inst: Instance) {
  const t0 = Date.now();
  const taskId = `${inst.instance_id.replace(/[^A-Za-z0-9._-]/g, "_")}_${Date.now().toString(36)}`.slice(0, 58);
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
  });
  const network = String(started?.network ?? "open");
  if (TRACE) console.log(`    started ${JSON.stringify(started)}`);

  // Everything after this point must release the container, whatever happens
  // in between: a box that outlives its run is billed for existing, and this
  // benchmark starts one per instance.
  let grade: any = { failToPass: false, passToPass: false, diff: "", failOut: "" };
  let agentSeconds = 0, answered: string | null = null;
  try {
    await post("/bench/say", { taskId,
      text: `Fix this issue in the repository at /testbed.\n\n${inst.problem_statement.slice(0, 6000)}` });
    answered = await waitForAnswer(taskId, t0 + BUDGET_MS);
    agentSeconds = Math.round((Date.now() - t0) / 1000);
    if (TRACE) console.log(`    agent > ${(answered ?? "(no answer)").replace(/\s+/g, " ").slice(0, 160)}`);

    // Grade with SWE-bench's own criterion, in the box the agent worked in.
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    const f2p: string[] = JSON.parse(inst.FAIL_TO_PASS);
    const p2p: string[] = JSON.parse(inst.PASS_TO_PASS);
    const diffRes: any = await shell(taskId, "cd /testbed && git diff --stat | tail -3");
    const diff = String(diffRes.result?.output ?? "").trim().split("\n").pop() ?? "";
    const gradeIds = async (ids: string[]) => {
      if (!ids.length) return { ok: true, out: "(none)" };
      const r: any = await shell(taskId,
        `cd /testbed && echo '${b64(inst.test_patch)}' | base64 -d > /tmp/test.patch && ` +
        `git checkout -- $(git diff --name-only -- '*test*' 2>/dev/null) 2>/dev/null; ` +
        `git apply -v /tmp/test.patch 2>&1 | tail -2; ` +
        `python -m pytest -q ${ids.map((i) => `'${i}'`).join(" ")} 2>&1 | tail -12`);
      const out = String(r.result?.output ?? r.error?.message ?? "");
      const tail = out.split("\n").slice(-3).join(" ");
      return { ok: /\d+ passed/.test(tail) && !/\d+ (failed|error)/.test(tail), out };
    };
    const fail = await gradeIds(f2p.slice(0, 12));
    const pass = await gradeIds(p2p.slice(0, 12));
    grade = {
      failToPass: fail.ok, passToPass: pass.ok, diff,
      failOut: fail.ok ? "" : fail.out.split("\n").slice(-4).join(" | ").slice(0, 220),
    };
  } finally {
    const release: any = await post("/bench/swe/release", { taskId }).catch((e) => ({ failed: [{ alias: "sandbox", error: String(e) }] }));
    for (const f of release?.failed ?? []) {
      console.log(`      \x1b[31mrelease failed: ${f.alias}: ${f.error}\x1b[0m`);
    }
  }

  // Read after release: the container's session is written into the mount's
  // connection state when the box is handed back, so the meter outlives it.
  const stats: any = await api(`/bench/swe/stats?taskId=${taskId}&wallMs=${Date.now() - t0}`);
  // What the object was billed for this instance alone, the runner's grading
  // shown apart: the activity log is per object and keeps every kind, so the
  // window since this instance started is this instance.
  const act: any = await api(`/bench/activity?since=${t0}`).catch(() => null);
  const gradingMs = (act?.byKind ?? []).filter((k: any) => k.kind === "benchSweShell")
    .reduce((a: number, k: any) => a + Number(k.ms), 0);
  const objectMs = Number(act?.activeMs ?? 0);
  return {
    id: inst.instance_id, taskId,
    resolved: grade.failToPass && grade.passToPass,
    ...grade,
    seconds: Math.round((Date.now() - t0) / 1000), agentSeconds,
    ended: answered ? "answered" : failed.has(taskId) ? `model: ${failed.get(taskId)}`.slice(0, 60) : "agent_stalled",
    network, modelTurns: stats.modelTurns, toolTurns: stats.toolTurns, toolErrors: stats.toolErrors ?? null, byTool: stats.byTool ?? {},
    calls: stats.usage?.calls ?? 0, prompt: stats.usage?.prompt ?? 0, out: stats.usage?.out ?? 0,
    cached: stats.usage?.cached ?? 0, meter: stats.meter as Meter | undefined,
    objectMs, gradingMs,
  };
}

// ------------------------------------------------------------ the run

await api("/bench/activity/reset", { method: "POST" }).catch(() => {});

console.log(`\n  SWE-bench Verified — ${instances.length} instance(s), inside the deployed object, container network ${process.env.NETWORK ?? "none"}` +
  `\n  on ${BASE} object bench-${OBJ}\n  ${"─".repeat(80)}`);
const out: any[] = [];
const t0Run = Date.now();
const RATES = ratesFromEnv();
for (const inst of instances) {
  console.log(`  ${inst.instance_id}  (${inst.repo})`);
  let r: any;
  try { r = await runOne(inst); }
  catch (e) {
    r = { id: inst.instance_id, resolved: false, error: (e as Error).message.slice(0, 200),
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
  if (r.failOut) console.log(`      \x1b[31m${r.failOut}\x1b[0m`);
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
const act = await api("/bench/activity").catch(() => null);
if (act) {
  const grading = (act.byKind ?? []).filter((k: any) => k.kind === "benchSweShell")
    .reduce((a: number, k: any) => a + Number(k.ms), 0);
  console.log(`  object billed ${(act.activeMs / 1000).toFixed(1)}s of ${wall}s wall ` +
    `(${wall ? Math.round((act.activeMs / 1000 / wall) * 100) : 0}%)` +
    (grading ? `, of which ${(grading / 1000).toFixed(1)}s is this runner grading` : ""));
}
const recorded = recordRun("swebench", OBJ, {
  bench: "swebench-verified", base: BASE, build: await workerBuild(BASE), driver: driverCommit(), object: `bench-${OBJ}`, offset: OFFSET, n: instances.length,
  network: out.map((r: any) => r.network).find(Boolean) ?? null,
  startedAt: new Date(t0Run).toISOString(), results: out, totals, activity: act,
});
console.log(`  recorded ${recorded}`);
console.log();
