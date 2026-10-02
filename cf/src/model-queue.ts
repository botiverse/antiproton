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

/** The two RPC methods of the agent's object the consumer uses. */
export interface ModelJobStub {
  /** `taker`: the queue message that will call the model with the job; absent when nothing is called (giving up). */
  takeJob(tenantId: string, agentId: string, jobId: string, taker?: string): Promise<unknown>;
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
  /** The queue's id for the message, the same on each of its retries. */
  readonly id?: string;
  readonly body: QueuedModelCall;
  ack(): void;
  retry(): void;
}

/** Logged once per message whose job the agent does not hold; the message is then acked. */
function unknownJob(m: QueuedModelCall, phase: "take" | "deliver" | "give_up"): void {
  logEvent("model_job.unknown", { tenantId: m.tenantId, agentId: m.agentId, jobId: m.jobId, phase });
}

/**
 * The model call, waited on where waiting is free (see index.ts). `taker` is the message's id: the agent
 * refuses the job to a second message while another one may still be calling the model with it.
 */
export async function runModelCall(m: QueuedModelCall, deps: ModelQueueDeps, taker?: string): Promise<void> {
  const stub = deps.stub(m);
  const job = await stub.takeJob(m.tenantId, m.agentId, m.jobId, taker);
  if (isUnknownJobReply(job)) return unknownJob(m, "take");
  // Already answered — a redelivery after success, which must not call the
  // provider again — or taken by another message that is calling it now.
  if (!job) return;
  const t0 = Date.now();
  const answer = await deps.call(job, m);
  const wrote = await stub.deliverAnswer(m.tenantId, m.agentId, m.jobId, answer, Date.now() - t0);
  if (isUnknownJobReply(wrote)) unknownJob(m, "deliver");
}

/** Out of retries. The agent has to hear about it, or it waits for ever. */
export async function failLoudly(m: QueuedModelCall, deps: ModelQueueDeps): Promise<void> {
  const stub = deps.stub(m);
  const job = await stub.takeJob(m.tenantId, m.agentId, m.jobId);
  if (isUnknownJobReply(job)) return unknownJob(m, "give_up");
  if (!job) return;
  const wrote = await stub.deliverAnswer(m.tenantId, m.agentId, m.jobId, deps.givenUp(m), 0);
  if (isUnknownJobReply(wrote)) unknownJob(m, "give_up");
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
      await runModelCall(message.body, deps, message.id);
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
