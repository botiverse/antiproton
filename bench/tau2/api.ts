/**
 * τ²-bench retail over the public Agents API only.
 *
 * The `/bench` runner (bench/tau2/cf.ts) reaches into the object through routes made for it: a mounted
 * retail plugin, a base database in R2, a result endpoint that hashes the object's own copy. This one is an
 * API caller like any other. It mints a key for the run, creates one agent per task with the retail tools as
 * its own functions, runs those functions here on the task's database, and grades that database. So what is
 * measured is what a customer of the API gets, and the `/bench` routes can go once the two agree (the
 * parallel run that decides it compares records of both, segmented by `runnerMethod`).
 *
 * Same tasks, simulator, grading and record as the `/bench` runner (bench/tau2/episode.ts, grade.ts,
 * bench/record.ts); where a record field is computed differently, bench/tau2/api-record.ts says how.
 *
 *   MODEL=default N=8 TRIALS=3 node bench/tau2/api.ts
 *   MODEL=gpt-5.6-luna N=8 TRIALS=3 node bench/tau2/api.ts
 *
 * MODEL is what the agents are created with: "default" (what the deployment runs for the tenant) or one of
 * the options /admin/models lists. The simulator stays on HARNESS_MODEL through DEEPSEEK_BASE_URL, as in the
 * `/bench` runner, in both arms. Credentials come from ~/.secrets/antiproton.env as there.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import type { RetailDB } from "./retail.ts";
import { argDiff } from "./grade.ts";
import { SIM } from "./episode.ts";
import { beginRun, driverCommit, recordRun, teeRun, workerBuild } from "../record.ts";
import { passLines } from "./passk.ts";
import { runOrder, runPlan } from "./plan.ts";
import { deafnessBudget, readDeafness } from "./deafness.ts";
import { apiClient } from "./api-client.ts";
import { retailFunctions } from "./api-tools.ts";
import { ProviderRefusal, runApiTask } from "./api-task.ts";
import { apiRunRecord, type ModelsList } from "./api-record.ts";

for (const l of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

// As in the `/bench` runner: the workers.dev address, without the interactive gate in front of the custom host.
const BASE = process.env.BENCH_BASE ?? "https://antiproton.botiverse.workers.dev";
const TOKEN = process.env.HARNESS_AUTOMATION_TOKEN ?? "";
const MODEL = process.env.MODEL || "default";
const SIM_MODEL = process.env.HARNESS_MODEL ?? "deepseek-flash";
const TRIALS = Number(process.env.TRIALS ?? 1);
const N = Number(process.env.N ?? 5);
const OFFSET = Number(process.env.OFFSET ?? 0);
const VERBOSE = !!process.env.VERBOSE;
const DEAFNESS = readDeafness(process.env.IGNORE_ANSWERS);
const deafness = deafnessBudget(DEAFNESS);
const ORDER = runOrder(process.env.ORDER);
/** The tenant the run's agents live in, and the owner its key acts for. */
const TENANT = "bench", OWNER = "tau2-api";

if (!TOKEN) throw new Error("HARNESS_AUTOMATION_TOKEN is not set: the run's key is minted with it");

const here = new URL("./data/", import.meta.url).pathname;
const BASE_DB: RetailDB = JSON.parse(readFileSync(here + "db.json", "utf8"));
const TASKS: any[] = JSON.parse(readFileSync(here + "tasks.json", "utf8"));
const POLICY = readFileSync(here + "policy.md", "utf8");
const GUIDELINES = readFileSync(here + "simulation_guidelines.md", "utf8");

const simModel = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!, model: SIM_MODEL,
});

const client = apiClient({ base: BASE, harnessToken: TOKEN });

// Before anything is made: a deployment that cannot name an option's provider cannot have a row checked
// against its ledger, and every task would be refused after it had run.
const models: ModelsList = await client.operator("/admin/models");
if (!Array.isArray(models.options)) throw new Error(`${BASE}/admin/models lists no options: this deployment predates the list the provider check reads`);

const selected = TASKS.slice(OFFSET, OFFSET + N);
const run = beginRun("tau2", `api-${MODEL}`);
teeRun(run);
console.log(`\n  τ²-bench retail over the Agents API — ${selected.length} task(s) × ${TRIALS} trial(s) in ${ORDER} order, ` +
  `agents on ${MODEL}, simulator ${SIM_MODEL}\n  on ${BASE}, one agent per task in ${TENANT}/${OWNER}\n  ${"─".repeat(84)}`);

