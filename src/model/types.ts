import type { Json } from "../core/types.ts";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  /** Counted inside completionTokens by DeepSeek-style providers. */
  reasoningTokens: number;
  cachedPromptTokens: number;
}

export interface ModelResponse {
  text: string;
  finishReason: string;
  usage: ModelUsage;
  /** True when the reply was cut off; the harness must not treat it as complete. */
  truncated: boolean;
}

export interface ModelAdapter {
  readonly id: string;
  complete(messages: ModelMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<ModelResponse>;
}

export type { Json };
