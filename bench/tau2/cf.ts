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
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { applyRetailAction, WRITE_TOOLS, type RetailDB } from "./retail.ts";
import { createHash } from "node:crypto";
import { driverCommit, recordRun, workerBuild } from "../record.ts";
import { decideFromPoll, stallCause } from "../poll-fallback.ts";
import { endingsAllRows, failingRowsByEndingAndCause } from "./endings.ts";

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
const withObj = (path: string) => path + (path.includes("?") ? "&" : "?") + `obj=${OBJ}`;

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(BASE + withObj(path), {
    ...init,
    headers: { "x-harness-token": TOKEN, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Stable serialisation so two databases compare by value, not key order. */
const canon = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v as object).sort()
    .map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(",")}}`;
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * How two write actions compare: by name and by arguments, where an array of
 * primitives is a set.
 *
 * `canon` keeps array order because the database hash must — a list in the
 * domain is a list. A request's `item_ids` is not: `return_delivered_order_items`
 * over the same three items in a different order is the same action, and the
 * database agreed (db=ok) on every trial the positional comparison failed. The
 * grader was asserting something the task does not require, three times in one
 * matrix. Arrays of objects keep their order; only primitive arrays are sorted.
 */
const canonArgs = (v: unknown): string => {
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) {
    return `[${[...v].map((x) => JSON.stringify(x)).sort().join(",")}]`;
  }
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonArgs).join(",")}]`;
  return `{${Object.keys(v as object).sort()
    .map((k) => `${JSON.stringify(k)}:${canonArgs((v as any)[k])}`).join(",")}}`;
};

/** The database the annotated solution leaves behind, hashed the same way the
 *  object hashes its own — the comparison is a hash because the database is
 *  2.8 MB and no part of it needs to travel. */
function gold(task: any) {
  const db = structuredClone(BASE_DB);
  const applied: Array<{ name: string; args: any }> = [];
  for (const a of task.evaluation_criteria?.actions ?? []) {
    if (!WRITE_TOOLS.has(a.name)) continue;
    applyRetailAction(db, a.name, a.arguments);
    applied.push({ name: a.name, args: a.arguments });
  }
  return { hash: sha256(canon(db)), expected: applied };
}

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
    const s = await api(`/bench/poll?taskId=${taskId}`);
    if (s.status === "idle" && s.answer) { count(taskId, "poll"); return s.answer; }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
}

/** The turn is over when the model replies with text and no tool call — which
 *  is the same rule the object applies, read from the same event stream the
 *  console reads.
 *
 *  Reconnects rather than gives up. A socket that drops mid-turn is not an
 *  agent that stalled, and scoring it as one would blame the harness for the
 *  network; the cursor means a reconnect resumes where it left off instead of
 *  replaying the previous turn's answer and ending the conversation early. */
async function pushForAnswer(taskId: string): Promise<string | null> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const answer = await oneSocket(taskId, deadline);
    if (answer !== null) return answer;
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
    // The object answers a ping, which is the only thing keeping an idle
    // connection from being closed underneath a slow model call.
    const keepalive = setInterval(() => {
      try { ws.send("ping"); } catch { /* closing */ }
      // A lost push must not become a stall: the object may have answered already (bench/poll-fallback.ts).
      void api(`/bench/poll?taskId=${taskId}`).then((poll: any) => {
        count(taskId, "pollAnswered");
        const d = decideFromPoll(poll, seen.get(taskId) ?? 0);
        if (!d) return;
        seen.set(taskId, d.seq);
        if (d.kind === "failed") { failed.set(taskId, "the model call failed (seen by poll after a lost push)"); stop(null); }
        else { if (!done) count(taskId, "poll"); stop(d.text); }
      }, () => {
        // Only the request failing counts here; the socket or the next tick will do.
        count(taskId, "pollFailed");
      }).catch(() => { /* a fault in handling an answer is not a failed poll */ });
    }, 20_000);
    const timer = setTimeout(() => stop(null), Math.max(0, deadline - Date.now()));
    // A socket that ends before this turn's answer is a drop, whatever comes next.
    const drop = () => { if (!done) count(taskId, "dropped"); stop(null); };
    ws.onerror = drop;
    ws.onclose = drop;
    ws.onmessage = (ev: MessageEvent) => {
      let e: any;
      try { e = JSON.parse(String(ev.data)); } catch { return; }
      if (e.kind === "pong") return;
      // A failed model call ends the turn as surely as an answer does, and
      // waiting out the timeout would report it as a stall — which blames the
      // wrong thing.
      if (e.kind === "model.failed") {
        failed.set(taskId, String(e.payload?.error ?? "the model call failed"));
        stop(null);
        return;
      }
      if (typeof e.id === "number") seen.set(taskId, e.id);
      if (e.kind === "model.response" && !e.payload?.toolCalls && e.payload?.text) {
        if (!done) count(taskId, "push");
        stop(String(e.payload.text));
      }
    };
  });
}

