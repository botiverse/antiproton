/**
 * What the console reads about an agent's engine (cf/src/engine-read.ts): the storage panel's jobs, outstanding count,
 * compactions, lane and tables (`AgentDO.uiStorage`), the operator's job list (cf/src/diagnose-read.ts), and the runs
 * that failed with no entry (cf/src/transcript-read.ts).
 *
 * On pd every one of them must come from pd's own records: a pd object has no pi tables, so a read that went there
 * would fail. On pi085 every one must be what the
 * console read before these readers existed; the queries it used are kept here, verbatim, as the reference.
 */
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { readEngineStorage, readFailedRuns, readModelJobs } from "../cf/src/engine-read.ts";
import { failedRuns } from "../src/runtime/pi-agent.ts";
import { pdFailedRuns, pdVersion, readPdCompactions, readPdLiveTasks } from "../src/runtime/pd-transcript.ts";
import { PiSqliteStorage, MAIN_SESSION } from "../src/store/pi-storage.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { converse } from "./spec/pd-conversation.ts";
import { unansweredObject, SUMMARIES, NOT_RETRYABLE, RETRYABLE } from "./spec/pd-unanswered.ts";

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
    // Newest first: the second compaction, then the first.
    const written = host.sql.exec("SELECT id FROM pd_entries WHERE json_extract(record, '$.kind') = 'pi.compaction' ORDER BY id").toArray().map((r) => Number(r.id));
    assert(written.length === SUMMARIES.length, `control: the fixture wrote ${written.length} compactions`);
    assert(show(s.compactions.map((c) => c.seq)) === show([...written].reverse()) && s.compactions.every((c) => c.bytes > 0), `compactions: ${show(s.compactions)}`);
    assert(s.lane.length === 1 && (s.lane[0] as any).kind === "test.parked" && (s.lane[0] as any).status === "pending", `lane: ${show(s.lane)}`);
    for (const t of ["ap_model_jobs", "pd_entries", "pd_tasks"]) assert(s.tables.includes(t), `${t} is not counted: ${show(s.tables)}`);
    assert(!s.tables.some((t) => t.startsWith("pi_")), `pi's tables are counted for a pd agent: ${show(s.tables)}`);
    assert(dump(host) === before, "the database changed while it was being read");
  } finally { host.dispose(); }
});

