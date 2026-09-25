import type { Json } from "../core/types.ts";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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
   * Recorded so a person can see why the agent did what it did, and never fed
   * back: the next request carries the reply, not the thinking behind it.
   * Sending it back would grow every prompt for no gain, and the provider does
   * not expect it.
   */
  reasoning?: string;
}

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
       * reasoning model, thinking on). "off" is for a caller that wants an
       * answer and nothing else — a role-player, a classifier — where a
       * reasoning trace only spends the token budget the answer needs:
       * the τ² user simulator returned empty replies that way (2026-09-22,
       * -24, -25). The adapter says it in the provider's dialect; a provider
       * with no such dial ignores it.
       */
      reasoning?: "off" | "low" | "high";
    },
  ): Promise<ModelResponse>;
}

export type { Json };
