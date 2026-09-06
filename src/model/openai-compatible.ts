import type { ModelAdapter, ModelMessage, ModelResponse } from "./types.ts";

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

  constructor(cfg: { baseUrl: string; apiKey: string; model: string }) {
    this.#baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.#apiKey = cfg.apiKey;
    this.#model = cfg.model;
    this.id = `${new URL(cfg.baseUrl).host}/${cfg.model}`;
  }

  async complete(messages: ModelMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<ModelResponse> {
    // Reasoning tokens are billed against max_tokens: a tight cap silently
    // yields empty content with finish_reason=length.
    const maxTokens = opts.maxTokens ?? 8192;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.#model,
            messages,
            max_tokens: maxTokens,
            temperature: opts.temperature ?? 0,
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
        return {
          text: choice?.message?.content ?? "",
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
        lastErr = err as Error;
        if (attempt === 2) break;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error("model call failed");
  }
}
