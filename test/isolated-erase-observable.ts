/**
 * A short session's erase is observable (cf/src/runtime.ts `#eraseIsolated`): each erased session is an
 * `isolated.erased` line, each one whose erase threw is an `isolated.erase_failed` line (the error's name, never its
 * message), and every pass that had short sessions is one `isolated.erase_pass` line whose rows always add up
 * (rows = erased + failed + busy).
 *
 * The runtime is the real one over sqlite (as test/model-queue.ts makes it), its agent provisioned as Raft provisions
 * one; a short session is opened as `#runPluginHooks` opens one (`recordIsolated`, then a post into it) and its turn is
 * driven by `step`, its model call answered through `takeJob` / `deliverAnswer`. What it leaves in the agent's SQLite is
 * read by a scan of every table (test/support/session-footprint.ts): present while it is alive, gone once erased. The erase is made to fail the way it
 * can in production: a call of the session parked its result in R2 (`operations.result_ref`), and the bucket's delete
 * throws.
 *
 *   node test/isolated-erase-observable.ts
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { adoptProvisionedAgent } from "../cf/src/provision/steps.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { setLogSink } from "../src/core/log.ts";
import { newIsolatedSessionId, recordIsolated } from "../src/runtime/isolated-session.ts";
import { recordImageAttempt } from "../cf/src/image-evidence.ts";
import { piTables } from "../src/store/pi-storage.ts";
import { ensureTurnTiming } from "../src/runtime/turn-timing.ts";
import { ensureBackgroundTable } from "../src/runtime/background-jobs.ts";
import { footprint, type Footprint, type FootprintHit } from "./support/session-footprint.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const T = "t", A = "agent-1";
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** What the failing delete says: it must never reach a log line. */
const SECRET_TEXT = "delete refused for tenants/t/agent-1/CANARY-erase-message";
class R2DeleteError extends Error { override name = "R2DeleteError"; }

async function world(opts: { evidence?: boolean } = {}) {
  const host = sqliteHost();
  /** The bucket's delete: what it was asked, and whether it throws. */
  const bucket = { deleted: [] as string[][], fail: false, async delete(keys: string[]) {
    if (bucket.fail) throw new R2DeleteError(SECRET_TEXT);
    bucket.deleted.push(keys);
  } };
  const env = { DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "deepseek-flash" } as any;
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: bucket as any, bucketName: "b", models: { resolve: () => null } as any,
    secretKek: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    operatorModel: operatorModelOf(env),
    ...(opts.evidence ? { modelInputEvidence: true, offloadModel: async () => {} } : {}),
  } as any);
  await rt.ready();
  const adopted = await adoptProvisionedAgent(rt, T, A, { name: "Cody", instructions: "", raftOrigin: "https://raft.example", avatar: "0badcafe" });
  if (!adopted.ok) throw new Error(`adopt: ${adopted.error}`);
  const sql = host.sql;
  /** A short session, opened as `#runPluginHooks` opens one, with a turn posted in it and driven to its model call. */
  const open = async (alias = "raft", turnKey: string | null = null) => {
    const session = newIsolatedSessionId();
    recordIsolated(sql, session, alias, Date.now(), { tools: [], turnKey });
    await rt.postMessage(T, A, "a check", "prompt", session);
    await rt.step(T, A);
    return session;
  };
  const pending = (session: string) => sql.exec("SELECT id FROM pi_model_jobs WHERE session = ? AND answer IS NULL", session).toArray()
    .map((r: any) => String(r.id));
  /** Answer the session's model call(s) with text, so its run ends. */
  const answer = async (session: string) => {
    const ids = pending(session);
    must(ids.length > 0, `no model call of ${session} to answer`);
    for (const id of ids) {
      const job: any = await rt.takeJob(T, A, id, "test");
      await rt.deliverAnswer(T, A, id, { role: "assistant", content: [{ type: "text", text: "nothing" }], api: job?.model?.api ?? "openai-completions",
        provider: job?.model?.provider ?? "deepseek", model: String(job?.model?.id ?? "m"), usage: USAGE, stopReason: "stop", timestamp: 0 } as never, "test");
    }
  };
  /** One pass with the log captured: every line it wrote. */
  const pass = async () => {
    const lines: Array<Record<string, unknown>> = [];
    const raw: string[] = [];
    setLogSink((line) => { raw.push(line); lines.push(JSON.parse(line) as Record<string, unknown>); });
    try { await rt.step(T, A); } finally { setLogSink(null); }
    return { lines, raw };
  };
  const kept = (session: string) => sql.exec("SELECT 1 AS x FROM isolated_sessions WHERE session = ?", session).toArray().length > 0;
  return { rt, sql, bucket, open, answer, pending, pass, kept };
}