await check("pd, through the runtime: jobs and tables of a real conversation, on an object with no pi table", async () => {
  const host = sqliteHost();
  try {
    const { agent } = await converse(host, "pd");
    await agent.close();
    // The control: a pd object has no pi table, so these reads can only have come from pd's records.
    assert(n(host, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'pi\\_%' ESCAPE '\\'") === 0, "a pd object has pi tables");
    const s = readEngineStorage(host.sql, MAIN_SESSION);
    assert(s.modelJobs.length === 2 && s.modelJobs.every((j) => typeof j.answered_at === "number" && j.request_bytes > 0), `jobs: ${show(s.modelJobs)}`);
    assert(s.outstanding === 0 && s.lane.length === 0, `outstanding ${s.outstanding}, lane ${show(s.lane)}`);
  } finally { host.dispose(); }
});

await check("pd: every generation that ended failed, faulted or orphaned is a failed run, once; one whose reply is the failure is not", async () => {
  const host = sqliteHost();
  try {
    const { generations: g } = await unansweredObject(host);
    const ended = host.sql.exec("SELECT id, json_extract(record, '$.state.outcome.status') AS o FROM pd_tasks WHERE kind = ? ORDER BY id", JSON.stringify("pi.generation"))
      .toArray().map((r) => `${r.id}:${r.o}`);
    // The control: the fixture's seven runs, six of which did not complete, then the one between its compactions.
    assert(ended.slice(0, 7).join() === [`${g[0]}:failed`, `${g[1]}:failed`, `${g[2]}:faulted`, `${g[3]}:faulted`, `${g[4]}:failed`, `${g[5]}:completed`, `${g[6]}:orphaned`].join()
      && g.length >= 7, `control: generations ${show(ended)}`);
    const entry = (q: string, ...b: Array<string | number>) => host.sql.exec(q, ...b).toArray().map((r) => r as Record<string, unknown>);
    const own = (gen: number) => entry("SELECT id, json_extract(record, '$.kind') AS kind, json_extract(record, '$.model[0].stopReason') AS stop, json_extract(record, '$.model[0].errorMessage') AS err FROM pd_entries WHERE json_extract(record, '$.byTaskId') = ? ORDER BY id", gen);
    assert(own(g[1]!).some((e) => e.kind === "pi.assistant" && e.err === NOT_RETRYABLE), "control: run 2 did not append its error reply");

    const runs = readFailedRuns(host.sql, MAIN_SESSION);
    assert(show(runs.map((r) => `${r.operationId}:${r.code}`)) === show([`${g[0]}:no_model`, `${g[2]}:faulted`, `${g[3]}:faulted`, `${g[4]}:no_model`, `${g[6]}:orphaned`]),
      `failed runs: ${show(runs)}`);
    const by = Object.fromEntries(runs.map((r) => [r.operationId, r]));
    // Before its first call: at its own id, after the input that started it, at that input's time.
    const hello = entry("SELECT id, json_extract(record, '$.model[0].timestamp') AS t FROM pd_entries WHERE id < ? ORDER BY id DESC LIMIT 1", g[0]!)[0]!;
    assert(by[g[0]!]!.seq === g[0] && by[g[0]!]!.at === Number(hello.t) && by[g[0]!]!.message === "Model gone/m is not available", `run 1: ${show(by[g[0]!])}`);
    // Faulted in its tools phase: after its tool-calling reply and the tool's result, the last of them.
    const toolRound = entry("SELECT id, json_extract(record, '$.kind') AS kind FROM pd_entries WHERE id > ? AND id < ? ORDER BY id", g[3]!, g[4]!)
      .filter((e) => e.kind === "pi.assistant" || e.kind === "pi.tool-result");
    assert(toolRound.map((e) => e.kind).join() === "pi.assistant,pi.tool-result", `control: run 4's round ${show(toolRound)}`);
    assert(by[g[3]!]!.seq === Number(toolRound.at(-1)!.id), `run 4 sorts at ${by[g[3]!]!.seq}, its round ends at ${toolRound.at(-1)!.id}`);
    // Failed on the retry after a retryable error reply: the reply is shown, and so is the failure, after it.
    const retried = own(g[4]!).filter((e) => e.kind === "pi.assistant");
    assert(retried.length === 1 && retried[0]!.err === RETRYABLE, `control: run 5's reply ${show(retried)}`);
    assert(by[g[4]!]!.seq === Number(retried[0]!.id) && by[g[4]!]!.message === "Model flaky/m is not available", `run 5: ${show(by[g[4]!])}`);
    assert(by[g[6]!]!.message === "missing_task", `run 7: ${show(by[g[6]!])}`);
    assert(readFailedRuns(host.sql, "task_nope").length === 0, "a session with no conversation has failed runs");
  } finally { host.dispose(); }
});

await check("pd: an error reply with no errorMessage is the failure itself, shown once, as one with a message is", async () => {
  const host = sqliteHost();
  try {
    const { generations: g } = await unansweredObject(host);
    // Run 2's error reply, as pi-durable records one whose provider gave no message: the reply without
    // `errorMessage`, and the outcome's message the one generation.js makes of it.
    const reply = host.sql.exec("SELECT id FROM pd_entries WHERE json_extract(record, '$.byTaskId') = ? AND json_extract(record, '$.kind') = 'pi.assistant'", g[1]!)
      .toArray().map((r) => Number(r.id));
    assert(reply.length === 1, `control: run 2's replies ${show(reply)}`);
    host.sql.exec("UPDATE pd_entries SET record = json_remove(record, '$.model[0].errorMessage') WHERE id = ?", reply[0]!);
    host.sql.exec("UPDATE pd_tasks SET record = json_set(record, '$.state.outcome.error.message', 'Model response ended with stop reason error') WHERE id = ?", g[1]!);
    const runs = readFailedRuns(host.sql, MAIN_SESSION);
    assert(!runs.some((r) => r.operationId === String(g[1])), `run 2 is shown again as a failed run: ${show(runs.filter((r) => r.operationId === String(g[1])))}`);
    // The control: an outcome that does not match its reply is still a failed run.
    host.sql.exec("UPDATE pd_tasks SET record = json_set(record, '$.state.outcome.error.message', 'something else') WHERE id = ?", g[1]!);
    assert(readFailedRuns(host.sql, MAIN_SESSION).some((r) => r.operationId === String(g[1])), "control: a different failure is not shown");
  } finally { host.dispose(); }
});

await check("pd: the console's version moves when a run fails without an entry", async () => {
  const host = sqliteHost();
  try {
    const { generations } = await unansweredObject(host);
    const failed = pdVersion(host.sql, MAIN_SESSION);
    // The same entries and jobs, with the failed generation still running: what the console last drew.
    host.sql.exec("UPDATE pd_tasks SET status = 'running' WHERE id = ?", generations[0]!);
    const running = pdVersion(host.sql, MAIN_SESSION);
    assert(failed !== running, `the version did not move: ${failed}`);
    // And when, before the console polls again, a task that appends no entry of its own starts (the fixture's parked
    // task; a manual compaction is one in production): the live count is what it was, so only the newest live task
    // tells the two states apart. Drawn: the generation running, the parked task not there yet.
    const parked = Number(host.sql.exec("SELECT id FROM pd_tasks WHERE kind = ?", JSON.stringify("test.parked")).toArray()[0]!.id);
    host.sql.exec("UPDATE pd_tasks SET status = 'terminal' WHERE id = ?", parked);
    const drawn = pdVersion(host.sql, MAIN_SESSION);
    assert(drawn.split(".")[2] === failed.split(".")[2], `control: the live counts differ (${drawn} vs ${failed}), so the count alone would move`);
    assert(failed !== drawn, `the version did not move when a failed run was followed by a task with no entry: ${failed}`);
  } finally { host.dispose(); }
});

await check("pd: the reads the console repeats use pi-durable's indexes rather than every entry or task the conversation has", async () => {
  const host = sqliteHost();
  try {
    await unansweredObject(host);
    // Each statement a reader issues, with the plan SQLite chose for it.
    const plans = (read: (sql: any) => unknown) => {
      const seen: string[] = [];
      read({ exec(q: string, ...b: unknown[]) {
        if (/^\s*SELECT/i.test(q) && !q.includes("sqlite_master")) {
          seen.push(`${q.replace(/\s+/g, " ").slice(0, 60)} => ${host.sql.exec(`EXPLAIN QUERY PLAN ${q}`, ...(b as never[])).toArray().map((r: any) => r.detail).join(" / ")}`);
        }
        return host.sql.exec(q, ...(b as never[]));
      } });
      return seen;
    };
    const compactions = plans((sql) => readPdCompactions(sql, MAIN_SESSION, 20)).filter((p) => p.includes("pd_entries"));
    assert(compactions.length === 1 && compactions[0]!.includes("pd_entry_heads_by_conversation"), `compactions: ${show(compactions)}`);
    const lane = plans((sql) => readPdLiveTasks(sql, 40));
    assert(lane.length === 1 && lane[0]!.includes("pd_tasks_by_status"), `lane: ${show(lane)}`);
    const version = plans((sql) => pdVersion(sql, MAIN_SESSION)).filter((p) => p.includes("pd_tasks"));
    assert(version.length === 1 && version[0]!.includes("pd_tasks_by_status"), `version: ${show(version)}`);
    // The failed generations by kind; each one's own entries and tool tasks by a range of ids, never the whole table.
    const failed = plans((sql) => pdFailedRuns(sql, MAIN_SESSION)).filter((p) => p.includes("pd_entries") || p.includes("pd_tasks"));
    assert(failed[0]!.includes("pd_tasks_by_kind"), `the failed generations: ${failed[0]}`);
    const ranged = failed.slice(1).filter((p) => !p.includes("id<?") && !p.includes("id>?") && !/id\W+[<>]/.test(p));
    assert(failed.length > 1 && ranged.length === 0, `a per-generation read is not bounded: ${show(ranged)}`);
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