/** How far each task's stream has been read, so a reconnect does not replay a
 *  previous turn's answer and end the conversation a turn early. */
const seen = new Map<string, number>();

/**
 * Which path brought each turn's answer, and how often each path was given
 * the chance. `poll: 0` alone cannot tell "no push was lost" from "the
 * fallback never ran" (Vera, 2026-09-17). `pollAnswered` and `pollFailed`
 * count the fallback's polls that came back and that failed, so both zero
 * means none was sent; `dropped` counts sockets that closed or failed before
 * an answer.
 */
type Delivered = { push: number; poll: number; pollAnswered: number; pollFailed: number; dropped: number };
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
  const taskId = `t_${task.id}_${Date.now().toString(36)}`;
  await post("/bench/start", { taskId, policy: POLICY, offload: true });

  const instr = task.user_scenario?.instructions ?? {};
  const scenario = [
    instr.task_instructions && `Style: ${instr.task_instructions}`,
    instr.reason_for_call && `Why you are contacting support: ${instr.reason_for_call}`,
    instr.known_info && `What you know: ${instr.known_info}`,
    instr.unknown_info && `What you do NOT know: ${instr.unknown_info}`,
  ].filter(Boolean).join("\n");
  const sim: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: `${GUIDELINES}\n\n# Your scenario\n${scenario}` },
  ];

  let agentSaid = "Hi! How can I help you today?";
  let turns = 0, simCalls = 0, ended = "max_turns";
  let stall: string | undefined;

  while (turns++ < 14) {
    sim.push({ role: "user", content: agentSaid });
    const u = await model.complete(sim, { maxTokens: 2000 });
    simCalls += 1;
    sim.push({ role: "assistant", content: u.text });
    const stop = /###(STOP|TRANSFER|OUT-OF-SCOPE)###/.exec(u.text);
    if (VERBOSE) console.log(`    user  > ${u.text.replace(/\s+/g, " ").slice(0, 130)}`);
    if (stop) { ended = stop[1]!.toLowerCase(); break; }

    await post("/bench/say", { taskId, text: u.text });

    const answered = await waitForAnswer(taskId);
    if (!answered) {
      if (failed.has(taskId)) ended = `model: ${failed.get(taskId)}`.slice(0, 60);
      else {
        ended = "agent_stalled";
        const last = await api(`/bench/poll?taskId=${taskId}`).catch(() => null);
        stall = stallCause(last, seen.get(taskId) ?? 0);
      }
      break;
    }
    agentSaid = answered;
    if (VERBOSE) console.log(`    agent > ${answered.replace(/\s+/g, " ").slice(0, 130)}`);
  }

  const res = await api(`/bench/result?taskId=${taskId}`);
  const { hash, expected } = gold(task);
  const writes = (res.writes ?? []).filter((w: any) => WRITE_TOOLS.has(w.name));
  const dbMatch = res.dbHash === hash;
  const actionMatch = expected.every((e) =>
    writes.some((w: any) => w.name === e.name && canonArgs(w.args) === canonArgs(e.args)));

  return {
    id: task.id, taskId, reward: dbMatch && actionMatch ? 1 : 0, dbMatch, actionMatch, ended, stall,
    delivered: delivered.get(taskId) ?? { push: 0, poll: 0, pollAnswered: 0, pollFailed: 0, dropped: 0 },
    turns: turns - 1, simCalls,
    usage: res.usage ?? {}, kinds: res.kinds ?? {}, byTool: res.byTool ?? {}, toolErrors: res.toolErrors ?? null,
    seconds: Math.round((Date.now() - t0) / 1000),
    expectedWrites: expected.map((e) => e.name),
    performedWrites: writes.map((w: any) => w.name),
    expectedArgs: expected, performedArgs: writes.map((w: any) => ({ name: w.name, args: w.args })),
  };
}

