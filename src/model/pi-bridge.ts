/**
 * pi's request shape, in the terms our own provider client already speaks.
 *
 * The model call happens in a Worker, not in the object, and the Worker must
 * stay small: importing pi-ai's provider implementations there would drag the
 * OpenAI, Anthropic, Google and Bedrock SDKs into a binary that is already
 * shipped to every tenant. Our OpenAiCompatibleModel is a few hundred lines and
 * has been answering DeepSeek for months, so the conversion happens here and the
 * client stays.
 *
 * Both directions are lossy in one place each, and deliberately. Images are
 * dropped on the way out because this provider has never accepted them. The
 * reasoning trace is kept on the way back but not replayed on the way out: the
 * next request carries the reply, not the thinking behind it. The exception is
 * an OpenAI reasoning model, called through the Responses API, whose reasoning
 * comes back as opaque items the next request must carry (`toResponsesInput`).
 */
import type { AssistantMessage, Context as PiContext, Message as PiMessage, Tool as PiTool, Usage } from "@earendil-works/pi-ai";
import type { ModelMessage, ModelResponse, ToolDefinition } from "./types.ts";

/**
 * The job wire format, version 2: a system message keeps its place in the conversation.
 *
 * Version 1 is pi-ai 0.85's `Context` as it is — `{ systemPrompt?, messages, tools? }`, no tag —
 * and it is what the live runtime (src/model/pi-offloaded.ts) writes. It has one system prompt,
 * at the top. pi-ai 1.0 writes the prompt as system messages in the transcript, each where it
 * took effect: pi-durable writes the first one after the first input and a patch after a later
 * input whenever a section or the tool set changed. Folded into one top prompt, every one of
 * them lost its position.
 *
 * Version 2 carries the tag and has no `systemPrompt`: every system message is an entry of
 * `messages`, sent where the writer placed it — the prompt at the top, each later one where it
 * stands. The writer renders each to its text first
 * (src/model/durable-offloaded.ts `jobContext`), so the consumer needs no pi-ai 1.0 code and the
 * Worker stays small. `tools` is the tool set current at the end of the conversation, because our
 * provider client sends one top-level tool list per request.
 */
export const JOB_WIRE_V2 = 2;

/** A system message at its position in the conversation, already rendered to its text. */
export type InlineSystemMessage = { role: "system"; content: string };

/** `M` and `T` are the writer's message and tool types; the shape is all the consumer reads. */
export interface JobContextV2<M = PiMessage, T = PiTool> {
  version: typeof JOB_WIRE_V2;
  messages: Array<M | InlineSystemMessage>;
  tools?: T[];
}

/** What a `pi_model_jobs` row's `context` may hold: version 1 (untagged) or version 2. */
export type JobContext = PiContext | JobContextV2;

/**
 * The version a stored context declares. Untagged is version 1. Any other tag is refused rather
 * than read as the nearest known one: a format this consumer does not know may carry turns it
 * would drop, and a request built without them is a wrong conversation that fails nowhere.
 */
function wireVersion(context: JobContext): 1 | 2 {
  const version: unknown = Reflect.get(context, "version");
  if (version === undefined) return 1;
  if (version === JOB_WIRE_V2) return 2;
  throw new Error(`a model job's context declares wire version ${JSON.stringify(version)}, which this consumer cannot read`);
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => String(c.text ?? ""))
    .join("");
};

/**
 * A stored job's context as our provider client's request. A version 1 context builds exactly
 * the request it always did. A version 2 context's inline system message becomes an inline
 * `role: "system"` message at the same position: OpenAiCompatibleModel sends `messages` as
 * given, and DeepSeek's chat completions (deepseek-flash, deepseek-v4-pro) accepted and followed
 * one between turns, after a user turn as the last message, and after a tool result (probed
 * 2026-10-02 through OpenAiCompatibleModel; pi-ai 1.0's catalog marks only deepseek-v4-pro as
 * verified, which is why the reading is cited rather than the catalog). No other provider was
 * probed. One that refuses a mid-conversation system message needs these folded into the leading
 * message, as pi-ai's `collapseSystemMessages` does, for that provider only.
 */
