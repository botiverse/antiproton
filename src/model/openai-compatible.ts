import type { ModelAdapter, ModelMessage, ModelResponse, ToolDefinition } from "./types.ts";
import { chatShapeFor } from "./chat-request-shape.ts";

/**
 * How long one `complete` may take, every attempt and backoff included, before it is abandoned.
 *
 * The request is not streamed, so there is no first byte or idle gap to watch: a provider that
 * accepts the request and never answers is only visible as a call that has not finished. Without a
 * bound that call is ended by the platform instead — the queue consumer that waits on it is killed
 * at its 15-minute wall-time limit with nothing logged, and each redelivery can hang the same way
 * (a DeepSeek call held a turn for 899997 ms at ~17 ms CPU, measured 2026-10-01). Ten minutes
 * leaves the consumer's other steps (taking the job, delivering the answer) room under that limit;
 * a legitimate answer slower than that would have been at risk of the same kill anyway.
 */
export const MODEL_CALL_DEADLINE_MS = 10 * 60_000;

/**
 * The provider statuses that say the request itself is wrong: malformed or unsupported (400, 422), not
 * authorised (401, 403), or naming something that does not exist (404). Sending it again sends the same
 * request, so it is refused the same way; a gpt-5.6-luna request with `max_tokens` was sent 12 times in
 * about 7 s (3 attempts here, times the queue's 4 deliveries) before the turn failed with a message that
 * did not say why (measured 2026-10-04). Any other 4xx is permanent too when the provider names it an
 * `invalid_request_error`, except the statuses that say "not now": 408 (timeout), 409 (conflict) and 429
 * (rate limit), which stay retryable with 5xx and network errors.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);
const RETRYABLE_4XX = new Set([408, 409, 429]);

export function isPermanentRefusal(status: number, body: string): boolean {
  if (PERMANENT_STATUSES.has(status)) return true;
  return status >= 400 && status < 500 && !RETRYABLE_4XX.has(status) && /invalid_request_error/.test(body);
}

/** Longest provider message carried into the turn's error. */
const REFUSAL_DETAIL_CHARS = 300;

/**
 * A provider's refusal of the request itself (`isPermanentRefusal`): not retried here, and answered to the
 * job as a failed turn by the queue consumer (`callQueuedModel`, cf/src/model-request.ts) instead of going
 * back to the queue.
 *
 * Two texts, kept apart on purpose. `message` is fixed: it is what becomes the answer's `errorMessage`, and
 * both engines' harnesses decide whether to retry a failed turn by scanning that string for patterns such as
 * `timeout`, `500` or `server error` (pi-ai's `isRetryableAssistantError`, `utils/retry.js`). A provider's
 * own text can contain any of them — "In context=('properties', 'timeout')" in a tool schema, or
 * "messages[502]" — and was read as retryable by both pi-ai versions, so pd dispatched the job again. No
 * provider text is ever in `message`; it holds only the status, which is never a retryable one here.
 *
 * `turnError` is what the turn shows: the status and the provider's own explanation, so it says what to fix.
 * It travels beside `errorMessage` on the answer (`providerError`, src/model/pi-bridge.ts), which no retry
 * check reads. It is built from the response body only, never its headers; the request's own credentials
 * are blanked in it (exact values only), and so is anything shaped like a key or a bearer token, since an
 * auth refusal can quote what it was sent.
 */
export class ModelRequestRefused extends Error {
  readonly status: number;
  /** The provider's error message, redacted and truncated. */
  readonly detail: string;
  /** The status and `detail`, and `hint` when one was given: the turn's error. */
  readonly turnError: string;
  readonly permanent = true;
  constructor(status: number, body: string, secrets: string[] = [], hint?: string) {
    super(`model refused (HTTP ${status}, permanent): see the turn's error`);
    this.name = "ModelRequestRefused";
    this.status = status;
    this.detail = refusalDetail(body, secrets);
    this.turnError = `the model provider refused the request (HTTP ${status})${this.detail ? `: ${this.detail}` : ""}${hint ? ` ${hint}` : ""}`;
  }
}

