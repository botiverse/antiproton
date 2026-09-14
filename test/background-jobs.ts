/**
 * The rules a background tool call is held to (task #16): how many may run,
 * how often they are checked, and what the agent is told at start and end.
 */
import {
  admitBackground, BACKGROUND_CAP, completionMessage, dueBackgroundJobs, finishBackgroundJob, markPolled,
  nextBackgroundWake, nextPollDelay, recordBackgroundJob, runningBackgroundJobs, startedResult,
} from "../src/runtime/background-jobs.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const now = 1_800_000_000_000;
const job = (id: string, secs = 10) => ({ id, mount: "node", tool: "shell", createdAt: now - secs * 1000 });

await check("up to the cap is admitted; the next is refused and told what is running", async () => {
  assert(BACKGROUND_CAP === 3, `tygg's cap is a small number; it is ${BACKGROUND_CAP}`);
  assert(admitBackground([job("a"), job("b")], 3, now).ok, "the third job was refused");
  const r = admitBackground([job("a", 12), job("b", 40), job("c", 95)], 3, now);
  assert(!r.ok, "a fourth job was admitted");
  const m = (r as { message: string }).message;
  for (const id of ["a", "b", "c"]) assert(m.includes(id), `the refusal does not name running job ${id}: ${m}`);
  assert(m.includes("95s") && m.includes("jobs.cancel"), `the refusal does not say how long or what to do: ${m}`);
});

await check("checks start soon, back off, and never wait more than 30 s", async () => {
  assert(nextPollDelay(0) === 2_000, `first check ${nextPollDelay(0)}`);
  for (let i = 1; i < 12; i++) {
    assert(nextPollDelay(i) >= nextPollDelay(i - 1), `the delay shrank at poll ${i}`);
    assert(nextPollDelay(i) <= 30_000, `poll ${i} waits ${nextPollDelay(i)} ms`);
  }
  assert(nextPollDelay(50) === 30_000, "a long job is not checked every 30 s");
});

await check("the agent is told at once that it may keep working, and how to see and stop the job", async () => {
  const r = startedResult({ id: "j1", mount: "node", tool: "shell" }, "npm test is still running.");
  assert(r.state === "running" && r.job === "j1", `unexpected shape: ${JSON.stringify(r)}`);
  assert(/Keep working/.test(r.note) && /arrives as a message/.test(r.note), `the note does not free the agent: ${r.note}`);
  assert(r.note.includes("jobs.list") && r.note.includes("jobs.cancel"), `the note does not name the job tools: ${r.note}`);
});

await check("the completion message names the job and carries the result or the error", async () => {
  const done = completionMessage(job("j1", 130), { state: "done", result: { exitCode: 0, output: "ok" } }, now);
  assert(done.includes("j1") && done.includes("node.shell") && done.includes("130s"), `header incomplete: ${done}`);
  assert(done.includes('"exitCode":0'), `result missing: ${done}`);
  const failed = completionMessage(job("j2"), { state: "failed", error: "box gone" }, now);
  assert(failed.includes("failed") && failed.includes("box gone"), `error missing: ${failed}`);
});

await check("the job table: recorded, due on schedule, polled forward, and the soonest wake", async () => {
  const host = sqliteHost(); const sql = host.sql as any;
  try {
    assert(nextBackgroundWake(sql, now) === null, "nothing running, yet the alarm was asked to wake");
    recordBackgroundJob(sql, { id: "j1", session: "main", mount: "node", tool: "shell", handle: { boxId: "b", execId: "e1" } }, now);
    recordBackgroundJob(sql, { id: "j2", session: "s2", mount: "node", tool: "run", handle: { execId: "e2" } }, now + 1_000);
    const running = runningBackgroundJobs(sql);
    assert(running.length === 2 && running[0]!.id === "j1", `running: ${JSON.stringify(running.map((j) => j.id))}`);
    assert((running[0]!.handle as any).execId === "e1", "the handle did not survive the round trip");
    assert(nextBackgroundWake(sql, now) === 2_000, `first wake ${nextBackgroundWake(sql, now)}`);
    assert(dueBackgroundJobs(sql, now + 1_999).length === 0, "a job was due before its first check");
    assert(dueBackgroundJobs(sql, now + 2_000).map((j) => j.id).join() === "j1", "j1 was not due at 2 s");
    markPolled(sql, "j1", now + 2_000);
    assert(dueBackgroundJobs(sql, now + 2_001).map((j) => j.id).join() === "", "a polled job stayed due");
    assert(nextBackgroundWake(sql, now + 2_000) === 1_000, `wake after polling j1: ${nextBackgroundWake(sql, now + 2_000)}`);
  } finally { host.dispose(); }
});

await check("a finished or cancelled job stays finished: a late answer cannot overwrite it", async () => {
  const host = sqliteHost(); const sql = host.sql as any;
  try {
    recordBackgroundJob(sql, { id: "j1", session: "main", mount: "node", tool: "shell", handle: {} }, now);
    assert(finishBackgroundJob(sql, "j1", { state: "cancelled" }, now + 5_000), "a running job could not be cancelled");
    assert(!finishBackgroundJob(sql, "j1", { state: "done", result: { exitCode: 0 } }, now + 9_000), "a late result overwrote the cancel");
    assert(runningBackgroundJobs(sql).length === 0, "a cancelled job still counts as running");
    assert(nextBackgroundWake(sql, now) === null, "a finished job still asks the alarm to wake");
    assert(!finishBackgroundJob(sql, "nope", { state: "done" }, now), "an unknown job was finished");
  } finally { host.dispose(); }
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
