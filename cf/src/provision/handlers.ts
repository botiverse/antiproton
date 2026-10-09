/**
 * `/provision/*` — raft-agent-provider.v1 (agreed with Tenny, Raft, 2026-09-28 in #raft-antiproton).
 *
 * Raft creates an external agent, picks antiproton as its runtime, and calls here with the server's
 * provider token. What follows on our side is the five steps a person would do by hand — an agent
 * record, a model binding, a `raft` mount pointing at that Raft, the agent's `sk_agent` credential
 * sealed onto the mount, and push registration — run through the same RPCs and the plugin's own
 * `enable_push` tool, so there is one registration path and one audit trail. Once made, the agent
 * runs on the P1 protocol like any hand-connected one; provisioning only removes the manual setup.
 *
 * The rules that need no Worker live here, over `ProvisionDeps`, so each can go red in
 * test/provision.ts: the shape of a request, idempotency, the token's origin, what a replay is
 * allowed to do, and that the credential is sealed and never echoed. cf/src/index.ts wires the deps
 * to the token directory, the registry (both D1) and the agent's object.
 *
 * Idempotency is strict: `Idempotency-Key` is the Raft agent id, and a replay must carry the same
 * body. Same key with any field different is 409, never a quiet update — Raft edits through PATCH,
 * and a delayed POST retry must not overwrite an edit that landed after it (Tenny's race).
 */
import type { Json } from "../../../src/core/types.ts";
import { originProblem } from "../../../src/plugins/types.ts";
import { secretShape } from "../secret-shape.ts";
import type { ConnectionRegistry, ConnectorStore, ProviderTokenIdentity, ProvisionRegistry, ProvisionedAgent } from "../control-plane.ts";
import { CONNECTION_PROVIDERS, returnUrlProblem, scopesFor, type ConnectionProvider } from "./connect.ts";
import { surface, surfaceReadOf, type SurfaceDeps } from "../agent-surface/surface.ts";
import { logEvent } from "../../../src/core/log.ts";
import { WORKING_SET } from "../../../src/plugins/state.ts";
import { SEED_MODES, seedPathProblem, seedText, type SeedFileMeta, type SeedMode, type SeedSeal, type SeedWriteResult } from "../../../src/store/seed-files.ts";
import type { FreshContextResult, RestartResult } from "../runtime.ts";

export type ProvisionTool = "enable_push" | "disable_push";

/** What the mount says about its push registration, read from its state — not a tool call. */
export interface PushStatus { enabled: boolean; registration: "active" | "uncertain" | null; lastReached: { deliveryId: string; at: string } | null }

/** What the handler asks of the agent's own object. Each is one RPC in cf/src/index.ts. */
export interface ProvisionAgentOps {
  /** Create or update the record (persona), bind the model, make sure the `raft` mount points at `raftOrigin`. */
  adopt(tenantId: string, agentId: string, spec: { name: string; instructions: string; raftOrigin: string }): Promise<void>;
  /** Seal the credential onto the `raft` mount; the plugin checks it against Raft. */
  attachCredential(tenantId: string, agentId: string, credential: string): Promise<{ ok: true; account: string | null } | { ok: false; error: string }>;
  removeCredential(tenantId: string, agentId: string): Promise<boolean>;
  /** Run one of the raft plugin's push tools through the gateway, as the model would. */
  tool(tenantId: string, agentId: string, name: ProvisionTool): Promise<{ ok: true; result: Json } | { ok: false; error: string }>;
  /**
   * The mount's push state, read directly. A GET used to run `push_status` through the gateway, and
   * every Raft poll became a tool.call trace row, a usage row and two Agent Activity events the model
   * never caused.
   */
  pushStatus(tenantId: string, agentId: string): Promise<PushStatus | null>;
}

/**
 * The tenant a request acts in. A tenant-scoped token is one tenant. A platform-scoped token (one key
 * for a whole Raft deployment, tygg 2026-09-28) derives it from the Raft server the request names —
 * the POST body's raftServerId, `?raftServerId=` on every other route — so isolation and billing
 * follow the server while Raft holds a single key. A tenant exists by being named: nothing to create.
 */
export function tenantFor(who: ProviderTokenIdentity, raftServerId: string | null): string | Fail {
  if (who.scope === "tenant") return who.tenantId;
  if (!raftServerId || !RAFT_ID.test(raftServerId)) {
    return { status: 422, code: "missing", message: "a platform token needs the Raft server: raftServerId in the body, or ?raftServerId= on the URL", param: "raftServerId" };
  }
  return `raft_${raftServerId.replace(/[^A-Za-z0-9._-]/g, "_")}`.slice(0, 64);
}

/**
 * No `model` anywhere: a provisioned agent runs on the deployment's default, and Raft shows no
 * selector. If choice comes later it is a new field, not a revived one.
 */