/**
 * A pass line's two equations, which hold in different cases:
 * - `processed == erased + failed + busy` always holds, finished or not (every row it reached went exactly one way);
 * - `rows == processed` holds only for a pass that finished (`completed: true`): one cut off reached fewer rows than it
 *   read, and is a correct line, not wrong arithmetic.
 * `adds` is for passes these tests expect to finish, so it asks for both; the cut-off pass is checked apart below.
 */
const tallied = (p: Record<string, unknown> | undefined) => !!p && p.processed === Number(p.erased) + Number(p.failed) + Number(p.busy);
const adds = (p: Record<string, unknown> | undefined) => tallied(p) && p!.completed === true && p!.rows === p!.processed;

await check("a check session whose run has ended is erased: one isolated.erased line, a pass of rows=1 erased=1, its row gone", async () => {
  const w = await world();
  const session = await w.open();
  must(w.kept(session), "control: the short session has no row");
  await w.answer(session);
  const { lines } = await w.pass();
  const erased = lines.filter((l) => l.evt === "isolated.erased" && l.session === session);
  must(erased.length === 1, `isolated.erased lines for the session: ${show(lines)}`);
  const e = erased[0]!;
  must(e.tenantId === T && e.agentId === A && e.mount === "raft" && typeof e.ms === "number" && e.ms >= 0, show(e));
  const passes = lines.filter((l) => l.evt === "isolated.erase_pass");
  must(passes.length === 1, `isolated.erase_pass lines: ${show(lines)}`);
  const p = passes[0]!;
  must(p.tenantId === T && p.agentId === A && p.rows === 1 && p.erased === 1 && p.failed === 0 && p.busy === 0 && p.completed === true && p.processed === 1, show(p));
  must(adds(p), `rows != erased + failed + busy: ${show(p)}`);
  must(!lines.some((l) => l.evt === "isolated.erase_failed"), show(lines));
  must(!w.kept(session), "the isolated_sessions row is still there");
});

await check("an erase that throws is an isolated.erase_failed line (name, not message), counted as failed; the row stays and the next pass erases it", async () => {
  const w = await world();
  const session = await w.open();
  await w.answer(session);
  // A call of the session parked its result in R2, as an over-large result is (`result_ref`), and the bucket's delete fails.
  w.sql.exec("INSERT INTO operations (operation_id, tenant_id, agent_id, task_id, mount_alias, tool, tool_version, status, result_ref, created_at, updated_at)" +
    " VALUES (?, ?, ?, ?, 'raft', 'messages_read', '1', 'succeeded', ?, ?, ?)", "op-parked", T, A, session, "r2://b/tenants/t/agent-1/parked.txt", Date.now(), Date.now());
  w.bucket.fail = true;
  const { lines, raw } = await w.pass();
  const failed = lines.filter((l) => l.evt === "isolated.erase_failed" && l.session === session);
  must(failed.length === 1, `isolated.erase_failed lines for the session: ${show(lines)}`);
  const f = failed[0]!;
  must(f.tenantId === T && f.agentId === A && f.mount === "raft" && typeof f.ms === "number" && f.ms >= 0, show(f));
  must(f.code === "R2DeleteError", `code: ${show(f.code)}`);
  must(!raw.some((l) => l.includes("CANARY-erase-message") || l.includes(SECRET_TEXT)), `the error's message was logged: ${raw.join("\n")}`);
  must(!lines.some((l) => l.evt === "isolated.erased" && l.session === session), show(lines));
  const p = lines.find((l) => l.evt === "isolated.erase_pass");
  must(p && p.rows === 1 && p.failed === 1 && p.erased === 0 && p.busy === 0 && p.failedOverHour === 0, show(p));
  must(adds(p), `rows != erased + failed + busy: ${show(p)}`);
  must(w.kept(session), "the isolated_sessions row was dropped though its erase failed");
  must(w.sql.exec("SELECT result_ref FROM operations WHERE operation_id = 'op-parked'").toArray()[0]?.result_ref, "the parked reference was cleared though its delete failed");

  // The fault removed: the next pass erases it, the stored copy deleted first.
  w.bucket.fail = false;
  const next = await w.pass();
  must(next.lines.filter((l) => l.evt === "isolated.erased" && l.session === session).length === 1, show(next.lines));
  const p2 = next.lines.find((l) => l.evt === "isolated.erase_pass");
  must(p2 && p2.rows === 1 && p2.erased === 1 && p2.failed === 0 && adds(p2), show(p2));
  must(show(w.bucket.deleted) === show([["tenants/t/agent-1/parked.txt"]]), `deleted: ${show(w.bucket.deleted)}`);
  must(!w.kept(session), "the isolated_sessions row is still there after the fault was removed");
});

