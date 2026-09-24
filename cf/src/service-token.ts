/**
 * The shape of a service token (task #7): what is issued, and what is recognised on a request.
 *
 * A service token is an operator-issued, named, revocable credential that stands where the single
 * QA key stood — a console identity each, never the operator. It is presented in `x-harness-token`
 * like the automation token, or pasted into /login/key like the QA key; only the hash is stored
 * (cf/migrations/0007_service_tokens.sql), so a leaked table authenticates nobody.
 *
 * The prefix is ours alone, so the value is recognisable without a label: cf/src/secret-shape.ts
 * refuses it in chat, and cf/src/auth.ts asks the directory only for a header that carries it.
 */
import { hashApiKey } from "./agents-api/keys.ts";

export const SERVICE_TOKEN_PREFIX = "st-";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A new token: the prefix and 32 random bytes. Shown once, when it is issued. */
export function newServiceToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return SERVICE_TOKEN_PREFIX + b64url(bytes);
}

/** Whether a presented value is worth asking the directory about: our prefix, our alphabet, our length. */
export function looksLikeServiceToken(value: string): boolean {
  return value.startsWith(SERVICE_TOKEN_PREFIX) && /^[A-Za-z0-9_-]{40,}$/.test(value.slice(SERVICE_TOKEN_PREFIX.length));
}

/** What is stored and looked up: the same hex SHA-256 the API keys use. */
export const hashServiceToken = hashApiKey;