export interface ProvisionDeps {
  now(): number;
  registry: ProvisionRegistry;
  agent: ProvisionAgentOps;
  /** Connecting the agent to other services (connect.ts). Absent: the routes answer 404, as before. */
  connections?: {
    registry: Pick<ConnectionRegistry, "get" | "put" | "remove" | "boundTo">;
    /** The tenant's connectors (0012): each connection is one, shared by the agents pointed at it. */
    connectors: ConnectorStore;
    newId(): string;
    /** Put a connector's sealed credential on the agent's one mount of the provider's plugin. */
    attach(tenantId: string, agentId: string, provider: ConnectionProvider, sealed: { ciphertext: string; iv: string }):
      Promise<{ ok: true; account: string | null } | { ok: false; error: string }>;
    /** The one-time link the browser opens; signed, ten minutes. */
    link(spec: { tenantId: string; agentId: string; raftAgentId: string; provider: ConnectionProvider; returnUrl: string; raftUserId: string; scopes: string[] }):
      Promise<{ url: string; expiresAt: string }>;
    /** Remove it only while the mount still holds this connector's credential, not a key put there since. */
    detachIfFrom(tenantId: string, agentId: string, provider: ConnectionProvider, sealed: { ciphertext: string; iv: string }): Promise<boolean>;
    /** Remove the provider's credential from the agent's mount. */
    detach(tenantId: string, agentId: string, provider: ConnectionProvider): Promise<boolean>;
    /** Make a held connection the mount's credential, for the Raft user it was held for (connect.ts). */
    confirm(tenantId: string, agentId: string, provider: ConnectionProvider, pending: string, raftUserId: string):
      Promise<{ ok: true; account: string | null; sealed: { ciphertext: string; iv: string } } | { ok: false; error: string; missing?: true }>;
  };
  /**
   * An agent's usage and workspace, read through the same core the public API uses
   * (cf/src/agent-surface/). Absent: those routes answer 404.
   */
  surface?: SurfaceDeps;
  /**
   * An evaluation's setup, in the agent's own object (cf/src/index.ts, behind EVAL_SEED_ROUTES). Absent: every
   * route of it answers 404, as on a deployment that never had them.
   */
  seed?: SeedOps;
}

/** What the setup routes ask of the agent's object; each is one RPC (cf/src/index.ts AgentDO). */
export interface SeedOps {
  write(tenantId: string, agentId: string, file: { path: string; mode: SeedMode; text: string }):
    Promise<SeedWriteResult | { ok: false; code: "not_found"; message: string }>;
  seal(tenantId: string, agentId: string, credentialId: string | null): Promise<SeedSeal | null>;
  manifest(tenantId: string, agentId: string): Promise<{ manifest: SeedFileMeta[]; manifestSha256: string; seal: SeedSeal | null } | null>;
  freshContext(tenantId: string, agentId: string): Promise<FreshContextResult>;
  restart(tenantId: string, agentId: string): Promise<RestartResult>;
  modelInput(tenantId: string, agentId: string, session: string | null, call: number | null): Promise<unknown | null>;
  /** The tools the agent's next turn offers the model, read without retaking or writing anything. */
  tools(tenantId: string, agentId: string): Promise<unknown | null>;
}

export const PROVIDER_AGENT_PREFIX = "raft_";
const NAME_MAX = 60;
const INSTRUCTIONS_MAX = 8_000;
const RAFT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** The plugin's own reading of its credential (src/plugins/raft.ts looksLike). */
const RAFT_CREDENTIAL = /^sk_agent_[A-Za-z0-9_-]{16,}$/;

/**
 * The antiproton agent a Raft agent is, from its id alone: deterministic, so a replay lands on the
 * same object without a lookup, and legal for an object name (cf/src/object-name.ts).
 */
export function providerAgentId(raftAgentId: string): string {
  return (PROVIDER_AGENT_PREFIX + raftAgentId.replace(/[^A-Za-z0-9._-]/g, "_")).slice(0, 64);
}

export type Fail = { status: number; code: string; message: string; param?: string };
const fail = (f: Fail) => Response.json({ error: { code: f.code, message: f.message, ...(f.param ? { param: f.param } : {}) } }, { status: f.status, headers: { "cache-control": "no-store" } });
const ok = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const field = (body: unknown, key: string): unknown => (typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined);

/** A text field within bounds, and not a credential someone pasted where a name goes. */
function textField(body: unknown, key: string, max: number, required: boolean): string | undefined | Fail {
  const v = field(body, key);
  if (v === undefined) return required ? { status: 422, code: "missing", message: `${key} is required`, param: key } : undefined;
  if (typeof v !== "string") return { status: 422, code: "invalid", message: `${key} must be a string`, param: key };
  if (required && !v.trim()) return { status: 422, code: "invalid", message: `${key} must not be empty`, param: key };
  if (v.length > max) return { status: 422, code: "invalid", message: `${key} is at most ${max} characters`, param: key };
  const shape = secretShape(v);
  if (shape) return { status: 422, code: "credential_in_text", message: `${key} carries what looks like a ${shape}; credentials go in the credential field only`, param: key };
  return v;
}
const isFail = (v: unknown): v is Fail => typeof v === "object" && v !== null && "status" in v && "code" in v;

