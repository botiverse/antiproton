/**
 * OpenAI's reasoning models through the Responses API, with their reasoning on and carried across a turn's tool
 * calls.
 *
 * Through chat/completions an OpenAI reasoning model cannot reason and call a function tool in the same
 * request: gpt-5.6-luna refuses it ("Function tools with reasoning_effort are not supported ... use /v1/responses
 * or set reasoning_effort to 'none'", 400, measured 2026-10-04), so that path sends its "off" level and every
 * Luna call there reported 0 reasoning tokens (src/model/chat-request-shape.ts). The Responses API takes tools
 * with reasoning on, and is what pi itself calls these models with (pi-ai-1's catalog lists them under
 * `api: "openai-responses"`).
 *
 * Which models: an `openai/` model whose entry in pi's OpenAI catalog says `reasoning` (`usesResponses`). The
 * name decides, as it decides the chat/completions shape, because the endpoint that refuses is OpenAI's own
 * behind whichever provider routes it. It is called at `<baseUrl>/responses`, the provider's own base: Cloudflare
 * AI Gateway's `/compat` answers there with the same `openai/gpt-5.6-luna` name and the same gateway token as its
 * chat/completions (measured 2026-10-06), so the provider, the model name, the endpoint host and the billing are
 * the ones the chat path had. No other provider was probed.
 *
 * The request is pi's (`buildParams` in pi-ai-1 dist/api/openai-responses.js) where pi decides, and ours where the
 * chat client already decided (src/model/openai-compatible.ts):
 *
 * - Reasoning: with no level asked for, the effort is RESPONSES_DEFAULT_EFFORT, "medium", which is pi's own
 *   default when reasoning is wanted and OpenAI's documented default for its reasoning models. That matches how
 *   DeepSeek is called, where nothing is sent and the model thinks at its default. A level asked for (`low`,
 *   `high`) is sent mapped by the catalog's `thinkingLevelMap`; `off` sends the catalog's off value ("none" for
 *   gpt-5.6-luna). With reasoning on, `summary: "auto"` asks for a readable summary (the transcript's thinking
 *   text) and `include: ["reasoning.encrypted_content"]` for the reasoning itself, which is what is replayed.
 * - `store: false`, as pi sends it: nothing is kept at OpenAI, and no `previous_response_id` is used. The model's
 *   earlier reasoning reaches the next request because the request carries it back as items
 *   (`toResponsesInput`, src/model/pi-bridge.ts), the way pi replays a thinking block's `thinkingSignature`.
 * - Tools are function tools with `strict: false`, as pi sends them: strict mode would hold every schema to
 *   OpenAI's strict subset, which our tools' schemas were never written for.
 * - The output cap is the chat client's 32768, as `max_output_tokens`; no temperature, which a reasoning model
 *   refuses with its reasoning on.
 *
 * Usage is read into the same fields the chat client fills, with the same meaning: `input_tokens` is the whole
 * prompt with `cached_tokens` beside it (as chat/completions' `prompt_tokens`), and `output_tokens` counts the
 * reasoning tokens it lists in `reasoning_tokens` (as `completion_tokens` does).
 */
import { OPENAI_MODELS } from "pi-ai-1/providers/openai.models";
import { MODEL_CALL_DEADLINE_MS, REASONING_CHARS, parseArguments, postModelRequest } from "./openai-compatible.ts";
import type { ModelResponse, ToolDefinition } from "./types.ts";

const OPENAI_VENDOR = "openai/";

/** The effort sent when the caller asked for none: pi's default when reasoning is on, and OpenAI's. */
export const RESPONSES_DEFAULT_EFFORT = "medium";

/** The output cap, the chat client's (src/model/openai-compatible.ts says why that number). */
const MAX_OUTPUT_TOKENS = 32_768;

interface Entry { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }

function entryFor(model: string): Entry | undefined {
  if (!model.startsWith(OPENAI_VENDOR)) return undefined;
  const id = model.slice(OPENAI_VENDOR.length);
  return Object.prototype.hasOwnProperty.call(OPENAI_MODELS, id) ? (OPENAI_MODELS as Record<string, Entry>)[id] : undefined;
}

/** Whether `model` is called through the Responses API: an `openai/` model pi's catalog lists as a reasoning model. */
export function usesResponses(model: string): boolean {
  return entryFor(model)?.reasoning === true;
}

