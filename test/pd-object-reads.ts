/**
 * The console's and the operator's reads on a whole `AgentDO` whose agent runs on `pd`, an object that was pd from its
 * first wake and so has no pi 0.85 table at all: the storage panel (`uiStorage`, through cf/src/engine-read.ts
 * `readEngineStorage`), the change check (`uiVersion`, `pdVersion`), the chat (`uiTranscript`) and the operator's
 * transcript (`adminTranscript`, cf/src/transcript-read.ts `readTranscript`). Each must answer from pd's own records,
 * issue no statement that names a `pi_` table, and leave none behind; the runtime's `ready()` and the conversation
 * lookup the handlers share must not make one either. And `uiStorage` refuses a conversation the agent does not
 * have, on both engines, as the transcript and version handlers do.
 *
 * Node only: the whole object needs `cloudflare:workers`, which node has only as the stand-in below, and the
 * conformance worker does not carry AgentDO.
 */
import { register } from "node:module";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

// `cloudflare:workers`, as much of it as cf/src/index.ts touches when constructed under node.
const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const T = "t", A = "a", TASK = `t_${A}`;
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const d1 = () => {
  const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 1 } }) };
  return { prepare: () => stmt, batch: async (s: unknown[]) => s.map(() => ({ results: [], meta: { changes: 1 } })) };
};

/** An AgentDO on `engine` (pd recorded before its first wake), every statement it runs recorded, one turn taken. */
async function object(engine: "pi085" | "pd") {
  const raw = sqliteHost();
  if (engine === "pd") {
    const ap = new ApStore(raw, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const statements: string[] = [];
  // Iterable as well, as a Durable Object's cursor is: the storage panel spreads one.
  const sql = { exec: (q: string, ...b: unknown[]) => {
    statements.push(q);
    const rows = raw.sql.exec(q, ...b).toArray();
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  let alarmAt: number | null = null;
  const ctx = {
    storage: {
      sql, transactionSync: raw.transactionSync,
      getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; },
    },
    id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
  };
  const jobs: string[] = [];
  const env = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
    ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "m1", DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k",
  };
  const D = new AgentDO(ctx as never, env as never);
  await D.uiAdoptAgent(T, A, { name: "n", description: "d", avatar: "x" });
  await D.runtime().bindOperatorModel(T, A);
  await D.uiSay(T, A, TASK, "Capital of France?", "steer");
  for (let i = 0; i < 100 && jobs.length === 0; i++) { await D.alarm(); if (jobs.length === 0) await sleep(10); }
  check(jobs.length === 1, `${engine}: no model call (${jobs.length})`);
  const job = await D.takeJob(T, A, jobs[0]!) as { model?: { api?: string; provider?: string } };
  await D.deliverAnswer(T, A, jobs[0]!, { role: "assistant", content: [{ type: "text", text: "Paris" }], api: job.model?.api ?? "x", provider: job.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0 }, 5);
  for (let i = 0; i < 100 && alarmAt !== null; i++) await D.alarm();
  const tables = () => raw.sql.exec("SELECT name FROM sqlite_master").toArray().map((r) => String(r.name));
  return { D, raw, statements, tables };
}

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const piStatements = (s: string[]) => s.filter((q) => /\bpi_/.test(q));

await run("pd, no pi table: the storage panel, the change check, the chat and the operator's transcript read pd's records, and name no pi_ table", async () => {
  const o = await object("pd");
  try {
    check(!o.tables().some((t) => t.startsWith("pi_")), `control: the pd object has pi tables: ${show(o.tables().filter((t) => t.startsWith("pi_")))}`);
    check(piStatements(o.statements).length === 0, `the turn named pi tables: ${show(piStatements(o.statements).slice(0, 3))}`);
    o.statements.length = 0;
    await o.D.runtime().ready();
    const storage = await o.D.uiStorage(T, A, TASK) as { counts: Record<string, number>; modelJobs: Array<{ id: string }>; runtime: { outstanding: number } };
    check(storage.modelJobs.length === 1 && storage.runtime.outstanding === 0, `storage panel: ${show({ jobs: storage.modelJobs, outstanding: storage.runtime.outstanding })}`);
    check(storage.counts.ap_model_jobs === 1 && !Object.keys(storage.counts).some((t) => t.startsWith("pi_")), `counts: ${show(storage.counts)}`);
    const v1 = await o.D.uiVersion(T, A, TASK);
    check(typeof v1 === "string" || typeof v1 === "object", `version: ${show(v1)}`);
    const chat = await o.D.uiTranscript(T, A, TASK);
    const said = show(chat);
    check(said.includes("Capital of France?") && said.includes("Paris"), `chat: ${said.slice(0, 300)}`);
    const read = await o.D.adminTranscript(T, A, TASK);
    check(read !== null && show(read).includes("Paris"), `operator's transcript: ${show(read).slice(0, 300)}`);
    check(piStatements(o.statements).length === 0, `the reads named pi tables: ${show(piStatements(o.statements).slice(0, 3))}`);
    check(!o.tables().some((t) => t.startsWith("pi_")), `the reads left pi tables: ${show(o.tables().filter((t) => t.startsWith("pi_")))}`);
    // The control for the probe: the same reads on a pi085 object do name pi tables.
    const p = await object("pi085");
    try {
      p.statements.length = 0;
      await p.D.uiStorage(T, A, TASK);
      await p.D.uiVersion(T, A, TASK);
      check(piStatements(p.statements).length > 0, "control: pi085's reads named no pi table, so the probe sees nothing");
    } finally { p.raw.dispose(); }
  } finally { o.raw.dispose(); }
});

await run("the storage panel refuses a conversation the agent does not have, on both engines, as the transcript and version do", async () => {
  for (const engine of ["pi085", "pd"] as const) {
    const o = await object(engine);
    try {
      for (const [what, call] of [
        ["uiStorage", () => o.D.uiStorage(T, A, "task_nope")],
        ["uiVersion", () => o.D.uiVersion(T, A, "task_nope")],
      ] as const) {
        let thrown: unknown;
        try { await call(); } catch (e) { thrown = e; }
        check(String((thrown as Error)?.message).includes("no such conversation: task_nope"), `${engine} ${what}: ${String(thrown)}`);
      }
      // The control: the agent's own conversation is read.
      check((await o.D.uiStorage(T, A, TASK) as { modelJobs: unknown[] }).modelJobs.length === 1, `${engine}: control: its own conversation was not read`);
    } finally { o.raw.dispose(); }
  }
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
