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
    opts?: { maxTokens?: number; temperature?: number; tools?: ToolDefinition[] },
  ): Promise<ModelResponse>;
}

export type { Json };
