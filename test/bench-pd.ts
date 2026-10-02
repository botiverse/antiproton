/**
 * The τ² bench on the pd engine (cf/src/index.ts `benchStart`, cf/src/bench.ts `chooseBenchEngine`,
 * bench/objects.ts): a run of two tasks, each in an object of its own as the driver addresses them, both
 * completing on pd, each answering with its usage, its activity and its engine; an object that hosted a
 * task refusing a second pd one; and pi085's shared object going on as it was, writing no engine.
 *
 * The whole `AgentDO` under node, as test/usage-flush.ts runs it: a `cloudflare:workers` stand-in, a
 * virtual clock that jumps to the armed alarm, D1 as node:sqlite with the two usage tables, and the model
 * faked at the queue (`takeJob` / `deliverAnswer`, what cf/src/model-queue.ts calls).
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { benchEngine, objectsShape, sumActivity, taskObject } from "../bench/objects.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

let clock = Date.now();
Date.now = () => ++clock;

/** D1 as node:sqlite, holding what the usage flush writes; the rest of D1 reads as empty. */
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE usage_cursor(tenant_id TEXT, agent_id TEXT, last_seq INTEGER, PRIMARY KEY(tenant_id, agent_id))");
  db.exec(`CREATE TABLE usage_hourly(tenant_id TEXT, hour INTEGER, agent_id TEXT, resource TEXT, key TEXT, unit TEXT, quantity REAL,
    PRIMARY KEY(tenant_id, hour, agent_id, resource, key, unit))`);
  const stmt = (q: string, b: unknown[] = []) => ({
    q, b,
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => { try { return (db.prepare(q).get(...(b as any[])) as any) ?? null; } catch { return null; } },
    all: async () => { try { return { results: db.prepare(q).all(...(b as any[])) }; } catch { return { results: [] }; } },
    run: async () => { try { return { meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }; } catch { return { meta: { changes: 0 } }; } },
  });
  return {
    prepare: (q: string) => stmt(q),
    batch: async (s: Array<ReturnType<typeof stmt>>) =>
      s.map((x) => { try { return { results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } }; } catch { return { results: [], meta: { changes: 0 } }; } }),
    tokens(agentId: string) {
      return Number((db.prepare("SELECT SUM(quantity) AS q FROM usage_hourly WHERE resource = 'model.tokens' AND agent_id = ?").get(agentId) as any)?.q ?? 0);
    },
  };
}

/** The base database the bench plugin replays a task's writes onto; the turns here make none. */
const BASE_DB = JSON.stringify({ products: {}, users: {}, orders: {} });
const control = d1();

/** One bench object, as `bench-${obj}` names it: its own storage and alarm, the shared D1 and bucket. */
function object() {
  const raw = sqliteHost();
  const jobs: string[] = [];
  const state = { alarmAt: null as number | null };
  const ctx = {
    storage: {
      sql: raw.sql, transactionSync: raw.transactionSync,
      getAlarm: async () => state.alarmAt,
      setAlarm: async (at: number) => { state.alarmAt = at; },
      deleteAlarm: async () => { state.alarmAt = null; },
    },
    id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
  };
  const env = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: {
      put: async () => ({}), head: async () => null, list: async () => ({ objects: [] }),
      get: async (key: string) => (key === "bench/tau2-db.json" ? { text: async () => BASE_DB } : null),
    },
    ARTIFACT_BUCKET: "b", CONTROL_DB: control, HARNESS_MODEL: "m1",
    DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k",
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
  };
  const D = new AgentDO(ctx as never, env as never);
  const USAGE = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  /** Fire the armed alarm until none is, answering every model job the object sends with `text`. */
  const settle = async (agentId: string, text: string, max = 60) => {
    let passes = 0;
    for (;;) {
      if (jobs.length) {
        const id = jobs.shift()!;
        const job = await D.takeJob("bench", agentId, id) as any;
        await D.deliverAnswer("bench", agentId, id, { role: "assistant", content: [{ type: "text", text }], api: job?.model?.api ?? "x", provider: job?.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0 }, 5);
        continue;
      }
      if (state.alarmAt === null) return passes;
      must(passes < max, `the object did not settle in ${max} passes`);
      clock = Math.max(clock, state.alarmAt);
      passes++;
      await D.alarm();
      clock += 5;
    }
  };
  const tables = () => raw.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r: any) => String(r.name));
  return { D, raw, settle, tables };
}

/** One τ² task as bench/tau2/cf.ts drives it: start, one customer turn, the answer, the result, the activity. */
async function task(o: ReturnType<typeof object>, taskId: string, engine: string | undefined, reply: string) {
  const started = await o.D.benchStart(taskId, "policy", true, engine);
  await o.D.benchSay(taskId, `hello from ${taskId}`);
  await o.settle(`b_${taskId}`, reply);
  const poll = await o.D.benchPoll(taskId) as any;
  const result = await o.D.benchResult(taskId) as any;
  const activity = await o.D.activity() as any;
  return { started, poll, result, activity };
}

const OBJ = "pdtest";
const shape = objectsShape(benchEngine("pd"), undefined);
const taskIds = ["t_0_a", "t_1_b"];
const objects = new Map<string, ReturnType<typeof object>>();
const ran: Array<Awaited<ReturnType<typeof task>> & { taskId: string; obj: string }> = [];

