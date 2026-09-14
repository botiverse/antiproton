/**
 * The only form of an artifact reference a model or a person is shown.
 *
 * A stored object's key is `t/<tenant>/<agent>/<path>`, and the reference the
 * store hands back was that key behind `r2://<bucket>/`. Every tool result,
 * note and error that carried it told whoever read it the bucket, the tenant
 * and the agent — tenant information, on every large result (tygg,
 * 2026-09-14). So outside storage a reference is `artifact://<path>`: the part
 * that belongs to the agent it was given to, and nothing about where that
 * agent lives. The raw form stays internal — the operations row, the
 * operator's diagnostics.
 *
 * Resolving goes the other way and always under the caller's own scope, so a
 * reference can only ever name something of the agent holding it. A legacy
 * raw reference is still accepted when it is inside that scope, because
 * transcripts written before this change hold them; it is never produced.
 */

export const AGENT_REF = "artifact://";

export interface RefOwner {
  tenantId: string;
  agentId: string;
}

const scopeOf = (o: RefOwner) => `t/${o.tenantId}/${o.agentId}/`;
const RAW = /^r2:\/\/[^/]+\//;

/** A path that moves (`.`, `..`) or has an empty segment names somewhere else. */
function plainPath(path: string): boolean {
  return path.length > 0 && !path.split("/").some((s) => s === "" || s === "." || s === "..");
}

/**
 * A raw reference or key, as the agent that owns it may be shown it. Null when
 * the key is not under that agent's scope: such a reference must not be shown
 * to this agent in any form.
 */
export function toAgentRef(refOrKey: string, owner: RefOwner): string | null {
  const key = String(refOrKey).replace(RAW, "");
  const scope = scopeOf(owner);
  if (!key.startsWith(scope)) return null;
  const path = key.slice(scope.length);
  return plainPath(path) ? `${AGENT_REF}${path}` : null;
}

/**
 * The storage key a reference names, for the caller holding it; null when it
 * names nothing that caller may read.
 */
export function keyForRef(ref: string, caller: RefOwner): string | null {
  const scope = scopeOf(caller);
  const r = String(ref);
  if (r.startsWith(AGENT_REF)) {
    const path = r.slice(AGENT_REF.length);
    return plainPath(path) ? scope + path : null;
  }
  if (RAW.test(r)) {
    const key = r.replace(RAW, "");
    return key.startsWith(scope) && plainPath(key.slice(scope.length)) ? key : null;
  }
  return null;
}

/**
 * Text as its owner may be shown it: every reference into that owner's scope
 * rewritten to the shown form. For what was written before references changed
 * shape — a transcript's stored tool results, an answer that quoted one — and
 * is read back to a person or a model now.
 *
 * Both spellings are rewritten: the raw reference, and the bare key an older
 * "no such artifact: t/<tenant>/<agent>/…" error echoed, which the model then
 * quoted in its answers (64c275a probe, 2026-09-14: 7 such keys on one agent,
 * every raw reference already masked). The key must start where a path can
 * start, so `…/t/<tenant>/<agent>/` inside some longer path is not taken for
 * one, and the trailing slash keeps agent `u-me` from matching `u-me2`.
 */
export function maskRawRefs(text: string, owner: RefOwner): string {
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scope = `t/${esc(owner.tenantId)}/${esc(owner.agentId)}/`;
  const raw = new RegExp(`r2://[A-Za-z0-9._-]+/${scope}`, "g");
  const bare = new RegExp(`(^|[^A-Za-z0-9._/-])${scope}`, "g");
  return String(text).replace(raw, AGENT_REF).replace(bare, `$1${AGENT_REF}`);
}
