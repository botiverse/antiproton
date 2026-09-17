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

/**
 * A key as its owner's page lists it. The hash stands in for the key: it names the row and cannot be
 * presented as a key, so a page may carry it (keys.ts hashApiKey is one-way over 32 random bytes).
 */
export interface ApiKeyRow {
  hash: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
  /** Waiting for its first secret. */
  pending?: boolean;
}

export interface ApiKeyDirectory {
  issue(row: ApiKeyOwner & { hash: string; label: string }): Promise<void>;
  /** A key resolves only while it is not revoked. */
  lookup(hash: string): Promise<ApiKeyOwner | null>;
  /** Whether a live key was revoked by this call. For automation, which may revoke any key. */
  revoke(hash: string): Promise<boolean>;
  /** An owner's keys, newest first. Revoked ones stay listed, so the page can say when. */
  list(owner: ApiKeyOwner): Promise<ApiKeyRow[]>;
  /** As revoke, but only a key of this owner: a person revokes their own keys and never another's. */
  revokeOwned(hash: string, owner: ApiKeyOwner): Promise<boolean>;
  /**
   * Issue only while the owner holds fewer than `max` live keys; whether it was issued. The count and the
   * insert are one statement, so requests at the same time cannot all pass a count read before any insert.
   */
  issueWithin(row: ApiKeyOwner & { hash: string; label: string }, max: number): Promise<boolean>;
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
    async list(owner) {
      const { results } = await db.prepare(
        "SELECT hash, label, created_at, revoked_at FROM api_keys WHERE tenant_id = ? AND owner_agent_id = ? ORDER BY created_at DESC, hash",
      ).bind(owner.tenantId, owner.ownerAgentId).all();
      return (results as any[]).map((r) => ({
        hash: String(r.hash), label: String(r.label), createdAt: Number(r.created_at),
        revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
      }));
    },
    async revokeOwned(hash, owner) {
      const res = await db.prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE hash = ? AND tenant_id = ? AND owner_agent_id = ? AND revoked_at IS NULL",
      ).bind(now(), hash, owner.tenantId, owner.ownerAgentId).run();
      return Number(res.meta?.changes ?? 0) > 0;
    },
    async issueWithin(row, max) {
      const res = await db.prepare(
        `INSERT INTO api_keys(hash, tenant_id, owner_agent_id, label, created_at)
         SELECT ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM api_keys WHERE tenant_id = ? AND owner_agent_id = ? AND revoked_at IS NULL) < ?`,
      ).bind(row.hash, row.tenantId, row.ownerAgentId, row.label, now(), row.tenantId, row.ownerAgentId, max).run();
      return Number(res.meta?.changes ?? 0) > 0;
    },
  };
}