// One key for the run, in memory only: never in the record or the log.
await client.issueKey(TENANT, OWNER, `tau2-${run.runId}`);

const results: any[] = [];
const t0Run = Date.now();
let refused: string | null = null;
try {
  for (const { task, trial } of runPlan(selected, TRIALS, ORDER)) {
    if (VERBOSE) console.log(`\n  task ${task.id} (trial ${trial})`);
    let r;
    try {
      r = await runApiTask(task, {
        client, sim: (m, o) => simModel.complete(m, o), baseDb: BASE_DB, policy: POLICY, guidelines: GUIDELINES,
        tools: retailFunctions(), model: MODEL, models, tenantId: TENANT,
        deafness, deafSetting: DEAFNESS, say: VERBOSE ? (line) => console.log(line) : undefined,
      });
    } catch (e) {
      if (e instanceof ProviderRefusal) { refused = e.message; break; }
      r = { id: task.id, engine: null, reward: 0, dbMatch: false, actionMatch: false,
            ended: `error: ${(e as Error).message.slice(0, 80)}`, turns: 0, simCalls: 0,
            usage: {}, kinds: {}, byTool: {}, seconds: 0, expectedWrites: [], performedWrites: [] };
    }
    results.push({ ...r, trial });
    const mark = r.reward ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${mark} task ${String(r.id).padEnd(4)} db=${r.dbMatch ? "ok " : "NO "}` +
      `act=${r.actionMatch ? "ok " : "NO "} ${String(r.ended).padEnd(13)} ` +
      `${r.turns} turns / ${(r.usage as any)?.calls ?? "?"} calls / ${(r.usage as any)?.prompt ?? "?"} tok / ${r.seconds}s` +
      `${"provider" in r && r.provider ? ` / ${r.provider.name}` : ""}`);
    if (!r.reward && (r.expectedWrites.length || r.performedWrites.length)) {
      console.log(`      expected: [${r.expectedWrites.join(", ")}]  performed: [${r.performedWrites.join(", ")}]`);
      for (const line of argDiff((r as any).expectedArgs ?? [], (r as any).performedArgs ?? [])) console.log(`        ${line}`);
    }
  }
} finally {
  if (!(await client.revokeKey())) {
    console.error(`  the run's key (label tau2-${run.runId}) could not be revoked: it is live until it is revoked by hand`);
  }
}

const built = apiRunRecord({
  base: BASE, build: await workerBuild(BASE), driver: driverCommit(), tenantId: TENANT, owner: OWNER,
  modelRequested: MODEL, sim: SIM, tasks: selected.map((t) => t.id), trials: TRIALS, order: ORDER,
  ...(DEAFNESS ? { ignoreAnswers: DEAFNESS } : {}), startedAt: new Date(t0Run).toISOString(), results,
});
if (refused || !built.ok) {
  // Not written: a record says which model its rows ran on, and this run cannot say it truthfully.
  console.error(`  no record written: ${refused ?? (built as { why: string }).why}`);
  process.exit(1);
}
const body = built.body as any;

console.log(`  ${"─".repeat(84)}`);
for (const line of passLines(results, TRIALS)) console.log(line);
const wall = results.reduce((a, r) => a + r.seconds, 0);
console.log(`  ${wall}s wall`);
console.log(`  tools: ${Object.entries(body.tools as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join("  ") || "(none)"}`);
const tally = (t: Record<string, number>) => Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  ");
console.log(`  endings, all ${results.length} rows: ${tally(body.endingsAllRows) || "(none)"}`);
if (Object.keys(body.failingRowsByEndingAndCause).length) console.log(`  failures by ending: ${tally(body.failingRowsByEndingAndCause)}`);
// What the agents' objects were billed for, one object per task (`activity` in bench/tau2/api-record.ts).
console.log(`  objects billed ${(body.activity.activeMs / 1000).toFixed(1)}s of ${wall}s wall ` +
  `(${wall ? Math.round((body.activity.activeMs / 1000 / wall) * 100) : 0}%) / provider ${body.provider ? `${body.provider.name} at ${body.provider.endpoint}` : "none (no model call)"}`);
console.log(`  recorded ${recordRun(run, body)}`);
console.log();
