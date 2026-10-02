/**
 * The offloaded model provider, on pi-ai 1.0, for pi-durable's harness.
 *
 * Same idea as src/model/pi-offloaded.ts, which serves the pi-agent-core 0.85
 * runtime: the provider never completes a model call in-process, because a
 * Durable Object is billed for wall clock and a completion is mostly waiting.
 * `stream` hands the request to a port (in production: a `pi_model_jobs` row
 * and a queue message) and answers `stopReason: "deferred"` with a handle;
 * `fetchDeferred` answers with the delivered message, or with the same handle
 * while the job is still out. There is no non-deferred path.
 *
 * What changed in pi-ai 1.0 is what a provider is handed: a `TranscriptContext`,
 * in which the system prompt and the tool declarations are system messages in
 * the transcript, rather than a `Context` with `systemPrompt` and `tools`
 * fields. The queue consumer (`runQueuedModelCall` in cf/src/index.ts) reads a
 * job's `context` through `toRequest` in src/model/pi-bridge.ts, which knows
 * the old shape only — a system message reaching it would be sent as an
 * assistant turn. So `jobContext` below folds the transcript back into exactly
 * that shape, and the job a port receives is `{ model, context, options }` as
 * before: one wire format, read by one consumer, whichever runtime wrote it.
 * test/durable-drive.ts runs a job written here through `toRequest` and
 * compares it with the same conversation written by the 0.85 provider.
 *
 * The fold is lossy in one place, deliberately: a system message in the middle
 * of the transcript (a prompt section or tool set that changed during the
 * conversation) is replayed into the one leading prompt, as pi-ai's own
 * `collapseSystemMessages` does for APIs without mid-conversation system
 * messages. The consumer's request format has no place for it.
 *
 * pi-ai 1.0 is imported as `pi-ai-1`, an npm alias; docs/pi-upstream.md says why.
 */
import type {
  Api, AssistantMessage, Context, DeferredHandle, Message, Model, SimpleStreamOptions, StreamOptions,
  TranscriptContext, Usage,
} from "pi-ai-1";
import { createProvider, type Provider } from "pi-ai-1/models";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "pi-ai-1/utils/event-stream";
import { getCurrentSystemPrompt, getCurrentTools } from "pi-ai-1/utils/transcript";

/**
 * A message that finished. `aborted` and `pending` are excluded for the reasons
 * `Answered` in src/model/pi-offloaded.ts gives: what a port returns was read
 * out of storage, never cut off mid-stream, and those two are the reasons the
 * `done` event refuses.
 */
export type Answered = AssistantMessage & {
  stopReason: Exclude<AssistantMessage["stopReason"], "aborted" | "pending">;
};

/** One queued model call: what the port stores, and what the queue consumer reads back. */
export type ModelJobRequest = { model: Model<Api>; context: Context; options?: StreamOptions };

/** Whatever does the waiting. Same contract as `OffloadPort` in src/model/pi-offloaded.ts. */
export interface DurableOffloadPort {
  /** Hand one request over and return a durable id for it. */
  start(request: ModelJobRequest): Promise<string>;
  /** The delivered message, or null while the job is still out. */
  poll(id: string): Promise<Answered | null>;
  /** Best-effort; pi-durable calls it when a polling generation is aborted. */
  cancel?(id: string): Promise<void>;
}

export interface DurableOffloadedModel {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const NO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const notSystem = (m: Message): boolean => m.role !== "system";

/**
 * The transcript in the shape the queue consumer reads: the current system
 * prompt and tools as fields, every non-system message in order. Fields are
 * omitted when empty, as the 0.85 harness omitted them.
 *
 * Lossy: a later system message loses its position — it is replayed into the leading prompt —
 * because the job wire format has no slot for a mid-conversation system message. Carrying it
 * is a phase-3 change to the format and its consumer.
 */
export function jobContext(context: TranscriptContext): Context {
  const systemPrompt = getCurrentSystemPrompt(context.messages);
  const tools = getCurrentTools(context.messages);
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: context.messages.filter(notSystem),
    ...(tools.length ? { tools } : {}),
  };
}

