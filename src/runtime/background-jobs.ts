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
  /** The mount's alias: where the work is polled and cancelled. */
  mount: string;
  /** The tool as the model was offered it (`node__shell`), never the dispatch address. */
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
 * How long a background call may run before it is cancelled. Not because long
 * work is wrong — that is what backgrounding is for — but because a job that
 * never ends holds one of the agent's slots and is billed for as long as it
 * runs (Piper, 2026-09-14).
 */
export const BACKGROUND_MAX_MS = 30 * 60_000;

export interface JobOwner {
  tenantId: string;
  agentId: string;
}

/** Past the ceiling: the poller cancels it through the plugin and finishes it as failed. */
export function overdueBackground(job: Pick<BackgroundJob, "createdAt">, now: number = Date.now(), maxMs: number = BACKGROUND_MAX_MS): boolean {
  return now - job.createdAt > maxMs;
}

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
    .map((j) => `${j.id} (${j.tool}, running ${Math.round((now - j.createdAt) / 1000)}s)`)
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
  const head = `[background job ${job.id} — ${job.tool} — ${outcome.state} after ${secs}s]`;
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
 *
 * The table is already this agent's alone (one object per agent, claimed on
 * first use), and every read still names the owner: a handle goes back to a
 * plugin to be polled or cancelled, and a query that forgot whose it was would
 * send another agent's work there (Piper, 2026-09-14; the same lesson as the
 * artifact references).
 */
