/**
 * `POST /provision/raft`: Raft registers push wake-ups for one of our agents'
 * raft mounts (Raft task #47; contract agreed with XX in
 * #botiverse-antiproton, 2026-09-17).
 *
 * Raft calls with a one-time handoff capability and a handoff id, and nothing
 * else is taken from the request. What the registration is for comes from
 * Raft itself, read back from the configured `RAFT_ORIGIN` with the same
 * capability; the grant goes back only to that origin. So a caller who is not
 * Raft cannot choose where a grant is sent, and cannot name the agent.
 *
 * Before a hook or grant exists, the agent's mount must be a raft mount that
 * takes events, and the plugin must vouch that its push state and a fresh
 * identity read both name the Raft agent asking (`verifyPushAccount`).
 *
 * The caller gets back ids and the endpoint hash, never the grant.
 */
import type { HookDirectory } from "./control-plane.ts";
import { originProblem } from "../../src/plugins/types.ts";

export interface ProvisionScope {
  registrationId: string;
  raftAgentId: string;
  tenantId: string;
  agentId: string;
  alias: string;
  version: number;
  nonce: string;
  expiresAt: number;
  /** A rotation's already-bound hook and its endpoint hash. */
  hookId: string | null;
  endpointHash: string | null;
}

export interface ProvisionDeps {
  raftOrigin: string | undefined;
  /** This deployment's public origin, for the hook URL. */
  origin: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  now(): number;
  hooks: HookDirectory;
  newHookId(): string;
  newGrant(): string;
  sha256Hex(text: string): Promise<string>;
  /** The agent's object, by (tenant, agent). */
  agent(tenantId: string, agentId: string): {
    hookConfirmInboundAccount(tenantId: string, agentId: string, alias: string, pluginId: string, accountId: string, recordAs: string):
      Promise<{ ok: true } | { ok: false; kind: "mismatch" | "unreachable" }>;
    hookRecord(tenantId: string, agentId: string, alias: string, recordAs: string, reason: string): Promise<void>;
    hookSecretVersion(tenantId: string, agentId: string, hookId: string): Promise<{ current: number; generatedHere: boolean }>;
  };
  /** Checks a (tenant, agent) pair the way object names do; throws when it is not one. */
  checkAgentName(tenantId: string, agentId: string): void;
}

export const PROVISION_PATH = "/internal/external-agent-provisioning/";
export const PROVISION_SCHEMA = "raft-external-agent-provisioning.v1";
/** The longest a grant lives, whatever the handoff says. */
export const PROVISION_GRANT_MAX_MS = 600_000;
/** A grant shorter than this could not reasonably be used. */
export const PROVISION_GRANT_MIN_MS = 30_000;
const RAFT_TIMEOUT_MS = 10_000;

const CAPABILITY = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,1024})$/i;
const HANDOFF_ID = /^[A-Za-z0-9_-]{8,128}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
const HOOK_ID = /^[A-Za-z0-9_-]{43}$/;

/** What a caller is told: a fixed code, and for our own checks a sentence; never Raft's body. */
export type ProvisionError =
  | "not_configured" | "capability_required" | "bad_request" | "raft_unreachable" | "handoff_not_accepted"
  | "handoff_invalid" | "account_mismatch" | "account_unconfirmed" | "hook_not_rotatable"
  | "grant_rejected" | "callback_outcome_unknown";
const refuse = (status: number, error: ProvisionError, detail?: string) =>
  Response.json(detail ? { error, detail } : { error }, { status });

/** The scope Raft returned, checked field by field; a string says what is wrong. */
export function parseScope(body: unknown, now: number): ProvisionScope | string {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!b) return "the handoff is not an object";
  if (b.schema !== PROVISION_SCHEMA) return `the handoff schema is not ${PROVISION_SCHEMA}`;
  if (b.state !== "pending") return `the handoff is ${JSON.stringify(b.state)}, not pending`;
  const str = (k: string, re: RegExp) => typeof b[k] === "string" && re.test(b[k] as string) ? b[k] as string : null;
  const registrationId = str("registrationId", ID), raftAgentId = str("raftAgentId", ID);
  const tenantId = str("antiprotonTenantId", ID), agentId = str("antiprotonAgentId", ID);
  const alias = str("mountAlias", /^[a-z][a-z0-9-]{0,23}$/), nonce = str("nonce", NONCE);
  for (const [k, v] of Object.entries({ registrationId, raftAgentId, antiprotonTenantId: tenantId, antiprotonAgentId: agentId, mountAlias: alias, nonce })) {
    if (v === null) return `the handoff's ${k} is missing or malformed`;
  }
  const version = b.secretVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return "the handoff's secretVersion is not a positive integer";
  const expiresAt = b.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "the handoff's expiresAt is not a number";
  if (expiresAt - now < PROVISION_GRANT_MIN_MS) return "the handoff expires too soon to use";
  let hookId: string | null = null, endpointHash: string | null = null;
  if (version > 1) {
    hookId = str("hookId", HOOK_ID);
    endpointHash = str("endpointHash", /^[0-9a-f]{64}$/);
    if (!hookId || !endpointHash) return "a rotation handoff must name its bound hookId and endpointHash";
  }
  return { registrationId: registrationId!, raftAgentId: raftAgentId!, tenantId: tenantId!, agentId: agentId!, alias: alias!,
    version, nonce: nonce!, expiresAt, hookId, endpointHash };
}

