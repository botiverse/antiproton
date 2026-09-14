/**
 * The rules a background tool call is held to (task #16): how many may run,
 * how often they are checked, and what the agent is told at start and end.
 */
import {
  admitBackground, BACKGROUND_CAP, BACKGROUND_MAX_MS, completionMessage, dueBackgroundJobs, finishBackgroundJob, markPolled,
  jobsTool, mountsWithRunningJobs, nextBackgroundWake, nextPollDelay, overdueBackground, recordBackgroundJob, runBackgroundPass, runningBackgroundJobs, startedResult,
} from "../src/runtime/background-jobs.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const now = 1_800_000_000_000;
const job = (id: string, secs = 10) => ({ id, mount: "node", tool: "node__shell", createdAt: now - secs * 1000 });
const me = { tenantId: "t-me", agentId: "u-me" };

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
  assert(done.includes("j1") && done.includes("node__shell") && done.includes("130s"), `header incomplete: ${done}`);
  assert(!done.includes("node.shell"), `the message names a dispatch address: ${done}`);
  assert(done.includes('"exitCode":0'), `result missing: ${done}`);
  const failed = completionMessage(job("j2"), { state: "failed", error: "box gone" }, now);
  assert(failed.includes("failed") && failed.includes("box gone"), `error missing: ${failed}`);
});

await check("the job table: recorded, due on schedule, polled forward, and the soonest wake", async () => {
  const host = sqliteHost(); const sql = host.sql as any;
  try {
    assert(nextBackgroundWake(sql, me, now) === null, "nothing running, yet the alarm was asked to wake");
    recordBackgroundJob(sql, me, { id: "j1", session: "main", mount: "node", tool: "shell", handle: { boxId: "b", execId: "e1" } }, now);
    recordBackgroundJob(sql, me, { id: "j2", session: "s2", mount: "node", tool: "run", handle: { execId: "e2" } }, now + 1_000);
    const running = runningBackgroundJobs(sql, me);
    assert(running.length === 2 && running[0]!.id === "j1", `running: ${JSON.stringify(running.map((j) => j.id))}`);
    assert((running[0]!.handle as any).execId === "e1", "the handle did not survive the round trip");
    assert(nextBackgroundWake(sql, me, now) === 2_000, `first wake ${nextBackgroundWake(sql, me, now)}`);
    assert(dueBackgroundJobs(sql, me, now + 1_999).length === 0, "a job was due before its first check");
    assert(dueBackgroundJobs(sql, me, now + 2_000).map((j) => j.id).join() === "j1", "j1 was not due at 2 s");
    markPolled(sql, me, "j1", now + 2_000);
    assert(dueBackgroundJobs(sql, me, now + 2_001).map((j) => j.id).join() === "", "a polled job stayed due");
    assert(nextBackgroundWake(sql, me, now + 2_000) === 1_000, `wake after polling j1: ${nextBackgroundWake(sql, me, now + 2_000)}`);
  } finally { host.dispose(); }
});

await check("a finished or cancelled job stays finished: a late answer cannot overwrite it", async () => {
  const host = sqliteHost(); const sql = host.sql as any;
  try {
    recordBackgroundJob(sql, me, { id: "j1", session: "main", mount: "node", tool: "shell", handle: {} }, now);
    assert(finishBackgroundJob(sql, me, "j1", { state: "cancelled" }, now + 5_000), "a running job could not be cancelled");
    assert(!finishBackgroundJob(sql, me, "j1", { state: "done", result: { exitCode: 0 } }, now + 9_000), "a late result overwrote the cancel");
    assert(runningBackgroundJobs(sql, me).length === 0, "a cancelled job still counts as running");
    assert(nextBackgroundWake(sql, me, now) === null, "a finished job still asks the alarm to wake");
    assert(!finishBackgroundJob(sql, me, "nope", { state: "done" }, now), "an unknown job was finished");
  } finally { host.dispose(); }
});

await check("every read names the owner: another agent's rows are never listed, polled, finished or counted", async () => {
  const host = sqliteHost(); const sql = host.sql as any;
  const other = { tenantId: "t-other", agentId: "u-me" };
  try {
    recordBackgroundJob(sql, other, { id: "x1", session: "main", mount: "node", tool: "shell", handle: { execId: "theirs" } }, now);
    assert(runningBackgroundJobs(sql, me).length === 0, "another owner's job was listed");
    assert(dueBackgroundJobs(sql, me, now + 60_000).length === 0, "another owner's job came due for this agent");
    assert(nextBackgroundWake(sql, me, now) === null, "another owner's job woke this agent");
    assert(!finishBackgroundJob(sql, me, "x1", { state: "cancelled" }, now), "this agent finished another owner's job");
    markPolled(sql, me, "x1", now);
    assert(runningBackgroundJobs(sql, other)[0]!.polls === 0, "this agent polled another owner's job forward");
    assert(mountsWithRunningJobs(sql, me).size === 0, "another owner's running job shielded this agent's mount");
  } finally { host.dispose(); }
});

await check("a mount with running work is shielded from idle reclaim, and only while it runs", async () => {
  const host = sqliteHost(); const sql = host.sql as any;
  try {
    recordBackgroundJob(sql, me, { id: "j1", session: "main", mount: "node", tool: "shell", handle: {} }, now);
    assert(mountsWithRunningJobs(sql, me).has("node"), "a mount running a background exec was not shielded");
    assert(!mountsWithRunningJobs(sql, me).has("web"), "a mount with nothing running was shielded");
    finishBackgroundJob(sql, me, "j1", { state: "done" }, now + 1);
    assert(!mountsWithRunningJobs(sql, me).has("node"), "a mount stayed shielded after its job finished");
  } finally { host.dispose(); }
});

