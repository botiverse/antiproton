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

import { isAgentProfile, type AgentProfile } from "../../src/runtime/agent-profile.ts";

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
  /**
   * The offered option's id the creating POST asked for, null when it asked for none (and on rows from before 0019).
   * What a replay is compared with; what runs is model_choices, which a PUT …/model changes and this never does.
   * Optional so a row built elsewhere without it (a test's, a fake registry's) reads as none asked.
   */
  model?: string | null;
  /**
   * The create named a model and its pick is not stored yet. Only then may a replay still change `model` (a create
   * that died half-way, retried under a lock or after an option was withdrawn), and only then does it store the pick.
   */
  modelPending?: boolean;
  /**
   * The create asked the agent to start no turn before its workspace import (0020). What a replay is compared with;
   * the hold itself is the agent's object's (src/store/workspace-import.ts). Optional: absent reads as false.
   */
  awaitImport?: boolean;
  /**
   * The daily budget the agent's spend is charged to, from the creating POST (0021): "onboarding" is the platform-paid
   * onboarding pool (cf/src/spend-limit.ts), null the tenant's own. Fixed at creation, compared on a replay, never
   * patched. Optional: absent reads as null.
   */
  budget?: AgentBudget | null;
  /**
   * The agent profile the creating POST asked for (0025, src/runtime/agent-profile.ts), null for today's agent. Fixed
   * at creation and compared on a replay, like `awaitImport`; the agent's object keeps the copy it runs by. Optional:
   * absent reads as null.
   */
  profile?: AgentProfile | null;
  status: ProvisionStatus;
  pushRegistered: boolean;
  pushError: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** The budgets an agent may be created on besides its tenant's own (`budget` on POST /provision/agents). */
export const AGENT_BUDGETS = ["onboarding"] as const;
export type AgentBudget = (typeof AGENT_BUDGETS)[number];

export type ProvisionedAgentPatch = Partial<Pick<ProvisionedAgent, "name" | "instructions" | "credentialHash" | "model" | "modelPending" | "status" | "pushRegistered" | "pushError" | "deletedAt">>;

export interface ProvisionRegistry {
  /** A new row. Throws when the Raft id, or the agent id, is already taken in this tenant. */
  create(row: Omit<ProvisionedAgent, "createdAt" | "updatedAt" | "deletedAt">): Promise<void>;
  get(tenantId: string, raftAgentId: string): Promise<ProvisionedAgent | null>;
  getByAgentId(tenantId: string, agentId: string): Promise<ProvisionedAgent | null>;
  /** Whether a row was changed. `updated_at` moves with every change. */
  update(tenantId: string, raftAgentId: string, patch: ProvisionedAgentPatch): Promise<boolean>;
  /**
   * Whether any agent of the tenant was provisioned for this Raft server: how a route addressed by server learns that a
   * tenant-scoped token (which names no server) is that server's. Optional: a registry without it proves nothing.
   */
  hasServer?(tenantId: string, raftServerId: string): Promise<boolean>;
}

