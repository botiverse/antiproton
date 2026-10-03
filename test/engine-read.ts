/**
 * What the console reads about an agent's engine (cf/src/engine-read.ts): the storage panel's jobs, outstanding count,
 * compactions, lane and tables (`AgentDO.uiStorage`), the operator's job list (cf/src/diagnose-read.ts), and the runs
 * that failed with no entry (cf/src/transcript-read.ts).
 *
 * On pd every one of them must come from pd's own records: pi's tables exist for a pd agent and stay empty, so a read
 * that went there would show no jobs, no compactions and nothing outstanding. On pi085 every one must be what the
 * console read before these readers existed; the queries it used are kept here, verbatim, as the reference.
 */
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { readEngineStorage, readFailedRuns, readModelJobs } from "../cf/src/engine-read.ts";
import { failedRuns } from "../src/runtime/pi-agent.ts";
import { pdVersion } from "../src/runtime/pd-transcript.ts";
import { PiSqliteStorage, MAIN_SESSION } from "../src/store/pi-storage.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { converse } from "./spec/pd-conversation.ts";
import { unansweredObject } from "./spec/pd-unanswered.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

type Host = ReturnType<typeof sqliteHost>;
function dump(host: Host): string {
  const tables = host.sql.exec("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").toArray() as any[];
  const rows = tables.filter((t) => t.type === "table")
    .map((t) => [t.name, host.sql.exec(`SELECT * FROM "${t.name}" ORDER BY rowid`).toArray()]);
  return JSON.stringify({ tables, rows });
}
const n = (host: Host, q: string) => Number(host.sql.exec(q).toArray()[0]!.n);

await check("pd: the storage panel's jobs, outstanding count, compactions, lane and tables are pd's own, and reading writes nothing", async () => {
  const host = sqliteHost();
  try {
    await unansweredObject(host);
    const before = dump(host);
    const s = readEngineStorage(host.sql, MAIN_SESSION);
    assert(s.modelJobs.map((j) => j.id).join() === "mj_open,mj_cancelled,mj_done", `jobs: ${show(s.modelJobs)}`);
    assert(show(s.modelJobs[0]) === show({ id: "mj_open", created_at: 3, answered_at: null, request_bytes: 7 }), `job row: ${show(s.modelJobs[0])}`);
    // Two rows have no answer; the cancelled one is owed nothing, as the engine counts it.
    assert(n(host, "SELECT COUNT(*) AS n FROM ap_model_jobs WHERE answer IS NULL") === 2, "control: the fixture has no cancelled job to leave out");
    assert(s.outstanding === 1, `outstanding: ${s.outstanding}`);
    assert(s.compactions.length === 1 && s.compactions[0]!.seq === 14 && s.compactions[0]!.bytes > 0, `compactions: ${show(s.compactions)}`);
    assert(s.lane.length === 1 && (s.lane[0] as any).kind === "test.parked" && (s.lane[0] as any).status === "pending", `lane: ${show(s.lane)}`);
    for (const t of ["ap_model_jobs", "pd_entries", "pd_tasks"]) assert(s.tables.includes(t), `${t} is not counted: ${show(s.tables)}`);
    assert(!s.tables.some((t) => t.startsWith("pi_")), `pi's tables are counted for a pd agent: ${show(s.tables)}`);
    assert(dump(host) === before, "the database changed while it was being read");
  } finally { host.dispose(); }
});

await check("pd, through the runtime: jobs and tables of a real conversation; pi's job table is there and empty", async () => {
  const host = sqliteHost();
  try {
    const { agent } = await converse(host, "pd");
    await agent.close();
    // The control: pi's tables exist for a pd agent, so a read of them would answer — with nothing.
    assert(n(host, "SELECT COUNT(*) AS n FROM pi_model_jobs") === 0 && n(host, "SELECT COUNT(*) AS n FROM pi_entries") === 0, "pi's tables are not empty");
    const s = readEngineStorage(host.sql, MAIN_SESSION);
    assert(s.modelJobs.length === 2 && s.modelJobs.every((j) => typeof j.answered_at === "number" && j.request_bytes > 0), `jobs: ${show(s.modelJobs)}`);
    assert(s.outstanding === 0 && s.lane.length === 0, `outstanding ${s.outstanding}, lane ${show(s.lane)}`);
  } finally { host.dispose(); }
});

await check("pd: a run that failed before its first model call is a failed run; one whose model replied with an error is not", async () => {
  const host = sqliteHost();
  try {
    await unansweredObject(host);
    const failed = host.sql.exec("SELECT id FROM pd_tasks WHERE json_extract(record, '$.state.outcome.status') = 'failed'").toArray().map((r) => Number(r.id));
    assert(failed.join() === "8,11", `control: both generations failed (${show(failed)})`);
    const runs = readFailedRuns(host.sql, MAIN_SESSION);
    assert(runs.length === 1, `failed runs: ${show(runs)}`);
    assert(runs[0]!.seq === 8 && runs[0]!.operationId === "8" && runs[0]!.code === "no_model" && runs[0]!.message === "Model gone/m is not available",
      `failed run: ${show(runs[0])}`);
    // Its time is the input it answered; it sorts after that input and before the next.
    const hello = host.sql.exec("SELECT json_extract(record, '$.model[0].timestamp') AS t FROM pd_entries WHERE id = 6").toArray()[0]!.t;
    assert(runs[0]!.at === Number(hello), `at ${runs[0]!.at}, the input's ${hello}`);
    assert(readFailedRuns(host.sql, "task_nope").length === 0, "a session with no conversation has failed runs");
  } finally { host.dispose(); }
});