/** Hex SHA-256, the same function the API keys and tokens use for what is stored of a secret. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function credentialField(body: unknown): string | Fail {
  const v = field(body, "credential");
  if (typeof v !== "string" || !v) return { status: 422, code: "missing", message: "credential is required", param: "credential" };
  if (!RAFT_CREDENTIAL.test(v)) return { status: 422, code: "invalid", message: "credential is not a Raft agent credential", param: "credential" };
  return v;
}

/** What Raft sees of a row. The credential has no field here to be in. */
function view(row: ProvisionedAgent, live?: Json) {
  return {
    providerAgentId: row.agentId,
    raftAgentId: row.raftAgentId,
    raftServerId: row.raftServerId,
    raftOrigin: row.raftOrigin,
    name: row.name,
    instructions: row.instructions,
    status: row.status,
    push: { registered: row.pushRegistered, ...(row.pushError ? { error: row.pushError } : {}), ...(live !== undefined ? { live } : {}) },
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt).toISOString(),
    /** The services Raft may offer a Connect button for (connections/:provider). */
    connections: [...CONNECTION_PROVIDERS],
  };
}

/**
 * Register push again for an agent that already exists: the operator's repair for a mount whose push
 * record is gone while Raft still points at the old hook. The same tool as at creation, so there is
 * one registration path; the row's `registered` follows the result the same way. Raft need do
 * nothing — the plugin rebuilds the hook and re-registers it with the agent's own credential, and
 * Raft replaces the old URL and secret.
 */
export async function repairPush(
  deps: ProvisionDeps, tenantId: string, raftAgentId: string,
): Promise<{ ok: true; push: ProvisionedAgent["pushRegistered"]; error: string | null } | { ok: false; error: string }> {
  const row = await deps.registry.get(tenantId, raftAgentId);
  if (!row || row.deletedAt !== null) return { ok: false, error: `no live provisioned agent ${raftAgentId} in tenant ${tenantId}` };
  const after = await registerPush(deps, row);
  return { ok: true, push: after.pushRegistered, error: after.pushError };
}

/** Register push through the plugin's own tool and write what happened; the row says `registered` only when it is. */
async function registerPush(deps: ProvisionDeps, row: ProvisionedAgent): Promise<ProvisionedAgent> {
  const push = await deps.agent.tool(row.tenantId, row.agentId, "enable_push");
  const patch = { status: "active" as const, pushRegistered: push.ok, pushError: push.ok ? null : push.error };
  await deps.registry.update(row.tenantId, row.raftAgentId, patch);
  return { ...row, ...patch, updatedAt: deps.now() };
}

