/**
 * The queue consumer for offloaded model calls, and what it does with a job id
 * the agent does not hold.
 *
 * Kept out of cf/src/index.ts so it runs under node (the Worker's entry cannot
 * be imported there): the provider call and the stub are handed in.
 */
import { logEvent } from "../../src/core/log.ts";
import { providerOutcome } from "./image-evidence.ts";

/** One message on the model-call queue: which object, which agent, which job row. */
export interface QueuedModelCall {
  doId: string;
  tenantId: string;
  agentId: string;
  jobId: string;
  /**
   * `prewarm`: not a job of the conversation but a prompt-cache prewarm (src/runtime/prewarm.ts), taken and reported
   * through its own two methods and never retried. Absent: a model job, as every message was before.
   */
  kind?: "prewarm";
}

/**
 * A job id with no `pi_model_jobs` row in the agent's object.
 *
 * Thrown by the runtime instead of guessing a session: falling back to the main
 * session found no row there either, so the request was never taken and the
 * answer never written, and nothing said so. A row is only deleted when its run
 * is cancelled, so the usual cause is a message that outlived its job; a retry
 * cannot bring the row back.
 */
export class UnknownJob extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`UnknownJob: no model job ${jobId} in this agent`);
    this.name = "UnknownJob";
    this.jobId = jobId;
  }
}

/**
 * What the Durable Object returns over RPC in place of throwing `UnknownJob`.
 * A class does not survive the RPC boundary (the caller gets a plain Error), so
 * the object answers with a value the consumer can test by shape.
 */
export interface UnknownJobReply {
  unknownJob: string;
}

export function isUnknownJobReply(v: unknown): v is UnknownJobReply {
  return typeof v === "object" && v !== null && typeof (v as { unknownJob?: unknown }).unknownJob === "string";
}

/** `fn`'s value, or an `UnknownJobReply` when it threw `UnknownJob`; any other throw passes through. */
export async function replyingUnknownJob<T>(fn: () => Promise<T>): Promise<T | UnknownJobReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UnknownJob) return { unknownJob: e.jobId };
    throw e;
  }
}

/** The RPC methods of the agent's object the consumer uses. */
export interface ModelJobStub {
  /** `taker`: this attempt's own name (`newTaker`); a job under another taker's live take is refused (null). */
  takeJob(tenantId: string, agentId: string, jobId: string, taker?: string): Promise<unknown>;
  /** Gives back the taker's take when its attempt failed, so a retry can take the job. */
  releaseJob(tenantId: string, agentId: string, jobId: string, taker: string): Promise<unknown>;
  /** `taker`: the attempt whose call this answers, so a replay of this RPC is metered once (`PdHost.deliver`). */
  deliverAnswer(tenantId: string, agentId: string, jobId: string, answer: unknown, modelMs: number, taker?: string): Promise<unknown>;
  /** A prewarm's request, once; null when it was taken already or is skipped (`AgentRuntime.takePrewarm`). */
  takePrewarm?(tenantId: string, agentId: string, jobId: string): Promise<unknown>;
  /** How the prewarm ended, and its usage to meter (`AgentRuntime.prewarmDone`). */
  prewarmDone?(tenantId: string, agentId: string, jobId: string, result: unknown): Promise<unknown>;
  /** One attempt that failed and is retried, for the agent's trace (`AgentRuntime.recordModelAttempt`). */
  recordModelAttempt?(tenantId: string, agentId: string, jobId: string, attempt: FailedAttempt): Promise<unknown>;
}

/**
 * How far an attempt got (`runModelCall`), so a failure can say which step failed and how long the provider took.
 * Written as the attempt goes; read only when it throws.
 */
export interface AttemptProgress {
  phase: "take" | "admit" | "call" | "deliver";
  /** The model the taken job names (`operatorModel`), once it is taken. */
  model?: string;
  /** When the provider call began; the provider's time is measured from here. */
  callStartedAt?: number;
  /** The provider call's time, once it has answered: a failure after it is the delivery's. */
  providerMs?: number;
}