export function ensureBackgroundTable(sql: Sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS background_jobs (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    session TEXT NOT NULL, mount TEXT NOT NULL, tool TEXT NOT NULL,
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
  sql: Sql, owner: JobOwner, job: { id: string; session: string; mount: string; tool: string; handle: unknown }, now: number = Date.now(),
) {
  ensureBackgroundTable(sql);
  sql.exec(
    "INSERT INTO background_jobs(id, tenant_id, agent_id, session, mount, tool, handle, state, created_at, polls, next_poll_at) VALUES (?,?,?,?,?,?,?,'running',?,0,?)",
    job.id, owner.tenantId, owner.agentId, job.session, job.mount, job.tool, JSON.stringify(job.handle ?? null), now, now + nextPollDelay(0));
}

export function runningBackgroundJobs(sql: Sql, owner: JobOwner): BackgroundJob[] {
  ensureBackgroundTable(sql);
  return sql.exec("SELECT * FROM background_jobs WHERE tenant_id = ? AND agent_id = ? AND state = 'running' ORDER BY created_at ASC",
    owner.tenantId, owner.agentId).toArray().map(rowToJob);
}

/** Mounts with work still running: idle reclaim must not release their boxes (Piper, 2026-09-14). */
export function mountsWithRunningJobs(sql: Sql, owner: JobOwner): Set<string> {
  return new Set(runningBackgroundJobs(sql, owner).map((j) => j.mount));
}

export function dueBackgroundJobs(sql: Sql, owner: JobOwner, now: number = Date.now()): BackgroundJob[] {
  ensureBackgroundTable(sql);
  return sql.exec("SELECT * FROM background_jobs WHERE tenant_id = ? AND agent_id = ? AND state = 'running' AND next_poll_at <= ? ORDER BY next_poll_at ASC",
    owner.tenantId, owner.agentId, now).toArray().map(rowToJob);
}

/** A check that found the job still running: count it and schedule the next. */
export function markPolled(sql: Sql, owner: JobOwner, id: string, now: number = Date.now()) {
  const row = sql.exec("SELECT polls FROM background_jobs WHERE id = ? AND tenant_id = ? AND agent_id = ?",
    id, owner.tenantId, owner.agentId).toArray()[0] as any;
  if (!row) return;
  const polls = Number(row.polls) + 1;
  sql.exec("UPDATE background_jobs SET polls = ?, next_poll_at = ? WHERE id = ? AND tenant_id = ? AND agent_id = ? AND state = 'running'",
    polls, now + nextPollDelay(polls), id, owner.tenantId, owner.agentId);
}

/** Only a running job finishes, so a late answer cannot overwrite a cancel. Returns whether it did. */
export function finishBackgroundJob(
  sql: Sql, owner: JobOwner, id: string, outcome: { state: "done" | "failed" | "cancelled"; result?: unknown; error?: string }, now: number = Date.now(),
): boolean {
  const before = sql.exec("SELECT state FROM background_jobs WHERE id = ? AND tenant_id = ? AND agent_id = ?",
    id, owner.tenantId, owner.agentId).toArray()[0] as any;
  if (!before || before.state !== "running") return false;
  sql.exec("UPDATE background_jobs SET state = ?, finished_at = ?, outcome = ? WHERE id = ? AND tenant_id = ? AND agent_id = ? AND state = 'running'",
    outcome.state, now, JSON.stringify({ result: outcome.result ?? null, error: outcome.error ?? null }), id, owner.tenantId, owner.agentId);
  return true;
}

/** Milliseconds until the soonest check, or null when nothing is running: the alarm stands down. */
export function nextBackgroundWake(sql: Sql, owner: JobOwner, now: number = Date.now()): number | null {
  ensureBackgroundTable(sql);
  const row = sql.exec("SELECT MIN(next_poll_at) AS at FROM background_jobs WHERE tenant_id = ? AND agent_id = ? AND state = 'running'",
    owner.tenantId, owner.agentId).toArray()[0] as any;
  if (!row || row.at === null || row.at === undefined) return null;
  return Math.max(0, Number(row.at) - now);
}

/** What a pass over due jobs needs from the runtime; each is a one-line call there. */
export interface BackgroundPassDeps {
  sql: Sql;
  owner: JobOwner;
  now?: number;
  maxMs?: number;
  poll(job: BackgroundJob): Promise<{ done: false; progress?: unknown } | { done: true; result: unknown }>;
  cancel(job: BackgroundJob): Promise<void>;
  completeOperation(operationId: string, status: "succeeded" | "failed" | "cancelled"): Promise<void>;
  deliver(session: string, text: string): Promise<void>;
}

/**
 * One alarm's worth of background work: check what is due, cancel what is past
 * the ceiling, finish and deliver what ended, and say when to come back.
 *
 * A poll that throws is not a result: the job is checked again later, and the
 * ceiling is what keeps "later" from being forever. A cancel that throws past
 * the ceiling still fails the job — the slot and the bill are what the
 * ceiling protects, and a plugin that cannot stop its work cannot change that.
 */
export async function runBackgroundPass(d: BackgroundPassDeps): Promise<{ checked: number; finished: string[]; wakeInMs: number | null }> {
  const now = d.now ?? Date.now();
  const maxMs = d.maxMs ?? BACKGROUND_MAX_MS;
  const finished: string[] = [];
  const due = dueBackgroundJobs(d.sql, d.owner, now);
  for (const job of due) {
    if (overdueBackground(job, now, maxMs)) {
      try { await d.cancel(job); } catch { /* failed either way; see above */ }
      const outcome = { state: "failed" as const, error: `ran longer than ${Math.round(maxMs / 60_000)} minutes and was cancelled` };
      if (finishBackgroundJob(d.sql, d.owner, job.id, outcome, now)) {
        await d.completeOperation(job.id, "failed");
        await d.deliver(job.session, completionMessage(job, outcome, now));
        finished.push(job.id);
      }
      continue;
    }
    let answer: Awaited<ReturnType<BackgroundPassDeps["poll"]>>;
    try { answer = await d.poll(job); }
    catch { markPolled(d.sql, d.owner, job.id, now); continue; }
    if (!answer.done) { markPolled(d.sql, d.owner, job.id, now); continue; }
    const outcome = { state: "done" as const, result: answer.result };
    if (finishBackgroundJob(d.sql, d.owner, job.id, outcome, now)) {
      await d.completeOperation(job.id, "succeeded");
      await d.deliver(job.session, completionMessage(job, outcome, now));
      finished.push(job.id);
    }
  }
  return { checked: due.length, finished, wakeInMs: nextBackgroundWake(d.sql, d.owner, now) };
}

/**
 * The agent's view of its background work: what is running, and a way to stop
 * one. A finished job needs no asking — its result arrives as a message — so
 * there is deliberately no "status" action for a model to spend turns on.
 */
/**
 * Stop the background work one session started, when its turn is cancelled
 * (Agents API input.cancel, task #17). A job whose stop is confirmed is finished
 * as cancelled; one whose stop fails stays tracked, so `jobs` still lists it and
 * the ceiling asks again.
 */
export async function stopSessionJobs(d: {
  sql: Sql;
  owner: JobOwner;
  session: string;
  cancel(job: BackgroundJob): Promise<void>;
  completeOperation(operationId: string, status: "cancelled"): Promise<void>;
  now?: number;
}): Promise<{ stopped: string[]; stillRunning: string[] }> {
  const stopped: string[] = [], stillRunning: string[] = [];
  for (const job of runningBackgroundJobs(d.sql, d.owner).filter((j) => j.session === d.session)) {
    try { await d.cancel(job); } catch { stillRunning.push(job.id); continue; }
    if (finishBackgroundJob(d.sql, d.owner, job.id, { state: "cancelled" }, d.now ?? Date.now())) {
      await d.completeOperation(job.id, "cancelled");
    }
    stopped.push(job.id);
  }
  return { stopped, stillRunning };
}

export function jobsTool(d: {
  sql: Sql;
  owner: JobOwner;
  cancel(job: BackgroundJob): Promise<void>;
  completeOperation(operationId: string, status: "cancelled"): Promise<void>;
  now?: () => number;
}) {
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], details: {} });
  return {
    name: "jobs",
    label: "jobs",
    description:
      "Background tool calls this agent has running. action \"list\" shows them; action \"cancel\" with a job id " +
      "stops one. A finished job's result arrives as a message on its own, so there is no need to check on it.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "cancel"] },
        job: { type: "string", description: "the job id, for cancel" },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: { action?: string; job?: string }) {
      const now = d.now?.() ?? Date.now();
      if (params?.action === "cancel") {
        const job = runningBackgroundJobs(d.sql, d.owner).find((j) => j.id === params.job);
        if (!job) throw new Error(`jobs: no running job ${JSON.stringify(params?.job ?? null)}; jobs with action "list" shows the running ones`);
        try { await d.cancel(job); }
        catch (e) { throw new Error(`jobs: could not stop ${job.id}: ${(e as Error).message}`); }
        finishBackgroundJob(d.sql, d.owner, job.id, { state: "cancelled" }, now);
        await d.completeOperation(job.id, "cancelled");
        return text({ cancelled: job.id });
      }
      return text({
        running: runningBackgroundJobs(d.sql, d.owner)
          .map((j) => ({ job: j.id, tool: j.tool, runningSeconds: Math.round((now - j.createdAt) / 1000) })),
        limit: BACKGROUND_CAP,
      });
    },
  };
}
