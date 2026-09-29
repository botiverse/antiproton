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
 * Schema: cf/migrations/0001_identities.sql, 0002_api_keys.sql and 0007_service_tokens.sql, applied by cf/scripts/deploy.sh
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

/**
 * A service token as the operator lists it (task #7). The hash names the row and cannot be presented
 * as a token (keys.ts hashApiKey is one-way over 32 random bytes), so a listing may carry it.
 */
export interface ServiceTokenRow {
  hash: string;
  label: string;
  tenantId: string;
  agentId: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

/** What presenting a live token resolves to: the identity the operator gave it. */
export interface ServiceTokenIdentity {
  label: string;
  tenantId: string;
  agentId: string;
}

export interface ServiceTokenDirectory {
  issue(row: ServiceTokenIdentity & { hash: string }): Promise<void>;
  /** A token resolves only while it is not revoked. */
  lookup(hash: string): Promise<ServiceTokenIdentity | null>;
  /** Whether a live token was revoked by this call: a second revoke is false. */
  revoke(hash: string): Promise<boolean>;
  /** Every token, newest first, revoked ones included so the list says when. */
  list(): Promise<ServiceTokenRow[]>;
  /**
   * Record a use. A token is presented on every request it makes, so this writes only when the
   * last record is older than an hour: the column answers "is anyone still using this", which does
   * not need the minute.
   */
  touch(hash: string): Promise<void>;
}

const HOUR_MS = 3600_000;

export function d1ServiceTokens(db: D1Database, now: () => number = Date.now): ServiceTokenDirectory {
  const identity = (r: any): ServiceTokenIdentity => ({ label: String(r.label), tenantId: String(r.tenant_id), agentId: String(r.agent_id) });
  return {
    async issue(row) {
      await db.prepare("INSERT INTO service_tokens(hash, label, tenant_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(row.hash, row.label, row.tenantId, row.agentId, now()).run();
    },
    async lookup(hash) {
      const r: any = await db.prepare("SELECT label, tenant_id, agent_id FROM service_tokens WHERE hash = ? AND revoked_at IS NULL")
        .bind(hash).first();
      return r ? identity(r) : null;
    },
    async revoke(hash) {
      const res = await db.prepare("UPDATE service_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL")
        .bind(now(), hash).run();
      return Number(res.meta?.changes ?? 0) > 0;
    },
    async list() {
      const { results } = await db.prepare("SELECT * FROM service_tokens ORDER BY created_at DESC, hash").all();
      return (results as any[]).map((r) => ({
        ...identity(r), hash: String(r.hash), createdAt: Number(r.created_at),
        revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
        lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
      }));
    },
    async touch(hash) {
      const t = now();
      await db.prepare("UPDATE service_tokens SET last_used_at = ? WHERE hash = ? AND (last_used_at IS NULL OR last_used_at < ?)")
        .bind(t, hash, t - HOUR_MS).run();
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
  create(row: { hookId: string; tenantId: string; agentId: string; alias: string }): Promise<void>;
  /** A hook resolves only while it is not revoked. */
  lookup(hookId: string): Promise<Omit<HookRow, "createdAt" | "revokedAt"> | null>;
  /** The revoked row, or null if there was no live hook by that id. */
  revoke(hookId: string): Promise<Omit<HookRow, "createdAt" | "revokedAt"> | null>;
  /** One agent's hooks, newest first, revoked ones included. */
  list(tenantId: string, agentId: string): Promise<HookRow[]>;
}

export function d1InboundHooks(db: D1Database, now: () => number = Date.now): HookDirectory {
  const row = (r: any) => ({ hookId: String(r.hook_id), tenantId: String(r.tenant_id), agentId: String(r.agent_id), alias: String(r.alias) });
  return {
    async create(r) {
      await db.prepare("INSERT INTO inbound_hooks(hook_id, tenant_id, agent_id, alias, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(r.hookId, r.tenantId, r.agentId, r.alias, now()).run();
    },
    async lookup(hookId) {
      const r: any = await db.prepare(
        "SELECT hook_id, tenant_id, agent_id, alias FROM inbound_hooks WHERE hook_id = ? AND revoked_at IS NULL",
      ).bind(hookId).first();
      return r ? row(r) : null;
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
      }));
    },
  };
}

// ---- provisioning (raft-agent-provider.v1): a Raft server's token, and the agents it made.

/**
 * What a provider token stands for, and the one Raft origin its mounts may point at. A tenant-scoped
 * token IS one tenant; a platform-scoped one stands for a whole Raft deployment, and the tenant of each
 * request is derived from the Raft server it names (cf/src/provision/handlers.ts tenantFor).
 */
export type ProviderTokenIdentity =
  | { label: string; raftOrigin: string; scope: "tenant"; tenantId: string }
  | { label: string; raftOrigin: string; scope: "platform" };

export interface ProviderTokenDirectory {
  issue(row: ProviderTokenIdentity & { hash: string }): Promise<void>;
  /** A token resolves only while it is not revoked. */
  lookup(hash: string): Promise<ProviderTokenIdentity | null>;
  /** Whether a live token was revoked by this call. */
  revoke(hash: string): Promise<boolean>;
  list(): Promise<Array<ProviderTokenIdentity & { hash: string; createdAt: number; revokedAt: number | null; lastUsedAt: number | null }>>;
  /** Remember a use, at most once an hour: enough to see a dead token, cheap enough for every request. */
  touch(hash: string): Promise<void>;
}

export function d1ProviderTokens(db: D1Database, now: () => number = Date.now): ProviderTokenDirectory {
  const identity = (r: any): ProviderTokenIdentity => r.scope === "platform"
    ? { label: String(r.label), raftOrigin: String(r.raft_origin), scope: "platform" }
    : { label: String(r.label), raftOrigin: String(r.raft_origin), scope: "tenant", tenantId: String(r.tenant_id) };
  return {
    async issue(row) {
      await db.prepare("INSERT INTO provider_tokens(hash, label, scope, tenant_id, raft_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(row.hash, row.label, row.scope, row.scope === "tenant" ? row.tenantId : null, row.raftOrigin, now()).run();
    },
    async lookup(hash) {
      const r: any = await db.prepare("SELECT label, scope, tenant_id, raft_origin FROM provider_tokens WHERE hash = ? AND revoked_at IS NULL")
        .bind(hash).first();
      return r ? identity(r) : null;
    },
    async revoke(hash) {
      const res = await db.prepare("UPDATE provider_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL")
        .bind(now(), hash).run();
      return Number(res.meta?.changes ?? 0) > 0;
    },
    async list() {
      const { results } = await db.prepare("SELECT * FROM provider_tokens ORDER BY created_at DESC, hash").all();
      return (results as any[]).map((r) => ({
        ...identity(r), hash: String(r.hash), createdAt: Number(r.created_at),
        revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
        lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
      }));
    },
    async touch(hash) {
      const t = now();
      await db.prepare("UPDATE provider_tokens SET last_used_at = ? WHERE hash = ? AND (last_used_at IS NULL OR last_used_at < ?)")
        .bind(t, hash, t - HOUR_MS).run();
    },
  };
}

export type ProvisionStatus = "provisioning" | "active" | "deleted";

/** One Raft agent the provider made, as the registry keeps it. Never the credential. */
export interface ProvisionedAgent {
  tenantId: string;
  raftAgentId: string;
  agentId: string;
  raftServerId: string;
  raftOrigin: string;
  name: string;
  instructions: string;
  /** SHA-256 hex of the credential the agent was last given; null on rows from before it was kept. */
  credentialHash: string | null;
  status: ProvisionStatus;
  pushRegistered: boolean;
  pushError: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type ProvisionedAgentPatch = Partial<Pick<ProvisionedAgent, "name" | "instructions" | "credentialHash" | "status" | "pushRegistered" | "pushError" | "deletedAt">>;

export interface ProvisionRegistry {
  /** A new row. Throws when the Raft id, or the agent id, is already taken in this tenant. */
  create(row: Omit<ProvisionedAgent, "createdAt" | "updatedAt" | "deletedAt">): Promise<void>;
  get(tenantId: string, raftAgentId: string): Promise<ProvisionedAgent | null>;
  getByAgentId(tenantId: string, agentId: string): Promise<ProvisionedAgent | null>;
  /** Whether a row was changed. `updated_at` moves with every change. */
  update(tenantId: string, raftAgentId: string, patch: ProvisionedAgentPatch): Promise<boolean>;
}

export function d1ProvisionedAgents(db: D1Database, now: () => number = Date.now): ProvisionRegistry {
  const row = (r: any): ProvisionedAgent => ({
    tenantId: String(r.tenant_id), raftAgentId: String(r.raft_agent_id), agentId: String(r.agent_id),
    raftServerId: String(r.raft_server_id), raftOrigin: String(r.raft_origin),
    name: String(r.name), instructions: String(r.instructions),
    credentialHash: r.credential_hash === null || r.credential_hash === undefined ? null : String(r.credential_hash),
    status: String(r.status) as ProvisionStatus,
    pushRegistered: Number(r.push_registered) === 1, pushError: r.push_error === null ? null : String(r.push_error),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
  });
  // The column a patch key writes. Listed, so a key this table does not have is a failed lookup, not SQL.
  const COLUMNS: Record<keyof ProvisionedAgentPatch, string> = {
    name: "name", instructions: "instructions", credentialHash: "credential_hash", status: "status",
    pushRegistered: "push_registered", pushError: "push_error", deletedAt: "deleted_at",
  };
  return {
    async create(r) {
      const t = now();
      await db.prepare(
        "INSERT INTO provisioned_agents(tenant_id, raft_agent_id, agent_id, raft_server_id, raft_origin, name, instructions, credential_hash, status, push_registered, push_error, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(r.tenantId, r.raftAgentId, r.agentId, r.raftServerId, r.raftOrigin, r.name, r.instructions, r.credentialHash, r.status,
        r.pushRegistered ? 1 : 0, r.pushError, t, t).run();
    },
    async get(tenantId, raftAgentId) {
      const r = await db.prepare("SELECT * FROM provisioned_agents WHERE tenant_id = ? AND raft_agent_id = ?").bind(tenantId, raftAgentId).first();
      return r ? row(r) : null;
    },
    async getByAgentId(tenantId, agentId) {
      const r = await db.prepare("SELECT * FROM provisioned_agents WHERE tenant_id = ? AND agent_id = ?").bind(tenantId, agentId).first();
      return r ? row(r) : null;
    },
    async update(tenantId, raftAgentId, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const key of Object.keys(patch) as Array<keyof ProvisionedAgentPatch>) {
        const v = patch[key];
        if (v === undefined) continue;
        sets.push(`${COLUMNS[key]} = ?`);
        values.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
      }
      sets.push("updated_at = ?");
      values.push(now());
      const res = await db.prepare(`UPDATE provisioned_agents SET ${sets.join(", ")} WHERE tenant_id = ? AND raft_agent_id = ?`)
        .bind(...values, tenantId, raftAgentId).run();
      return Number(res.meta?.changes ?? 0) > 0;
    },
  };
}


// ---- connections a provisioned agent has to other services (migration 0011) ----------------

/** What Raft may show about a connection: never the credential, which is sealed on the agent's mount. */
export interface ProvisionedConnection {
  tenantId: string;
  raftAgentId: string;
  provider: string;
  account: string | null;
  connectedBy: string;
  connectedAt: number;
  /** The tenant connector it came from (0012); null for one made before connectors. */
  connectorId: string | null;
}

export interface ConnectionRegistry {
  get(tenantId: string, raftAgentId: string, provider: string): Promise<ProvisionedConnection | null>;
  put(c: ProvisionedConnection): Promise<void>;
  remove(tenantId: string, raftAgentId: string, provider: string): Promise<boolean>;
  /** The agents whose connection came from this connector. */
  boundTo(tenantId: string, connectorId: string): Promise<string[]>;
  /** Record a connect link's nonce as used. False when it was used before: a link starts one flow. */
  consumeLink(nonce: string, at: number): Promise<boolean>;
}

export function d1Connections(db: D1Database): ConnectionRegistry {
  return {
    async get(tenantId, raftAgentId, provider) {
      const r = await db.prepare(
        "SELECT account, connected_by, connected_at, connector_id FROM provisioned_connections WHERE tenant_id = ? AND raft_agent_id = ? AND provider = ?",
      ).bind(tenantId, raftAgentId, provider).first<any>();
      if (!r) return null;
      return {
        tenantId, raftAgentId, provider, account: r.account === null ? null : String(r.account), connectedBy: String(r.connected_by),
        connectedAt: Number(r.connected_at), connectorId: r.connector_id === null || r.connector_id === undefined ? null : String(r.connector_id),
      };
    },
    async put(c) {
      await db.prepare(
        `INSERT INTO provisioned_connections (tenant_id, raft_agent_id, provider, account, connected_by, connected_at, connector_id) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, raft_agent_id, provider) DO UPDATE SET account = excluded.account, connected_by = excluded.connected_by,
           connected_at = excluded.connected_at, connector_id = excluded.connector_id`,
      ).bind(c.tenantId, c.raftAgentId, c.provider, c.account, c.connectedBy, c.connectedAt, c.connectorId).run();
    },
    async boundTo(tenantId, connectorId) {
      const r = await db.prepare("SELECT raft_agent_id FROM provisioned_connections WHERE tenant_id = ? AND connector_id = ? ORDER BY raft_agent_id")
        .bind(tenantId, connectorId).all<any>();
      return (r.results ?? []).map((x) => String(x.raft_agent_id));
    },
    async remove(tenantId, raftAgentId, provider) {
      const r = await db.prepare("DELETE FROM provisioned_connections WHERE tenant_id = ? AND raft_agent_id = ? AND provider = ?")
        .bind(tenantId, raftAgentId, provider).run();
      return (r.meta?.changes ?? 0) > 0;
    },
    async consumeLink(nonce, at) {
      // A spent nonce only has to outlive its link (ten minutes); an hour keeps the table small.
      await db.prepare("DELETE FROM connect_links WHERE used_at < ?").bind(at - 3_600_000).run();
      const r = await db.prepare("INSERT INTO connect_links (nonce, used_at) VALUES (?, ?) ON CONFLICT (nonce) DO NOTHING")
        .bind(nonce, at).run();
      return (r.meta?.changes ?? 0) > 0;
    },
  };
}

/** A tenant's connection to a provider (0012_connectors.sql). The sealed credential never leaves the Worker and the agents' objects. */
export interface Connector {
  id: string;
  tenantId: string;
  provider: string;
  account: string | null;
  creatorRaftUserId: string;
  sealed: { ciphertext: string; iv: string };
  createdAt: number;
}

export interface ConnectorEvent {
  tenantId: string; connectorId: string; raftAgentId: string | null;
  action: "create" | "bind" | "unbind" | "disconnect";
  actingRaftUserId: string; actingRole: "creator" | "admin"; at: number;
}

export interface ConnectorStore {
  create(c: Connector): Promise<void>;
  /** Only within the tenant: an id from another tenant is not found. */
  get(tenantId: string, id: string): Promise<Connector | null>;
  list(tenantId: string, provider: string): Promise<Connector[]>;
  remove(tenantId: string, id: string): Promise<boolean>;
  record(e: ConnectorEvent): Promise<void>;
}

export function d1Connectors(db: D1Database): ConnectorStore {
  const row = (r: any): Connector => ({
    id: String(r.id), tenantId: String(r.tenant_id), provider: String(r.provider), account: r.account === null ? null : String(r.account),
    creatorRaftUserId: String(r.creator_raft_user_id), sealed: { ciphertext: String(r.ciphertext), iv: String(r.iv) }, createdAt: Number(r.created_at),
  });
  return {
    async create(c) {
      await db.prepare(
        "INSERT INTO connectors (id, tenant_id, provider, account, creator_raft_user_id, ciphertext, iv, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(c.id, c.tenantId, c.provider, c.account, c.creatorRaftUserId, c.sealed.ciphertext, c.sealed.iv, c.createdAt).run();
    },
    async get(tenantId, id) {
      const r = await db.prepare("SELECT * FROM connectors WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first<any>();
      return r ? row(r) : null;
    },
    async list(tenantId, provider) {
      const r = await db.prepare("SELECT * FROM connectors WHERE tenant_id = ? AND provider = ? ORDER BY created_at, id").bind(tenantId, provider).all<any>();
      return (r.results ?? []).map(row);
    },
    async remove(tenantId, id) {
      const r = await db.prepare("DELETE FROM connectors WHERE tenant_id = ? AND id = ?").bind(tenantId, id).run();
      return (r.meta?.changes ?? 0) > 0;
    },
    async record(e) {
      await db.prepare(
        "INSERT INTO connector_events (tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(e.tenantId, e.connectorId, e.raftAgentId, e.action, e.actingRaftUserId, e.actingRole, e.at).run();
    },
  };
}

/** One model choice (0013_model_overrides.sql); `tenantId` and `agentId` are "" for a wider scope. */
export interface ModelOverride { tenantId: string; agentId: string; model: string; setBy: string; setAt: number }

export interface ModelOverrides {
  /** The most specific choice for this agent: its own, then its tenant's, then the deployment's; null for the env default. */
  effective(tenantId: string, agentId: string): Promise<string | null>;
  list(): Promise<ModelOverride[]>;
  put(o: ModelOverride): Promise<void>;
  remove(tenantId: string, agentId: string): Promise<boolean>;
}

export function d1ModelOverrides(db: D1Database): ModelOverrides {
  return {
    async effective(tenantId, agentId) {
      const r = await db.prepare(
        `SELECT model FROM model_overrides
          WHERE (tenant_id = ?1 AND agent_id = ?2) OR (tenant_id = ?1 AND agent_id = '') OR (tenant_id = '' AND agent_id = '')
          ORDER BY (tenant_id <> '') + (agent_id <> '') DESC LIMIT 1`,
      ).bind(tenantId, agentId).first<any>();
      return r ? String(r.model) : null;
    },
    async list() {
      const r = await db.prepare("SELECT * FROM model_overrides ORDER BY tenant_id, agent_id").all<any>();
      return (r.results ?? []).map((x) => ({ tenantId: String(x.tenant_id), agentId: String(x.agent_id), model: String(x.model), setBy: String(x.set_by), setAt: Number(x.set_at) }));
    },
    async put(o) {
      await db.prepare(
        `INSERT INTO model_overrides (tenant_id, agent_id, model, set_by, set_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET model = excluded.model, set_by = excluded.set_by, set_at = excluded.set_at`,
      ).bind(o.tenantId, o.agentId, o.model, o.setBy, o.setAt).run();
    },
    async remove(tenantId, agentId) {
      const r = await db.prepare("DELETE FROM model_overrides WHERE tenant_id = ? AND agent_id = ?").bind(tenantId, agentId).run();
      return (r.meta?.changes ?? 0) > 0;
    },
  };
}
