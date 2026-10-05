/**
 * One run of the Agents API τ² runner (bench/tau2/api.ts), with everything it touches handed in, so a test can
 * run it whole against a Worker in its own process and read its exit code and its files.
 *
 * The run stops, writes no record and exits non-zero when it cannot say truthfully which model it ran
 * (`RunRefusal`, bench/tau2/api-task.ts): a model the deployment refuses is found by `preflight` before task 1
 * and before any file is written; a ledger that cannot vouch for a row is found after that row.
 *
 * Whatever the run made is undone however it ends: the key is revoked and the agents still in the API's index
 * are deleted in a `finally`, and on SIGINT or SIGTERM by the handler below, which a `finally` does not cover
 * (the process exits from the signal without unwinding).
 */
import type { RetailDB } from "./retail.ts";
import { argDiff } from "./grade.ts";
import { SIM } from "./episode.ts";
import { beginRun, recordRun, teeRun } from "../record.ts";
import { passLines } from "./passk.ts";
import { runPlan, type RunOrder } from "./plan.ts";
import { deafnessBudget, type Deafness } from "./deafness.ts";
import { retailFunctions } from "./api-tools.ts";
import { deleteLive, preflight, RunRefusal, runApiTask, type ApiTaskDeps } from "./api-task.ts";
import { apiRunRecord, type ModelsList } from "./api-record.ts";
import type { ApiClient } from "./api-client.ts";