/**
 * Said with a 401 when the request carried no key of ours for a `vendor/model` name, so the gateway supplied
 * the vendor's credential itself. An id the vendor does not have comes back that way too, not as a 404:
 * `openai/gpt-nonexistent-rev749` through Cloudflare AI Gateway answered 401 "You didn't provide an API
 * key" (measured 2026-10-04), which points at auth when the name is what is wrong.
 */
export const GATEWAY_401_HINT = "(through the gateway, an unknown model id also comes back as 401; check the model name)";

function refusalDetail(body: string, secrets: string[]): string {
  let text = body;
  try {
    const e = (JSON.parse(body) as any)?.error;
    // OpenAI's shape, which the gateway's /compat and DeepSeek both answer in: { error: { message, type, code } }.
    const message = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : undefined;
    if (message !== undefined) {
      const kind = [e?.type, e?.code].filter((v) => typeof v === "string" && v).join(", ");
      text = kind ? `${message} (${kind})` : message;
    }
  } catch { /* not JSON: the body as sent */ }
  for (const s of secrets) {
    // The credential is the part after the scheme; a header value is `Bearer <token>`.
    const bare = s.replace(/^Bearer\s+/i, "");
    if (bare.length >= 4) text = text.split(bare).join("[redacted]");
  }
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_*-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > REFUSAL_DETAIL_CHARS ? `${text.slice(0, REFUSAL_DETAIL_CHARS)}…` : text;
}

/**
 * Normalises any OpenAI-compatible endpoint. Provider-specific extras
 * (reasoning_content, cache hit counters) are folded into usage rather than
 * leaking into the harness — that is what keeps §11's "provider is replaceable"
 * honest.
 */
export class OpenAiCompatibleModel implements ModelAdapter {
  readonly id: string;
  #baseUrl: string;
  #apiKey: string;
  #model: string;
  #headers: Record<string, string>;
  #deadlineMs: number;