await check("a short session with work left is counted busy, not erased, beside one that is erased; rows add up", async () => {
  const w = await world();
  // Both opened first: a pass erases what has ended, so `done` is answered only once `busy` is out.
  const done = await w.open();
  const busy = await w.open();
  await w.answer(done);
  must(w.pending(busy).length > 0, "control: the busy session has no model call out");
  const { lines } = await w.pass();
  must(!lines.some((l) => (l.evt === "isolated.erased" || l.evt === "isolated.erase_failed") && l.session === busy), show(lines));
  must(lines.filter((l) => l.evt === "isolated.erased" && l.session === done).length === 1, show(lines));
  const p = lines.find((l) => l.evt === "isolated.erase_pass");
  must(p && p.rows === 2 && p.busy === 1 && p.erased === 1 && p.failed === 0 && p.busyOverHour === 0, show(p));
  must(adds(p), `rows != erased + failed + busy: ${show(p)}`);
  must(w.kept(busy) && !w.kept(done), `kept: busy ${w.kept(busy)}, done ${w.kept(done)}`);
});

await check("CHANGE DETECTOR: a short session opened in a pass is still there, tables and all, when that pass ends", async () => {
  // Always true today: the post that opens it marks it active (cf/src/runtime.ts postMessage, markSession), so the erase
  // that runs later in the same pass counts it busy. Kept to catch a change that moves the opening after the erase, or
  // drops that mark: the pass's rows would still add up (the session would count as erased), and only this would fail.
  const w = await world();
  const session = await w.open();
  const entries = (w.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as any[]).map((r) => String(r.name))
    .filter((n) => n.includes(session.replace(/[^A-Za-z0-9_]/g, "_")) || n.includes(session));
  must(entries.length > 0, `control: no table of the session after its opening pass: ${show(entries)}`);
  must(w.kept(session), "the isolated_sessions row is gone after the pass that opened it");
  must(w.sql.exec("SELECT active FROM pi_sessions WHERE session = ?", session).toArray()[0]?.active === 1, "the session is not active after its opening pass");
  const { lines } = await w.pass();
  must(!lines.some((l) => l.evt === "isolated.erased" && l.session === session), `erased while its model call is out: ${show(lines)}`);
  must(w.kept(session), "the isolated_sessions row is gone after a pass with its call still out");
});

await check("erasing a short session takes its calls' input digests too (model_input_digests: hashes and lengths, no text)", async () => {
  const w = await world({ evidence: true });
  const session = await w.open();
  await w.answer(session);
  const digests = () => (w.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_input_digests'").toArray().length
    ? Number((w.sql.exec("SELECT COUNT(*) AS n FROM model_input_digests WHERE session_id = ?", session).toArray()[0] as any)?.n ?? 0) : 0);
  const before = digests();
  must(before > 0, `control: no input digest recorded for the session's call (${before})`);
  await w.pass();
  must(!w.kept(session), "control: the session was not erased");
  must(digests() === 0, `input digests left after the erase: ${digests()}`);
});

await check("a pass with no short sessions still writes its line (rows: 0), so every pass that reached the erase has one", async () => {
  const w = await world();
  const { lines } = await w.pass();
  const p = lines.filter((l) => l.evt === "isolated.erase_pass");
  must(p.length === 1 && p[0]!.rows === 0 && p[0]!.completed === true, show(lines));
});

