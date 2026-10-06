/**
 * τ²-bench retail, against a real Durable Object.
 *
 * The Node runner drives `PiAgent` over node:sqlite in this process. That is a
 * loop nobody deploys: the object owns the storage, the queue owns the model
 * call, and neither is present in-process. It also leaves nothing behind — the
 * transcript is an in-memory database that vanishes when the run ends, so
 * explaining a failure means reproducing it.
 *
 * This one talks to the deployment. The agent runs inside the object, the model
 * call goes through the queue that production uses, and the transcript stays in
 * the object afterwards where the console can read it. What is measured is the
 * thing that ships.
 *
 * The customer stays here. τ²'s user is a second model with no access to the
 * domain, so running it locally changes nothing about what is under test and
 * keeps the simulator's tokens out of the agent's own accounting.
 *
 *   N=8 TRIALS=3 node bench/tau2/cf.ts
 *   ENGINE=pd N=8 TRIALS=3 OBJ=pd1 node bench/tau2/cf.ts   (one object per task: bench/objects.ts)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { WRITE_TOOLS, type RetailDB } from "./retail.ts";
import { argDiff, actionMatch as grade } from "./grade.ts";
import { gold as goldOf, MAX_TURNS, OPENING, rowTaskId, SIM, SIM_LAST_MAX, simEnding, simRecord, simSystem } from "./episode.ts";
import { beginRun, driverCommit, recordRun, teeRun, workerBuild, workerModel } from "../record.ts";
import { stallAtDeadline, type StallEvidence } from "../poll-fallback.ts";
import { endingsAllRows, failingRowsByEndingAndCause } from "./endings.ts";
import { passLines, passRecord } from "./passk.ts";
import { runOrder, runPlan } from "./plan.ts";
import { deafnessBudget, readDeafness } from "./deafness.ts";
import { pushForAnswer as pushForAnswerOn, type Delivered } from "./wait.ts";
import { benchEngine, objectsShape, sumActivity, taskObject } from "../objects.ts";

for (const l of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

// The custom hostname sits behind Cloudflare Access, which answers a benchmark
// run with a login redirect. The workers.dev address is the same Worker and the
// same objects without the interactive gate; the endpoints that spend the model
// account are guarded there by `x-harness-token` instead.
const BASE = process.env.BENCH_BASE ?? "https://antiproton.botiverse.workers.dev";
const TOKEN = process.env.HARNESS_AUTOMATION_TOKEN ?? "";
const MODEL_ID = process.env.HARNESS_MODEL ?? "deepseek-flash";
const TRIALS = Number(process.env.TRIALS ?? 1);
const N = Number(process.env.N ?? 5);
const OFFSET = Number(process.env.OFFSET ?? 0);
const VERBOSE = !!process.env.VERBOSE;
// Deliberate deafness for ONE turn of one round, so the recovery path can be observed rather than waited
// for: bench/tau2/deafness.ts says what the settings mean and why they are named that way.
const DEAFNESS = readDeafness(process.env.IGNORE_ANSWERS);
const deafness = deafnessBudget(DEAFNESS);
// Which order the (task, trial) pairs are visited in; an unknown name throws (bench/tau2/plan.ts).
const ORDER = runOrder(process.env.ORDER);

const here = new URL("./data/", import.meta.url).pathname;
const BASE_DB: RetailDB = JSON.parse(readFileSync(here + "db.json", "utf8"));
const TASKS: any[] = JSON.parse(readFileSync(here + "tasks.json", "utf8"));
const POLICY = readFileSync(here + "policy.md", "utf8");
const GUIDELINES = readFileSync(here + "simulation_guidelines.md", "utf8");

const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!, model: MODEL_ID,
});

// Each arm gets its own object, so one arm's activity is never read as
// another's — the meter is per object and it does not reset itself.
const OBJ = process.env.OBJ ?? "v1";
// Which kernel runs the agent, and so whether each task needs an object of its own (bench/objects.ts).
const ENGINE = benchEngine(process.env.ENGINE);
const OBJECTS = objectsShape(ENGINE, process.env.OBJECTS);
/** The object a task runs in: the run's own, or the task's (OBJECTS=per-task, and always on pd). */
const objOf = (taskId: string) => taskObject(OBJ, OBJECTS, taskId);
const withObj = (path: string, obj = OBJ) => path + (path.includes("?") ? "&" : "?") + `obj=${obj}`;