await check("a job past the ceiling is overdue; one inside it is not", async () => {
  assert(BACKGROUND_MAX_MS === 30 * 60_000, `ceiling ${BACKGROUND_MAX_MS}`);
  assert(!overdueBackground({ createdAt: now - BACKGROUND_MAX_MS }, now), "exactly at the ceiling counted as overdue");
  assert(overdueBackground({ createdAt: now - BACKGROUND_MAX_MS - 1 }, now), "past the ceiling did not count as overdue");
});

function fakes() {
  const log = { completed: [] as string[], delivered: [] as Array<{ session: string; text: string }>, cancelled: [] as string[] };
  return {
    log,
    completeOperation: async (id: string, status: string) => { log.completed.push(`${id}:${status}`); },
    deliver: async (session: string, text: string) => { log.delivered.push({ session, text }); },
    cancel: async (j: { id: string }) => { log.cancelled.push(j.id); },
  };
}

await check("a pass finishes a done job: operation succeeded, result delivered to its session, nothing left to wake for", async () => {
  const host = sqliteHost(); const sql = host.sql as any; const f = fakes();
  try {
    recordBackgroundJob(sql, me, { id: "op1", session: "s2", mount: "node", tool: "node__shell", handle: { execId: "e1" } }, now);
    const r = await runBackgroundPass({ sql, owner: me, now: now + 2_000, ...f,
      poll: async () => ({ done: true as const, result: { exitCode: 0, output: "all green" } }) });
    assert(r.finished.join() === "op1", `finished: ${r.finished}`);
    assert(f.log.completed.join() === "op1:succeeded", `operation: ${f.log.completed}`);
    assert(f.log.delivered.length === 1 && f.log.delivered[0]!.session === "s2", `delivered to ${JSON.stringify(f.log.delivered)}`);
    assert(f.log.delivered[0]!.text.includes("all green"), `the result is not in the message: ${f.log.delivered[0]!.text}`);
    assert(runningBackgroundJobs(sql, me).length === 0 && r.wakeInMs === null, "a finished job still runs or wakes");
  } finally { host.dispose(); }
});

await check("a pass leaves an unfinished or unreachable job running and checks it later", async () => {
  const host = sqliteHost(); const sql = host.sql as any; const f = fakes();
  try {
    recordBackgroundJob(sql, me, { id: "op1", session: "main", mount: "node", tool: "node__shell", handle: {} }, now);
    recordBackgroundJob(sql, me, { id: "op2", session: "main", mount: "node", tool: "node__shell", handle: {} }, now);
    const r = await runBackgroundPass({ sql, owner: me, now: now + 2_000, ...f,
      poll: async (j) => { if (j.id === "op2") throw new Error("run9 502"); return { done: false as const }; } });
    assert(r.checked === 2 && r.finished.length === 0, `checked ${r.checked}, finished ${r.finished}`);
    assert(f.log.delivered.length === 0 && f.log.completed.length === 0, "an unfinished job was delivered or completed");
    assert(runningBackgroundJobs(sql, me).length === 2, "a job stopped running without an answer");
    assert(r.wakeInMs === nextPollDelay(1), `next wake ${r.wakeInMs}, expected ${nextPollDelay(1)}`);
  } finally { host.dispose(); }
});

await check("a job past the ceiling is cancelled and failed, even when the plugin cannot stop it", async () => {
  const host = sqliteHost(); const sql = host.sql as any; const f = fakes();
  try {
    recordBackgroundJob(sql, me, { id: "op1", session: "main", mount: "node", tool: "node__shell", handle: {} }, now);
    const later = now + BACKGROUND_MAX_MS + 60_000;
    const r = await runBackgroundPass({ sql, owner: me, now: later, ...f,
      poll: async () => ({ done: false as const }),
      cancel: async () => { f.log.cancelled.push("tried"); throw new Error("box gone"); } });
    assert(f.log.cancelled.join() === "tried", "the plugin was not asked to stop the job");
    assert(r.finished.join() === "op1" && f.log.completed.join() === "op1:failed", `finished ${r.finished}, op ${f.log.completed}`);
    assert(/longer than 30 minutes/.test(f.log.delivered[0]?.text ?? ""), `the agent was not told why: ${f.log.delivered[0]?.text}`);
  } finally { host.dispose(); }
});

await check("the jobs tool lists running work by offered name, and cancels one by id", async () => {
  const host = sqliteHost(); const sql = host.sql as any; const f = fakes();
  try {
    recordBackgroundJob(sql, me, { id: "op1", session: "main", mount: "node", tool: "node__shell", handle: {} }, now);
    const t = jobsTool({ sql, owner: me, cancel: f.cancel, completeOperation: f.completeOperation, now: () => now + 42_000 });
    const listed = JSON.parse((await t.execute("c1", { action: "list" })).content[0]!.text);
    assert(listed.running[0]?.job === "op1" && listed.running[0]?.tool === "node__shell" && listed.running[0]?.runningSeconds === 42,
      `list: ${JSON.stringify(listed)}`);
    let msg = "";
    try { await t.execute("c2", { action: "cancel", job: "nope" }); } catch (e) { msg = String((e as Error).message); }
    assert(/no running job/.test(msg), `cancelling an unknown job did not say so: ${msg}`);
    await t.execute("c3", { action: "cancel", job: "op1" });
    assert(f.log.cancelled.join() === "op1" && f.log.completed.join() === "op1:cancelled", `cancel: ${JSON.stringify(f.log)}`);
    assert(runningBackgroundJobs(sql, me).length === 0, "a cancelled job still runs");
  } finally { host.dispose(); }
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
