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
 * bench/record.ts); where a record field is computed differently, bench/tau2/api-record.ts says how. The run
 * itself is bench/tau2/api-run.ts; this file reads the environment, the secrets and the task data.
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
import { driverCommit, workerBuild } from "../record.ts";
import { runOrder } from "./plan.ts";
import { readDeafness } from "./deafness.ts";
import { apiClient } from "./api-client.ts";
import { runApiBench } from "./api-run.ts";

for (const l of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

// As in the `/bench` runner: the workers.dev address, without the interactive gate in front of the custom host.
const BASE = process.env.BENCH_BASE ?? "https://antiproton.botiverse.workers.dev";
const TOKEN = process.env.HARNESS_AUTOMATION_TOKEN ?? "";
if (!TOKEN) throw new Error("HARNESS_AUTOMATION_TOKEN is not set: the run's key is minted with it");
const SIM_MODEL = process.env.HARNESS_MODEL ?? "deepseek-flash";
const N = Number(process.env.N ?? 5);
const OFFSET = Number(process.env.OFFSET ?? 0);

const here = new URL("./data/", import.meta.url).pathname;
const BASE_DB: RetailDB = JSON.parse(readFileSync(here + "db.json", "utf8"));
const TASKS: any[] = JSON.parse(readFileSync(here + "tasks.json", "utf8"));

const simModel = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!, model: SIM_MODEL,
});

const { code } = await runApiBench({
  client: apiClient({ base: BASE, harnessToken: TOKEN }),
  sim: (m, o) => simModel.complete(m, o),
  baseDb: BASE_DB,
  tasks: TASKS.slice(OFFSET, OFFSET + N),
  policy: readFileSync(here + "policy.md", "utf8"),
  guidelines: readFileSync(here + "simulation_guidelines.md", "utf8"),
  model: process.env.MODEL || "default",
  trials: Number(process.env.TRIALS ?? 1),
  order: runOrder(process.env.ORDER),
  deafness: readDeafness(process.env.IGNORE_ANSWERS),
  verbose: !!process.env.VERBOSE,
  base: BASE,
  build: () => workerBuild(BASE),
  driver: driverCommit(),
  tee: true,
});
process.exit(code);