export function toRequest(context: JobContext): {
  messages: ModelMessage[];
  tools?: ToolDefinition[];
} {
  const inline = wireVersion(context) === 2;
  const messages: ModelMessage[] = [];
  if ("systemPrompt" in context && context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });

  for (const m of context.messages) {
    if (m.role === "system") {
      // Only version 2 may carry one. In version 1 it was never written, and passing it on would
      // put an instruction into a request whose format says it has none.
      if (!inline) throw new Error("a version 1 model job carries a system message in its conversation");
      messages.push({ role: "system", content: m.content });
      continue;
    }
    if (m.role === "user") {
      messages.push({ role: "user", content: textOf(m.content) });
      continue;
    }
    if (m.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: textOf(m.content),
      });
      continue;
    }
    // assistant
    const calls = (m.content ?? []).filter((c: any) => c?.type === "toolCall") as any[];
    messages.push({
      role: "assistant",
      content: textOf(m.content),
      ...(calls.length
        ? {
            tool_calls: calls.map((c) => ({
              id: c.id, type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
            })),
          }
        : {}),
    });
  }

  const tools = context.tools?.map((t) => ({
    name: t.name, description: t.description, parameters: t.parameters as unknown,
  })) as ToolDefinition[] | undefined;

  return { messages, ...(tools?.length ? { tools } : {}) };
}

/**
 * A stored job's context as Responses API input (src/model/openai-responses.ts), for `model`, the model the call
 * reaches.
 *
 * The conversation is `toRequest`'s, item for item, in the Responses API's form (pi's own conversion is
 * `convertResponsesMessages`, pi-ai-1 dist/api/openai-responses-shared.js): a system message, the leading prompt
 * or a later one in place, is a `developer` message, as pi sends instructions to a reasoning model; a tool call is a
 * `function_call` item and its result a `function_call_output`. Images are dropped as there.
 *
 * The one difference is reasoning. An assistant turn's thinking block that carries a `thinkingSignature` is
 * replayed as the reasoning item it holds, in its place before the text and calls it led to, so the model sees
 * its own reasoning again across the tool calls of a turn instead of starting each call from the visible
 * transcript alone. Only an answer from `model` itself is replayed (its `model`, which `fromResponse` sets to the
 * model called): encrypted reasoning is the model's own, and pi drops it for any other model too
 * (`transformMessages`, pi-ai-1 dist/api/transform-messages.js). A thinking block with no signature — DeepSeek's
 * trace, or one written before this existed — is dropped, as `toRequest` drops it.
 */
export function toResponsesInput(context: JobContext, model: string): {
  input: Array<Record<string, unknown>>;
  tools?: ToolDefinition[];
} {
  const inline = wireVersion(context) === 2;
  const input: Array<Record<string, unknown>> = [];
  if ("systemPrompt" in context && context.systemPrompt) input.push({ role: "developer", content: context.systemPrompt });

  for (const m of context.messages) {
    if (m.role === "system") {
      if (!inline) throw new Error("a version 1 model job carries a system message in its conversation");
      input.push({ role: "developer", content: m.content });
      continue;
    }
    if (m.role === "user") {
      input.push({ role: "user", content: textOf(m.content) });
      continue;
    }
    if (m.role === "toolResult") {
      input.push({ type: "function_call_output", call_id: m.toolCallId, output: textOf(m.content) });
      continue;
    }
    // assistant: its blocks in order, as pi replays them
    const own = m.model === model;
    for (const c of (m.content ?? []) as any[]) {
      if (c?.type === "thinking") {
        if (!own || typeof c.thinkingSignature !== "string" || !c.thinkingSignature) continue;
        let item: unknown;
        try { item = JSON.parse(c.thinkingSignature); } catch { continue; }
        if (item && typeof item === "object" && (item as { type?: unknown }).type === "reasoning") input.push(item as Record<string, unknown>);
      } else if (c?.type === "text") {
        if (c.text) input.push({ role: "assistant", content: String(c.text) });
      } else if (c?.type === "toolCall") {
        input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) });
      }
    }
  }

  const tools = context.tools?.map((t) => ({
    name: t.name, description: t.description, parameters: t.parameters as unknown,
  })) as ToolDefinition[] | undefined;

  return { input, ...(tools?.length ? { tools } : {}) };
}

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** Cost is left at zero: this deployment prices per tenant elsewhere, and a
 *  wrong number in the transcript is worse than an absent one. */
function usageOf(res: ModelResponse): Usage {
  const u = res.usage ?? { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 };
  return {
    input: u.promptTokens ?? 0,
    output: u.completionTokens ?? 0,
    cacheRead: u.cachedPromptTokens ?? 0,
    cacheWrite: 0,
    ...(u.reasoningTokens ? { reasoning: u.reasoningTokens } : {}),
    totalTokens: (u.promptTokens ?? 0) + (u.completionTokens ?? 0),
    cost: { ...NO_COST },
  };
}

/**
 * An answer as it is delivered and read back: an assistant message that may
 * name the `pi_model_jobs` row it answered. Both ends use this type so that
 * "the field is still there when it is read back" is said by the type, not
 * only by the test that reads the stored entry.
 */