export async function handleProvision(
  method: string, path: string,
  headers: { idempotencyKey: string | null; raftServerId: string | null; credentialId?: string | null }, body: unknown,
  who: ProviderTokenIdentity, deps: ProvisionDeps, query: URLSearchParams = new URLSearchParams(),
  /** The body as sent, for the one route whose body is not JSON (`PUT …/seed`). */
  raw: Uint8Array | null = null,
): Promise<Response | null> {
  const seg = path.split("/").filter(Boolean);
  if (seg[0] === "connectors" && seg.length === 2 && method === "DELETE") {
    const tenant = tenantFor(who, headers.raftServerId);
    if (isFail(tenant)) return fail(tenant);
    return disconnect(tenant, seg[1]!, body, deps);
  }
  if (seg[0] !== "agents") return null;
  // On POST the body names the server; elsewhere the URL does.
  const serverForTenant = method === "POST" && seg.length === 1
    ? (typeof field(body, "raftServerId") === "string" ? field(body, "raftServerId") as string : null)
    : headers.raftServerId;
  const tenant = tenantFor(who, serverForTenant);
  if (isFail(tenant)) return fail(tenant);
  const tenantId = tenant;

  if (seg.length === 1 && method === "POST") {
    const raftAgentId = field(body, "raftAgentId");
    if (typeof raftAgentId !== "string" || !RAFT_ID.test(raftAgentId)) {
      return fail({ status: 422, code: "invalid", message: `raftAgentId must match ${RAFT_ID}`, param: "raftAgentId" });
    }
    if (headers.idempotencyKey !== null && headers.idempotencyKey !== raftAgentId) {
      return fail({ status: 422, code: "invalid", message: "Idempotency-Key must be the raftAgentId", param: "Idempotency-Key" });
    }
    const raftServerId = textField(body, "raftServerId", 128, true);
    if (isFail(raftServerId)) return fail(raftServerId);
    const raftOrigin = field(body, "raftOrigin");
    if (typeof raftOrigin !== "string" || originProblem(raftOrigin)) {
      return fail({ status: 422, code: "invalid", message: `raftOrigin ${typeof raftOrigin === "string" ? originProblem(raftOrigin) : "is required"}`, param: "raftOrigin" });
    }
    // The token was minted for one Raft. A mount made under it points there and nowhere else, so a
    // leaked token cannot aim an agent's credential at another address.
    if (raftOrigin !== who.raftOrigin) {
      return fail({ status: 422, code: "origin_mismatch", message: "raftOrigin is not the origin this token was issued for", param: "raftOrigin" });
    }
    const name = textField(body, "name", NAME_MAX, true);
    if (isFail(name)) return fail(name);
    const instructions = textField(body, "instructions", INSTRUCTIONS_MAX, false) ?? "";
    if (isFail(instructions)) return fail(instructions);
    const credential = credentialField(body);
    if (isFail(credential)) return fail(credential);

    const agentId = providerAgentId(raftAgentId);
    const asked = { raftServerId: raftServerId!, raftOrigin, name: name!, instructions };
    const credentialHash = await sha256Hex(credential);
    let row = await deps.registry.get(tenantId, raftAgentId);
    let created = false;
    if (row) {
      if (row.status === "deleted") {
        return fail({ status: 409, code: "deleted", message: "this Raft agent was deleted here; a new agent needs a new id" });
      }
      const differs = (Object.keys(asked) as Array<keyof typeof asked>).filter((k) => row![k] !== asked[k]);
      // The credential is the one field that matters most: a delayed retry with an old one must not
      // overwrite a newer PUT /credential. Compared by hash; a row from
      // before the hash existed accepts the first replay and records it.
      if (row.credentialHash !== null && row.credentialHash !== credentialHash) differs.push("credential" as keyof typeof asked);
      if (differs.length) {
        return fail({ status: 409, code: "idempotency_conflict", message: `a different request was already made under this key (${differs.join(", ")}); edits go through PATCH` });
      }
      if (row.credentialHash === null) { await deps.registry.update(tenantId, raftAgentId, { credentialHash }); row = { ...row, credentialHash }; }
    } else {
      const t = deps.now();
      row = { tenantId, raftAgentId, agentId, ...asked, credentialHash, status: "provisioning", pushRegistered: false, pushError: null, createdAt: t, updatedAt: t, deletedAt: null };
      try { await deps.registry.create(row); }
      catch (e) {
        // Only the unique index says 409 (two Raft ids that sanitise alike). Anything else — D1 away, a
        // migration missing — is a 500 Raft retries, not a permanent conflict.
        const message = typeof e === "object" && e !== null && "message" in e ? String((e as { message?: unknown }).message) : String(e);
        if (!/UNIQUE constraint/i.test(message)) throw e;
        return fail({ status: 409, code: "agent_id_taken", message: `${agentId} already belongs to another Raft agent in this tenant` });
      }
      created = true;
    }
    // From here every step is idempotent, so a replay of a request that died half-way finishes it.
    await deps.agent.adopt(tenantId, agentId, { name: row.name, instructions: row.instructions, raftOrigin: row.raftOrigin });
    const attached = await deps.agent.attachCredential(tenantId, agentId, credential);
    if (!attached.ok) return fail({ status: 422, code: "credential_refused", message: attached.error, param: "credential" });
    row = await registerPush(deps, row);
    return ok(view(row), created ? 201 : 200);
  }

  // An agent is addressed by its providerAgentId, or by the Raft id it was made from
  // (`/agents/by-raft-agent/<raftAgentId>`): a POST whose answer was lost leaves Raft with no
  // providerAgentId, and a delete must still reach the agent it made (Tenny's orphan case).
  const byRaft = seg[1] === "by-raft-agent";
  const rest = byRaft ? seg.slice(2) : seg.slice(1);
  if ((rest.length === 3 || (rest.length === 4 && rest[3] === "confirm")) && rest[1] === "connections") {
    return connection(method, rest, body, tenantId, byRaft, deps);
  }
  // `…/usage`, `…/workspace-files`, `…/workspace-files/read`: the agent's own surface, read through
  // the core the public API uses; only how the agent is found, and the envelope, are this binding's.
  if (EVAL_ROUTES.has(rest.slice(1).join("/"))) {
    if (!deps.seed) return null;
    const found = byRaft ? await deps.registry.get(tenantId, rest[0]!) : await deps.registry.getByAgentId(tenantId, rest[0]!);
    if (!found || found.status === "deleted") {
      return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });
    }
    return evalSetup(method, rest.slice(1).join("/"), tenantId, found.agentId, query, raw, headers.credentialId ?? null, deps.seed);
  }
  const read = method === "GET" && rest.length >= 2 ? surfaceReadOf(rest.slice(1), "provider") : null;
  if (read && deps.surface) {
    const found = byRaft ? await deps.registry.get(tenantId, rest[0]!) : await deps.registry.getByAgentId(tenantId, rest[0]!);
    if (!found || found.status === "deleted") {
      return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });
    }
    const a = await surface(deps.surface, read, tenantId, found.agentId, query);
    if (!a.ok) return fail({ status: a.status, code: a.status === 404 ? "not_found" : a.status === 502 ? "unavailable" : "invalid", message: a.message, ...(a.param ? { param: a.param } : {}) });
    return ok(read === "usage" ? { raftAgentId: found.raftAgentId, providerAgentId: found.agentId, ...a.body } : a.body);
  }
  if (rest.length < 1 || rest.length > 2 || (rest.length === 2 && rest[1] !== "credential")) return null;
  const row = byRaft ? await deps.registry.get(tenantId, rest[0]!) : await deps.registry.getByAgentId(tenantId, rest[0]!);
  const gone = () => fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });

  if (rest.length === 1 && method === "GET") {
    if (!row) return gone();
    if (row.status === "deleted") return ok(view(row));
    const live = await deps.agent.pushStatus(tenantId, row.agentId);
    return ok(view(row, (live ?? { error: "no push state on the mount" }) as unknown as Json));
  }

  if (rest.length === 1 && method === "PATCH") {
    if (!row || row.status === "deleted") return gone();
    const name = textField(body, "name", NAME_MAX, false);
    if (isFail(name)) return fail(name);
    const instructions = textField(body, "instructions", INSTRUCTIONS_MAX, false);
    if (isFail(instructions)) return fail(instructions);
    if (name === undefined && instructions === undefined) {
      return fail({ status: 422, code: "empty", message: "nothing to change: give name or instructions" });
    }
    const patch = { ...(name !== undefined ? { name } : {}), ...(instructions !== undefined ? { instructions } : {}) };
    await deps.registry.update(tenantId, row.raftAgentId, patch);
    const next = { ...row, ...patch, updatedAt: deps.now() };
    await deps.agent.adopt(tenantId, row.agentId, { name: next.name, instructions: next.instructions, raftOrigin: next.raftOrigin });
    return ok(view(next));
  }

  if (rest.length === 2 && method === "PUT") {
    if (!row || row.status === "deleted") return gone();
    const credential = credentialField(body);
    if (isFail(credential)) return fail(credential);
    const attached = await deps.agent.attachCredential(tenantId, row.agentId, credential);
    if (!attached.ok) return fail({ status: 422, code: "credential_refused", message: attached.error, param: "credential" });
    const credentialHash = await sha256Hex(credential);
    await deps.registry.update(tenantId, row.raftAgentId, { credentialHash });
    // A new credential means a new registration on Raft's side; the plugin replaces the hook and re-PUTs.
    return ok(view(await registerPush(deps, { ...row, credentialHash })));
  }

  if (rest.length === 1 && method === "DELETE") {
    if (!row) return gone();
    if (row.status === "deleted") return ok(view(row));
    // Raft revokes the credential itself, so pushes stop even if this fails half-way; what is
    // reported is what could not be undone here. The object and its transcript stay: data is
    // never destroyed by a delete, here as for every agent.
    const off = await deps.agent.tool(tenantId, row.agentId, "disable_push");
    await deps.agent.removeCredential(tenantId, row.agentId);
    const t = deps.now();
    const patch = { status: "deleted" as const, pushRegistered: false, pushError: off.ok ? null : off.error, deletedAt: t };
    await deps.registry.update(tenantId, row.raftAgentId, patch);
    return ok(view({ ...row, ...patch, updatedAt: t }));
  }

  return null;
}


