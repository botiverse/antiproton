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
 * The message carries the status and the provider's own explanation, so the turn says what to fix. It is
 * built from the response body only, never its headers; the request's own credentials are blanked in it,
 * and so is anything shaped like a key or a bearer token, since an auth refusal can quote what it was sent.
 * The wording does not match pi-ai's retryable-error patterns (`isRetryableAssistantError`,
 * `utils/retry.js`), so neither engine's harness retries the failed turn either; test/model-refusal.ts
 * checks that against both pi-ai versions.
 */
export class ModelRequestRefused extends Error {
  readonly status: number;
  /** The provider's error message, redacted and truncated. */
  readonly detail: string;
  readonly permanent = true;
  constructor(status: number, body: string, secrets: string[] = []) {
    const detail = refusalDetail(body, secrets);
    super(`the model provider refused the request (HTTP ${status})${detail ? `: ${detail}` : ""}`);
    this.name = "ModelRequestRefused";
    this.status = status;
    this.detail = detail;
  }
}

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
    let lastErr: Error | null = null;
    // One signal for the whole call rather than one per attempt: three attempts each under the
    // deadline would add up past the limit the deadline exists to stay under. It reaches the body
    // read too, since a response whose headers arrived can still stall before its last byte.
    const deadline = AbortSignal.timeout(this.#deadlineMs);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${this.#baseUrl}/chat/completions`, {
          signal: deadline,
          method: "POST",
          headers: {
            ...this.#headers,
            ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
            "content-type": "application/json",
          },
          body: JSON.stringify({
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
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          if (isPermanentRefusal(res.status, body)) {
            throw new ModelRequestRefused(res.status, body, [this.#apiKey, ...Object.values(this.#headers)]);
          }
          const err = new Error(`model ${res.status}: ${body.slice(0, 300)}`);
          if (res.status >= 500 || res.status === 429) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            continue;
          }
          throw err;
        }
        const data = (await res.json()) as any;
        const choice = data.choices?.[0];
        const u = data.usage ?? {};
        const finishReason = choice?.finish_reason ?? "unknown";
        const rawCalls = choice?.message?.tool_calls ?? [];
        // Bounded: a reasoning trace can run to thousands of tokens, and this
        // goes into an append-only log that is never trimmed.
        const reasoning = String(choice?.message?.reasoning_content ?? "").slice(0, 8000);
        return {
          text: choice?.message?.content ?? "",
          ...(reasoning ? { reasoning } : {}),
          toolCalls: rawCalls.length
            ? rawCalls.map((c: any) => ({
                id: c.id,
                name: c.function?.name,
                arguments: (() => {
                  try { return JSON.parse(c.function?.arguments ?? "{}"); }
                  catch { return { __unparsable: c.function?.arguments }; }
                })(),
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
      } catch (err) {
        // Thrown rather than retried here: no time is left to retry in. It fails the call the way an
        // exhausted run of 5xx does, so the queue redelivers it, and the message says which bound
        // ended it — a bare AbortError would read as a cancel, which nothing on this path issues.
        if (deadline.aborted) {
          throw new Error(
            `model call timed out: no complete response within the ${this.#deadlineMs / 1000} s total deadline` +
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
}