await check("a pass cut off before it has seen every row still writes its line: completed false, processed < rows, the tally adds up", async () => {
  const w = await world();
  const session = await w.open();
  await w.answer(session);
  // Make the erase's read of which sessions have work throw, and only there (by the caller in the stack), so the pass
  // fails outside the per-session try: the one way a pass ends without having seen every row.
  const exec = w.sql.exec.bind(w.sql);
  (w.sql as any).exec = (q: string, ...args: unknown[]) => {
    if (/UNION SELECT session FROM background_jobs/.test(q) && /eraseIsolated/.test(String(new Error().stack))) throw new Error("cut off");
    return exec(q, ...args);
  };
  let lines: Array<Record<string, unknown>> = [];
  setLogSink((line) => { lines.push(JSON.parse(line) as Record<string, unknown>); });
  try { await w.rt.step(T, A); } catch { /* the cut-off may surface from the step: the line is what is checked */ } finally { setLogSink(null); (w.sql as any).exec = exec; }
  const p = lines.filter((l) => l.evt === "isolated.erase_pass");
  must(p.length === 1, `expected one pass line from the cut-off pass, found ${p.length}: ${show(lines)}`);
  must(p[0]!.completed === false, `a cut-off pass must say completed: false: ${show(p[0])}`);
  must(Number(p[0]!.rows) >= 1, `rows is what the pass read, the session included: ${show(p[0])}`);
  // processed < rows written as an inequality, not a number: it is what makes this the cut-off case at all.
  must(Number(p[0]!.processed) < Number(p[0]!.rows), `processed must be below rows when cut off: ${show(p[0])}`);
  must(tallied(p[0]), `processed != erased + failed + busy: ${show(p[0])}`);
  must(w.kept(session), "the session must still be there for the next pass");
  const next = await w.pass();
  const p2 = next.lines.find((l) => l.evt === "isolated.erase_pass");
  must(adds(p2) && !w.kept(session), `the next pass must finish and erase it: ${show(p2)}`);
});

// ---- What a short session leaves in the agent's SQLite: everything there while it is alive, nothing once erased.

const TURN_KEY = "test.check:abcd1234";
/** A table named after a session (`piTables`) is reported under one name, so the known set is not per run. */
const PI_SESSION_TABLES = "pi_s_<session>_*";
function tableOf(table: string, sessions: string[]): string {
  for (const s of sessions) if (Object.values(piTables(s)).includes(table)) return PI_SESSION_TABLES;
  return table;
}
/**
 * The tables an alive short session is found in, each with the key that links it. The scan reads values only, so a table
 * named after the session is here because its rows name it too; the table names themselves are checked apart.
 */
const KNOWN_ALIVE: Record<string, string> = {
  isolated_sessions: "session (its row), turn_key (= the turnKey, whole)",
  pi_sessions: "session",
  [PI_SESSION_TABLES]: "the session's own transcript tables (entries.body names the session)",
  pi_model_jobs: "session, id (job id), request (names the session)",
  model_input_digests: "session_id, job_id, digest (JSON naming both)",
  model_input_images: "job_id, record (JSON naming the job id and session)",
  turn_timing: "session (the turn open on it)",
  harness_opens: "conversation_key = <tenant>/<agent>#<session>",
  model_request_prefix: "conversation = <tenant>/<agent>#<session>",
  prompt_context: "conversation = session",
  tools_seen: "conversation = session",
  trace_outbox: "span_id / attrs of its ended spans (harness.open, model.call, turn.timing)",
};
/**
 * What an erase deliberately leaves, by (table.column), with why. Keyed by column, not table: a new column in a kept
 * table that starts holding the session is a leak of its own and fails here by name.
 */
const KEPT_AFTER_ERASE: Record<string, string> = {
  "trace_outbox.span_id": "the export outbox: ids and readings, no content; rows leave on the alarm pass's trace export (pruneTrace)",
  "trace_outbox.attrs": "same rows as span_id: the span's readings, keyed by the session id; deleting them would lose the turn's trace",
};
/** Values that only contain the turnKey (not equal to it), deliberately left, by (table.column). */
const KEPT_PARTIAL: Record<string, string> = {
  "plugin_turn_ends.body": "the turn's end owed to the mount that asked for it (`only: {alias, turnKey}`, no text), "
    + "which it is told after the erase and which is pruned a day after it is handled (src/runtime/plugin-wakes.ts)",
};
/** Tables the scan cannot read. */
const KNOWN_UNSCANNED: string[] = [];

