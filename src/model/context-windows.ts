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

export const CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4.1-flash-expires-on-0910": 1_000_000,
};

export function contextWindowFor(
  model: string | undefined,
  fallback = ASSUMED_CONTEXT_WINDOW,
): number {
  if (!model) return fallback;
  if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model]!;
  // Dated or suffixed variants of a known model share its window.
  const base = Object.keys(CONTEXT_WINDOWS).find((k) => model.startsWith(k));
  return base ? CONTEXT_WINDOWS[base]! : fallback;
}