/**
 * `…/connections/:provider` (raft-agent-provider.v1, optional): POST a one-time link the browser
 * opens to connect the agent to a provider; `/confirm` makes the finished flow a connector of the
 * tenant and points this agent at it; GET what Raft may show (this agent's connection and the
 * tenant's connectors); PUT to point this agent at another connector; DELETE to take it off this
 * agent only. A connector as a whole goes through `DELETE /connectors/:id`. No credential passes
 * here in the clear: the flow in connect.ts seals it, and the handlers carry it only sealed.
 */
async function connection(
  method: string, rest: string[], body: unknown, tenantId: string, byRaft: boolean, deps: ProvisionDeps,
): Promise<Response | null> {
  const c = deps.connections;
  if (!c) return null;
  const provider = rest[2]!;
  if (!(CONNECTION_PROVIDERS as readonly string[]).includes(provider)) {
    return fail({ status: 404, code: "unknown_provider", message: `no provider ${provider}; this deployment connects ${CONNECTION_PROVIDERS.join(", ")}` });
  }
  const p = provider as ConnectionProvider;
  const row = byRaft ? await deps.registry.get(tenantId, rest[0]!) : await deps.registry.getByAgentId(tenantId, rest[0]!);
  if (!row || row.status === "deleted") return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });

  if (rest.length === 4) {
    // Raft calls this server to server after checking that its session is the user the flow was started for,
    // and sends that session's user; the hold is released only for the user it was held for.
    if (method !== "POST") return null;
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const unknown = Object.keys(b).find((k) => k !== "pending" && k !== "raftUserId");
    if (unknown) return fail({ status: 400, code: "unknown_field", message: `unknown field ${unknown}`, param: unknown });
    if (typeof b.pending !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(b.pending)) return fail({ status: 422, code: "invalid", message: "pending is the id Raft was given", param: "pending" });
    if (typeof b.raftUserId !== "string" || !RAFT_ID.test(b.raftUserId)) {
      return fail({ status: 422, code: "invalid", message: "raftUserId is required: the user of Raft's current session", param: "raftUserId" });
    }
    const r = await c.confirm(tenantId, row.agentId, p, b.pending, b.raftUserId);
    if (!r.ok) {
      return r.missing
        ? fail({ status: 404, code: "not_found", message: "no pending connection with that id for this agent and user; it may have expired or been used" })
        : fail({ status: 422, code: "connect_failed", message: r.error });
    }
    // A finished authorization is a new connector of the tenant, created by whoever confirmed it.
    const connectedAt = deps.now();
    const connectorId = c.newId();
    await c.connectors.create({ id: connectorId, tenantId, provider: p, account: r.account, creatorRaftUserId: b.raftUserId, sealed: r.sealed, createdAt: connectedAt });
    await c.registry.put({ tenantId, raftAgentId: row.raftAgentId, provider: p, account: r.account, connectedBy: b.raftUserId, connectedAt, connectorId });
    await c.connectors.record({ tenantId, connectorId, raftAgentId: row.raftAgentId, action: "create", actingRaftUserId: b.raftUserId, actingRole: "creator", at: connectedAt });
    return ok({ connected: true, connectorId, account: r.account, connectedAt: new Date(connectedAt).toISOString(), connectedBy: b.raftUserId });
  }

  if (method === "POST") {
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const allowed = new Set(["returnUrl", "initiatedBy", "access"]);
    const unknown = Object.keys(b).find((k) => !allowed.has(k));
    if (unknown) return fail({ status: 400, code: "unknown_field", message: `unknown field ${unknown}`, param: unknown });
    if (typeof b.returnUrl !== "string") return fail({ status: 422, code: "invalid", message: "returnUrl is required", param: "returnUrl" });
    const where = returnUrlProblem(b.returnUrl, row.raftOrigin);
    if (where) return fail({ status: 422, code: "invalid", message: where, param: "returnUrl" });
    const by = b.initiatedBy && typeof b.initiatedBy === "object" ? (b.initiatedBy as Record<string, unknown>).raftUserId : undefined;
    if (typeof by !== "string" || !RAFT_ID.test(by)) {
      return fail({ status: 422, code: "invalid", message: "initiatedBy.raftUserId is required: the Raft user the connection is for", param: "initiatedBy" });
    }
    if (b.access !== undefined && b.access !== "public" && b.access !== "private") {
      return fail({ status: 422, code: "invalid", message: "access is public or private", param: "access" });
    }
    const scopes = scopesFor(b.access === "private" ? "private" : "public");
    const link = await c.link({ tenantId, agentId: row.agentId, raftAgentId: row.raftAgentId, provider: p, returnUrl: b.returnUrl, raftUserId: by, scopes });
    return ok({ ...link, scopes });
  }
  if (method === "GET") {
    const got = await c.registry.get(tenantId, row.raftAgentId, p);
    const current = got?.connectorId ?? null;
    const connectors = (await c.connectors.list(tenantId, p)).map((k) => ({
      id: k.id, account: k.account, creatorRaftUserId: k.creatorRaftUserId, createdAt: new Date(k.createdAt).toISOString(), current: k.id === current,
    }));
    return ok({
      ...(got
        ? { connected: true, connectorId: current, account: got.account, connectedAt: new Date(got.connectedAt).toISOString(), connectedBy: got.connectedBy }
        : { connected: false, connectorId: null, account: null, connectedAt: null, connectedBy: null }),
      connectors,
    });
  }
  if (method === "PUT") {
    const acting = actingField(body, ["connectorId"]);
    if (isFail(acting)) return fail(acting);
    const connectorId = (body as Record<string, unknown>).connectorId;
    if (typeof connectorId !== "string" || !connectorId) return fail({ status: 422, code: "invalid", message: "connectorId is required", param: "connectorId" });
    const k = await c.connectors.get(tenantId, connectorId);
    if (!k || k.provider !== p) return fail({ status: 404, code: "not_found", message: `no ${p} connector ${connectorId} in this tenant` });
    const refused = creatorRefused(k, acting);
    if (refused) return fail(refused);
    const r = await c.attach(tenantId, row.agentId, p, k.sealed);
    if (!r.ok) return fail({ status: 422, code: "connect_failed", message: r.error });
    const at = deps.now();
    await c.registry.put({ tenantId, raftAgentId: row.raftAgentId, provider: p, account: k.account, connectedBy: acting.actingRaftUserId, connectedAt: at, connectorId: k.id });
    await c.connectors.record({ tenantId, connectorId: k.id, raftAgentId: row.raftAgentId, action: "bind", ...acting, at });
    return ok({ connected: true, connectorId: k.id, account: k.account, connectedAt: new Date(at).toISOString(), connectedBy: acting.actingRaftUserId });
  }
  if (method === "DELETE") {
    const got = await c.registry.get(tenantId, row.raftAgentId, p);
    await c.detach(tenantId, row.agentId, p);
    await c.registry.remove(tenantId, row.raftAgentId, p);
    // Who asked is optional here: removing a connection from an agent gives nobody an identity.
    const acting = body === undefined || body === null ? null : actingField(body, []);
    if (got?.connectorId && acting && !isFail(acting)) {
      await c.connectors.record({ tenantId, connectorId: got.connectorId, raftAgentId: row.raftAgentId, action: "unbind", ...acting, at: deps.now() });
    }
    return new Response(null, { status: 204 });
  }
  return null;
}

