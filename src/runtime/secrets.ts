/**
 * Per-agent secrets, sealed at rest.
 *
 * A mount stores a reference, never a value. Until now the only reference
 * form was `env:NAME`, resolved from the Worker's own environment — one key
 * per deployment, nothing per agent, no way in but a redeploy. `agent:<name>`
 * is the second form: the value lives in the agent's own object, in a table
 * beside its transcript, encrypted under one key the Worker holds as a secret.
 *
 * Three properties, each pinned by a test:
 *  - the plaintext exists only in gateway memory for the duration of a call;
 *    the table holds ciphertext, an IV, and the last four characters written
 *    once at store time so that no read path ever touches the value;
 *  - an `agent:` reference resolves only against the (tenant, agent) that owns
 *    the mount naming it — the resolver takes the scope from the mount, not
 *    from the reference, so there is no reference one agent could write that
 *    reaches another's store;
 *  - nothing returns the value: not the console, not a tool result, not a
 *    transcript entry. The only outputs are `last4`, timestamps, and whatever
 *    a plugin's own `checkCredential` reports.
 */
import type { StorageAdapter } from "../core/store.ts";
import type { SecretResolver } from "./gateway.ts";

export const AGENT_REF = "agent:";
export function agentRef(name: string): string { return AGENT_REF + name; }
export function isAgentRef(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.startsWith(AGENT_REF);
}

export interface Sealed { ciphertext: string; iv: string }

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The Worker's key-encryption key: 32 bytes, base64, held as a Worker secret
 *  and never written anywhere else. */
export async function importKek(base64: string): Promise<CryptoKey> {
  const raw = unb64(base64);
  if (raw.length !== 32) throw new Error(`SECRET_KEK must be 32 bytes, got ${raw.length}`);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(kek: CryptoKey, value: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, enc.encode(value));
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}

export async function open(kek: CryptoKey, sealed: Sealed): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(sealed.iv) }, kek, unb64(sealed.ciphertext));
  return dec.decode(pt);
}

/** What a page may see. Never the value. */
export function last4(value: string): string {
  return value.length <= 4 ? "" : value.slice(-4);
}

/**
 * Resolves `agent:` references against the caller's own store and hands every
 * other form to the resolver that existed before. Stamps `last_used_at` on the
 * way out, which is the only write a read ever does.
 */
export function agentSecrets(
  store: StorageAdapter, kek: CryptoKey | null, fallback: SecretResolver,
): SecretResolver {
  return {
    async resolve(ref, scope) {
      if (!isAgentRef(ref)) return fallback.resolve(ref, scope);
      if (!scope) return null;              // no owner, no lookup: the reference alone names nothing
      if (!kek) throw new Error("agent secrets are configured but the Worker has no SECRET_KEK");
      const name = ref.slice(AGENT_REF.length);
      const row = await store.getSecret(scope.tenantId, scope.agentId, name);
      if (!row) return null;
      const value = await open(kek, row);
      await store.touchSecret(scope.tenantId, scope.agentId, name, Date.now());
      return value;
    },
  };
}