const colsOf = (hs: FootprintHit[]) => [...new Set(hs.map((h) => `${h.table}.${h.column}`))].sort();
const tablesOf = (hs: FootprintHit[], sessions: string[]) => [...new Set(hs.map((h) => tableOf(h.table, sessions)))].sort();
const brief = (hs: FootprintHit[]) => hs.map((h) => `${h.table}.${h.column} x${h.rows}: ${h.sample}`).join("\n        ");
function mustScanAll(f: Footprint) {
  const extra = f.unscanned.filter((u) => !KNOWN_UNSCANNED.includes(u.table));
  // Always true today, as every table is scannable; it guards the day a virtual or encrypted table is added.
  must(extra.length === 0, `tables the footprint scan could not read (${show(extra)}). Every table is scannable today, so this `
    + "only fails once a table the scan cannot read (a virtual or encrypted one) is added: its rows would be \"not scanned\", not "
    + "\"no hits\", and the erase checks below would pass without looking at it. Make the scan read it, or list it in KNOWN_UNSCANNED with why it cannot hold a session.");
}

/** A short session with a key, answered, with image evidence recorded for its call, as the queue consumer records it. */
async function aliveSession(w: Awaited<ReturnType<typeof world>>) {
  const session = await w.open("raft", TURN_KEY);
  await w.answer(session);
  const jobIds = (w.sql.exec("SELECT id FROM pi_model_jobs WHERE session = ?", session).toArray() as any[]).map((r) => String(r.id));
  must(jobIds.length > 0, "control: the session has no model call");
  // What `AgentDO.recordImageAttempt` writes for a call's image evidence (the consumer reports it; this harness has none).
  const wrote = recordImageAttempt(w.sql, jobIds[0]!, { attemptId: "att-1", budget: { maxImages: 4, maxBytes: 1000, step: 1 }, windowStart: 0,
    model: "deepseek-flash", vision: true, preparedAt: new Date().toISOString(), items: [] });
  must(wrote, "control: the call's image evidence was not recorded");
  return { session, jobIds, probe: { ids: [session, ...jobIds], exact: [TURN_KEY] } };
}

await check("ALIVE: a short session that has run is in the agent's SQLite, and the footprint scan finds it there", async () => {
  const w = await world({ evidence: true });
  const { session, probe } = await aliveSession(w);
  // The rows themselves, read directly ...
  const pi = Number((w.sql.exec("SELECT COUNT(*) AS n FROM pi_sessions WHERE session = ?", session).toArray()[0] as any).n);
  const entries = piTables(session).entries;
  const messages = Number((w.sql.exec(`SELECT COUNT(*) AS n FROM ${entries}`).toArray()[0] as any).n);
  must(pi === 1 && messages >= 1, `control: pi_sessions rows ${pi}, ${entries} rows ${messages}`);
  // ... and found by the scan.
  const f = footprint(w.sql, probe);
  mustScanAll(f);
  must(f.hits.length > 0, "the scan found nothing of an alive session");
  const tables = new Set(f.hits.map((h) => h.table));
  must(tables.has("pi_sessions") && tables.has(entries), `the scan missed pi_sessions or ${entries}:\n        ${brief(f.hits)}`);
  must(tables.has("isolated_sessions") && f.hits.some((h) => h.table === "isolated_sessions" && h.column === "turn_key"),
    `the scan missed the turnKey in isolated_sessions:\n        ${brief(f.hits)}`);
});

await check("DISCOVERY: the tables an alive short session is found in are exactly the known ones (a new one fails here, named)", async () => {
  const w = await world({ evidence: true });
  const { session, probe } = await aliveSession(w);
  const f = footprint(w.sql, probe);
  mustScanAll(f);
  const unknown = f.hits.filter((h) => !(tableOf(h.table, [session]) in KNOWN_ALIVE));
  must(unknown.length === 0, `tables holding the short session that the erase test does not know (add each to KNOWN_ALIVE, and to the erase or `
    + `KEPT_AFTER_ERASE with why):\n        ${brief(unknown)}`);
  must(f.suspicious.length === 0, `matches that could be chance:\n        ${brief(f.suspicious)}`);
  // And the other way: every known table is still found, so the known set is what is observed, not a list that only grows.
  must(Object.keys(KNOWN_ALIVE).length > 0, "KNOWN_ALIVE is empty");
  const seen = tablesOf(f.hits, [session]);
  const missing = Object.keys(KNOWN_ALIVE).filter((t) => !seen.includes(t));
  must(missing.length === 0, `known tables no longer holding an alive short session (the scan broke, or they stopped keeping it: drop them from `
    + `KNOWN_ALIVE and the erase): ${show(missing)}`);
});