type Acting = { actingRaftUserId: string; actingRole: "creator" | "admin" };

/** `{ actingRaftUserId, actingRole }` plus the named fields and nothing else: the session user Raft checked, and in what capacity. */
function actingField(body: unknown, also: string[]): Acting | Fail {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const allowed = new Set(["actingRaftUserId", "actingRole", ...also]);
  const unknown = Object.keys(b).find((k) => !allowed.has(k));
  if (unknown) return { status: 400, code: "unknown_field", message: `unknown field ${unknown}`, param: unknown };
  if (typeof b.actingRaftUserId !== "string" || !RAFT_ID.test(b.actingRaftUserId)) {
    return { status: 422, code: "invalid", message: "actingRaftUserId is required: the user of Raft's current session", param: "actingRaftUserId" };
  }
  if (b.actingRole !== "creator" && b.actingRole !== "admin") {
    return { status: 422, code: "invalid", message: "actingRole is creator or admin", param: "actingRole" };
  }
  return { actingRaftUserId: b.actingRaftUserId, actingRole: b.actingRole };
}

/**
 * Pointing an agent at a connector hands it that account's identity, so only its creator or a server
 * admin may. Raft checks both before calling, and only Raft knows who is an admin; a claim to be the
 * creator can be checked here as well, and is.
 */