/**
 * One failed attempt as its trace row records it (`modelAttemptRow`, src/trace/seams.ts): which delivery of the message
 * it was, the step that failed, and what the failure was as classes and numbers (`providerOutcome`: an HTTP status, a
 * timeout, or an error's class name). Never the error's message: a provider's error carries its response body, and the
 * row is exported. The message stays where it was, in the consumer's own log line.
 */
export interface FailedAttempt {
  /** The queue's delivery count for the message (Cloudflare's `Message.attempts`, from 1); null where it gave none. */
  attempt: number | null;
  phase: AttemptProgress["phase"];
  outcome: "http" | "timeout" | "transport_error";
  httpStatus?: number;
  errorClass?: string;
  /** The whole attempt, from before the take to the failure. */
  ms: number;
  /** The provider call alone: to its failure when the call failed, to its answer when the delivery after it did. */
  providerMs?: number;
  model?: string;
}

/** `e` and how far the attempt got, as a `FailedAttempt`. */
export function failedAttempt(e: unknown, progress: AttemptProgress, attempt: number | undefined, startedAt: number, now = Date.now()): FailedAttempt {
  const o = providerOutcome(e, undefined, new Date(now));
  const providerMs = progress.providerMs
    ?? (progress.phase === "call" && progress.callStartedAt !== undefined ? now - progress.callStartedAt : undefined);
  return {
    attempt: typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 ? attempt : null,
    phase: progress.phase,
    outcome: o.outcome,
    ...(o.outcome === "http" ? { httpStatus: o.status } : {}),
    ...(o.outcome === "transport_error" ? { errorClass: o.errorClass } : {}),
    ms: Math.max(0, now - startedAt),
    ...(providerMs === undefined ? {} : { providerMs: Math.max(0, providerMs) }),
    ...(progress.model ? { model: progress.model } : {}),
  };
}

export interface ModelQueueDeps {
  stub(m: QueuedModelCall): ModelJobStub;
  /** The provider call for a taken job: the answer to deliver. */
  call(job: unknown, m: QueuedModelCall): Promise<unknown>;
  /** The answer a given-up job is delivered. */
  givenUp(m: QueuedModelCall): unknown;
  /**
   * Asked after the take and before the provider call: null to call it, or the answer to deliver instead
   * (a daily spend limit reached, cf/src/spend-limit.ts). An answer, not a throw, so the message is acked and
   * neither the queue nor the harness sends the call again.
   */
  admit?(job: unknown, m: QueuedModelCall): Promise<unknown | null>;
  /** A prewarm's provider call (cf/src/model-request.ts `callPrewarm`): never throws, its failure is its outcome. */
  prewarm?(job: unknown, m: QueuedModelCall): Promise<{ model: string; outcome: string } & Record<string, unknown>>;
}

export interface ModelQueueMessage {
  readonly body: QueuedModelCall;
  /** How many times the queue has delivered this message, this one included (Cloudflare's `Message.attempts`). */
  readonly attempts?: number;
  ack(): void;
  retry(): void;
}

/**
 * How long the consumer waits on a failed attempt's trace row before retrying without it. The same bound as an image
 * evidence write (`EVIDENCE_WRITE_BOUND_MS`, cf/src/image-evidence.ts), for the same reason: a record is never worth
 * holding up the call it describes, and here the object being asked may be the one that just failed.
 */
export const ATTEMPT_TRACE_BOUND_MS = 2_000;

/**
 * A failed attempt's trace row, written by the agent's object. Without it a retried call showed in the trace only as
 * the one slow `model.call` its final answer closed, with nothing saying an attempt had failed in between (a 36 s call
 * in an onboarding agent's turn, 2026-10-20). A failure to write it, or no answer within ATTEMPT_TRACE_BOUND_MS, is
 * logged and never stops the retry.
 */