export async function provisionRaft(request: Request, deps: ProvisionDeps): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const raft = deps.raftOrigin;
  if (!raft || originProblem(raft)) return refuse(503, "not_configured");
  const base = new URL(raft).origin;
  const cap = CAPABILITY.exec((request.headers.get("authorization") ?? "").trim())?.[1];
  if (!cap) return refuse(401, "capability_required");
  const body = (await request.json().catch(() => null)) as any;
  const handoffId = typeof body?.handoffId === "string" && HANDOFF_ID.test(body.handoffId) ? body.handoffId as string : null;
  if (!handoffId) return refuse(400, "bad_request", "expected {handoffId}");
  const at = `${base}${PROVISION_PATH}${handoffId}`;
  // Every Raft call: the configured origin, the caller's capability, no redirects.
  const call = async (method: "GET" | "POST", url: string, payload?: unknown): Promise<{ status: number; json: any } | null> => {
    try {
      const res = await deps.fetch(url, {
        method, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(RAFT_TIMEOUT_MS),
        headers: { authorization: `Bearer ${cap}`, accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      } as RequestInit);
      return { status: res.status, json: await res.json().catch(() => null) };
    } catch {
      return null;
    }
  };

  // What the registration is for: Raft's word only.
  const read = await call("GET", at);
  if (!read || read.status >= 500) return refuse(502, "raft_unreachable");
  if (read.status !== 200) return refuse(401, "handoff_not_accepted");
  const now = deps.now();
  const scope = parseScope(read.json, now);
  if (typeof scope === "string") return refuse(409, "handoff_invalid", scope);
  try { deps.checkAgentName(scope.tenantId, scope.agentId); }
  catch { return refuse(409, "handoff_invalid", "the Antiproton tenant or agent id is not one"); }
  const recordAs = `provision:${scope.registrationId}`;

  const agent = deps.agent(scope.tenantId, scope.agentId);
  const confirmed = await agent.hookConfirmInboundAccount(scope.tenantId, scope.agentId, scope.alias, "raft", scope.raftAgentId, recordAs);
  if (!confirmed.ok) {
    return confirmed.kind === "unreachable" ? refuse(503, "account_unconfirmed") : refuse(403, "account_mismatch");
  }

  let hookId: string;
  const fresh = scope.version === 1;
  if (fresh) {
    hookId = deps.newHookId();
    await deps.hooks.create({ hookId, tenantId: scope.tenantId, agentId: scope.agentId, alias: scope.alias }, { pending: true });
  } else {
    const row = await deps.hooks.lookupLive(scope.hookId!);
    if (!row || row.pending || row.tenantId !== scope.tenantId || row.agentId !== scope.agentId || row.alias !== scope.alias) {
      return refuse(409, "hook_not_rotatable", "the hook is not a live hook of that mount");
    }
    if (await deps.sha256Hex(`${deps.origin}/hooks/${row.hookId}`) !== scope.endpointHash) {
      return refuse(409, "hook_not_rotatable", "the bound endpoint hash is not this hook's");
    }
    const v = await agent.hookSecretVersion(scope.tenantId, scope.agentId, row.hookId);
    if (v.generatedHere || v.current + 1 !== scope.version) {
      return refuse(409, "hook_not_rotatable", `the hook's next secret version is ${v.current + 1}`);
    }
    hookId = row.hookId;
  }
  const endpointHash = await deps.sha256Hex(`${deps.origin}/hooks/${hookId}`);
  const grant = deps.newGrant();
  const expiresAt = Math.min(scope.expiresAt, now + PROVISION_GRANT_MAX_MS);
  await deps.hooks.grant({ grantHash: await deps.sha256Hex(grant), hookId, version: scope.version, nonce: scope.nonce, expiresAt });
  const payload = { hookId, endpointHash, grant, secretVersion: scope.version, nonce: scope.nonce, expiresAt };
  const ours = (r: any) => r?.registrationId === scope.registrationId && r?.endpointHash === endpointHash && r?.secretVersion === scope.version;
  const accepted = () => Response.json({ state: "accepted", registrationId: scope.registrationId, hookId, endpointHash, secretVersion: scope.version });
  // A pending hook nobody will write to is withdrawn, but only on a definite no.
  const rejected = async () => {
    if (fresh) await deps.hooks.revoke(hookId);
    return refuse(502, "grant_rejected");
  };
  // Raft may have taken the grant and lost the answer: never guess. Accepted
  // and matching is success; a definite no withdraws; anything else stays
  // pending (not activated, not withdrawn) for reset to settle.
  const settle = async (sent: { status: number; json: any } | null, replayed: boolean): Promise<Response> => {
    if (sent && (sent.status === 200 || sent.status === 201)) return sent.json?.state === "accepted" && ours(sent.json) ? accepted() : rejected();
    if (sent && sent.status >= 400 && sent.status < 500) return rejected();
    const state = await call("GET", at);
    const st = state?.status === 200 ? state.json?.state : null;
    if (st === "accepted" && ours(state!.json) && state!.json?.hookId === hookId) return accepted();
    if (st === "failed" || st === "expired" || st === "rejected") return rejected();
    if (st === "pending" && !replayed) return settle(await call("POST", `${at}/grant`, payload), true);
    await agent.hookRecord(scope.tenantId, scope.agentId, scope.alias, recordAs, "callback_outcome_unknown: hook left pending");
    return refuse(502, "callback_outcome_unknown");
  };
  return settle(await call("POST", `${at}/grant`, payload), false);
}