function creatorRefused(k: { creatorRaftUserId: string }, acting: Acting): Fail | null {
  if (acting.actingRole === "creator" && acting.actingRaftUserId !== k.creatorRaftUserId) {
    return { status: 403, code: "not_creator", message: "actingRole is creator, but this connector was created by someone else" };
  }
  return null;
}

/**
 * `DELETE /connectors/:id`: the connector goes, and with it the credential on every agent pointed at it.
 * The connector is removed only once every agent has been detached: a partial failure answers 502 with
 * the agents still holding it, and the same call finishes the job.
 */
async function disconnect(tenantId: string, connectorId: string, body: unknown, deps: ProvisionDeps): Promise<Response> {
  const c = deps.connections;
  if (!c) return fail({ status: 404, code: "not_found", message: "this deployment has no connectors" });
  const acting = actingField(body, []);
  if (isFail(acting)) return fail(acting);
  const k = await c.connectors.get(tenantId, connectorId);
  if (!k) return fail({ status: 404, code: "not_found", message: `no connector ${connectorId} in this tenant` });
  const refused = creatorRefused(k, acting);
  if (refused) return fail(refused);
  const provider = k.provider as ConnectionProvider;
  // Not atomic with a PUT that lands between `boundTo` and the delete below: that agent keeps a copy of
  // the credential and a connectorId that no longer exists, until it is pointed elsewhere or disconnected.
  const detached: string[] = [];
  const failed: Array<{ raftAgentId: string; error: string }> = [];
  for (const raftAgentId of await c.registry.boundTo(tenantId, k.id)) {
    try {
      const row = await deps.registry.get(tenantId, raftAgentId);
      if (row) await c.detachIfFrom(tenantId, row.agentId, provider, k.sealed);
      await c.registry.remove(tenantId, raftAgentId, provider);
      detached.push(raftAgentId);
    } catch (e) {
      failed.push({ raftAgentId, error: String((e as { message?: unknown })?.message ?? e).slice(0, 200) });
    }
  }
  if (failed.length) {
    return Response.json({
      error: { code: "partially_disconnected", message: "some agents still hold this connector's credential; the same call finishes the job" },
      detached, failed,
    }, { status: 502, headers: { "cache-control": "no-store" } });
  }
  await c.connectors.remove(tenantId, k.id);
  await c.connectors.record({ tenantId, connectorId: k.id, raftAgentId: null, action: "disconnect", ...acting, at: deps.now() });
  return ok({ disconnected: true, connectorId: k.id, detached });
}

/** The setup routes, after the agent's id. */
const EVAL_ROUTES = new Set(["seed", "seed/seal", "seed/manifest", "fresh-context", "restart", "model-input", "tools"]);

/**
 * An evaluation's setup (EVAL_SEED_ROUTES): files put in the agent's workspace before it first runs, the seal that
 * ends that window, a fresh main conversation or an ordinary restart of the same one, what the model was sent, and the
 * tools its next turn is offered. The rules of a file are src/store/seed-files.ts's; the one checked only here is the credential
 * shape, which lives with the Worker (cf/src/secret-shape.ts). Each change leaves one log line naming the token it
 * came by (its hash, the name the operator's listing gives it), never the token or a file's text.
 */
