/**
 * A model provider that never waits.
 *
 * Durable Objects are billed for wall-clock time while they are active, and
 * Cloudflare grants no exemption for time spent awaiting network I/O. A model
 * completion is roughly 94% waiting, so a Durable Object that awaits one is
 * paying for the provider's latency. That single fact is why the model call
 * leaves the object at all, and it is not negotiable: it is the cost model.
 *
 * pi's harness calls the model itself, inside `drive()`. The seam that
 * reconciles the two is pi's own: a provider may answer `stopReason: "deferred"`
 * with a durable handle, meaning "this is still running, come back for it". The
 * harness then suspends the operation, and the object is free to stop being
 * active. That mechanism exists for provider batch APIs; here the thing holding
 * the work is our queue instead, and the harness cannot tell the difference.
 *
 * So there is no non-deferred path here. `stream` hands the request to the port
 * and returns a handle; `fetchDeferred` answers with the finished message, or
 * with the same handle again while it is still out.
 */
import { createProvider, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage, AssistantMessageEventStream, Context, DeferredHandle, Model, Provider,
  SimpleStreamOptions, StreamOptions, Usage,
} from "@earendil-works/pi-ai";

/** Whatever actually does the waiting. In production: a queue and a Worker. */
export interface OffloadPort {
  /**
   * Hand one request over and return a durable id for it. Must be idempotent
   * per id from the caller's point of view: the harness may re-drive a pass.
   */
  start(request: { model: Model<any>; context: Context; options?: StreamOptions }): Promise<string>;
  /**
   * The finished message, or null while the request is still out.
   *
   * **Never `aborted`.** That stop reason is produced by pi's own driver, one
   * layer above, when a response comes back while a cancel is in flight — it
   * is a fact about a live stream. Nothing on this path can carry it: what
   * comes back here was read out of storage by whoever answered the queue, and
   * a cancelled request simply has no answer to read.
   *
   * Stated in the type rather than handled in a branch. The unreachability was
   * established from the records (task #1, 2026-09-12), and the choice follows
   * from it: a branch for it would assert that the value can arrive, which is
   * false, and would then be dead code that looks like caution. Narrowing
   * instead means a port that ever tries to return one does not compile — the
   * claim is checked at the boundary where it is made, not read out of a
   * comment.
   */
  poll(id: string): Promise<Answered | null>;
  /** Best-effort; the harness calls this when an operation is abandoned. */
  cancel?(id: string): Promise<void>;
}

/**
 * A message that finished, as opposed to one abandoned mid-flight.
 *
 * Two reasons are excluded, for the same kind of reason rather than the same
 * reason. `aborted` belongs to a stream someone cancelled while it was
 * running, and this side only ever reads a stored answer. `pending` is what a
 * *partial* carries while a stream is still open — `settled` sets it on the
 * `start` event it emits — so it describes the emission, never the message
 * that was answered.
 *
 * Together they are exactly the two the `done` event refuses, which is why
 * naming them here lets that line be checked instead of trusted.
 */
export type Answered = AssistantMessage & {
  stopReason: Exclude<AssistantMessage["stopReason"], "aborted" | "pending">;
};

const NO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface OffloadedModelDefinition {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * "Not yet", as a message. `deferred` is a finished shape in the sense that
 * matters here — it is an answer this side produced, not a stream that was
 * cut off — so it is `Answered` like everything else that leaves this file.
 */
function deferredMessage(model: Model<any>, handle: DeferredHandle): Answered {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider,
    model: model.id, usage: NO_USAGE, stopReason: "deferred", deferred: handle,
    timestamp: Date.now(),
  };
}

/** One event stream carrying one already-decided message. Nothing streams here
 *  — the tokens arrive at the queue, not at this object. */
/**
 * Replay a message that is already complete as a one-shot stream.
 *
 * Takes `Answered` rather than any assistant message, which is what lets the
 * `done` event below be checked instead of trusted: `reason` is the message's
 * own stop reason, and `aborted` is not a reason anything on this path can
 * report — it describes a stream that was cancelled while running, which by
 * definition is not this one: the port side alone left these two lines living
 * on "upstream would not do that".
 */
function settled(message: Answered): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
  });
  return stream;
}

export function offloadedProvider(opts: {
  port: OffloadPort;
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  models: OffloadedModelDefinition[];
  /** How long the harness should wait before asking again. */
  pollAfterMs?: number;
}): Provider {
  const api = opts.api ?? "offloaded";
  const models = opts.models.map((d) => ({
    id: d.id,
    name: d.name ?? d.id,
    api,
    provider: opts.id,
    baseUrl: opts.baseUrl ?? "https://offloaded.invalid",
    reasoning: d.reasoning ?? false,
    input: ["text"] as ("text" | "image")[],
    cost: d.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: d.contextWindow,
    maxTokens: d.maxTokens ?? 8192,
  }));

  const stream = (model: Model<any>, context: Context, options?: StreamOptions) => {
    const outer = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        const id = await opts.port.start({ model, context, options });
        const handle: DeferredHandle = {
          provider: model.provider, modelId: model.id, api: model.api, id,
          ...(opts.pollAfterMs === undefined ? {} : { pollAfterMs: opts.pollAfterMs }),
        };
        const message = deferredMessage(model, handle);
        outer.push({ type: "start", partial: { ...message, stopReason: "pending" } });
        outer.push({ type: "done", reason: "deferred", message });
        outer.end(message);
      } catch (e: any) {
        const message: Answered = {
          role: "assistant", content: [], api: model.api, provider: model.provider,
          model: model.id, usage: NO_USAGE, stopReason: "error",
          errorMessage: String(e?.message ?? e), timestamp: Date.now(),
        };
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
      }
    });
    return outer;
  };

  const fetchDeferred = (model: Model<any>, handle: DeferredHandle) => {
    const outer = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        const answer = await opts.port.poll(handle.id);
        // Still out. Answering with the same handle is how pi says "not yet",
        // and it is why nothing here ever blocks.
        const message = answer ?? deferredMessage(model, handle);
        outer.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        if (message.stopReason === "error") outer.push({ type: "error", reason: "error", error: message });
        else outer.push({ type: "done", reason: message.stopReason, message });
        outer.end(message);
      } catch (e: any) {
        const message: Answered = {
          role: "assistant", content: [], api: model.api, provider: model.provider,
          model: model.id, usage: NO_USAGE, stopReason: "error",
          errorMessage: String(e?.message ?? e), timestamp: Date.now(),
        };
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
      }
    });
    return outer;
  };

  return createProvider({
    id: opts.id,
    name: opts.name ?? opts.id,
    baseUrl: opts.baseUrl ?? "https://offloaded.invalid",
    // The key never reaches this object: whatever performs the call resolves it.
    auth: { apiKey: { name: opts.name ?? opts.id, resolve: async () => ({ auth: {} }) } },
    models: models as any,
    api: {
      stream,
      streamSimple: (m: Model<any>, c: Context, o?: SimpleStreamOptions) => stream(m, c, o),
      fetchDeferred,
      cancelDeferred: async (_m: Model<any>, handle: DeferredHandle) => {
        await opts.port.cancel?.(handle.id);
      },
    } as any,
  } as any);
}

export { settled as settledStream };
