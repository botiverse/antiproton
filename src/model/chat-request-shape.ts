/**
 * Which fields a chat/completions request carries for a model, decided from the model's name alone.
 *
 * The provider does not enter into it, because what refuses the request is OpenAI's own endpoint behind
 * whichever provider routes it; that was measured through Cloudflare AI Gateway's /compat only. OpenRouter
 * was not probed, and pi addresses it differently (`thinkingFormat: "openrouter"`, a `reasoning: { effort }`
 * object rather than `reasoning_effort`), so these fields are not known to be what OpenRouter wants. Only
 * OpenAI's models are shaped here; every other model, DeepSeek's included, is sent the body it always was
 * (`null` below).
 *
 * The rules are pi's, not ours. pi-ai's `openai-completions` provider decides them per model
 * (`dist/api/openai-completions.js`, `detectCompat` and `buildParams`, the same rule in 0.85.1 and 1.0.0),
 * and its catalog says what each OpenAI model is (`dist/providers/openai.models.js`, data in
 * `providers/data/openai.json`). The catalog is imported, from 1.0.0 (`pi-ai-1`) because it lists more
 * OpenAI models than 0.85.1's, and for every model both list it yields the shape 0.85.1's would; it is data, so which engine runs
 * the turn does not matter. The two rules are mirrored, because pi does not export them and the module that
 * holds them imports OpenAI's SDK, which the consumer does not ship. test/chat-request-shape.ts runs pi's own
 * `buildParams` (through its `onPayload` hook) in both versions for every model their catalogs list, and goes
 * red if pi's rule and this one part.
 *
 * - The output cap is `max_completion_tokens`. pi sends it for every model at a standard OpenAI endpoint
 *   (`maxTokensField`), and OpenAI deprecated `max_tokens` for its chat models: gpt-5.6-luna refuses it
 *   with a 400 (measured 2026-10-04 through the gateway's /compat), and gpt-4.1-mini accepts both.
 * - A reasoning model whose reasoning the caller did not ask for is sent the catalog's "off" level as
 *   `reasoning_effort` when there is one (`thinkingLevelMap.off`, "none" for gpt-5.6-luna); a level the
 *   caller asked for is sent mapped the same way. This is what keeps function tools usable: chat/completions
 *   refuses tools with reasoning on for gpt-5.6-luna ("Function tools with reasoning_effort are not
 *   supported ... use /v1/responses or set reasoning_effort to 'none'", 400, measured 2026-10-04), and
 *   answered 200 with a correct tool call once "none" was sent. A model whose catalog entry has no "off"
 *   (o3, o4-mini) is sent nothing, as pi sends nothing. The Responses API, which pi itself uses for these
 *   models, is the way to keep reasoning on with tools: the queue consumer sends every such model there
 *   (src/model/openai-responses.ts, `usesResponses`). This shape applies only if something calls our chat
 *   client directly with such a model, which would then still run with its reasoning off.
 * - `temperature` is ours, not pi's (pi sends one only when asked): the harness has always sent 0, and an
 *   OpenAI reasoning model with its reasoning on refuses any temperature but the default, so it is left out
 *   exactly then. With reasoning off gpt-5.6-luna accepted temperature 0 (measured 2026-10-04).
 *
 * A model under `openai/` that the catalog does not list is shaped as a non-reasoning OpenAI model:
 * `max_completion_tokens`, temperature 0, no `reasoning_effort`. If it is a reasoning model that needs more,
 * its refusal reaches the turn with the provider's message (src/model/openai-compatible.ts).
 */
import { OPENAI_MODELS } from "pi-ai-1/providers/openai.models";

/** The vendor segment that marks a model as OpenAI's. A bare name is never shaped: at DeepSeek's API it is DeepSeek's. */
const OPENAI_VENDOR = "openai/";

type Effort = "off" | "low" | "high";

export interface ChatShape {
  /** pi's `maxTokensField` for the model. */
  tokensField: "max_tokens" | "max_completion_tokens";
  /** `reasoning_effort` to send, or absent. */
  reasoningEffort?: string;
  /** Whether `temperature` is sent. */
  temperature: boolean;
}

/** pi's catalog entry for an OpenAI model, as far as the shape reads it. */
interface Entry { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }

/**
 * The shape for `model` when `reasoning` is what the caller asked for, or null for a model that is not
 * OpenAI's (its request is the one it always was).
 */
export function chatShapeFor(model: string, reasoning?: Effort): ChatShape | null {
  if (!model.startsWith(OPENAI_VENDOR)) return null;
  const id = model.slice(OPENAI_VENDOR.length);
  const entry: Entry | undefined = Object.prototype.hasOwnProperty.call(OPENAI_MODELS, id)
    ? (OPENAI_MODELS as Record<string, Entry>)[id] : undefined;
  if (!entry?.reasoning) return { tokensField: "max_completion_tokens", temperature: true };
  const map = entry.thinkingLevelMap ?? {};
  // pi's `streamSimple` reads a requested "off" as no level at all, and `buildParams` then sends the off value.
  const asked = reasoning === "off" ? undefined : reasoning;
  const effort = asked ? (map[asked] ?? asked) : (typeof map.off === "string" ? map.off : undefined);
  const off = effort !== undefined && effort === map.off;
  return { tokensField: "max_completion_tokens", ...(effort !== undefined ? { reasoningEffort: effort } : {}), temperature: off };
}