export interface ApiRunOptions {
  client: ApiClient;
  sim: ApiTaskDeps["sim"];
  baseDb: RetailDB;
  tasks: any[];
  policy: string;
  guidelines: string;
  model: string;
  trials: number;
  order: RunOrder;
  deafness?: Deafness;
  verbose?: boolean;
  base: string;
  build(): Promise<string | null>;
  driver: unknown;
  /** The runs tree (bench/record.ts); the report's own when unset. */
  runs?: string;
  /** Send console output to the run's log as well (bench/record.ts `teeRun`). Off in a test. */
  tee?: boolean;
  /** Where SIGINT/SIGTERM handlers are installed; `process.once` when unset. */
  onSignal?(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  /** How the process ends after an interrupt; `process.exit` when unset. */
  exit?(code: number): void;
  timing?: Pick<ApiTaskDeps, "turnTimeoutMs" | "lookEveryMs" | "ledgerWaitMs">;
}

export const TENANT = "bench", OWNER = "tau2-api";

export async function runApiBench(o: ApiRunOptions): Promise<{ code: number; record: string | null; why?: string }> {
  const c = o.client;
  const live = new Set<string>();
  const say = (line: string) => console.log(line);
  // A deployment that cannot name an option's provider cannot have a row checked against its ledger, and
  // every task would be refused after it had run.
  const models: ModelsList = await c.operator("/admin/models");
  if (!Array.isArray(models.options)) {
    const why = `${o.base}/admin/models lists no options: this deployment predates the list the provider check reads`;
    console.error(`  ${why}`);
    return { code: 1, record: null, why };
  }

  // One key for the run, in memory only: never in the record or the log.
  await c.issueKey(TENANT, OWNER, `tau2-api-${Date.now().toString(36)}`);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await deleteLive(c, live).catch(() => {});
    if (!(await c.revokeKey())) console.error("  the run's key could not be revoked: it is live until it is revoked by hand");
  };
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const onSignal = o.onSignal ?? ((s, h) => { process.once(s, h); });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    onSignal(signal, () => {
      console.error(`\n  ${signal}: deleting this run's agents and revoking its key`);
      void cleanup().finally(() => exit(code));
    });
  }

  const deps = (): ApiTaskDeps => ({
    client: c, sim: o.sim, baseDb: o.baseDb, policy: o.policy, guidelines: o.guidelines, tools: retailFunctions(),
    model: o.model, models, tenantId: TENANT, deafness, deafSetting: o.deafness, live, ...o.timing,
    say: o.verbose ? say : undefined,
  });
  const deafness = deafnessBudget(o.deafness);

  const results: any[] = [];
  let refused: string | null = null;
  let run: ReturnType<typeof beginRun> | null = null;
  const t0Run = Date.now();
  try {
    try { await preflight(deps()); }
    catch (e) {
      if (!(e instanceof RunRefusal)) throw e;
      console.error(`  no run: ${e.message}`);
      return { code: 1, record: null, why: e.message };
    }
    run = o.runs ? beginRun("tau2", `api-${o.model}`, o.runs) : beginRun("tau2", `api-${o.model}`);
    if (o.tee) teeRun(run);
    console.log(`\n  τ²-bench retail over the Agents API — ${o.tasks.length} task(s) × ${o.trials} trial(s) in ${o.order} order, ` +
      `agents on ${o.model}\n  on ${o.base}, one agent per task in ${TENANT}/${OWNER}\n  ${"─".repeat(84)}`);
    for (const { task, trial } of runPlan(o.tasks, o.trials, o.order)) {
      if (o.verbose) console.log(`\n  task ${task.id} (trial ${trial})`);
      let r: any;
      try { r = await runApiTask(task, deps()); }
      catch (e) {
        if (e instanceof RunRefusal) { refused = e.message; break; }
        r = { id: task.id, engine: null, reward: 0, dbMatch: false, actionMatch: false,
              ended: `error: ${(e as Error).message.slice(0, 80)}`, turns: 0, simCalls: 0,
              usage: {}, kinds: {}, byTool: {}, seconds: 0, expectedWrites: [], performedWrites: [] };
      }
      results.push({ ...r, trial });
      const mark = r.reward ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(`  ${mark} task ${String(r.id).padEnd(4)} db=${r.dbMatch ? "ok " : "NO "}` +
        `act=${r.actionMatch ? "ok " : "NO "} ${String(r.ended).padEnd(13)} ` +
        `${r.turns} turns / ${r.usage?.calls ?? "?"} calls / ${r.usage?.prompt ?? "?"} tok / ${r.seconds}s` +
        `${r.provider ? ` / ${r.provider.name}` : ""}`);
      if (!r.reward && (r.expectedWrites.length || r.performedWrites.length)) {
        console.log(`      expected: [${r.expectedWrites.join(", ")}]  performed: [${r.performedWrites.join(", ")}]`);
        for (const line of argDiff(r.expectedArgs ?? [], r.performedArgs ?? [])) console.log(`        ${line}`);
      }
    }
  } finally {
    await cleanup();
  }

  const built = apiRunRecord({
    base: o.base, build: await o.build(), driver: o.driver, tenantId: TENANT, owner: OWNER,
    modelRequested: o.model, sim: SIM, tasks: o.tasks.map((t) => t.id), trials: o.trials, order: o.order,
    ...(o.deafness ? { ignoreAnswers: o.deafness } : {}), startedAt: new Date(t0Run).toISOString(), results,
  });
  if (refused || !built.ok) {
    // Not written: a record says which model its rows ran on, and this run cannot say it truthfully.
    const why = refused ?? (built as { why: string }).why;
    console.error(`  no record written: ${why}`);
    return { code: 1, record: null, why };
  }
  const body = built.body as any;
  console.log(`  ${"─".repeat(84)}`);
  for (const line of passLines(results, o.trials)) console.log(line);
  const wall = results.reduce((a, r) => a + r.seconds, 0);
  console.log(`  ${wall}s wall`);
  const tally = (t: Record<string, number>) => Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  ");
  console.log(`  tools: ${tally(body.tools) || "(none)"}`);
  console.log(`  endings, all ${results.length} rows: ${tally(body.endingsAllRows) || "(none)"}`);
  if (Object.keys(body.failingRowsByEndingAndCause).length) console.log(`  failures by ending: ${tally(body.failingRowsByEndingAndCause)}`);
  // What the agents' objects were billed for, one object per task (`activity` in bench/tau2/api-record.ts).
  console.log(`  objects billed ${(body.activity.activeMs / 1000).toFixed(1)}s of ${wall}s wall ` +
    `(${wall ? Math.round((body.activity.activeMs / 1000 / wall) * 100) : 0}%) / provider ${body.provider ? `${body.provider.name} at ${body.provider.endpoint}` : "none (no model call)"}`);
  const record = recordRun(run!, body);
  console.log(`  recorded ${record}\n`);
  return { code: 0, record };
}
