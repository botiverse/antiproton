/**
 * τ²-bench retail against the Cloudflare deployment.
 *
 * Same tasks, same user simulator, same scoring as bench/tau2/run.ts — the only
 * difference is that the agent runs in a Durable Object instead of in-process.
 * That makes it an instrument for Cloudflare-specific ablations: set OFFLOAD=0
 * or 1 and the only thing that changes is where the model call is awaited.
 *
 *   OFFLOAD=1 N=6 node --experimental-strip-types bench/tau2/cf.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { applyRetailAction, WRITE_TOOLS, type RetailDB } from "./retail.ts";

for (const l of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

const BASE = process.env.CF_BASE ?? "https://antiproton.botiverse.workers.dev";
const here = new URL("./data/", import.meta.url).pathname;
const BASE_DB: RetailDB = JSON.parse(readFileSync(here + "db.json", "utf8"));
const TASKS: any[] = JSON.parse(readFileSync(here + "tasks.json", "utf8"));
const POLICY = readFileSync(here + "policy.md", "utf8");
const GUIDELINES = readFileSync(here + "simulation_guidelines.md", "utf8");

const MODEL = process.env.HARNESS_MODEL ?? "deepseek-v4-pro";
const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!, model: MODEL,
});

const canon = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(",")}}`;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Set per arm: every bench call is addressed to that arm's own object. */
let OBJ = "v1";
async function api(path: string, init?: RequestInit): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const url = path.startsWith("/bench") ? `${BASE}${path}${sep}obj=${OBJ}` : BASE + path;
  const r = await fetch(url, init);
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`${path} -> ${r.status} ${t.slice(0, 200)}`); }
}
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function gold(task: any) {
  const db = structuredClone(BASE_DB);
  const applied: Array<{ name: string; args: any }> = [];
  for (const a of task.evaluation_criteria?.actions ?? []) {
    if (!WRITE_TOOLS.has(a.name)) continue;
    applyRetailAction(db, a.name, a.arguments);
    applied.push({ name: a.name, args: a.arguments });
  }
  return { hash: sha(canon(db)), expected: applied };
}

async function runTask(task: any, offload: boolean, tag: string, verbose: boolean) {
  const taskId = `${task.id}_${offload ? "on" : "off"}_${tag}`;
  const t0 = Date.now();
  await post("/bench/start", { taskId, policy: POLICY, offload });

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

  while (turns++ < 14) {
    sim.push({ role: "user", content: agentSaid });
    const u = await model.complete(sim, { maxTokens: 2000 });
    simCalls++;
    sim.push({ role: "assistant", content: u.text });
    const stop = /###(STOP|TRANSFER|OUT-OF-SCOPE)###/.exec(u.text);
    if (verbose) console.log(`    user  > ${u.text.replace(/\s+/g, " ").slice(0, 120)}`);
    if (stop) { ended = stop[1]!.toLowerCase(); break; }

    const said = await post("/bench/say", { taskId, text: u.text });
    // A stale answer looks exactly like a fresh one, so wait for the checkpoint
    // to move past the version that existed when we spoke.
    const before = said.checkpointVersion ?? 0;
    let answered: string | null = null;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await api(`/bench/poll?taskId=${taskId}`);
      if (s.answer && s.checkpointVersion > before) { answered = s.answer; break; }
    }
    if (!answered) { ended = "timeout"; console.log(`    [stalled task ${taskId} on object ${OBJ}]`); break; }
    agentSaid = answered;
    if (verbose) console.log(`    agent > ${answered.replace(/\s+/g, " ").slice(0, 120)}`);
  }

  const res = await api(`/bench/result?taskId=${taskId}`);
  const g = gold(task);
  const dbMatch = res.dbHash === g.hash;
  const actionMatch = g.expected.every((e) =>
    (res.writes ?? []).some((w: any) => w.name === e.name && canon(w.args) === canon(e.args)));
  return {
    id: task.id, offload, reward: dbMatch && actionMatch ? 1 : 0, dbMatch, actionMatch, ended,
    turns: turns - 1, seconds: Math.round((Date.now() - t0) / 1000),
    modelCalls: res.usage?.calls ?? 0, simCalls,
    prompt: res.usage?.prompt ?? 0, completion: res.usage?.completion ?? 0,
    expectedWrites: g.expected.map((e) => e.name),
    performedWrites: (res.writes ?? []).map((w: any) => w.name),
  };
}