async function traceFailedAttempt(m: QueuedModelCall, deps: ModelQueueDeps, attempt: FailedAttempt, boundMs = ATTEMPT_TRACE_BOUND_MS): Promise<void> {
  const failed = (reason: "error" | "timeout", error: string) =>
    logEvent("model_job.attempt_trace_failed", { tenantId: m.tenantId, agentId: m.agentId, jobId: m.jobId, reason, error });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"slow">((r) => { timer = setTimeout(() => r("slow"), boundMs); });
  try {
    const stub = deps.stub(m);
    if (!stub.recordModelAttempt) return;
    const wrote = Promise.resolve().then(() => stub.recordModelAttempt!(m.tenantId, m.agentId, m.jobId, attempt)).then(() => "done" as const);
    if (await Promise.race([wrote, bound]) === "slow") {
      failed("timeout", `no answer within ${boundMs} ms`);
      wrote.catch(() => { /* already reported as slow */ });
    }
  } catch (e) {
    failed("error", String((e as Error)?.message ?? e).slice(0, 200));
  } finally { clearTimeout(timer); }
}

/** Logged once per message whose job the agent does not hold; the message is then acked. */
function unknownJob(m: QueuedModelCall, phase: "take" | "deliver" | "give_up"): void {
  logEvent("model_job.unknown", { tenantId: m.tenantId, agentId: m.agentId, jobId: m.jobId, phase });
}

/**
 * A name for one attempt at a job, fresh each time. Not the queue message's id: the queue does not promise to keep it
 * across retries, and two deliveries of one message would share it, so a guard keyed on it could refuse a retry or
 * grant both deliveries.
 */
function newTaker(): string { return crypto.randomUUID(); }

/**
 * Takes the job as a fresh taker and runs `use` on it; does nothing when the take is null (answered, cancelled, or
 * under another taker's live take). When `use` throws, the take is given back before the throw goes on, so the queue's
 * retry (or the dead letter queue) can take the job at once; a release that fails leaves the take to lapse.
 */
async function withTake(
  m: QueuedModelCall, stub: ModelJobStub, phase: "take" | "give_up", use: (job: unknown, taker: string) => Promise<void>,
): Promise<void> {
  const taker = newTaker();
  const job = await stub.takeJob(m.tenantId, m.agentId, m.jobId, taker);
  if (isUnknownJobReply(job)) return unknownJob(m, phase);
  if (!job) return;
  try { await use(job, taker); }
  catch (e) {
    try { await stub.releaseJob(m.tenantId, m.agentId, m.jobId, taker); }
    catch (r) { logEvent("model_job.release_failed", { tenantId: m.tenantId, agentId: m.agentId, jobId: m.jobId, error: String((r as Error)?.message ?? r).slice(0, 200) }); }
    throw e;
  }
}

/**
 * The model call, waited on where waiting is free (see index.ts). Null from the take — already answered (a
 * redelivery after success, which must not call the provider again), or another attempt is calling it now —
 * calls nothing.
 */
export async function runModelCall(m: QueuedModelCall, deps: ModelQueueDeps, progress: AttemptProgress = { phase: "take" }): Promise<void> {
  const stub = deps.stub(m);
  await withTake(m, stub, "take", async (job, taker) => {
    const model = (job as { operatorModel?: unknown }).operatorModel;
    if (typeof model === "string" && model) progress.model = model.slice(0, 120);
    progress.phase = "admit";
    const refused = deps.admit ? await deps.admit(job, m) : null;
    if (refused) {
      const wrote = await stub.deliverAnswer(m.tenantId, m.agentId, m.jobId, refused, 0, taker);
      if (isUnknownJobReply(wrote)) unknownJob(m, "deliver");
      return;
    }
    const t0 = Date.now();
    progress.phase = "call";
    progress.callStartedAt = t0;
    const answer = await deps.call(job, m);
    progress.providerMs = Date.now() - t0;
    progress.phase = "deliver";
    const wrote = await stub.deliverAnswer(m.tenantId, m.agentId, m.jobId, answer, progress.providerMs, taker);
    if (isUnknownJobReply(wrote)) unknownJob(m, "deliver");
  });
}

