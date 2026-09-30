/** A Durable Object call Cloudflare marked as safe to repeat, such as the object moving between machines. */
export function objectMoved(e: unknown): boolean {
  const x = e as { retryable?: unknown; message?: unknown } | null;
  return x?.retryable === true || /object has moved to a different machine/i.test(String(x?.message ?? ""));
}
