/**
 * A Durable Object call Cloudflare marked as safe to repeat: its `retryable` flag, or the object moving
 * between machines, matched as the whole message Cloudflare gives (as read 2026-09-30) so text that
 * only mentions it does not count. A repeat relies on the receiving plugin's `dedupeKey`; one that gives
 * none (a GitHub push without `x-github-delivery`) is delivered again.
 */
export function objectMoved(e: unknown): boolean {
  const x = e as { retryable?: unknown; message?: unknown } | null;
  return x?.retryable === true || /^cannot access storage because object has moved to a different machine$/i.test(String(x?.message ?? ""));
}
