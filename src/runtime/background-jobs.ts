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
