/**
 * What each model can hold.
 *
 * A deployment-wide constant is wrong by an order of magnitude the moment two
 * models are in play: a threshold that is most of a small window is a rounding
 * error in a large one. Making this per-model immediately found a live
 * misconfiguration — compaction calibrated for 131k on a model holding a
 * million, so it fired at a twelfth of the context it had.
 *
 * The shape is pi's `models.json` idea, kept small: the harness asks the model
 * what it holds rather than being told once at deploy time.
 */

/**
 * The conservative assumption. Compacting early costs a summary; discovering
 * the limit from a refused call costs the turn.
 */
export const ASSUMED_CONTEXT_WINDOW = 131_072;

/**
 * Only models this deployment has actually seen. A dated variant that the
 * provider has since withdrawn is worse than absent: it looks configured, and
 * every call 404s. One was left here until the day it expired.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  // Measured rather than read off a page: a 900,034-token prompt was accepted
  // without a length refusal. The provider publishes no window in its model
  // list, and this is the one number here that is wrong by an order of
  // magnitude if guessed.
  "deepseek-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
};

export function contextWindowFor(
  model: string | undefined,
  fallback = ASSUMED_CONTEXT_WINDOW,
): number {
  if (!model) return fallback;
  // Through a gateway a model is named `provider/model`; the window is the model's.
  model = model.slice(model.indexOf("/") + 1);
  if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model]!;
  // Dated or suffixed variants of a known model share its window.
  const base = Object.keys(CONTEXT_WINDOWS).find((k) => model.startsWith(k));
  return base ? CONTEXT_WINDOWS[base]! : fallback;
}

/**
 * The models that can see an image, by the same name the windows are matched by. A model not listed is sent text
 * only: an image in its conversation is replaced by a sentence saying it cannot see it (src/model/images.ts
 * `NO_VISION_SENTENCE`). Listed only after a live call with an image answered correctly through the path this
 * deployment calls the model by: deepseek-flash at DeepSeek's /chat/completions as a user `image_url`, and
 * gpt-5.6-luna through Cloudflare AI Gateway's /compat/responses as `input_image`, in a user message and in a
 * `function_call_output` (measured 2026-10-12). deepseek-v4-pro was not probed.
 */
export const VISION_MODELS: ReadonlySet<string> = new Set(["deepseek-flash", "gpt-5.6-luna"]);

/** Whether `model` can be shown images, matched as `contextWindowFor` matches a window. */
export function acceptsImages(model: string | undefined): boolean {
  if (!model) return false;
  model = model.slice(model.indexOf("/") + 1);
  if (VISION_MODELS.has(model)) return true;
  return [...VISION_MODELS].some((k) => model!.startsWith(k));
}
