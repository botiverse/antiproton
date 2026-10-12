/**
 * Anthropic's Messages API, for a provider declared `api: "anthropic-messages"` (src/model/providers.ts): Claude
 * through Cloudflare AI Gateway's `/anthropic` route, called at `<baseUrl>/v1/messages` with the gateway's own token
 * and no vendor key (the gateway bills the call).
 *
 * Why not the gateway's OpenAI-compatible `/compat`, where every other model goes: it serves Claude, but it does not
 * cache for it. With `cache_control` on a system content part, or as a top-level field, `/compat` answered 200 and
 * the gateway billed each of two identical 8,036-token requests in full, with no cached tokens in the usage; the same
 * prefix through `/anthropic` with `cache_control` was written by the first call (`cache_creation_input_tokens`
 * 8,027) and read by the second (`cache_read_input_tokens` 8,027), billed at the write and read rates (measured
 * 2026-10-12 on claude-haiku-4-5, gateway logs). For a model whose cache reads cost a tenth of its input, that is
 * the difference this client exists for.
 *
 * The request is pi's where pi decides (`buildParams` in pi-ai-1 dist/api/anthropic-messages.js), and the chat
 * client's where it already decided (src/model/openai-compatible.ts):
 * - the conversation and its cache breakpoints are `toAnthropicRequest`'s (src/model/pi-bridge.ts);
 * - the output cap is the chat client's 32768 (`max_tokens` is required here);
 * - no `thinking` and no `temperature` unless asked: the model thinks at its own default, as DeepSeek and the
 *   Responses client's models do. `reasoning: "off"` sends `thinking: { type: "disabled" }`, a level sends it as
 *   `output_config.effort`; a model that refuses either says so in its 400, which reaches the turn;
 * - not streamed, as no client here streams; the whole call stays under MODEL_CALL_DEADLINE_MS.
 *
 * Usage is read into the fields the other clients fill, with their meaning: `promptTokens` is the WHOLE prompt.
 * Anthropic's `input_tokens` counts only what was neither read from nor written to the cache, so the prompt is
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; the reads are `cachedPromptTokens`
 * and the writes `cacheWriteTokens`, both inside it, as the price table reads them (cf/migrations, 0016's header).
 */
import { MODEL_CALL_DEADLINE_MS, REASONING_CHARS, postModelRequest } from "./openai-compatible.ts";
import type { AnthropicMessage } from "./pi-bridge.ts";
import type { ModelResponse } from "./types.ts";

/** The Messages API version header every request carries. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** The output cap, the chat client's (src/model/openai-compatible.ts says why that number). */
const MAX_OUTPUT_TOKENS = 32_768;

export class AnthropicMessagesModel {
  readonly id: string;
  #baseUrl: string;
  #apiKey: string;
  #model: string;
  #headers: Record<string, string>;
  #deadlineMs: number;

  /** The same configuration as OpenAiCompatibleModel's, and the same meaning for each field. */
  constructor(cfg: {
    baseUrl: string; apiKey: string; model: string; headers?: Record<string, string>; deadlineMs?: number;
  }) {
    this.#baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.#apiKey = cfg.apiKey;
    this.#model = cfg.model;
    this.#headers = cfg.headers ?? {};
    this.#deadlineMs = cfg.deadlineMs ?? MODEL_CALL_DEADLINE_MS;
    this.id = `${new URL(cfg.baseUrl).host}/${cfg.model}`;
  }

  async complete(
    request: { system?: Array<Record<string, unknown>>; messages: AnthropicMessage[]; tools?: Array<Record<string, unknown>> },
    opts: { reasoning?: "off" | "low" | "high"; maxTokens?: number } = {},
  ): Promise<ModelResponse> {
    const body = JSON.stringify({
      model: this.#model,
      max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(opts.reasoning === "off" ? { thinking: { type: "disabled" } }
        : opts.reasoning ? { output_config: { effort: opts.reasoning } } : {}),
    });
    return postModelRequest(
      {
        url: `${this.#baseUrl}/v1/messages`, apiKey: this.#apiKey, model: this.#model, deadlineMs: this.#deadlineMs,
        headers: { ...this.#headers, "anthropic-version": ANTHROPIC_VERSION },
        // No vendor key is sent, so the gateway supplies its own; an id it does not know comes back 401 then. Measured
        // 2026-10-12: claude-haiku-5-5 and a made-up claude-nonexistent-9 both answered 401 "x-api-key header is
        // required" through /anthropic while claude-sonnet-5-5 answered 200, so the hint says to check the name.
        gatewayKeyed: !this.#apiKey,
      },
      body,
      readMessage,
    );
  }
}

/**
 * A Messages API answer as our ModelResponse. Each thinking block (or redacted one) is kept whole as a reasoning
 * item, its block as JSON in `signature`, so `toAnthropicRequest` can send it back unchanged; its readable text, when
 * the model returned one, is the trace. A `refusal` stop is an answer with no text, not an error to retry: sending the
 * same request again is refused the same way.
 */
export function readMessage(data: any): ModelResponse {
  const content: any[] = Array.isArray(data?.content) ? data.content : [];
  const text: string[] = [];
  const toolCalls: NonNullable<ModelResponse["toolCalls"]> = [];
  const reasoningItems: NonNullable<ModelResponse["reasoningItems"]> = [];
  for (const b of content) {
    if (b?.type === "text") text.push(String(b.text ?? ""));
    else if (b?.type === "tool_use") toolCalls.push({ id: String(b.id), name: String(b.name), arguments: b.input ?? {} });
    else if (b?.type === "thinking" || b?.type === "redacted_thinking") {
      reasoningItems.push({ text: b.type === "thinking" ? String(b.thinking ?? "") : "", signature: JSON.stringify(b) });
    }
  }
  const stop = String(data?.stop_reason ?? "unknown");
  const reasoning = reasoningItems.map((r) => r.text).filter(Boolean).join("\n\n").slice(0, REASONING_CHARS);
  const u = data?.usage ?? {};
  const fresh = num(u.input_tokens), written = num(u.cache_creation_input_tokens), read = num(u.cache_read_input_tokens);
  return {
    text: text.join(""),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningItems.length ? { reasoningItems } : {}),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: stop === "tool_use" ? "tool_calls" : stop,
    truncated: stop === "max_tokens",
    usage: {
      promptTokens: fresh + written + read,
      completionTokens: num(u.output_tokens),
      // Anthropic does not count thinking apart from the output.
      reasoningTokens: 0,
      cachedPromptTokens: read,
      cacheWriteTokens: written,
    },
  };
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
