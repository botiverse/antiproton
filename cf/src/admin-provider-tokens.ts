/**
 * `/admin/provider-tokens` (raft-agent-provider.v1): the operator issues, lists and revokes the tokens
 * a Raft server provisions agents with.
 *
 * Operator header only, and closed when no token is configured, like /admin/service-tokens: a route
 * that mints a tenant's identity does not open for a local dev server. A minted token appears in the POST
 * answer and nowhere else; the table keeps its hash, and the listing carries the hash because it names
 * the row and cannot be presented as a token.
 *
 * A POST with `hash` registers a token its holder made instead, and the answer carries no token: the
 * plaintext never reaches this deployment. Only where PROVIDER_TOKEN_HASH_REGISTRATION is "1" (preview and
 * the canary; never cf/wrangler.jsonc, test/provider-tokens.ts checks), and refused with a 403 elsewhere.
 */
import { isOperator } from "./auth.ts";
import { agentObjectName } from "./object-name.ts";
import type { ProviderTokenDirectory } from "./control-plane.ts";
import { hashProviderToken, newProviderToken } from "./provider-token.ts";
import { originProblem } from "../../src/plugins/types.ts";

const answer = (body: unknown, status = 200, allow?: string) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...(allow ? { allow } : {}) } });

function field(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export const LABEL_MAX = 64;

/** Exactly what hashProviderToken returns (cf/src/provider-token.ts): SHA-256, lowercase hex. */
export const PROVIDER_TOKEN_HASH = /^[0-9a-f]{64}$/;

/**
 * Whether an insert failed because the hash is already a row. `hash` is the table's primary key
 * (cf/migrations/0008_provisioning.sql), so a revoked row counts too; test/spec/control-plane-spec.ts checks
 * this reading against real D1.
 */
export function isDuplicateHash(e: unknown): boolean {
  const message = typeof e === "object" && e !== null && "message" in e ? String((e as { message?: unknown }).message) : String(e);
  return /UNIQUE constraint failed: provider_tokens\.hash/.test(message);
}

/** The prefix every tenant derived from a Raft server id starts with (derivedTenant, cf/src/provision/handlers.ts). */
export const RESERVED_TENANT_PREFIX = "raft_";

/**
 * Why a credential that brings a new principal into a tenant may not name this one, or null when it may.
 *
 * `raft_` is the namespace of the tenants derived from Raft server ids: a platform token's request for server S
 * acts in `raft_<S>`. A credential issued under that prefix acts in the same tenant as whichever server derives
 * it — its agents, quota and billing — so only the derivation may name one. Asked by the routes that mint such a
 * principal: a tenant-scoped provider token (below), and an Agents API key (`/admin/api-keys`, cf/src/index.ts),
 * whose owner agent and the agents it makes live in the named tenant and count against its spend limit.
 *
 * Not asked by a service token (cf/src/admin-service-tokens.ts): an operator may need one to reach an existing
 * provisioned agent in a `raft_` tenant, so there the agent must be named and be a live provisioned_agents row
 * instead. Not asked by `/admin/hooks` and `/admin/mounts` either: they are operator-only and act on the object of
 * the agent the request names, though neither checks that the agent exists. Refused at issuance only, so a row
 * issued before this still resolves, and can still be listed and revoked.
 */
export function reservedTenantProblem(tenantId: string): string | null {
  if (!tenantId.startsWith(RESERVED_TENANT_PREFIX)) return null;
  return `a tenant id starting with "${RESERVED_TENANT_PREFIX}" is reserved for the tenants derived from Raft server ids`;
}

export async function adminProviderTokens(request: Request, token: string | undefined, dir: ProviderTokenDirectory, url: URL,
  options: { hashRegistration?: boolean } = {}): Promise<Response> {
  if (!isOperator(token, request.headers.get("x-harness-token"))) return answer({ error: "unauthorized" }, 401);
  switch (request.method) {
    case "GET":
      return answer({ tokens: await dir.list() });
    case "POST": {
      const body: unknown = await request.json().catch(() => null);
      const label = (field(body, "label") ?? "").trim();
      if (!label || label.length > LABEL_MAX) return answer({ error: "label", hint: `a label of 1 to ${LABEL_MAX} characters` }, 400);
      const scope = field(body, "scope") ?? "tenant";
      if (scope !== "tenant" && scope !== "platform") return answer({ error: "scope", hint: "tenant or platform" }, 400);
      const raftOrigin = (field(body, "raftOrigin") ?? "").trim();
      const problem = originProblem(raftOrigin);
      if (problem) return answer({ error: "raftOrigin", hint: `raftOrigin ${problem}` }, 400);
      // Registered by hash: the holder made the token and keeps it, and only its hash is sent, so the plaintext
      // never reaches this deployment. Nothing is minted and the answer carries no token.
      const byHash = typeof body === "object" && body !== null && "hash" in body;
      let t: string | null = null;
      let hash: string;
      if (byHash) {
        if (!options.hashRegistration) {
          return answer({ error: "hash_registration_disabled", hint: "registering a provider token by hash is enabled only where PROVIDER_TOKEN_HASH_REGISTRATION is \"1\" (preview and the canary)" }, 403);
        }
        const given = (body as Record<string, unknown>).hash;
        if (typeof given !== "string" || !PROVIDER_TOKEN_HASH.test(given)) {
          return answer({ error: "hash", hint: "the lowercase hex SHA-256 of the token's UTF-8 bytes: 64 characters of 0-9a-f" }, 400);
        }
        if ("token" in (body as Record<string, unknown>)) return answer({ error: "token", hint: "send only the hash; the token stays with its holder" }, 400);
        hash = given;
      } else {
        t = newProviderToken();
        hash = await hashProviderToken(t);
      }
      const issue = async (row: Parameters<ProviderTokenDirectory["issue"]>[0]): Promise<Response | null> => {
        try { await dir.issue(row); return null; } catch (e) {
          if (isDuplicateHash(e)) return answer({ error: "duplicate", hint: "a provider token with this hash is already registered (live or revoked)" }, 409);
          throw e;
        }
      };
      if (scope === "platform") {
        // One key for a whole Raft deployment: no tenant here, each request names its server.
        if (field(body, "tenantId") !== undefined) return answer({ error: "tenantId", hint: "a platform token has no tenant; the request's raftServerId decides" }, 400);
        const refused = await issue({ hash, label, raftOrigin, scope });
        if (refused) return refused;
        return answer({ ...(t ? { token: t } : {}), hash, label, scope, raftOrigin }, 201);
      }
      const tenantId = field(body, "tenantId") ?? "";
      // The tenant is checked the way an object name checks it: what cannot name an object cannot be a tenant.
      try { agentObjectName(tenantId, "probe"); } catch (e) {
        const message = typeof e === "object" && e !== null && "message" in e ? (e as { message?: unknown }).message : e;
        return answer({ error: String(message) }, 400);
      }
      // Not a tenant the operator may name (reservedTenantProblem above).
      const reserved = reservedTenantProblem(tenantId);
      if (reserved) {
        return answer({ error: "tenantId", hint: `${reserved}; issue a platform token for a Raft server, or pick another tenant id` }, 400);
      }
      const refused = await issue({ hash, label, scope, tenantId, raftOrigin });
      if (refused) return refused;
      return answer({ ...(t ? { token: t } : {}), hash, label, scope, tenantId, raftOrigin }, 201);
    }
    case "DELETE": {
      const hash = url.searchParams.get("hash") ?? "";
      if (!/^[0-9a-f]{64}$/.test(hash)) return answer({ error: "hash", hint: "the hash from the listing" }, 400);
      return answer({ revoked: await dir.revoke(hash) });
    }
    default:
      return answer({ error: "GET, POST or DELETE" }, 405, "GET, POST, DELETE");
  }
}