  /**
   * `apiKey` empty sends no `authorization`: a gateway that holds the provider's key (Cloudflare AI
   * Gateway's stored keys) adds it itself. `headers` are sent as given, e.g. the gateway's own token.
   * `deadlineMs` replaces MODEL_CALL_DEADLINE_MS, so a test can hang a call without waiting minutes.
   */
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
    messages: ModelMessage[],
    opts: {
      maxTokens?: number; temperature?: number;
      tools?: ToolDefinition[]; toolChoice?: "auto" | "required" | "none";
      reasoning?: "off" | "low" | "high";
    } = {},
  ): Promise<ModelResponse> {
    // Reasoning tokens are billed against max_tokens, so the cap is a budget for
    // thinking and answering together, not for the answer. 8192 was the default
    // here and it was not enough: on a τ² turn seven tool calls deep the model
    // spent all 8192 on reasoning, returned empty content with
    // finish_reason=length, and the conversation simply stopped — an agent that
    // had done the work and had nothing left to say it with.
    //
    // The provider accepts 65536. This is half of that: high enough that the
    // budget is not the thing that ends a turn, low enough to still be a bound
    // on a reasoning trace that has run away.
    //
    // With `reasoning: "off"` there is no trace, and the same cap bounds the
    // answer alone — which is what a caller that asks for it means by it.
    const maxTokens = opts.maxTokens ?? 32_768;
    // DeepSeek's dialect: `thinking.type` switches the trace off, and
    // `reasoning_effort` sizes it. Nothing is sent when the caller did not ask,
    // so a request without the option is the request it always was.
    const reasoningDial = opts.reasoning === "off" ? { thinking: { type: "disabled" } }
      : opts.reasoning ? { reasoning_effort: opts.reasoning } : {};
    // An OpenAI model's fields (src/model/chat-request-shape.ts); null for every other model, whose
    // body below is exactly the one it always was.
    const shape = chatShapeFor(this.#model, opts.reasoning);
    const capAndDial: Record<string, unknown> = shape
      ? {
          [shape.tokensField]: maxTokens,
          ...(shape.temperature ? { temperature: opts.temperature ?? 0 } : {}),
          ...(shape.reasoningEffort !== undefined ? { reasoning_effort: shape.reasoningEffort } : {}),
        }
      : { max_tokens: maxTokens, temperature: opts.temperature ?? 0, ...reasoningDial };
    const body = JSON.stringify({
      model: this.#model,
      messages,
      ...capAndDial,
      ...(opts.tools?.length
        ? {
            tools: opts.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
          }
        : {}),
    });
    return postModelRequest(
      { url: `${this.#baseUrl}/chat/completions`, apiKey: this.#apiKey, model: this.#model, headers: this.#headers, deadlineMs: this.#deadlineMs },
      body,
      (data) => {
        const choice = data.choices?.[0];
        const u = data.usage ?? {};
        const finishReason = choice?.finish_reason ?? "unknown";
        const rawCalls = choice?.message?.tool_calls ?? [];
        const reasoning = String(choice?.message?.reasoning_content ?? "").slice(0, REASONING_CHARS);
        return {
          text: choice?.message?.content ?? "",
          ...(reasoning ? { reasoning } : {}),
          toolCalls: rawCalls.length
            ? rawCalls.map((c: any) => ({
                id: c.id,
                name: c.function?.name,
                arguments: parseArguments(c.function?.arguments),
              }))
            : undefined,
          finishReason,
          truncated: finishReason === "length",
          usage: {
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
            cachedPromptTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
          },
        };
      });
  }
}

/**
 * Longest reasoning trace kept on an answer as text. Bounded: a trace can run to thousands of tokens, and
 * this goes into an append-only log that is never trimmed.
 */
export const REASONING_CHARS = 8000;

/** A tool call's arguments as the provider sent them, a JSON string; one that does not parse is kept, not dropped. */
export function parseArguments(raw: unknown): unknown {
  try { return JSON.parse((raw as string | undefined) ?? "{}"); }
  catch { return { __unparsable: raw }; }
}

/**
 * One model call over HTTP, shared by both of our clients (chat/completions here, Responses in
 * src/model/openai-responses.ts) so they cannot differ in how a call is retried, bounded or refused: three
 * attempts, a 5xx or 429 retried with a growing pause, a refusal of the request itself (`isPermanentRefusal`)
 * thrown at once as `ModelRequestRefused`, and every attempt under one deadline. `read` turns a 2xx JSON body
 * into the answer.
 */
export async function postModelRequest(
  cfg: { url: string; apiKey: string; model: string; headers: Record<string, string>; deadlineMs: number },
  body: string,
  read: (data: any) => ModelResponse,
): Promise<ModelResponse> {
  let lastErr: Error | null = null;
  // One signal for the whole call rather than one per attempt: three attempts each under the
  // deadline would add up past the limit the deadline exists to stay under. It reaches the body
  // read too, since a response whose headers arrived can still stall before its last byte.
  const deadline = AbortSignal.timeout(cfg.deadlineMs);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(cfg.url, {
        signal: deadline,
        method: "POST",
        headers: {
          ...cfg.headers,
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
          "content-type": "application/json",
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        if (isPermanentRefusal(res.status, text)) {
          const gatewayKeyed = res.status === 401 && !cfg.apiKey && cfg.model.includes("/");
          throw new ModelRequestRefused(res.status, text, [cfg.apiKey, ...Object.values(cfg.headers)],
            gatewayKeyed ? GATEWAY_401_HINT : undefined);
        }
        const err = new Error(`model ${res.status}: ${text.slice(0, 300)}`);
        if (res.status >= 500 || res.status === 429) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        throw err;
      }
      return read(await res.json());
    } catch (err) {
      // Thrown rather than retried here: no time is left to retry in. It fails the call the way an
      // exhausted run of 5xx does, so the queue redelivers it, and the message says which bound
      // ended it — a bare AbortError would read as a cancel, which nothing on this path issues.
      if (deadline.aborted) {
        throw new Error(
          `model call timed out: no complete response within the ${cfg.deadlineMs / 1000} s total deadline` +
          (lastErr ? ` (last error before it: ${lastErr.message})` : ""));
      }
      // The same request would be refused the same way: one call is the whole answer.
      if (err instanceof ModelRequestRefused) throw err;
      lastErr = err as Error;
      if (attempt === 2) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("model call failed");
}
