/**
 * The queue consumer for offloaded model calls, and what it does with a job id
 * the agent does not hold.
 *
 * Kept out of cf/src/index.ts so it runs under node (the Worker's entry cannot
 * be imported there): the provider call and the stub are handed in.
 */
import { logEvent } from "../../src/core/log.ts";

/** One message on the model-call queue: which object, which agent, which job row. */
export interface QueuedModelCall {
  doId: string;
  tenantId: string;
  agentId: string;
  jobId: string;
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
  deliverAnswer(tenantId: string, agentId: string, jobId: string, answer: unknown, modelMs: number): Promise<unknown>;
}

export interface ModelQueueDeps {
  stub(m: QueuedModelCall): ModelJobStub;
  /** The provider call for a taken job: the answer to deliver. */
  call(job: unknown, m: QueuedModelCall): Promise<unknown>;
  /** The answer a given-up job is delivered. */
  givenUp(m: QueuedModelCall): unknown;
}

export interface ModelQueueMessage {
  readonly body: QueuedModelCall;
  ack(): void;
  retry(): void;
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
  m: QueuedModelCall, stub: ModelJobStub, phase: "take" | "give_up", use: (job: unknown) => Promise<void>,
): Promise<void> {
  const taker = newTaker();
  const job = await stub.takeJob(m.tenantId, m.agentId, m.jobId, taker);
  if (isUnknownJobReply(job)) return unknownJob(m, phase);
  if (!job) return;
  try { await use(job); }
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
export async function runModelCall(m: QueuedModelCall, deps: ModelQueueDeps): Promise<void> {
  const stub = deps.stub(m);
  await withTake(m, stub, "take", async (job) => {
    const t0 = Date.now();
    const answer = await deps.call(job, m);
    const wrote = await stub.deliverAnswer(m.tenantId, m.agentId, m.jobId, answer, Date.now() - t0);
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
  await withTake(m, stub, "give_up", async () => {
    const wrote = await stub.deliverAnswer(m.tenantId, m.agentId, m.jobId, deps.givenUp(m), 0);
    if (isUnknownJobReply(wrote)) unknownJob(m, "give_up");
  });
}

/**
 * One batch. A message whose job is unknown returns normally from either path,
 * so it is acked like a success: retrying cannot create the row, and a retry
 * would only walk it to the dead letter queue and back here.
 */
export async function consumeModelCalls(
  batch: { readonly queue: string; readonly messages: readonly ModelQueueMessage[] },
  deps: ModelQueueDeps,
): Promise<void> {
  for (const message of batch.messages) {
    if (batch.queue.endsWith("-dlq")) {
      await failLoudly(message.body, deps);
      message.ack();
      continue;
    }
    try {
      await runModelCall(message.body, deps);
      message.ack();
    } catch (e) {
      // Deliberately not acked: the queue redelivers, and after max_retries
      // the message lands in the dead letter queue, where it becomes a
      // visible failure on the task rather than a silence.
      console.error("model call failed", String((e as Error)?.message ?? e));
      message.retry();
    }
  }
}