async function evalSetup(
  method: string, route: string, tenantId: string, agentId: string, query: URLSearchParams, raw: Uint8Array | null,
  credentialId: string | null, seed: SeedOps,
): Promise<Response | null> {
  const audit = (op: string, fields: Record<string, string | number | boolean | null>) =>
    logEvent("eval.seed", { tenant: tenantId, agent: agentId, op, ...fields, credentialId });
  const gone = () => fail({ status: 404, code: "not_found", message: `no agent ${agentId} in this object` });
  if (route === "seed" && method === "PUT") {
    const path = query.get("path");
    const problem = seedPathProblem(path);
    if (problem) return fail({ status: 422, code: "invalid", message: problem, param: "path" });
    // The working set's documents are shown to the agent as written by it (src/plugins/state.ts `workingSet`); a
    // seeded file under one of their keys would reach its prompt as its own notes.
    if (WORKING_SET.some((d) => d.key === path)) {
      return fail({ status: 400, code: "reserved", param: "path",
        message: `${path} is one of the agent's own working-set documents (${WORKING_SET.map((d) => d.key).join(", ")}), shown to it as written by it; seed under another path` });
    }
    const mode = query.get("mode") ?? "writable";
    if (!(SEED_MODES as readonly string[]).includes(mode)) return fail({ status: 422, code: "invalid", message: `mode is ${SEED_MODES.join(" or ")}`, param: "mode" });
    const body = seedText(raw ?? new Uint8Array());
    if ("problem" in body) return fail({ status: body.status, code: body.status === 413 ? "too_large" : "invalid", message: body.problem });
    const shape = secretShape(body.text);
    if (shape) return fail({ status: 422, code: "credential_in_text", message: `the file carries what looks like a ${shape}; credentials are never seeded` });
    const r = await seed.write(tenantId, agentId, { path: path!, mode: mode as SeedMode, text: body.text });
    if (!r.ok) {
      audit("write", { path: path!, outcome: r.code });
      if (r.code === "not_found") return gone();
      return fail(r.code === "sealed"
        ? { status: 409, code: "sealed", message: r.message }
        : { status: 413, code: "too_large", message: r.message });
    }
    audit("write", { path: r.file.path, mode: r.file.mode, sha256: r.file.sha256, bytes: r.file.bytes, changed: r.changed, outcome: "ok" });
    return ok({ ...r.file, changed: r.changed });
  }
  const sealView = (s: SeedSeal) => ({
    manifest: s.manifest, manifestSha256: s.manifestSha256, sealedAt: new Date(s.sealedAt).toISOString(), how: s.how,
  });
  if (route === "seed/seal" && method === "POST") {
    const s = await seed.seal(tenantId, agentId, credentialId);
    return s ? ok(sealView(s)) : gone();
  }
  if (route === "seed/manifest" && method === "GET") {
    const m = await seed.manifest(tenantId, agentId);
    if (!m) return gone();
    // Once sealed, the manifest is the one the seal closed on, which is also what the files still are.
    return ok(m.seal ? { sealed: true, ...sealView(m.seal) } : { sealed: false, manifest: m.manifest, manifestSha256: m.manifestSha256, sealedAt: null, how: null });
  }
  if (route === "fresh-context" && method === "POST") {
    const r = await seed.freshContext(tenantId, agentId);
    if (!r.ok) return fail({ status: r.status, code: r.status === 404 ? "not_found" : "busy", message: r.error });
    audit("fresh-context", { oldSessionId: r.oldSessionId, newSessionId: r.newSessionId });
    return ok({ oldSessionId: r.oldSessionId, newSessionId: r.newSessionId });
  }
  // Not a fresh context: the same conversation, rebuilt from storage as after an eviction.
  if (route === "restart" && method === "POST") {
    const r = await seed.restart(tenantId, agentId);
    if (!r.ok) return fail({ status: r.status, code: r.status === 404 ? "not_found" : "busy", message: r.error });
    audit("restart", { sessionId: r.sessionId });
    return ok({ sessionId: r.sessionId, restartedAt: new Date(r.restartedAt).toISOString() });
  }
  if (route === "model-input" && method === "GET") {
    const session = query.get("session");
    const callText = query.get("call");
    const call = callText === null ? null : Number(callText);
    if (call !== null && !(Number.isInteger(call) && call >= 1)) return fail({ status: 422, code: "invalid", message: "call is a whole number from 1", param: "call" });
    const r = await seed.modelInput(tenantId, agentId, session, call);
    if (!r) return fail({ status: 404, code: "not_found", message: session === null ? `no agent ${agentId}` : `no recorded call ${call ?? 1} of session ${session}` });
    return ok(r);
  }
  // What the next turn offers the model, as its harness would be built now (cf/src/runtime.ts `offeredTools`).
  if (route === "tools" && method === "GET") {
    const r = await seed.tools(tenantId, agentId);
    return r ? ok(r) : gone();
  }
  return null;
}