const STOP_REASONS: ReadonlySet<string> = new Set<Answered["stopReason"]>(["stop", "length", "toolUse", "error", "deferred"]);

/**
 * A stored answer, read back from JSON, checked for the one claim the port
 * makes: an assistant message that finished. A stored `aborted` is an
 * invariant that broke upstream (see `#pollJob` in src/runtime/pi-agent.ts),
 * and is thrown rather than passed on.
 */
export function readAnswer(json: string): Answered {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) throw new Error("a stored answer is not an object");
  const role: unknown = Reflect.get(value, "role");
  const stopReason: unknown = Reflect.get(value, "stopReason");
  const content: unknown = Reflect.get(value, "content");
  if (role !== "assistant") throw new Error(`a stored answer has role ${JSON.stringify(role)}, not "assistant"`);
  if (!Array.isArray(content)) throw new Error("a stored answer has no content array");
  if (typeof stopReason !== "string" || !STOP_REASONS.has(stopReason)) {
    throw new Error(
      `a stored answer says stopReason ${JSON.stringify(stopReason)}, which nothing that writes one can produce`);
  }
  // Checked above: the fields this path relies on. The rest is the writer's message, passed on whole
  // so that fields like `jobId` (src/model/pi-bridge.ts) survive into the entry.
  return value as Answered;
}

function messageOf(model: Model<Api>, extra: { stopReason: "deferred"; deferred: DeferredHandle } | { stopReason: "error"; errorMessage: string }): Answered {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: NO_USAGE, timestamp: Date.now(), ...extra,
  };
}

/** Replay one already-decided message as a complete stream. Nothing streams: the tokens arrive at the queue. */
function emit(stream: AssistantMessageEventStream, message: Answered) {
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
  else stream.push({ type: "done", reason: message.stopReason, message });
  stream.end(message);
}

/** A stream of the message `decide` settles on; a rejection becomes an `error` message. */
function settledLater(model: Model<Api>, decide: () => Promise<Answered>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  decide().then(
    (message) => emit(stream, message),
    (error: unknown) => emit(stream, messageOf(model, {
      stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error),
    })),
  );
  return stream;
}

export function durableOffloadedProvider(opts: {
  port: DurableOffloadPort;
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  models: DurableOffloadedModel[];
  /** How long pi-durable sleeps before polling again: the `pollAt` a park waits for. */
  pollAfterMs?: number;
}): Provider {
  const api = opts.api ?? "offloaded";
  const baseUrl = opts.baseUrl ?? "https://offloaded.invalid";
  const models: Model<Api>[] = opts.models.map((d) => ({
    id: d.id,
    name: d.name ?? d.id,
    api,
    provider: opts.id,
    baseUrl,
    reasoning: d.reasoning ?? false,
    input: ["text"],
    cost: d.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: d.contextWindow,
    maxTokens: d.maxTokens ?? 8192,
  }));

  const stream = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
    settledLater(model, async () => {
      const id = await opts.port.start({ model, context: jobContext(context), ...(options === undefined ? {} : { options }) });
      return messageOf(model, {
        stopReason: "deferred",
        deferred: {
          provider: model.provider, modelId: model.id, api: model.api, id,
          ...(opts.pollAfterMs === undefined ? {} : { pollAfterMs: opts.pollAfterMs }),
        },
      });
    });

  return createProvider({
    id: opts.id,
    name: opts.name ?? opts.id,
    baseUrl,
    // The key never reaches the object: whatever performs the call resolves it.
    auth: { apiKey: { name: opts.name ?? opts.id, resolve: async () => ({ auth: {} }) } },
    models,
    api: {
      stream,
      streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => stream(model, context, options),
      // Not ready answers with the same handle: that is how pi says "not yet", and why nothing here blocks.
      fetchDeferred: (model: Model<Api>, handle: DeferredHandle) =>
        settledLater(model, async () => (await opts.port.poll(handle.id)) ?? messageOf(model, { stopReason: "deferred", deferred: handle })),
      cancelDeferred: async (_model: Model<Api>, handle: DeferredHandle) => { await opts.port.cancel?.(handle.id); },
    },
  });
}
