import type { Json } from "../core/types.ts";

/** One part of a chat/completions message's content, when it is not a plain string: text, or an image as a data URL. */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * A string, as every message without an image always was. Parts only for a user message that carries an image
   * (DeepSeek takes an image in a user message only; src/model/pi-bridge.ts `toRequest`).
   */
  content: string | ChatContentPart[];
  /** Assistant turns that issued tool calls, replayed back to the provider. */
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  /** Counted inside completionTokens by DeepSeek-style providers. */
  reasoningTokens: number;
  cachedPromptTokens: number;
  /**
   * Prompt tokens the provider wrote to its cache on this call, inside `promptTokens` like the cached ones.
   * Only a provider that reports writes sets it (Anthropic's Messages API, src/model/anthropic-messages.ts);
   * absent is none, which is what every other client has always recorded.
   */
  cacheWriteTokens?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ModelResponse {
  text: string;
  finishReason: string;
  usage: ModelUsage;
  /** True when the reply was cut off; the harness must not treat it as complete. */
  truncated: boolean;
  /** Present only when the caller offered tools and the provider used them. */
  toolCalls?: ToolCall[];
  /**
   * The provider's reasoning trace, when it returns one.
   *
   * Recorded so a person can see why the agent did what it did. Through
   * chat/completions it is never fed back: the next request carries the reply,
   * not the thinking behind it. Sending it back would grow every prompt for no
   * gain, and the provider does not expect it.
   */
  reasoning?: string;
  /**
   * Reasoning the provider expects back, as opaque items: OpenAI's Responses API
   * (src/model/openai-responses.ts), whose reasoning items carry the model's
   * encrypted reasoning. `text` is the item's readable summary, `signature` the
   * whole item as JSON, which is what pi stores in a thinking block's
   * `thinkingSignature` for the same purpose. Answered into the transcript by
   * `fromResponse` and replayed by `toResponsesInput` (src/model/pi-bridge.ts),
   * so the model keeps its reasoning across the tool calls of one turn.
   */
  reasoningItems?: Array<{ text: string; signature: string }>;
  /**
   * The answer's content in the provider's own order, each block with its raw form as JSON, for a provider that must be
   * sent its blocks back exactly as it wrote them (Anthropic's Messages API, src/model/anthropic-messages.ts: its
   * thinking blocks are bound to the blocks around them). When present, `fromResponse` writes the transcript's blocks
   * in this order, each raw block in that block's signature field, and `toAnthropicRequest` sends them back verbatim.
   */
  blocks?: ResponseBlock[];
  /**
   * Set when the provider ended the answer with nothing in it for a reason that is not a normal stop (Anthropic's
   * `refusal` or `model_context_window_exceeded` with empty content): the answer is a failed turn, and this says why.
   */
  failure?: string;
}

/** One block of an answer in the provider's order, `raw` its block as the provider wrote it (JSON). */
export type ResponseBlock =
  | { type: "thinking"; text: string; raw: string }
  | { type: "text"; text: string; raw: string }
  | { type: "toolCall"; call: ToolCall; raw: string };

/** Provider-native tool definition, normalised. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ModelAdapter {
  readonly id: string;
  complete(
    messages: ModelMessage[],
    opts?: {
      maxTokens?: number;
      temperature?: number;
      tools?: ToolDefinition[];
      /** "required" forces a tool call — used to separate *which* tool the model
       *  picks from *whether* it decides to act at all. */
      toolChoice?: "auto" | "required" | "none";
      /**
       * How much the model may think before it answers, when the provider
       * lets a request say. Unset leaves the provider's default (for a
       * reasoning model, thinking on). The trace is billed against maxTokens
       * with the answer, so a caller with a small cap chooses here: the τ²
       * user simulator returned empty replies at the default effort under
       * 2000 (2026-09-22, -24, -25), and with "off" stopped applying the
       * conditions in its script (2026-09-25); it runs at "low" under a cap
       * the trace cannot exhaust. "off" is for a caller that needs no
       * judgement at all. The adapter says it in the provider's dialect; a
       * provider with no such dial ignores it.
       */
      reasoning?: "off" | "low" | "high";
    },
  ): Promise<ModelResponse>;
}

export type { Json };