async function api(path: string, init: RequestInit = {}, obj = OBJ): Promise<any> {
  const r = await fetch(BASE + withObj(path, obj), {
    ...init,
    headers: { "x-harness-token": TOKEN, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const post = (path: string, body: unknown, obj = OBJ) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, obj);

/** The simulator, its settings and the gold database are bench/tau2/episode.ts, shared with bench/tau2/api.ts. */
const gold = (task: any) => goldOf(task, BASE_DB);

/**
 * Wait for the object to finish a turn.
 *
 * Two ways, because the difference is the measurement. Polling asks the object
 * whether it is done, and every ask is a request that wakes it — so a benchmark
 * that polls is partly measuring its own poller. The deployed console does not
 * poll: the object pushes over a socket it accepted with the hibernation API,
 * and while it waits it holds nothing and is billed nothing.
 *
 * WAIT=poll switches back, so the cost of the difference can be read off the
 * same benchmark rather than argued.
 */
const WAIT = process.env.WAIT ?? "push";
const TURN_TIMEOUT_MS = 300_000;

function waitForAnswer(taskId: string): Promise<string | null> {
  return WAIT === "poll" ? pollForAnswer(taskId) : pushForAnswer(taskId);
}

async function pollForAnswer(taskId: string): Promise<string | null> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = await api(`/bench/poll?taskId=${taskId}`, {}, objOf(taskId));
    if (s.status === "idle" && s.answer) { count(taskId, "poll"); return s.answer; }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
}

/** WAIT=push: the socket wait itself is bench/tau2/wait.ts; this passes it the runner's state. */
async function pushForAnswer(taskId: string): Promise<string | null> {
  return pushForAnswerOn(taskId, Date.now() + TURN_TIMEOUT_MS, {
    socketUrl: (taskId, after) => BASE.replace(/^http/, "ws") + withObj(
      `/bench/events?tenantId=bench&agentId=b_${taskId}&after=${after}`, objOf(taskId)),
    headers: { "x-harness-token": TOKEN },
    poll: (taskId) => api(`/bench/poll?taskId=${taskId}`, {}, objOf(taskId)),
    seen, failed, count,
    deaf: (to) => deafness.deaf(to),
    say: VERBOSE ? (line) => console.log(line) : undefined,
  });
}

/** How far each task's stream has been read, so a reconnect does not replay a
 *  previous turn's answer and end the conversation a turn early. */
const seen = new Map<string, number>();

const delivered = new Map<string, Delivered>();
function count(taskId: string, what: keyof Delivered) {
  const d = delivered.get(taskId) ?? { push: 0, poll: 0, pollAnswered: 0, pollFailed: 0, dropped: 0 };
  d[what] += 1;
  delivered.set(taskId, d);
}

/** Why a turn ended without an answer, when the object said why. */
const failed = new Map<string, string>();

async function runTask(task: any) {
  const t0 = Date.now();
  const taskId = rowTaskId(task.id, t0);
  const obj = objOf(taskId);
  // The engine is named only when it is not the default, so a pi085 run sends what it always sent.
  const started = await post("/bench/start", { taskId, policy: POLICY, offload: true, ...(ENGINE === "pi085" ? {} : { engine: ENGINE }) }, obj);
  // What the object says it runs, not what was asked: an older Worker ignores `engine` and answers without one.
  const engine = started?.engine ?? (ENGINE === "pi085" ? "pi085" : null);
  if (engine !== ENGINE) throw new Error(`asked for ${ENGINE}, the object runs ${engine ?? "an engine it did not name"}`);

  const sim: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: simSystem(task, GUIDELINES) },
  ];

  let agentSaid = OPENING;
  let turns = 0, simCalls = 0, ended = "max_turns";
  let simLast = "";
  let stall: string | undefined;
  // The values that cause was decided from, so a record can be re-decided rather than believed.
  let stallWhy: StallEvidence | undefined;

  while (turns++ < MAX_TURNS) {
    sim.push({ role: "user", content: agentSaid });
    // Why the simulator thinks a little under a large cap: SIM in bench/tau2/episode.ts.
    const u = await model.complete(sim, SIM);
    simCalls += 1;
    sim.push({ role: "assistant", content: u.text });
    // Verbatim, including a stop tag when the turn carried one (a STOP turn's text
    // is never posted to the agent — see the break below). Capped where the row is built.
    simLast = u.text;
    if (VERBOSE) console.log(`    user  > ${u.text.replace(/\s+/g, " ").slice(0, 130)}`);
    const simEnded = simEnding(u);
    if (simEnded) { ended = simEnded; break; }

    await post("/bench/say", { taskId, text: u.text }, obj);

    const answered = await waitForAnswer(taskId);
    if (!answered) {
      if (failed.has(taskId)) ended = `model: ${failed.get(taskId)}`.slice(0, 60);
      else {
        ended = "agent_stalled";
        ({ stall, stallWhy } = await stallAtDeadline(
          () => api(`/bench/poll?taskId=${taskId}`, {}, obj), seen.get(taskId) ?? 0));
        // The hole is spent whether or not it produced the stall, so a round injects exactly one.
        deafness.spend();
      }
      break;
    }
    if (DEAFNESS === "socket") deafness.spend();
    agentSaid = answered;
    if (VERBOSE) console.log(`    agent > ${answered.replace(/\s+/g, " ").slice(0, 130)}`);
  }

  const res = await api(`/bench/result?taskId=${taskId}`, {}, obj);
  // A task with an object of its own has that object's whole activity log to itself.
  const activity = OBJECTS === "per-task" ? await api("/bench/activity", {}, obj).catch(() => null) : undefined;
  const { hash, expected } = gold(task);
  const writes = (res.writes ?? []).filter((w: any) => WRITE_TOOLS.has(w.name));
  const dbMatch = res.dbHash === hash;
  const actionMatch = grade(expected, writes);

  return {
    id: task.id, taskId, engine, object: `bench-${obj}`, ...(activity === undefined ? {} : { activity }),
    reward: dbMatch && actionMatch ? 1 : 0, dbMatch, actionMatch, ended, stall, stallWhy,
    simLast: simLast.slice(0, SIM_LAST_MAX),
    delivered: delivered.get(taskId) ?? { push: 0, poll: 0, pollAnswered: 0, pollFailed: 0, dropped: 0 },
    turns: turns - 1, simCalls,
    usage: res.usage ?? {}, kinds: res.kinds ?? {}, byTool: res.byTool ?? {}, toolErrors: res.toolErrors ?? null,
    seconds: Math.round((Date.now() - t0) / 1000),
    expectedWrites: expected.map((e) => e.name),
    performedWrites: writes.map((w: any) => w.name),
    expectedArgs: expected, performedArgs: writes.map((w: any) => ({ name: w.name, args: w.args })),
  };
}



