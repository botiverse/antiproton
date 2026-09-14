/**
 * Tool calls that outlive a turn.
 *
 * A container command was awaited inside the agent's object: the object was
 * billed for every second of it, the turn could not continue, and at
 * `timeoutMs` the command was killed (tygg, task #16, 2026-09-14: SWE-bench
 * billed the object for 75% of wall clock, τ² for 3%). A long call now leaves
 * a job behind instead: the tool answers at once with the job, the object
 * checks it on its alarm, and the result comes back as a message that wakes
 * the agent. While it runs the agent is free to think.
 *
 * Everything here is a rule that has to be able to fail a test — the cap, the
 * schedule, what the agent is told — so none of it lives inline at a call site.
 */

export interface BackgroundJob {
  id: string;
  mount: string;
  tool: string;
  /** Whatever the plugin needs to find the work again. Never a credential. */
  handle: unknown;
  state: "running" | "done" | "failed" | "cancelled";
  createdAt: number;
  finishedAt: number | null;
  polls: number;
  session: string;
}

/** Per agent, across every mount: a plugin sees only its own, so it cannot count this. */
export const BACKGROUND_CAP = 3;

/**
 * Whether one more background job may start. The refusal names what is
 * running, because the useful next step is to wait for one or cancel one, and
 * the agent cannot do either without the ids.
 */
export function admitBackground(
  running: Array<Pick<BackgroundJob, "id" | "mount" | "tool" | "createdAt">>,
  cap: number = BACKGROUND_CAP,
  now: number = Date.now(),
): { ok: true } | { ok: false; message: string } {
  if (running.length < cap) return { ok: true };
  const list = running
    .map((j) => `${j.id} (${j.mount}.${j.tool}, running ${Math.round((now - j.createdAt) / 1000)}s)`)
    .join(", ");
  return {
    ok: false,
    message: `${running.length} background jobs are already running, the most this agent may have at once: ${list}. ` +
      "Wait for one to finish (its result arrives as a message) or cancel one with jobs.cancel.",
  };
}

/** How long before the next check: soon at first, then less often, never more than 30 s apart. */
export function nextPollDelay(polls: number): number {
  const steps = [2_000, 5_000, 10_000, 20_000];
  return polls < steps.length ? steps[polls]! : 30_000;
}

/** What the agent is told the moment a call goes to the background. */
export function startedResult(job: Pick<BackgroundJob, "id" | "mount" | "tool">, note?: string) {
  return {
    state: "running",
    job: job.id,
    note: (note ? `${note} ` : "") +
      "This runs in the background. Keep working; its result arrives as a message when it finishes. " +
      "jobs.list shows what is running, jobs.cancel stops one.",
  };
}

/** The message that wakes the agent when a job ends. Plain text, so every lane mode accepts it. */
export function completionMessage(
  job: Pick<BackgroundJob, "id" | "mount" | "tool" | "createdAt">,
  outcome: { state: "done" | "failed" | "cancelled"; result?: unknown; error?: string },
  now: number = Date.now(),
): string {
  const secs = Math.round((now - job.createdAt) / 1000);
  const head = `[background job ${job.id} — ${job.mount}.${job.tool} — ${outcome.state} after ${secs}s]`;
  if (outcome.state === "done") return `${head}\n${JSON.stringify(outcome.result ?? null)}`;
  if (outcome.state === "failed") return `${head}\n${outcome.error ?? "failed without a message"}`;
  return head;
}

/** The two methods of a Durable Object's SQL a job table needs; node:sqlite provides the same pair in tests. */
type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };

/**
 * One row per background call, in the agent's own object. `next_poll_at` is
 * what the alarm reads: the object sleeps until the soonest one, and a job
 * that is not due costs nothing.
 */
export function ensureBackgroundTable(sql: Sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS background_jobs (
    id TEXT PRIMARY KEY, session TEXT NOT NULL, mount TEXT NOT NULL, tool TEXT NOT NULL,
    handle TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
    finished_at INTEGER, polls INTEGER NOT NULL DEFAULT 0, next_poll_at INTEGER NOT NULL,
    outcome TEXT)`);
}

const rowToJob = (r: any): BackgroundJob => ({
  id: String(r.id), session: String(r.session), mount: String(r.mount), tool: String(r.tool),
  handle: JSON.parse(String(r.handle)), state: r.state, createdAt: Number(r.created_at),
  finishedAt: r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at),
  polls: Number(r.polls),
});

export function recordBackgroundJob(
  sql: Sql, job: { id: string; session: string; mount: string; tool: string; handle: unknown }, now: number = Date.now(),
) {
  ensureBackgroundTable(sql);
  sql.exec(
    "INSERT INTO background_jobs(id, session, mount, tool, handle, state, created_at, polls, next_poll_at) VALUES (?,?,?,?,?,'running',?,0,?)",
    job.id, job.session, job.mount, job.tool, JSON.stringify(job.handle ?? null), now, now + nextPollDelay(0));
}

export function runningBackgroundJobs(sql: Sql): BackgroundJob[] {
  ensureBackgroundTable(sql);
  return sql.exec("SELECT * FROM background_jobs WHERE state = 'running' ORDER BY created_at ASC").toArray().map(rowToJob);
}

export function dueBackgroundJobs(sql: Sql, now: number = Date.now()): BackgroundJob[] {
  ensureBackgroundTable(sql);
  return sql.exec("SELECT * FROM background_jobs WHERE state = 'running' AND next_poll_at <= ? ORDER BY next_poll_at ASC", now)
    .toArray().map(rowToJob);
}

/** A check that found the job still running: count it and schedule the next. */
export function markPolled(sql: Sql, id: string, now: number = Date.now()) {
  const row = sql.exec("SELECT polls FROM background_jobs WHERE id = ?", id).toArray()[0] as any;
  if (!row) return;
  const polls = Number(row.polls) + 1;
  sql.exec("UPDATE background_jobs SET polls = ?, next_poll_at = ? WHERE id = ? AND state = 'running'",
    polls, now + nextPollDelay(polls), id);
}

/** Only a running job finishes, so a late answer cannot overwrite a cancel. Returns whether it did. */
export function finishBackgroundJob(
  sql: Sql, id: string, outcome: { state: "done" | "failed" | "cancelled"; result?: unknown; error?: string }, now: number = Date.now(),
): boolean {
  const before = sql.exec("SELECT state FROM background_jobs WHERE id = ?", id).toArray()[0] as any;
  if (!before || before.state !== "running") return false;
  sql.exec("UPDATE background_jobs SET state = ?, finished_at = ?, outcome = ? WHERE id = ? AND state = 'running'",
    outcome.state, now, JSON.stringify({ result: outcome.result ?? null, error: outcome.error ?? null }), id);
  return true;
}

/** Milliseconds until the soonest check, or null when nothing is running: the alarm stands down. */
export function nextBackgroundWake(sql: Sql, now: number = Date.now()): number | null {
  ensureBackgroundTable(sql);
  const row = sql.exec("SELECT MIN(next_poll_at) AS at FROM background_jobs WHERE state = 'running'").toArray()[0] as any;
  if (!row || row.at === null || row.at === undefined) return null;
  return Math.max(0, Number(row.at) - now);
}