export function d1ProvisionedAgents(db: D1Database, now: () => number = Date.now): ProvisionRegistry {
  const row = (r: any): ProvisionedAgent => ({
    tenantId: String(r.tenant_id), raftAgentId: String(r.raft_agent_id), agentId: String(r.agent_id),
    raftServerId: String(r.raft_server_id), raftOrigin: String(r.raft_origin),
    name: String(r.name), instructions: String(r.instructions),
    credentialHash: r.credential_hash === null || r.credential_hash === undefined ? null : String(r.credential_hash),
    model: r.model === null || r.model === undefined ? null : String(r.model),
    modelPending: Number(r.model_pending ?? 0) === 1,
    awaitImport: Number(r.await_import ?? 0) === 1,
    budget: r.budget === AGENT_BUDGETS[0] ? AGENT_BUDGETS[0] : null,
    profile: isAgentProfile(r.profile) ? r.profile : null,
    status: String(r.status) as ProvisionStatus,
    pushRegistered: Number(r.push_registered) === 1, pushError: r.push_error === null ? null : String(r.push_error),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
  });
  // The column a patch key writes. Listed, so a key this table does not have is a failed lookup, not SQL.
  const COLUMNS: Record<keyof ProvisionedAgentPatch, string> = {
    name: "name", instructions: "instructions", credentialHash: "credential_hash", model: "model", modelPending: "model_pending", status: "status",
    pushRegistered: "push_registered", pushError: "push_error", deletedAt: "deleted_at",
  };
  return {
    async create(r) {
      const t = now();
      await db.prepare(
        "INSERT INTO provisioned_agents(tenant_id, raft_agent_id, agent_id, raft_server_id, raft_origin, name, instructions, credential_hash, model, model_pending, await_import, budget, profile, status, push_registered, push_error, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(r.tenantId, r.raftAgentId, r.agentId, r.raftServerId, r.raftOrigin, r.name, r.instructions, r.credentialHash, r.model ?? null, r.modelPending ? 1 : 0, r.awaitImport ? 1 : 0, r.budget ?? null, r.profile ?? null, r.status,
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
    async hasServer(tenantId, raftServerId) {
      return (await db.prepare("SELECT 1 AS one FROM provisioned_agents WHERE tenant_id = ? AND raft_server_id = ? LIMIT 1").bind(tenantId, raftServerId).first()) !== null;
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
      // Deleted is final: a write that sets any other status (a push registration, a credential PUT or a create's
      // replay that read the row before a delete landed) changes nothing on a deleted row, rather than reviving it with
      // its deleted_at still set.
      const final = patch.status !== undefined && patch.status !== "deleted" ? " AND status != 'deleted'" : "";
      const res = await db.prepare(`UPDATE provisioned_agents SET ${sets.join(", ")} WHERE tenant_id = ? AND raft_agent_id = ?${final}`)
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
  /** GitHub refused this connection's renewal (0023); only for one with no connector, whose state is the connector's. Writing the row clears it. */
  brokenAt?: number | null;
  brokenReason?: string | null;
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
        "SELECT account, connected_by, connected_at, connector_id, broken_at, broken_reason FROM provisioned_connections WHERE tenant_id = ? AND raft_agent_id = ? AND provider = ?",
      ).bind(tenantId, raftAgentId, provider).first<any>();
      if (!r) return null;
      return {
        tenantId, raftAgentId, provider, account: r.account === null ? null : String(r.account), connectedBy: String(r.connected_by),
        connectedAt: Number(r.connected_at), connectorId: r.connector_id === null || r.connector_id === undefined ? null : String(r.connector_id),
        brokenAt: r.broken_at == null ? null : Number(r.broken_at), brokenReason: r.broken_reason == null ? null : String(r.broken_reason),
      };
    },
    async put(c) {
      await db.prepare(
        `INSERT INTO provisioned_connections (tenant_id, raft_agent_id, provider, account, connected_by, connected_at, connector_id) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, raft_agent_id, provider) DO UPDATE SET account = excluded.account, connected_by = excluded.connected_by,
           connected_at = excluded.connected_at, connector_id = excluded.connector_id, broken_at = NULL, broken_reason = NULL`,
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
  /** GitHub's numeric user id for `account`, which a rename does not change (0024); null on a connector from before. */
  accountId?: string | null;
  creatorRaftUserId: string;
  /** The access token, sealed. Rotated in place when an expiring one is refreshed (0023). */
  sealed: { ciphertext: string; iv: string };
  createdAt: number;
  /** The refresh token, sealed, with both expiries; absent or null for a token that does not expire (0023). */
  refresh?: ConnectorRefresh | null;
  /** Set when GitHub refused the renewal: the connection needs its person to connect again (0023). */
  brokenAt?: number | null;
  brokenReason?: string | null;
  /** When it was last checked, whatever came of it (0023); null on a row from before. */
  lastCheckedAt?: number | null;
}

/** What renews a connector's access token. Times are ms since the epoch. */
export interface ConnectorRefresh {
  sealed: { ciphertext: string; iv: string };
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

export interface ConnectorEvent {
  tenantId: string; connectorId: string; raftAgentId: string | null;
  action: "create" | "bind" | "unbind" | "disconnect" | "broken" | "reconnect";
  /** `system` for what the deployment records itself (`broken`), with SYSTEM_ACTOR as the user. */
  actingRaftUserId: string; actingRole: "creator" | "admin" | "system"; at: number;
  /** Why, for `broken`: GitHub's error, never a token. */
  reason?: string | null;
}

/** Who a `system` connector event names: no Raft user did it. */
export const SYSTEM_ACTOR = "antiproton";

export interface ConnectorStore {
  create(c: Connector): Promise<void>;
  /** Only within the tenant: an id from another tenant is not found. */
  get(tenantId: string, id: string): Promise<Connector | null>;
  list(tenantId: string, provider: string): Promise<Connector[]>;
  remove(tenantId: string, id: string): Promise<boolean>;
  record(e: ConnectorEvent): Promise<void>;
  /** Its credential was checked and taken (pointing an agent at it): the time Raft shows as `lastCheckedAt`. */
  checked?(tenantId: string, id: string, at: number): Promise<void>;
  /**
   * A reconnect in place: the new pair over whatever the connector holds, in one write that also clears its broken
   * state and any renewal's lease, and records the account's id when it had none. Only while the connector still acts
   * as `accountId`, or has no id yet and its login is `account` (a connector from before 0024): false when it is gone
   * or another account's, and then nothing was written.
   */
  reconnect(tenantId: string, id: string, next: ConnectorReconnect): Promise<boolean>;
}

/** What a reconnect in place writes. */
export interface ConnectorReconnect {
  sealed: { ciphertext: string; iv: string };
  refresh: ConnectorRefresh | null;
  account: string | null;
  accountId: string;
  at: number;
}

export function d1Connectors(db: D1Database): ConnectorStore {
  const row = connectorRow;
  return {
    async create(c) {
      const f = c.refresh ?? null;
      await db.prepare(
        `INSERT INTO connectors (id, tenant_id, provider, account, creator_raft_user_id, ciphertext, iv, created_at,
           refresh_ciphertext, refresh_iv, expires_at, refresh_expires_at, refreshed_at, last_checked_at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(c.id, c.tenantId, c.provider, c.account, c.creatorRaftUserId, c.sealed.ciphertext, c.sealed.iv, c.createdAt,
        f?.sealed.ciphertext ?? null, f?.sealed.iv ?? null, f?.expiresAt ?? null, f?.refreshExpiresAt ?? null, f ? c.createdAt : null,
        // Made from a confirm, whose attach has just checked the credential with GitHub.
        c.createdAt, c.accountId ?? null).run();
    },
    async reconnect(tenantId, id, next) {
      const f = next.refresh;
      // The lease is cleared whoever holds it: a renewal still in flight traded the old refresh token, and its write
      // (`rotate`, which expects that token) and its refusal (`markBroken`, likewise) no longer match, so neither can
      // put the old chain back over this pair or mark it broken.
      const r = await db.prepare(
        `UPDATE connectors SET ciphertext = ?, iv = ?, refresh_ciphertext = ?, refresh_iv = ?, expires_at = ?, refresh_expires_at = ?,
           refreshed_at = ?, last_checked_at = ?, broken_at = NULL, broken_reason = NULL, refreshing_until = NULL, refreshing_by = NULL,
           account = ?, account_id = ?
         WHERE tenant_id = ? AND id = ? AND (account_id IS NULL OR account_id = ?)
           -- With no id yet, the login has to match here too: a renamed login can be claimed by someone else.
           AND (account_id IS NOT NULL OR lower(account) = lower(?))`,
      ).bind(next.sealed.ciphertext, next.sealed.iv, f?.sealed.ciphertext ?? null, f?.sealed.iv ?? null, f?.expiresAt ?? null, f?.refreshExpiresAt ?? null,
        f ? next.at : null, next.at, next.account, next.accountId, tenantId, id, next.accountId, next.account).run();
      return Number(r.meta?.changes ?? 0) > 0;
    },
    async checked(tenantId, id, at) {
      await db.prepare("UPDATE connectors SET last_checked_at = ? WHERE tenant_id = ? AND id = ?").bind(at, tenantId, id).run();
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
        "INSERT INTO connector_events (tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(e.tenantId, e.connectorId, e.raftAgentId, e.action, e.actingRaftUserId, e.actingRole, e.at, e.reason ?? null).run();
    },
  };
}

function connectorRow(r: any): Connector {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r.id), tenantId: String(r.tenant_id), provider: String(r.provider), account: r.account === null ? null : String(r.account),
    accountId: r.account_id == null ? null : String(r.account_id),
    creatorRaftUserId: String(r.creator_raft_user_id), sealed: { ciphertext: String(r.ciphertext), iv: String(r.iv) }, createdAt: Number(r.created_at),
    refresh: r.refresh_ciphertext == null ? null
      : { sealed: { ciphertext: String(r.refresh_ciphertext), iv: String(r.refresh_iv) }, expiresAt: n(r.expires_at), refreshExpiresAt: n(r.refresh_expires_at) },
    brokenAt: n(r.broken_at), brokenReason: r.broken_reason == null ? null : String(r.broken_reason),
    lastCheckedAt: n(r.last_checked_at),
  };
}

/** A connector as its refresh reads it: the stored pair, and who may trade it and until when. */
export interface ConnectorGrant extends Connector {
  refreshedAt: number | null;
  refreshingUntil: number | null;
}

/**
 * Renewing connectors' expiring tokens (0023), from the agents' objects. Every write
 * names what it expects to replace, so two refreshes racing on one connector cannot both land: the refresh
 * token is single-use, and GitHub spends the old access token with it.
 */
export interface ConnectorGrants {
  grant(tenantId: string, id: string): Promise<ConnectorGrant | null>;
  /** Take the right to trade the refresh token until `until`, as `holder`; false while someone else holds it. */
  lease(tenantId: string, id: string, now: number, until: number, holder: string): Promise<boolean>;
  /** Give it back; only `holder`'s own lease is released. */
  release(tenantId: string, id: string, holder: string): Promise<void>;
  /** The new pair, only over the refresh token it was traded from (`expect`); clears any broken state, and `holder`'s lease. */
  rotate(tenantId: string, id: string, next: { sealed: { ciphertext: string; iv: string }; refresh: ConnectorRefresh; at: number }, expect: string, holder: string): Promise<boolean>;
  /**
   * Record that only a reconnect mends it, with a `broken` event, releasing `holder`'s lease. Only while the connector
   * still holds `spent` (the refresh token GitHub refused, sealed; null: whatever it holds), like `rotate`. False when
   * it was already broken, or holds another pair now.
   */
  markBroken(tenantId: string, id: string, reason: string, at: number, holder: string | null, spent: string | null): Promise<boolean>;
  /**
   * Record GitHub's numeric user id on a connector from before 0024: only while it has none, and only while its login is
   * `login`. False when either no longer holds, and then nothing was written.
   */
  fillAccountId(tenantId: string, id: string, accountId: string, login: string): Promise<boolean>;
  /** The same, for an agent's connection that has no connector. */
  markAgentBroken(tenantId: string, agentId: string, provider: string, reason: string, at: number): Promise<boolean>;
}

export function d1ConnectorGrants(db: D1Database): ConnectorGrants {
  return {
    async grant(tenantId, id) {
      const r = await db.prepare("SELECT * FROM connectors WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first<any>();
      if (!r) return null;
      return { ...connectorRow(r), refreshedAt: r.refreshed_at == null ? null : Number(r.refreshed_at), refreshingUntil: r.refreshing_until == null ? null : Number(r.refreshing_until) };
    },
    async lease(tenantId, id, now, until, holder) {
      const r = await db.prepare(
        "UPDATE connectors SET refreshing_until = ?, refreshing_by = ? WHERE tenant_id = ? AND id = ? AND (refreshing_until IS NULL OR refreshing_until <= ?)",
      ).bind(until, holder, tenantId, id, now).run();
      return Number(r.meta?.changes ?? 0) > 0;
    },
    async release(tenantId, id, holder) {
      await db.prepare("UPDATE connectors SET refreshing_until = NULL, refreshing_by = NULL WHERE tenant_id = ? AND id = ? AND refreshing_by = ?")
        .bind(tenantId, id, holder).run();
    },
    async rotate(tenantId, id, next, expect, holder) {
      const r = await db.prepare(
        `UPDATE connectors SET ciphertext = ?, iv = ?, refresh_ciphertext = ?, refresh_iv = ?, expires_at = ?, refresh_expires_at = ?,
           refreshed_at = ?, last_checked_at = ?, broken_at = NULL, broken_reason = NULL,
           refreshing_until = CASE WHEN refreshing_by = ? THEN NULL ELSE refreshing_until END,
           refreshing_by = CASE WHEN refreshing_by = ? THEN NULL ELSE refreshing_by END
         WHERE tenant_id = ? AND id = ? AND refresh_ciphertext = ?`,
      ).bind(next.sealed.ciphertext, next.sealed.iv, next.refresh.sealed.ciphertext, next.refresh.sealed.iv, next.refresh.expiresAt,
        next.refresh.refreshExpiresAt, next.at, next.at, holder, holder, tenantId, id, expect).run();
      return Number(r.meta?.changes ?? 0) > 0;
    },
    async markBroken(tenantId, id, reason, at, holder, spent) {
      const r = await db.prepare(
        `UPDATE connectors SET broken_at = ?, broken_reason = ?, last_checked_at = ?,
           refreshing_until = CASE WHEN refreshing_by = ? THEN NULL ELSE refreshing_until END,
           refreshing_by = CASE WHEN refreshing_by = ? THEN NULL ELSE refreshing_by END
         WHERE tenant_id = ? AND id = ? AND broken_at IS NULL AND (? IS NULL OR refresh_ciphertext = ?)`,
      ).bind(at, reason, at, holder, holder, tenantId, id, spent, spent).run();
      const changed = Number(r.meta?.changes ?? 0) > 0;
      if (changed) {
        await db.prepare(
          "INSERT INTO connector_events (tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason) VALUES (?, ?, NULL, 'broken', ?, 'system', ?, ?)",
        ).bind(tenantId, id, SYSTEM_ACTOR, at, reason).run();
      }
      return changed;
    },
    async fillAccountId(tenantId, id, accountId, login) {
      const r = await db.prepare("UPDATE connectors SET account_id = ? WHERE tenant_id = ? AND id = ? AND account_id IS NULL AND lower(account) = lower(?)")
        .bind(accountId, tenantId, id, login).run();
      return Number(r.meta?.changes ?? 0) > 0;
    },
    async markAgentBroken(tenantId, agentId, provider, reason, at) {
      const r = await db.prepare(
        `UPDATE provisioned_connections SET broken_at = ?, broken_reason = ?
         WHERE tenant_id = ? AND provider = ? AND broken_at IS NULL
           AND raft_agent_id IN (SELECT raft_agent_id FROM provisioned_agents WHERE tenant_id = ? AND agent_id = ?)`,
      ).bind(at, reason, tenantId, provider, tenantId, agentId).run();
      return Number(r.meta?.changes ?? 0) > 0;
    },
  };
}

/**
 * One model choice (0013_model_overrides.sql, 0014_model_override_provider.sql); `tenantId` and `agentId` are ""
 * for a wider scope. `provider` null is a row written before providers existed: the default provider.
 */
export interface ModelOverride { tenantId: string; agentId: string; provider: string | null; model: string; setBy: string; setAt: number }

/**
 * The admin's rows, written and listed. Nothing here says which row decides an agent: that is d1ModelChoices.layers
 * read through resolveModel (cf/src/model-request.ts), the one place the order between scopes and the owner's pick
 * is kept, so a second rule cannot drift from it.
 */
export interface ModelOverrides {
  list(): Promise<ModelOverride[]>;
  put(o: ModelOverride): Promise<void>;
  remove(tenantId: string, agentId: string): Promise<boolean>;
}

export function d1ModelOverrides(db: D1Database): ModelOverrides {
  const providerOf = (x: any) => (x.provider === null || x.provider === undefined ? null : String(x.provider));
  return {
    async list() {
      const r = await db.prepare("SELECT * FROM model_overrides ORDER BY tenant_id, agent_id").all<any>();
      return (r.results ?? []).map((x) => ({ tenantId: String(x.tenant_id), agentId: String(x.agent_id), provider: providerOf(x), model: String(x.model), setBy: String(x.set_by), setAt: Number(x.set_at) }));
    },
    async put(o) {
      await db.prepare(
        `INSERT INTO model_overrides (tenant_id, agent_id, provider, model, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, set_by = excluded.set_by, set_at = excluded.set_at`,
      ).bind(o.tenantId, o.agentId, o.provider, o.model, o.setBy, o.setAt).run();
    },
    async remove(tenantId, agentId) {
      const r = await db.prepare("DELETE FROM model_overrides WHERE tenant_id = ? AND agent_id = ?").bind(tenantId, agentId).run();
      return (r.meta?.changes ?? 0) > 0;
    },
  };
}

/** An owner's pick for one agent (0015_model_choices.sql): the id of a USER_MODELS option. */
export interface ModelChoiceRow { tenantId: string; agentId: string; choiceId: string; setBy: string; setAt: number }

/**
 * Everything that may decide an agent's operator model, each scope separately, so the order between the admin's rows
 * and the owner's pick is decided in one place (cf/src/model-request.ts resolveModel) rather than in SQL.
 */
export interface ModelLayers {
  agent: { provider: string | null; model: string } | null;
  tenant: { provider: string | null; model: string } | null;
  deployment: { provider: string | null; model: string } | null;
  /** The owner's option id, as stored: whether it is still offered is the resolver's question. */
  owner: string | null;
}

export interface ModelChoices {
  layers(tenantId: string, agentId: string): Promise<ModelLayers>;
  put(c: ModelChoiceRow): Promise<void>;
  remove(tenantId: string, agentId: string): Promise<boolean>;
}

export function d1ModelChoices(db: D1Database): ModelChoices {
  const chosen = (x: any) => ({ provider: x.provider === null || x.provider === undefined ? null : String(x.provider), model: String(x.model) });
  return {
    async layers(tenantId, agentId) {
      // One statement, so a run that binds reads the model once, as it did before owners could choose
      // (test/hook-fast-ack.ts counts those reads). `model_overrides` is named within the first 80 characters,
      // which is what that count matches on.
      const r = await db.prepare(
        `SELECT tenant_id, agent_id, provider, model, 0 AS owner FROM model_overrides
          WHERE (tenant_id = ?1 AND agent_id = ?2) OR (tenant_id = ?1 AND agent_id = '') OR (tenant_id = '' AND agent_id = '')
         UNION ALL
         SELECT tenant_id, agent_id, NULL, choice_id, 1 FROM model_choices WHERE tenant_id = ?1 AND agent_id = ?2`,
      ).bind(tenantId, agentId).all<any>();
      const out: ModelLayers = { agent: null, tenant: null, deployment: null, owner: null };
      for (const x of r.results ?? []) {
        if (Number(x.owner) === 1) out.owner = String(x.model);
        else if (x.agent_id !== "") out.agent = chosen(x);
        else if (x.tenant_id !== "") out.tenant = chosen(x);
        else out.deployment = chosen(x);
      }
      return out;
    },
    async put(c) {
      await db.prepare(
        `INSERT INTO model_choices (tenant_id, agent_id, choice_id, set_by, set_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET choice_id = excluded.choice_id, set_by = excluded.set_by, set_at = excluded.set_at`,
      ).bind(c.tenantId, c.agentId, c.choiceId, c.setBy, c.setAt).run();
    },
    async remove(tenantId, agentId) {
      const r = await db.prepare("DELETE FROM model_choices WHERE tenant_id = ? AND agent_id = ?").bind(tenantId, agentId).run();
      return (r.meta?.changes ?? 0) > 0;
    },
  };
}

/**
 * Whether a tenant (a Raft server) may pick a model other than the default through the provider routes (0022). Off
 * unless Raft has said otherwise: the deployment decides, and an operator's rows decide per tenant or agent.
 */
export interface TenantModelPicker {
  enabled(tenantId: string): Promise<boolean>;
  set(tenantId: string, enabled: boolean, setBy: string, at: number): Promise<void>;
}

export function d1TenantModelPicker(db: D1Database): TenantModelPicker {
  return {
    async enabled(tenantId) {
      const r = await db.prepare("SELECT enabled FROM tenant_model_picker WHERE tenant_id = ?").bind(tenantId).first<any>();
      // Only an explicit 1 is on: no row, or anything else, is the default (off).
      return Number(r?.enabled) === 1;
    },
    async set(tenantId, enabled, setBy, at) {
      await db.prepare(
        `INSERT INTO tenant_model_picker (tenant_id, enabled, set_by, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET enabled = excluded.enabled, set_by = excluded.set_by, set_at = excluded.set_at`,
      ).bind(tenantId, enabled ? 1 : 0, setBy, at).run();
    },
  };
}