// The base database has to be where the object can read it, and it is 2.8 MB,
// so it is uploaded once rather than carried in every request.
await api("/bench/basedb", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: readFileSync(here + "db.json", "utf8"),
});
// Per task, every object is new and has nothing to reset.
if (OBJECTS === "shared") await api("/bench/activity/reset", { method: "POST" }).catch(() => {});

const selected = TASKS.slice(OFFSET, OFFSET + N);
// Before the first line of output: the log path has to exist while there is
// still something to write to it.
const run = beginRun("tau2", OBJ);
teeRun(run);
console.log(`\n  τ²-bench retail — ${selected.length} task(s) × ${TRIALS} trial(s) in ${ORDER} order, ` +
  `model ${MODEL_ID}, waiting by ${WAIT}, engine ${ENGINE}\n  on ${BASE} ${OBJECTS === "shared" ? `object bench-${OBJ}` : `one object per task, bench-${OBJ}-<task>`}\n  ${"─".repeat(84)}`);

const results: any[] = [];
const t0Run = Date.now();
for (const { task, trial } of runPlan(selected, TRIALS, ORDER)) {
  {
    if (VERBOSE) console.log(`\n  task ${task.id} (trial ${trial})`);
    let r;
    try { r = await runTask(task); }
    catch (e) {
      r = { id: task.id, engine: ENGINE, reward: 0, dbMatch: false, actionMatch: false,
            ended: `error: ${(e as Error).message.slice(0, 80)}`, turns: 0, simCalls: 0,
            usage: {}, kinds: {}, byTool: {}, seconds: 0, expectedWrites: [], performedWrites: [] };
    }
    results.push({ ...r, trial });
    const mark = r.reward ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${mark} task ${String(r.id).padEnd(4)} db=${r.dbMatch ? "ok " : "NO "}` +
      `act=${r.actionMatch ? "ok " : "NO "} ${String(r.ended).padEnd(13)} ` +
      `${r.turns} turns / ${r.usage?.calls ?? "?"} calls / ${r.usage?.prompt ?? "?"} tok / ${r.seconds}s`);
    if (!r.reward && (r.expectedWrites.length || r.performedWrites.length)) {
      console.log(`      expected: [${r.expectedWrites.join(", ")}]  performed: [${r.performedWrites.join(", ")}]`);
      // The match is on the arguments, not the names, so a line that prints
      // only names can show `expected [X] performed [X]` next to act=NO and
      // look like the grader is broken. Show what actually differed.
      for (const line of argDiff(r.expectedArgs ?? [], r.performedArgs ?? [])) console.log(`        ${line}`);
    }
  }
}

console.log(`  ${"─".repeat(84)}`);
for (const line of passLines(results, TRIALS)) console.log(line);
console.log(`  ${results.reduce((a, r) => a + r.seconds, 0)}s wall`);

// The same tally the in-process runner printed, so "did anything reach for
// run_js" has an on-object answer rather than an in-process one.
const toolTotals: Record<string, number> = {};
for (const r of results) for (const [n, c] of Object.entries(r.byTool ?? {})) {
  toolTotals[n] = (toolTotals[n] ?? 0) + (c as number);
}
console.log(`  tools: ${Object.entries(toolTotals).sort((a: any, b: any) => b[1] - a[1])
  .map(([n, c]) => `${n}×${c}`).join("  ") || "(none)"}`);

// Two tallies over two different sets of rows, each written under a name that
// says which set it counted (bench/tau2/endings.ts).
const allEndings = endingsAllRows(results);
const failEndings = failingRowsByEndingAndCause(results);
const tally = (t: Record<string, number>) => Object.entries(t)
  .sort((a: any, b: any) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  ");
console.log(`  endings, all ${results.length} rows: ${tally(allEndings) || "(none)"}`);
if (Object.keys(failEndings).length) {
  console.log(`  failures by ending: ${tally(failEndings)}`);
}

/**
 * What the object was billed for.
 *
 * This is the number the in-process runner could not produce at all, and the
 * reason for running here: Durable Objects are billed for wall clock while
 * active, so the gap between this and the wall clock above is the part of the
 * run that cost nothing because the object was asleep waiting on the queue.
 */
const act = OBJECTS === "shared"
  ? await api("/bench/activity").catch(() => null)
  : sumActivity(results.map((r) => r.activity));
if (act) {
  const wall = results.reduce((a, r) => a + r.seconds, 0);
  console.log(`  object billed ${(act.activeMs / 1000).toFixed(1)}s of ${wall}s wall ` +
    `(${wall ? Math.round((act.activeMs / 1000 / wall) * 100) : 0}%)` +
    (act.pollMs ? `, of which ${(act.pollMs / 1000).toFixed(1)}s is this runner polling` : ""));
}
const recorded = recordRun(run, {
  bench: "tau2-retail", base: BASE, build: await workerBuild(BASE), driver: driverCommit(), object: OBJECTS === "shared" ? `bench-${OBJ}` : `bench-${OBJ}-<task>`, engine: ENGINE, objects: OBJECTS, model: MODEL_ID, wait: WAIT, sim: simRecord(GUIDELINES),
  provider: await workerModel(BASE),
  tasks: selected.map((t) => t.id), trials: TRIALS, order: ORDER,
  ...(DEAFNESS ? { ignoreAnswers: DEAFNESS } : {}),
  startedAt: new Date(t0Run).toISOString(),
  results, ...passRecord(results, TRIALS),
  tools: toolTotals, endingsAllRows: allEndings, failingRowsByEndingAndCause: failEndings, activity: act,
});
console.log(`  recorded ${recorded}`);
console.log();