// ---------------------------------------------------------------------- main
const N = Number(process.env.N ?? 4);
const OFFSET = Number(process.env.OFFSET ?? 0);
const verbose = !!process.env.VERBOSE;
const modes = (process.env.MODES ?? "off,on").split(",");
const tag = process.env.TAG ?? Math.random().toString(36).slice(2, 6);
const selected = TASKS.slice(OFFSET, OFFSET + N);

console.log(`\n  τ²-bench retail on Cloudflare — ${selected.length} tasks, model ${MODEL}`);
console.log(`  variable: where the model call is awaited (DO vs Worker)\n  ${"─".repeat(76)}`);

const all: any[] = [];
for (const mode of modes) {
  const offload = mode === "on";
  OBJ = `${tag}-${mode}`;
  await api("/bench/activity/reset");
  const t0 = Date.now();
  const rows: any[] = [];
  for (const task of selected) {
    let r;
    try { r = await runTask(task, offload, tag, verbose); }
    catch (e) {
      r = { id: task.id, offload, reward: 0, dbMatch: false, actionMatch: false,
            ended: `error: ${(e as Error).message.slice(0, 70)}`, turns: 0, seconds: 0,
            modelCalls: 0, simCalls: 0, prompt: 0, completion: 0,
            expectedWrites: [], performedWrites: [] };
    }
    rows.push(r); all.push(r);
    const mark = r.reward ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  [${mode.padEnd(3)}] ${mark} task ${String(r.id).padEnd(4)} db=${r.dbMatch ? "ok " : "NO "} ` +
      `act=${r.actionMatch ? "ok " : "NO "} ${String(r.ended).padEnd(12)} ${r.turns}t / ${r.modelCalls}c / ${r.seconds}s`);
  }
  const act = await api("/bench/activity");
  const wall = Date.now() - t0;
  (rows as any).meta = { mode, act, wall };
  const kind = (k: string) => (act.byKind ?? []).find((x: any) => x.kind === k) ?? { n: 0, ms: 0 };
  all.push({ _meta: true, mode, activeMs: act.activeMs, invocations: act.invocations,
             byKind: act.byKind, wallMs: wall,
             // Guard against the arm silently running in the other mode.
             delivered: kind("deliverModel").n, alarmMs: kind("alarm").ms,
             alarms: kind("alarm").n,
             pass: rows.filter((r) => r.reward).length, n: rows.length,
             prompt: rows.reduce((a, r) => a + r.prompt, 0),
             completion: rows.reduce((a, r) => a + r.completion, 0) });
}

console.log(`  ${"─".repeat(76)}\n`);
console.log("  mode  pass   DO active(s)  alarms  alarm(s)  offloaded  wall(s)   prompt tok");
for (const m of all.filter((r) => r._meta)) {
  console.log(`  ${m.mode.padEnd(5)} ${String(m.pass + "/" + m.n).padEnd(6)} ` +
    `${(m.activeMs / 1000).toFixed(1).padStart(11)} ${String(m.alarms).padStart(7)} ` +
    `${(m.alarmMs / 1000).toFixed(1).padStart(9)} ${String(m.delivered).padStart(10)} ` +
    `${(m.wallMs / 1000).toFixed(0).padStart(8)} ${String(m.prompt).padStart(12)}`);
}
// An "off" arm that offloaded, or an "on" arm that did not, is not a control.
for (const m of all.filter((r) => r._meta)) {
  const bad = (m.mode === "off" && m.delivered > 0) || (m.mode === "on" && m.delivered === 0);
  if (bad) console.log(`\n  \x1b[31mCONTAMINATED\x1b[0m: mode "${m.mode}" recorded ${m.delivered} offloaded deliveries`);
}
const off = all.find((r) => r._meta && r.mode === "off");
const on = all.find((r) => r._meta && r.mode === "on");
if (off && on) {
  console.log(`\n  DO active wall clock: ${(off.activeMs / 1000).toFixed(1)}s -> ${(on.activeMs / 1000).toFixed(1)}s ` +
    `(${(100 * (off.activeMs - on.activeMs) / off.activeMs).toFixed(1)}% less, ${(off.activeMs / Math.max(on.activeMs, 1)).toFixed(1)}x)`);
  console.log(`  billed DO duration @ 128MB: $${(off.activeMs / 1000 * 0.125 * 12.5e-6).toFixed(6)} -> ` +
    `$${(on.activeMs / 1000 * 0.125 * 12.5e-6).toFixed(6)} per ${off.n} tasks\n`);
}