/**
 * The `reasoning` field for `model` when `reasoning` is what the caller asked for, and whether the reasoning is to
 * be returned for replay. Undefined sends no field: a model with no off value asked for `off`, as pi sends none.
 */
export function responsesReasoningFor(model: string, reasoning?: "off" | "low" | "high"):
  { field?: { effort: string; summary?: "auto" }; replay: boolean } {
  const map = entryFor(model)?.thinkingLevelMap ?? {};
  if (reasoning === "off") return typeof map.off === "string" ? { field: { effort: map.off }, replay: false } : { replay: false };
  const level = reasoning ?? RESPONSES_DEFAULT_EFFORT;
  return { field: { effort: map[level] ?? level, summary: "auto" }, replay: true };
}

/** A Responses API input item; built by `toResponsesInput` (src/model/pi-bridge.ts), sent as given. */
export type ResponsesInputItem = Record<string, unknown>;

export class OpenAiResponsesModel {
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
    input: ResponsesInputItem[],
    opts: { tools?: ToolDefinition[]; reasoning?: "off" | "low" | "high"; maxTokens?: number } = {},
  ): Promise<ModelResponse> {
    const reasoning = responsesReasoningFor(this.#model, opts.reasoning);
    const body = JSON.stringify({
      model: this.#model,
      input,
      max_output_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
      store: false,
      ...(reasoning.field ? { reasoning: reasoning.field } : {}),
      ...(reasoning.replay ? { include: ["reasoning.encrypted_content"] } : {}),
      ...(opts.tools?.length
        ? { tools: opts.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })) }
        : {}),
    });
    return postModelRequest(
      { url: `${this.#baseUrl}/responses`, apiKey: this.#apiKey, model: this.#model, headers: this.#headers, deadlineMs: this.#deadlineMs },
      body,
      readResponse,
    );
  }
}

/**
 * A Responses API answer as our ModelResponse. A `failed` response is thrown, so the queue retries it as it does a
 * 5xx; an `incomplete` one is answered, truncated when it ran out of output tokens.
 */
export function readResponse(data: any): ModelResponse {
  if (data?.status === "failed") throw new Error(`model response failed: ${JSON.stringify(data?.error ?? null).slice(0, 300)}`);
  const output: any[] = Array.isArray(data?.output) ? data.output : [];
  const text: string[] = [];
  const toolCalls: NonNullable<ModelResponse["toolCalls"]> = [];
  const reasoningItems: NonNullable<ModelResponse["reasoningItems"]> = [];
  for (const item of output) {
    if (item?.type === "message") {
      for (const c of item.content ?? []) if (c?.type === "output_text") text.push(String(c.text ?? ""));
    } else if (item?.type === "function_call") {
      // A tool result answers `call_id`; the item's own id (`fc_…`) is not kept, and is not needed to replay
      // the call beside its reasoning (an item without it was accepted, measured 2026-10-06).
      toolCalls.push({ id: String(item.call_id), name: String(item.name), arguments: parseArguments(item.arguments) });
    } else if (item?.type === "reasoning") {
      const summary = (item.summary ?? []).map((s: any) => String(s?.text ?? "")).filter(Boolean).join("\n\n");
      // Only an item with its encrypted reasoning is worth replaying: with `store: false` an id alone names
      // nothing OpenAI kept.
      if (item.encrypted_content) reasoningItems.push({ text: summary, signature: JSON.stringify(item) });
    }
  }
  const incomplete = data?.status === "incomplete";
  const reason = data?.incomplete_details?.reason;
  const finishReason = incomplete ? String(reason ?? "incomplete") : toolCalls.length ? "tool_calls" : String(data?.status ?? "unknown");
  const reasoningText = reasoningItems.map((r) => r.text).filter(Boolean).join("\n\n").slice(0, REASONING_CHARS);
  const u = data?.usage ?? {};
  return {
    text: text.join(""),
    ...(reasoningText ? { reasoning: reasoningText } : {}),
    ...(reasoningItems.length ? { reasoningItems } : {}),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason,
    truncated: incomplete && reason === "max_output_tokens",
    usage: {
      promptTokens: u.input_tokens ?? 0,
      completionTokens: u.output_tokens ?? 0,
      reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
      cachedPromptTokens: u.input_tokens_details?.cached_tokens ?? 0,
    },
  };
}
