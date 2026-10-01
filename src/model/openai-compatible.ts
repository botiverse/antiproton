import type { ModelAdapter, ModelMessage, ModelResponse, ToolDefinition } from "./types.ts";

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
            max_tokens: maxTokens,
            temperature: opts.temperature ?? 0,
            ...reasoningDial,
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
        lastErr = err as Error;
        if (attempt === 2) break;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error("model call failed");
  }
}