export type AnsweredMessage = AssistantMessage & { jobId?: string; providerError?: string };

/**
 * `jobId` is the trace spine's one durable link from an answer back to the
 * model call that produced it. It has to ride on the message because nothing
 * else can carry it: the final entry's id is generated by pi after the answer
 * is delivered, and the usage row is assembled upstream without the job
 * handle. The message is stored verbatim as the entry body, so the entry ends
 * up saying which `pi_model_jobs` row answered it. `toRequest` copies only
 * content and tool calls, so the field never reaches a provider.
 */
export function fromResponse(
  res: ModelResponse,
  model: { api: string; provider: string; id: string },
  jobId?: string,
): AnsweredMessage {
  const content: AssistantMessage["content"] = [];
  // Reasoning to replay (the Responses API's items) is one thinking block per item, its item in
  // `thinkingSignature`; a trace that is only text is one block with no signature, as it always was.
  if (res.reasoningItems?.length) {
    for (const r of res.reasoningItems) content.push({ type: "thinking", thinking: r.text, thinkingSignature: r.signature } as any);
  } else if (res.reasoning) content.push({ type: "thinking", thinking: res.reasoning } as any);
  if (res.text) content.push({ type: "text", text: res.text });
  for (const c of res.toolCalls ?? []) {
    content.push({
      type: "toolCall", id: c.id, name: c.name,
      arguments: (c.arguments ?? {}) as Record<string, unknown>,
    } as any);
  }

  // A truncated reply that still says something is usable, and `length` is how
  // the harness is told it was cut off. A truncated reply that says nothing at
  // all is not a turn — it is a failed call wearing the shape of one, and
  // recording it as an assistant message ends the run with an empty answer that
  // no caller can distinguish from silence. That is what happened: the object
  // was idle, the transcript was complete, and the answer was "".
  if (res.truncated && !res.text && !(res.toolCalls?.length)) {
    return {
      ...errorMessage(
        "the model reached its output limit before writing an answer" +
        (res.usage?.reasoningTokens ? ` (${res.usage.reasoningTokens} tokens of reasoning)` : ""),
        model),
      usage: usageOf(res),
      rawStopReason: res.finishReason,
      ...(jobId ? { jobId } : {}),
    };
  }

  const stopReason: AssistantMessage["stopReason"] =
    res.truncated ? "length"
      : (res.toolCalls?.length ? "toolUse" : "stop");

  return {
    role: "assistant",
    content,
    api: model.api as any,
    provider: model.provider,
    model: model.id,
    usage: usageOf(res),
    stopReason,
    rawStopReason: res.finishReason,
    timestamp: Date.now(),
    ...(jobId ? { jobId } : {}),
  };
}

/**
 * The text a failed answer shows a reader: the provider's own refusal when it carries one (`providerError`,
 * set for a refused request by `callQueuedModel`, cf/src/model-request.ts), else its `errorMessage`. The two
 * are apart because the harness's retry check scans `errorMessage` and must never see provider text
 * (src/model/openai-compatible.ts, `ModelRequestRefused`); every reader that shows a failed turn reads this.
 */
export function failureText(m: { errorMessage?: unknown; providerError?: unknown } | undefined): string | undefined {
  if (typeof m?.providerError === "string" && m.providerError) return m.providerError;
  return typeof m?.errorMessage === "string" ? m.errorMessage : undefined;
}

/**
 * The answer for a provider call that threw, where no queue consumer stands between the client and the agent
 * (the bench runners' worker, bench/node-worker.ts). `errorMessage` is the error's own message, at most 300
 * characters, as it always was; a refusal (`ModelRequestRefused`, src/model/openai-compatible.ts) adds its
 * `turnError` as `providerError`, since its `errorMessage` is fixed text that says only the status. Read by
 * shape rather than `instanceof`, so this file does not import the client.
 */
export function failedAnswer(e: unknown, model: { api: string; provider: string; id: string }): AnsweredMessage {
  const err = e as { message?: unknown; permanent?: unknown; turnError?: unknown } | null;
  const answer: AnsweredMessage = errorMessage(String(err?.message ?? e).slice(0, 300), model);
  if (err?.permanent === true && typeof err.turnError === "string") answer.providerError = err.turnError;
  return answer;
}

export function errorMessage(
  error: string,
  model: { api: string; provider: string; id: string },
): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api as any, provider: model.provider,
    model: model.id, usage: usageOf({} as ModelResponse), stopReason: "error",
    errorMessage: error, timestamp: Date.now(),
  };
}