/**
 * Out of retries. The agent has to hear about it, or it waits for ever. It takes the job like a call does, so a
 * job another attempt is still calling the model for is left to that attempt: its answer is the one paid for. If
 * that attempt dies, its take lapses and the job is sent again (src/runtime/durable-agent.ts `#sweep`).
 */
export async function failLoudly(m: QueuedModelCall, deps: ModelQueueDeps): Promise<void> {
  const stub = deps.stub(m);
  await withTake(m, stub, "give_up", async (_job, taker) => {
    const wrote = await stub.deliverAnswer(m.tenantId, m.agentId, m.jobId, deps.givenUp(m), 0, taker);
    if (isUnknownJobReply(wrote)) unknownJob(m, "give_up");
  });
}

/**
 * One batch. A message whose job is unknown returns normally from either path,
 * so it is acked like a success: retrying cannot create the row, and a retry
 * would only walk it to the dead letter queue and back here.
 */
/**
 * A prompt-cache prewarm (src/runtime/prewarm.ts): taken once from the object, called, reported back. Admitted like a
 * model call (the daily spend limits): a refusal skips it. Nothing here throws to the queue: a prewarm is at most once,
 * so a failure is reported as its outcome and the message acked, never sent again.
 */
export async function runPrewarm(m: QueuedModelCall, deps: ModelQueueDeps): Promise<void> {
  const stub = deps.stub(m);
  if (!stub.takePrewarm || !stub.prewarmDone || !deps.prewarm) return;
  let job: unknown;
  try { job = await stub.takePrewarm(m.tenantId, m.agentId, m.jobId); }
  catch (e) { logEvent("model_prewarm.take_failed", { tenantId: m.tenantId, agentId: m.agentId, jobId: m.jobId, error: String((e as Error)?.message ?? e).slice(0, 200) }); return; }
  if (!job) return;
  const model = String((job as { operatorModel?: unknown }).operatorModel ?? "unknown");
  let result: { model: string; outcome: string } & Record<string, unknown>;
  try {
    const refused = deps.admit ? await deps.admit(job, m) : null;
    result = refused ? { model, outcome: "skipped: a daily spend limit is reached" } : await deps.prewarm(job, m);
  } catch (e) {
    result = { model, outcome: `failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
  try { await stub.prewarmDone(m.tenantId, m.agentId, m.jobId, result); }
  catch (e) { logEvent("model_prewarm.report_failed", { tenantId: m.tenantId, agentId: m.agentId, jobId: m.jobId, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
}

export async function consumeModelCalls(
  batch: { readonly queue: string; readonly messages: readonly ModelQueueMessage[] },
  deps: ModelQueueDeps,
  /** How long a failed attempt's trace row is waited on (`traceFailedAttempt`); a test shortens it. */
  traceBoundMs = ATTEMPT_TRACE_BOUND_MS,
): Promise<void> {
  for (const message of batch.messages) {
    if (message.body.kind === "prewarm") {
      // Never retried, and no answer is owed to anyone: on the dead letter queue there is nothing to give up on.
      if (!batch.queue.endsWith("-dlq")) await runPrewarm(message.body, deps);
      message.ack();
      continue;
    }
    if (batch.queue.endsWith("-dlq")) {
      await failLoudly(message.body, deps);
      message.ack();
      continue;
    }
    const progress: AttemptProgress = { phase: "take" };
    const startedAt = Date.now();
    try {
      await runModelCall(message.body, deps, progress);
      message.ack();
    } catch (e) {
      // Deliberately not acked: the queue redelivers, and after max_retries
      // the message lands in the dead letter queue, where it becomes a
      // visible failure on the task rather than a silence.
      console.error("model call failed", String((e as Error)?.message ?? e));
      await traceFailedAttempt(message.body, deps, failedAttempt(e, progress, message.attempts, startedAt), traceBoundMs);
      message.retry();
    }
  }
}