/** Which expected write had no performed write with the same name *and*
 *  arguments — the actual criterion — with both sides shown. */
function argDiff(expected: Array<{ name: string; args: any }>, performed: Array<{ name: string; args: any }>): string[] {
  const out: string[] = [];
  for (const e of expected) {
    const same = performed.filter((p) => p.name === e.name);
    if (same.some((p) => canonArgs(p.args) === canonArgs(e.args))) continue;
    out.push(`${e.name} expected ${canonArgs(e.args).slice(0, 160)}`);
    for (const p of same) out.push(`${" ".repeat(e.name.length)} performed ${canonArgs(p.args).slice(0, 160)}`);
    if (!same.length) out.push(`${" ".repeat(e.name.length)} performed (nothing by that name)`);
  }
  return out;
}

function passAtK(rows: any[], k: number) {
  const byTask = new Map<string, any[]>();
  for (const r of rows) byTask.set(String(r.id), [...(byTask.get(String(r.id)) ?? []), r]);
  let all = 0, counted = 0;
  for (const [, rs] of byTask) {
    if (rs.length < k) continue;
    counted += 1;
    if (rs.slice(0, k).every((r) => r.reward)) all += 1;
  }
  return { passed: all, of: counted };
}

// The base database has to be where the object can read it, and it is 2.8 MB,
// so it is uploaded once rather than carried in every request.
await api("/bench/basedb", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: readFileSync(here + "db.json", "utf8"),
});
await api("/bench/activity/reset", { method: "POST" }).catch(() => {});

const selected = TASKS.slice(OFFSET, OFFSET + N);
console.log(`\n  τ²-bench retail — ${selected.length} task(s) × ${TRIALS} trial(s), ` +
  `model ${MODEL_ID}, waiting by ${WAIT}\n  on ${BASE} object bench-${OBJ}\n  ${"─".repeat(84)}`);

const results: any[] = [];
const t0Run = Date.now();
for (let trial = 1; trial <= TRIALS; trial++) {
  for (const task of selected) {
    if (VERBOSE) console.log(`\n  task ${task.id} (trial ${trial})`);
    let r;
    try { r = await runTask(task); }
    catch (e) {
      r = { id: task.id, reward: 0, dbMatch: false, actionMatch: false,
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

const pass = results.filter((r) => r.reward).length;
console.log(`  ${"─".repeat(84)}`);
if (TRIALS > 1) {
  for (let k = 1; k <= TRIALS; k++) {
    const { passed, of } = passAtK(results, k);
    console.log(`  pass^${k} = ${passed}/${of} = ${of ? (100 * passed / of).toFixed(1) : "0.0"}%`);
  }
}
console.log(`  pass^1 = ${pass}/${results.length} = ${(100 * pass / results.length).toFixed(1)}%   ` +
  `${results.reduce((a, r) => a + r.seconds, 0)}s wall`);

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
const act = await api("/bench/activity").catch(() => null);
if (act) {
  const wall = results.reduce((a, r) => a + r.seconds, 0);
  console.log(`  object billed ${(act.activeMs / 1000).toFixed(1)}s of ${wall}s wall ` +
    `(${wall ? Math.round((act.activeMs / 1000 / wall) * 100) : 0}%)` +
    (act.pollMs ? `, of which ${(act.pollMs / 1000).toFixed(1)}s is this runner polling` : ""));
}
const recorded = recordRun("tau2", OBJ, {
  bench: "tau2-retail", base: BASE, build: await workerBuild(BASE), driver: driverCommit(), object: `bench-${OBJ}`, model: MODEL_ID, wait: WAIT,
  tasks: selected.map((t) => t.id), trials: TRIALS, startedAt: new Date(t0Run).toISOString(),
  results, passAtK: TRIALS > 1 ? Object.fromEntries([...Array(TRIALS)].map((_, k) => [k + 1, passAtK(results, k + 1)])) : undefined,
  tools: toolTotals, endingsAllRows: allEndings, failingRowsByEndingAndCause: failEndings, activity: act,
});
console.log(`  recorded ${recorded}`);
console.log();
