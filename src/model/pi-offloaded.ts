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
   * Stated in the type rather than handled in a branch. @Vera established the
   * unreachability from the records (task #1, 2026-09-12) and the choice is
   * hers: a branch for it would assert that the value can arrive, which is
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
 * `aborted` belongs to a stream someone cancelled while it was running. This
 * side of the queue only ever reads a stored answer, so the distinction is
 * real and worth keeping in the type.
 */
export type Answered = AssistantMessage & { stopReason: Exclude<AssistantMessage["stopReason"], "aborted"> };

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

function deferredMessage(model: Model<any>, handle: DeferredHandle): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider,
    model: model.id, usage: NO_USAGE, stopReason: "deferred", deferred: handle,
    timestamp: Date.now(),
  };
}

/** One event stream carrying one already-decided message. Nothing streams here
 *  — the tokens arrive at the queue, not at this object. */
function settled(message: AssistantMessage): AssistantMessageEventStream {
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
        const message: AssistantMessage = {
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
        const message: AssistantMessage = {
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
