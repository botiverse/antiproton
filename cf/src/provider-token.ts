/**
 * The shape of a provider token (raft-agent-provider.v1): what is issued to a Raft server, and what is
 * recognised on a `/provision/*` request.
 *
 * A provider token stands for a TENANT, not an agent — the difference from a service token
 * (cf/src/service-token.ts), which is one console identity. Raft holds one per server, presents it as
 * `Authorization: Bearer`, and never names a tenant; the token is the tenant. It is bound at minting
 * to the Raft origin it may point mounts at (cf/migrations/0008_provisioning.sql). Only the hash is
 * stored, so a leaked table authenticates nobody.
 *
 * The prefix is ours alone, so the value is recognisable without a label: cf/src/secret-shape.ts
 * refuses it in chat.
 */
import { hashApiKey } from "./agents-api/keys.ts";

export const PROVIDER_TOKEN_PREFIX = "pt-";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A new token: the prefix and 32 random bytes. Shown once, when it is issued. */
export function newProviderToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return PROVIDER_TOKEN_PREFIX + b64url(bytes);
}

/** Whether a presented value is worth asking the directory about: our prefix, our alphabet, our length. */
export function looksLikeProviderToken(value: string): boolean {
  return value.startsWith(PROVIDER_TOKEN_PREFIX) && /^[A-Za-z0-9_-]{40,}$/.test(value.slice(PROVIDER_TOKEN_PREFIX.length));
}

/** What is stored and looked up: the same hex SHA-256 the API keys and service tokens use. */
export const hashProviderToken = hashApiKey;
