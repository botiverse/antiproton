/**
 * A tenant's key, derived rather than issued.
 *
 * Nobody types a sandbox credential and nobody logs in: the mount has always
 * carried the deployment's own reference, and that must not change. But the
 * broker still has to tell callers apart — telling them apart *is* what it
 * does — so each agent needs a distinct credential. Deriving one removes every
 * moving part that issuing one has: there is nothing to mint, nothing to store,
 * no first-use race, and no state that can be half-created.
 *
 * The public half carries the identity and the secret half proves it:
 *
 *     ak = ak_<tenant>.<agent>
 *     sk = HMAC(shared secret, "<tenant>/<agent>")
 *
 * **Both halves of the identity are proved, not claimed.** Binding only to the
 * tenant would leave the agent column of the audit self-reported: any agent
 * could file its usage under a sibling's name. That is not an escalation — they
 * share a tenant — but the audit is the whole point, and a column that is half
 * authenticated and half asserted is not one (Piper, 2026-09-12).
 *
 * **The cost is revocation.** There is no way to cut off one tenant: rotating
 * the shared secret invalidates every key at once, and every caller silently
 * picks up a new one on its next resolve. That is acceptable while this is a
 * free tier with no adversary, and it is written here rather than discovered on
 * the day someone needs to cut off exactly one account — which is when the
 * absence of per-key revocation is noticed. The escape, if that day comes, is a
 * small deny list in the ledger, checked after the signature.
 */
import { constantTimeEqual } from "../../cf/src/auth.ts";

export interface Caller {
  tenantId: string;
  agentId: string;
}

const enc = new TextEncoder();

async function mac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What this deployment hands an agent. Computed on demand; never stored. */
export async function deriveKey(secret: string, who: Caller): Promise<{ ak: string; sk: string }> {
  return {
    ak: `ak_${who.tenantId}.${who.agentId}`,
    sk: await mac(secret, `${who.tenantId}/${who.agentId}`),
  };
}

/**
 * Who presented this, or nobody.
 *
 * The identity is read out of the public half and then *proved* by recomputing
 * the signature over it — not looked up. A name that does not verify is not a
 * name, so a caller cannot claim a tenant by naming one.
 */
export async function callerOf(secret: string, presented: string | null): Promise<Caller | null> {
  if (!presented) return null;
  const at = presented.indexOf(":");
  if (at < 0) return null;
  const ak = presented.slice(0, at);
  const sk = presented.slice(at + 1);
  if (!ak.startsWith("ak_")) return null;
  const dot = ak.indexOf(".", 3);
  if (dot < 0) return null;
  const who = { tenantId: ak.slice(3, dot), agentId: ak.slice(dot + 1) };
  if (!who.tenantId || !who.agentId) return null;
  const expected = await mac(secret, `${who.tenantId}/${who.agentId}`);
  // The comparison is the repository's own, not a second one written here:
  // `constantTimeEqual` already exists for exactly this, it handles unequal
  // lengths without an early return, and two implementations of one rule is
  // how they come to disagree.
  return constantTimeEqual(expected, sk) ? who : null;
}