await check("a run of two τ² tasks on pd completes both, each in an object of its own, each recorded as pd", async () => {
  for (const [i, taskId] of taskIds.entries()) {
    const obj = taskObject(OBJ, shape, taskId);
    must(!objects.has(obj), `two tasks share ${obj}`);
    const o = object();
    objects.set(obj, o);
    const r = await task(o, taskId, "pd", `answer ${i}`);
    must(r.started.engine === "pd", `benchStart answered ${show(r.started)}`);
    must(r.poll.status === "idle" && r.poll.answer === `answer ${i}`, `task ${taskId} did not complete: ${show(r.poll)}`);
    must(o.tables().includes("ap_meta") && o.tables().some((t) => t.startsWith("pd_")), `not a pd object: ${show(o.tables())}`);
    // Nothing of the task ran on pi 0.85's tables (made empty by every object's constructor).
    const piRows = Number((o.raw.sql.exec("SELECT COUNT(*) AS n FROM pi_entries").toArray()[0] as any).n);
    must(piRows === 0, `${piRows} rows in pi_entries`);
    ran.push({ ...r, taskId, obj });
  }
  must(ran.length === 2, `${ran.length} tasks ran`);
});

await check("each pd task's result carries its model usage and its object's active time", async () => {
  must(ran.length === 2, "the run did not complete");
  for (const r of ran) {
    must(r.result.usage.calls === 1 && r.result.usage.prompt === 7 && r.result.usage.completion === 3,
      `${r.taskId}: usage ${show(r.result.usage)}`);
    must(r.activity.activeMs > 0 && r.activity.byKind.some((k: any) => k.kind === "alarm"), `${r.taskId}: activity ${show(r.activity)}`);
  }
  // SWE-bench's per-instance figures are read from the same transcript, by its own reader.
  const swe = await objects.get(ran[0]!.obj)!.D.benchSweStats(ran[0]!.taskId, 1_000) as any;
  must(swe.usage.calls === 1 && swe.usage.prompt === 7 && swe.usage.out === 3 && swe.modelTurns === 1, `swe stats ${show(swe.usage)}`);
  const sum = sumActivity(ran.map((r) => r.activity));
  must(sum.objects === 2 && sum.activeMs === ran[0]!.activity.activeMs + ran[1]!.activity.activeMs, `sum ${show(sum)}`);
});

await check("pd usage reaches the ledger through the commit hook, under each task's agent", async () => {
  must(ran.length === 2, "the run did not complete");
  for (const r of ran) {
    const tokens = control.tokens(`b_${r.taskId}`);
    must(tokens === 10, `${r.taskId}: ${tokens} model tokens in the ledger`);
  }
});

await check("an object that hosted a task refuses a second pd task, and a pi085 one", async () => {
  const o = objects.get(taskObject(OBJ, shape, taskIds[0]!))!;
  for (const engine of ["pd", "pi085", undefined]) {
    let refused = "";
    try { await o.D.benchStart("t_9_z", "policy", true, engine); } catch (e) { refused = String((e as Error).message); }
    must(refused !== "", `benchStart(${engine}) on a used pd object succeeded`);
  }
  // Still the first task's, answer and all.
  const poll = await o.D.benchPoll(taskIds[0]!) as any;
  must(poll.answer === "answer 0", `the first task's transcript moved: ${show(poll)}`);
  // And a pi085 object that hosted a task cannot be turned into a pd one either.
  const p = object();
  await p.D.benchStart("t_8_y", "policy", true);
  let refused = "";
  try { await p.D.benchStart("t_7_x", "policy", true, "pd"); } catch (e) { refused = String((e as Error).message); }
  must(/object of its own/.test(refused), `a used pi085 object took a pd task: ${refused}`);
  let unknown = "";
  try { await object().D.benchStart("t_6_w", "policy", true, "pi99"); } catch (e) { unknown = String((e as Error).message); }
  must(/unknown bench engine/.test(unknown), `an unknown engine: ${unknown}`);
});

await check("a pd task's transcript is read back from its object, unarchived", async () => {
  must(ran.length === 2, "the run did not complete");
  const o = objects.get(ran[1]!.obj)!;
  const t = await o.D.benchTrajectory(ran[1]!.taskId) as any;
  must(t.entries.some((e: any) => JSON.stringify(e).includes("answer 1")), `trajectory: ${show(t).slice(0, 300)}`);
  const diag = await o.D.benchDiag() as any;
  must(diag.modelJobs.length === 1, `diag jobs: ${show(diag.modelJobs)}`);
});

await check("pi085 keeps its shared object: two tasks in turn, each on a cleared transcript, no engine written", async () => {
  const o = object();
  const one = await task(o, "t_0_p", undefined, "first");
  const two = await task(o, "t_1_q", "pi085", "second");
  must(one.started.engine === "pi085" && two.started.engine === "pi085", `engines ${show([one.started, two.started])}`);
  must(one.poll.answer === "first" && two.poll.answer === "second", `answers ${show([one.poll, two.poll])}`);
  // The second task did not start on the first one's conversation.
  must(two.result.usage.calls === 1, `the second task's usage ${show(two.result.usage)}`);
  must(!o.tables().includes("ap_meta"), `a pi085 bench object recorded an engine: ${show(o.tables())}`);
});

await check("the drivers' engine and object shape: pd is always one object per task, pi085 shared unless asked", () => {
  must(benchEngine(undefined) === "pi085" && benchEngine("") === "pi085" && benchEngine("pd") === "pd", "engine defaults");
  let threw = false;
  try { benchEngine("pi"); } catch { threw = true; }
  must(threw, "an unknown ENGINE was accepted");
  must(objectsShape("pd", undefined) === "per-task" && objectsShape("pi085", undefined) === "shared"
    && objectsShape("pi085", "per-task") === "per-task", "shapes");
  threw = false;
  try { objectsShape("pd", "shared"); } catch { threw = true; }
  must(threw, "ENGINE=pd OBJECTS=shared was accepted");
  must(taskObject("v1", "shared", "t_1") === "v1" && taskObject("v1", "per-task", "t_1") === "v1-t_1", "object names");
});

for (const o of objects.values()) o.raw.dispose();
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