await check("pd: the console's version moves when a run fails without an entry", async () => {
  const host = sqliteHost();
  try {
    await unansweredObject(host);
    const failed = pdVersion(host.sql, MAIN_SESSION);
    // The same entries and jobs, with the failed generation still running: what the console last drew.
    host.sql.exec("UPDATE pd_tasks SET status = 'running' WHERE id = 8");
    const running = pdVersion(host.sql, MAIN_SESSION);
    assert(failed !== running, `the version did not move: ${failed}`);
  } finally { host.dispose(); }
});

// ---- pi085: what the console read before, for the same object ------------------------------------------------------

/** AgentDO.uiStorage's and readDiagnosis's pi085 queries as they were (8e2ec0c), verbatim. */
function before(host: Host) {
  const rows = (q: string) => host.sql.exec(q).toArray() as any[];
  return {
    tables: ["pi_entries", "pi_usage", "pi_values", "pi_list", "pi_meta", "pi_model_jobs"],
    lane: rows("SELECT namespace, key, seq FROM pi_values WHERE namespace LIKE 'pi.%' LIMIT 40"),
    modelJobs: rows(`SELECT id, created_at, answered_at, LENGTH(request) AS request_bytes
                         FROM pi_model_jobs ORDER BY created_at DESC LIMIT 20`),
    compactions: rows(`SELECT id, seq, timestamp, LENGTH(body) AS bytes FROM pi_entries
                          WHERE type='compaction' ORDER BY seq DESC LIMIT 20`),
    outstanding: Number((rows("SELECT COUNT(*) AS n FROM pi_model_jobs WHERE answer IS NULL")[0] ?? {}).n ?? 0),
    diagnoseJobs: rows("SELECT id, created_at, answered_at FROM pi_model_jobs ORDER BY created_at DESC LIMIT 10"),
  };
}

await check("pi085: every read is what the console read before, on an object with jobs, an open job, a compaction and a failed run", async () => {
  const host = sqliteHost();
  try {
    const { agent } = await converse(host, "pi085");
    const main = new PiSqliteStorage(host);
    await main.commit([{ kind: "entry", entry: { id: "c1", parentId: null, type: "compaction", summary: "so far", retainedTail: [], tokensBefore: 99, fromHook: false } } as any], CTX);
    host.sql.exec("INSERT INTO pi_model_jobs (id, session, request, created_at) SELECT 'mj_open', session, request, created_at + 1 FROM pi_model_jobs LIMIT 1");
    host.sql.exec("INSERT INTO pi_values(namespace, key, seq, body) VALUES ('pi.result', 'op-1', 999, ?)",
      JSON.stringify({ operationId: "op-1", kind: "run", status: "failed", error: { code: "configured_tools_unavailable", message: "unavailable" } }));
    await agent.close();
    const was = before(host);
    // The controls: each read has something to return.
    assert(was.modelJobs.length === 3 && was.outstanding === 1 && was.compactions.length === 1 && was.lane.length > 0,
      `the object is missing what this compares: ${show({ jobs: was.modelJobs.length, out: was.outstanding, c: was.compactions.length, lane: was.lane.length })}`);
    const s = readEngineStorage(host.sql, MAIN_SESSION);
    assert(show(s.tables) === show(was.tables), `tables: ${show(s.tables)}`);
    assert(show(s.lane) === show(was.lane), `lane: ${show(s.lane)}\nwas ${show(was.lane)}`);
    assert(show(s.modelJobs) === show(was.modelJobs), `jobs: ${show(s.modelJobs)}\nwas ${show(was.modelJobs)}`);
    assert(show(s.compactions) === show(was.compactions), `compactions: ${show(s.compactions)}\nwas ${show(was.compactions)}`);
    assert(s.outstanding === was.outstanding, `outstanding ${s.outstanding}, was ${was.outstanding}`);
    const diag = readModelJobs(host.sql, 10).map((r) => ({ id: r.id, created_at: r.created_at, answered_at: r.answered_at }));
    assert(show(diag) === show(was.diagnoseJobs), `diagnose jobs: ${show(diag)}\nwas ${show(was.diagnoseJobs)}`);
    const runs = readFailedRuns(host.sql, MAIN_SESSION);
    assert(runs.length === 1 && show(runs) === show(failedRuns(host.sql, MAIN_SESSION)), `failed runs: ${show(runs)}`);
  } finally { host.dispose(); }
});

await check("uiStorage reads the engine's records through readEngineStorage, and no pi table of its own", () => {
  const index = readFileSync(new URL("../cf/src/index.ts", import.meta.url), "utf8");
  const start = index.indexOf("  async uiStorage(");
  const body = index.slice(start, index.indexOf("\n  }\n", start));
  assert(start > 0 && body.includes("readEngineStorage("), "uiStorage no longer reads through readEngineStorage");
  const named = body.match(/\bpi_[a-z_]+/g);
  assert(named === null, `uiStorage names pi's tables itself: ${show(named)}`);
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