await check("AFTER ERASE: an erased short session leaves nothing but what is kept on purpose; a busy one beside it is untouched", async () => {
  const w = await world({ evidence: true });
  must(Object.keys(KNOWN_ALIVE).length > 0, "KNOWN_ALIVE is empty");
  // The control, opened first and left busy (its model call is not answered), so it must survive the pass whole.
  const control = await w.open("raft", "test.control:0000ffff");
  must(w.pending(control).length > 0, "control: the busy session has no model call out");
  const controlProbe = () => ({ ids: [control, ...(w.sql.exec("SELECT id FROM pi_model_jobs WHERE session = ?", control).toArray() as any[]).map((r) => String(r.id))] });
  const { session, probe } = await aliveSession(w);
  // A short session whose turn was lost without an end (in flight across a deploy: src/runtime/turn-timing.ts), and
  // whose background call finished: no work, so it is erased, and its `turn_timing` row is not closed by any step.
  const lost = newIsolatedSessionId();
  recordIsolated(w.sql, lost, "raft", Date.now(), { tools: [], turnKey: null });
  ensureTurnTiming(w.sql);
  w.sql.exec("INSERT INTO turn_timing(session, inbound_at) VALUES (?, ?)", lost, Date.now() - 60_000);
  ensureBackgroundTable(w.sql);
  w.sql.exec("INSERT INTO background_jobs(id, tenant_id, agent_id, session, mount, tool, handle, state, created_at, finished_at, polls, next_poll_at, outcome)"
    + " VALUES ('bg-lost', ?, ?, ?, 'raft', 'slow', '{}', 'done', ?, ?, 1, 0, 'ok')", T, A, lost, Date.now() - 60_000, Date.now() - 30_000);

  const before = footprint(w.sql, probe);
  mustScanAll(before);
  must(before.hits.length > 0, "control: the target session had no data before the pass");
  const lostBefore = footprint(w.sql, { ids: [lost] });
  must(new Set(lostBefore.hits.map((h) => h.table)).has("turn_timing") && lostBefore.hits.some((h) => h.table === "background_jobs"),
    `control: the lost session's turn_timing / background_jobs rows are not there: ${brief(lostBefore.hits)}`);
  const controlBefore = footprint(w.sql, controlProbe());
  must(controlBefore.hits.length > 0, "CONTROL HAD NO DATA BEFORE: the scan found nothing of the busy session, so it proves nothing");

  const { lines } = await w.pass();
  must(lines.some((l) => l.evt === "isolated.erased" && l.session === session), `the target was not erased: ${show(lines)}`);
  must(lines.some((l) => l.evt === "isolated.erased" && l.session === lost), `the lost-turn session was not erased: ${show(lines)}`);

  const controlAfter = footprint(w.sql, controlProbe());
  must(controlAfter.hits.length > 0 && w.kept(control), "CONTROL LOST DATA AFTER: the pass erased a busy session it must not have");

  const after = footprint(w.sql, probe);
  mustScanAll(after);
  const left = after.hits.filter((h) => !(`${h.table}.${h.column}` in KEPT_AFTER_ERASE));
  must(left.length === 0, `TARGET STILL HAS DATA AFTER the erase:\n        ${brief(left)}`);
  // Equality, not subset: a kept column the session no longer reaches fails too (the reason above has gone stale).
  must(show(colsOf(after.hits)) === show(Object.keys(KEPT_AFTER_ERASE).sort()),
    `kept on purpose: expected ${show(Object.keys(KEPT_AFTER_ERASE).sort())}, found ${show(colsOf(after.hits))}`);
  must(show(colsOf(after.partial)) === show(Object.keys(KEPT_PARTIAL).sort()),
    `values containing the turnKey after the erase: expected ${show(Object.keys(KEPT_PARTIAL))}, found:\n        ${brief(after.partial)}`);
  must(after.suspicious.length === 0, `matches that could be chance:\n        ${brief(after.suspicious)}`);
  const lostAfter = footprint(w.sql, { ids: [lost] }).hits.filter((h) => !(`${h.table}.${h.column}` in KEPT_AFTER_ERASE));
  must(lostAfter.length === 0, `TARGET STILL HAS DATA AFTER the erase (the lost-turn session):\n        ${brief(lostAfter)}`);
  // Tables named after an erased session: the scan reads values, so their names are checked here.
  const named = (w.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as any[]).map((r) => String(r.name))
    .filter((n) => [session, lost].some((s) => Object.values(piTables(s)).includes(n)));
  must(named.length === 0, `TARGET STILL HAS DATA AFTER the erase: tables named after it: ${show(named)}`);
});

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
