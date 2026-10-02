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
 * fields — and each one takes effect where it stands. pi-durable writes the
 * prompt after the first input, and a patch to it after a later input. The
 * queue consumer (`modelQueueDeps` in cf/src/index.ts) reads a job's
 * `context` through `toRequest` in src/model/pi-bridge.ts, so `jobContext`
 * below writes the transcript as job wire format version 2 (`JobContextV2`
 * there): every system message inline at its place, and the current tools as
 * a field, as the 0.85 provider writes them.
 * test/durable-drive.ts runs a job written here through `toRequest` and
 * compares it with the same conversation written by the 0.85 provider.
 *
 * pi-ai 1.0 is imported as `pi-ai-1`, an npm alias; docs/pi-upstream.md says why.
 */
import type {
  Api, AssistantMessage, DeferredHandle, Message, Model, SimpleStreamOptions, StreamOptions,
  SystemMessage, Tool, TranscriptContext, Usage,
} from "pi-ai-1";
import { createProvider, type Provider } from "pi-ai-1/models";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "pi-ai-1/utils/event-stream";
import { getSystemMessageText, renderSystemMessageUpdate } from "pi-ai-1/utils/text";
import { getCurrentTools } from "pi-ai-1/utils/transcript";
import { JOB_WIRE_V2, type InlineSystemMessage, type JobContextV2 } from "./pi-bridge.ts";

/**
 * A message that finished. `aborted` and `pending` are excluded for the reasons
 * `Answered` in src/model/pi-offloaded.ts gives: what a port returns was read
 * out of storage, never cut off mid-stream, and those two are the reasons the
 * `done` event refuses.
 */
export type Answered = AssistantMessage & {
  stopReason: Exclude<AssistantMessage["stopReason"], "aborted" | "pending">;
};

/** A job context written by this provider: version 2, over pi-ai 1.0's non-system messages. */
export type DurableJobContext = JobContextV2<Exclude<Message, SystemMessage>, Tool>;

/** One queued model call: what the port stores, and what the queue consumer reads back. */
export type ModelJobRequest = { model: Model<Api>; context: DurableJobContext; options?: StreamOptions };

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

/**
 * The transcript as job wire format version 2: each system message rendered to text, where it
 * stands. The first is the prompt being declared, so it is rendered whole — content, then its
 * sections — as `getSystemMessageText` renders a leading prompt. Each later one changes that
 * prompt and is rendered as pi-ai's chat-completions transport renders a mid-conversation
 * system message (`convertMessages` in its api/openai-completions.js): its content, then each
 * changed section framed by name. That transport frames by index instead — only index 0 is
 * whole — which would send pi-durable's first prompt, written after the first input, as an
 * "update" of a prompt the model was never shown.
 *
 * One that renders empty — it only changed the tools — is dropped, as that transport drops it:
 * `tools` is the set current at the end, the field the 0.85 provider wrote.
 */
export function jobContext(context: TranscriptContext): DurableJobContext {
  const tools = getCurrentTools(context.messages);
  const messages: Array<Exclude<Message, SystemMessage> | InlineSystemMessage> = [];
  let declared = false;
  for (const m of context.messages) {
    if (m.role !== "system") { messages.push(m); continue; }
    const content = declared ? renderSystemMessageUpdate(m) : getSystemMessageText(m);
    declared = true;
    if (content) messages.push({ role: "system", content });
  }
  return { version: JOB_WIRE_V2, messages, ...(tools.length ? { tools } : {}) };
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
  /**
   * When set, each not-ready poll answers with the handle's `pollAfterMs` doubled, up to this. pi-durable
   * stores the handle it was last given in the `poll` checkpoint and takes the next `pollAt` from it, so
   * the handle is the one place the interval can move: a delivered answer cannot shorten a sleep already
   * committed, and a short interval for a long call is a wake per interval. Doubling keeps a quick answer
   * waited for briefly and a slow one polled rarely.
   */
  maxPollAfterMs?: number;
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

  const max = opts.maxPollAfterMs;
  /** The handle a not-ready poll answers with: the same job, asked again after twice as long (capped), when `maxPollAfterMs` is set. */
  const later = (handle: DeferredHandle): DeferredHandle =>
    max === undefined || handle.pollAfterMs === undefined ? handle : { ...handle, pollAfterMs: Math.min(max, handle.pollAfterMs * 2) };

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
        settledLater(model, async () => (await opts.port.poll(handle.id)) ?? messageOf(model, { stopReason: "deferred", deferred: later(handle) })),
      cancelDeferred: async (_model: Model<Api>, handle: DeferredHandle) => { await opts.port.cancel?.(handle.id); },
    },
  });
}
