/**
 * The control plane: who may sign in, and as which (tenant, agent) (task #18, tygg 2026-09-15).
 *
 * This was a table inside one agent object, addressed as tenant "demo", agent "identities": a
 * central directory dressed as a business object. It is one table, consulted at sign-in, and now
 * it is what it is: a D1 database per deployment, with real SQL behind the admin route, so rows
 * can be listed, counted per tenant and changed without going through an agent.
 *
 * The line this file keeps: control-plane data only. Who may enter and which tenant they belong
 * to, and later the tenant list, quota ceilings and operator switches. What an agent owns (its
 * transcript, secrets, events, mounts) stays in that agent's own object and never moves here.
 *
 * What that costs, accepted on purpose:
 * - D1 has one primary. This buys operability, not decentralisation.
 * - D1 unavailable means new sign-ins are refused ("unavailable"). A person already signed in is
 *   not affected: their tenant and agent are sealed into the session cookie at sign-in, and no
 *   request after that reads this table.
 * - A row exists before its object does, and that is the normal state rather than a gap. An
 *   object is created on first use and records its (tenant, agent) then (AgentDO #claim), so
 *   sign-in builds nothing and has nothing to undo if the first request never comes.
 *
 * Schema: cf/migrations/0001_identities.sql and 0002_api_keys.sql, applied by cf/scripts/deploy.sh
 * before the Worker ships. Depends on: those files. A column changed there is changed in the queries below.
 */

/** What sign-in needs from a row. */
export interface Invitation {
  agentId: string;
  tenantId: string;
}

export interface IdentityRow extends Invitation {
  key: string;
  addedBy: string;
  createdAt: number;
}

export interface IdentityDirectory {
  lookup(key: string): Promise<Invitation | null>;
  /** The operator's write: the row becomes this, whatever it was. Keeps the first created_at. */
  upsert(key: string, row: Invitation, by: string): Promise<void>;
  /** Open sign-up's write: only when the key has no row. Returns whichever row holds afterwards. */
  register(key: string, row: Invitation, by: string): Promise<Invitation>;
  remove(key: string): Promise<void>;
  list(): Promise<IdentityRow[]>;
}

const COLUMNS = "provider_key, agent_id, tenant_id, added_by, created_at";

export function d1Identities(db: D1Database): IdentityDirectory {
  const invitation = (r: any): Invitation => ({ agentId: String(r.agent_id), tenantId: String(r.tenant_id) });
  return {
    async lookup(key) {
      const r = await db.prepare("SELECT agent_id, tenant_id FROM identities WHERE provider_key = ?").bind(key).first();
      return r ? invitation(r) : null;
    },
    async upsert(key, row, by) {
      await db.prepare(
        `INSERT INTO identities(${COLUMNS}) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_key) DO UPDATE SET agent_id = excluded.agent_id, tenant_id = excluded.tenant_id, added_by = excluded.added_by`,
      ).bind(key, row.agentId, row.tenantId, by, Date.now()).run();
    },
    async register(key, row, by) {
      // One batch is one transaction: the row read back is the one this write left or lost to.
      const [, read] = await db.batch([
        db.prepare(`INSERT INTO identities(${COLUMNS}) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_key) DO NOTHING`)
          .bind(key, row.agentId, row.tenantId, by, Date.now()),
        db.prepare("SELECT agent_id, tenant_id FROM identities WHERE provider_key = ?").bind(key),
      ]);
      const held = (read.results as any[])[0];
      if (!held) throw new Error(`identities: ${key} has no row right after registering it`);
      return invitation(held);
    },
    async remove(key) {
      await db.prepare("DELETE FROM identities WHERE provider_key = ?").bind(key).run();
    },
    async list() {
      const { results } = await db.prepare(`SELECT ${COLUMNS} FROM identities ORDER BY created_at, provider_key`).all();
      return (results as any[]).map((r) => ({
        key: String(r.provider_key), ...invitation(r), addedBy: String(r.added_by), createdAt: Number(r.created_at),
      }));
    },
  };
}

export type Admission =
  | { ok: true; row: Invitation; registered: boolean }
  | { ok: false; reason: "not-invited" | "unavailable"; error?: string };

/**
 * The sign-in decision. Never throws: a directory that cannot answer is a refusal the person sees
 * ("unavailable"), not a 500, and no session is issued on a row that was not read.
 */
export async function admit(
  dir: IdentityDirectory,
  key: string,
  o: { openSignup: boolean; derive: () => Invitation },
): Promise<Admission> {
  try {
    const row = await dir.lookup(key);
    if (row) return { ok: true, row, registered: false };
    if (!o.openSignup) return { ok: false, reason: "not-invited" };
    const fresh = o.derive();
    // An operator row written since the lookup wins; sign-up never overwrites one.
    const held = await dir.register(key, fresh, "self");
    return { ok: true, row: held, registered: held.agentId === fresh.agentId && held.tenantId === fresh.tenantId };
  } catch (e) {
    return { ok: false, reason: "unavailable", error: String((e as Error)?.message ?? e) };
  }
}

/**
 * Agents API keys (task #17): which tenant and owner a bearer key speaks for. The same kind of fact as an
 * invitation — who may call, and as whom — so it lives here rather than in an agent object, where it sat
 * while the Agents API was a branch. Only the hash is stored (agents-api/keys.ts); the key is shown once.
 */
export interface ApiKeyOwner {
  tenantId: string;
  ownerAgentId: string;
}

export interface ApiKeyDirectory {
  issue(row: ApiKeyOwner & { hash: string; label: string }): Promise<void>;
  /** A key resolves only while it is not revoked. */
  lookup(hash: string): Promise<ApiKeyOwner | null>;
  /** Whether a live key was revoked by this call. */
  revoke(hash: string): Promise<boolean>;
}

export function d1ApiKeys(db: D1Database, now: () => number = Date.now): ApiKeyDirectory {
  return {
    async issue(row) {
      await db.prepare("INSERT INTO api_keys(hash, tenant_id, owner_agent_id, label, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(row.hash, row.tenantId, row.ownerAgentId, row.label, now()).run();
    },
    async lookup(hash) {
      const r: any = await db.prepare("SELECT tenant_id, owner_agent_id FROM api_keys WHERE hash = ? AND revoked_at IS NULL")
        .bind(hash).first();
      return r ? { tenantId: String(r.tenant_id), ownerAgentId: String(r.owner_agent_id) } : null;
    },
    async revoke(hash) {
      const res = await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL")
        .bind(now(), hash).run();
      return Number(res.meta?.changes ?? 0) > 0;
    },
  };
}