/** A hook's public index row: which agent's mount its URL reaches. */
export interface HookRow {
  hookId: string;
  tenantId: string;
  agentId: string;
  alias: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface HookDirectory {
  /** `pending`: the secret comes later, from the service (see `grant`); until then the hook does not resolve. */
  create(row: { hookId: string; tenantId: string; agentId: string; alias: string }, opts?: { pending?: boolean }): Promise<void>;
  /** A hook resolves only while it is live and has its first secret. */
  lookup(hookId: string): Promise<Omit<HookRow, "createdAt" | "revokedAt"> | null>;
  /** Live, whether or not it has its first secret yet: the secret-writing route's lookup. */
  lookupLive(hookId: string): Promise<(Omit<HookRow, "createdAt" | "revokedAt"> & { pending: boolean }) | null>;
  /** The first secret is stored: the hook starts resolving. Whether this call did it. */
  activate(hookId: string): Promise<boolean>;
  /** The revoked row, or null if there was no live hook by that id. Pending hooks are revoked too. */
  revoke(hookId: string): Promise<Omit<HookRow, "createdAt" | "revokedAt"> | null>;
  /** One agent's hooks, newest first, revoked ones included. */
  list(tenantId: string, agentId: string): Promise<HookRow[]>;
  /** Record a grant to write one secret version. Only its hash is kept. */
  grant(row: { grantHash: string; hookId: string; version: number; nonce: string; expiresAt: number }): Promise<void>;
  /**
   * Use a grant: one statement, so it succeeds once. Null unless the grant is
   * for this hook, version and nonce, unused, and unexpired.
   */
  useGrant(grantHash: string, hookId: string, version: number, nonce: string): Promise<{ version: number } | null>;
  /** What happened to the write a used grant allowed. */
  finishGrant(grantHash: string, outcome: string): Promise<void>;
  /** A grant's state, for the service to read back. Null if there is no such grant for this hook. */
  grantState(grantHash: string, hookId: string): Promise<GrantState | null>;
}

export interface GrantState {
  state: "unused" | "expired" | "stored" | "failed" | "in_progress";
  version: number;
  expiresAt: number;
  usedAt: number | null;
  /** Why a used grant's write failed; null otherwise. */
  reason: string | null;
}

export function d1InboundHooks(db: D1Database, now: () => number = Date.now): HookDirectory {
  const row = (r: any) => ({ hookId: String(r.hook_id), tenantId: String(r.tenant_id), agentId: String(r.agent_id), alias: String(r.alias) });
  return {
    async create(r, opts) {
      const at = now();
      await db.prepare("INSERT INTO inbound_hooks(hook_id, tenant_id, agent_id, alias, created_at, activated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(r.hookId, r.tenantId, r.agentId, r.alias, at, opts?.pending ? null : at).run();
    },
    async lookup(hookId) {
      const r: any = await db.prepare(
        "SELECT hook_id, tenant_id, agent_id, alias FROM inbound_hooks WHERE hook_id = ? AND revoked_at IS NULL AND activated_at IS NOT NULL",
      ).bind(hookId).first();
      return r ? row(r) : null;
    },
    async lookupLive(hookId) {
      const r: any = await db.prepare(
        "SELECT hook_id, tenant_id, agent_id, alias, activated_at FROM inbound_hooks WHERE hook_id = ? AND revoked_at IS NULL",
      ).bind(hookId).first();
      return r ? { ...row(r), pending: r.activated_at === null } : null;
    },
    async activate(hookId) {
      const res = await db.prepare(
        "UPDATE inbound_hooks SET activated_at = ? WHERE hook_id = ? AND revoked_at IS NULL AND activated_at IS NULL",
      ).bind(now(), hookId).run();
      return (res.meta?.changes ?? 0) === 1;
    },
    async revoke(hookId) {
      // One statement, so two revokes at once cannot both report the row.
      const r: any = await db.prepare(
        "UPDATE inbound_hooks SET revoked_at = ? WHERE hook_id = ? AND revoked_at IS NULL RETURNING hook_id, tenant_id, agent_id, alias",
      ).bind(now(), hookId).first();
      return r ? row(r) : null;
    },
    async list(tenantId, agentId) {
      const { results } = await db.prepare(
        "SELECT * FROM inbound_hooks WHERE tenant_id = ? AND agent_id = ? ORDER BY created_at DESC, hook_id",
      ).bind(tenantId, agentId).all();
      return (results as any[]).map((r) => ({
        ...row(r), createdAt: Number(r.created_at), revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
        pending: r.activated_at === null,
      }));
    },
    async grant(r) {
      await db.prepare("INSERT INTO hook_grants(grant_hash, hook_id, version, nonce, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(r.grantHash, r.hookId, r.version, r.nonce, now(), r.expiresAt).run();
    },
    async useGrant(grantHash, hookId, version, nonce) {
      const t = now();
      const r: any = await db.prepare(
        "UPDATE hook_grants SET used_at = ? WHERE grant_hash = ? AND hook_id = ? AND version = ? AND nonce = ? " +
        "AND used_at IS NULL AND expires_at > ? RETURNING version",
      ).bind(t, grantHash, hookId, version, nonce, t).first();
      return r ? { version: Number(r.version) } : null;
    },
    async finishGrant(grantHash, outcome) {
      await db.prepare("UPDATE hook_grants SET outcome = ? WHERE grant_hash = ? AND used_at IS NOT NULL AND outcome IS NULL")
        .bind(outcome.slice(0, 300), grantHash).run();
    },
    async grantState(grantHash, hookId) {
      const r: any = await db.prepare(
        "SELECT version, expires_at, used_at, outcome FROM hook_grants WHERE grant_hash = ? AND hook_id = ?",
      ).bind(grantHash, hookId).first();
      if (!r) return null;
      const usedAt = r.used_at === null ? null : Number(r.used_at);
      const outcome = r.outcome === null ? null : String(r.outcome);
      const state: GrantState["state"] = usedAt === null
        ? (Number(r.expires_at) > now() ? "unused" : "expired")
        : outcome === null ? "in_progress" : outcome === "stored" ? "stored" : "failed";
      return { state, version: Number(r.version), expiresAt: Number(r.expires_at), usedAt,
        reason: state === "failed" ? outcome : null };
    },
  };
}
