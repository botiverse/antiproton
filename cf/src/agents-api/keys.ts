/**
 * API keys for the OpenAI-compatible agents API (task #17).
 *
 * The OpenAI SDK authenticates with `Authorization: Bearer <key>`, so a
 * program that changes only the base URL needs a key it can put there. A key
 * is shown once, when it is issued; only its SHA-256 is stored, next to the
 * identity table, mapping to the tenant and the owning agent. A leaked table
 * therefore holds nothing that authenticates.
 */

/** Distinguishes our keys from OpenAI's (`sk-...`), so a mix-up fails loudly rather than as a lookup miss. */
export const KEY_PREFIX = "ap-";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A new key: the prefix and 32 random bytes. */
export function newApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return KEY_PREFIX + b64url(bytes);
}

/** What is stored and looked up: the hex SHA-256 of the whole key. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The key a request presents, or null. Strict on purpose: only the Bearer
 * scheme, only our prefix, only the characters a key can contain. Anything else
 * is "no key", and the caller answers 401 the way OpenAI does.
 */
export function bearerKey(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  if (!m) return null;
  const key = m[1]!;
  return key.startsWith(KEY_PREFIX) && /^[A-Za-z0-9_-]{16,}$/.test(key.slice(KEY_PREFIX.length)) ? key : null;
}
