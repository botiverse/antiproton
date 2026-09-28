/**
 * `/admin/provider-tokens` (raft-agent-provider.v1): the operator issues, lists and revokes the tokens
 * a Raft server provisions agents with.
 *
 * Operator header only, and closed when no token is configured, like /admin/service-tokens: a route
 * that mints a tenant's identity does not open for a local dev server. The token appears in the POST
 * answer and nowhere else; the table keeps its hash, and the listing carries the hash because it names
 * the row and cannot be presented as a token.
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

export async function adminProviderTokens(request: Request, token: string | undefined, dir: ProviderTokenDirectory, url: URL): Promise<Response> {
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
      const t = newProviderToken();
      const hash = await hashProviderToken(t);
      if (scope === "platform") {
        // One key for a whole Raft deployment: no tenant here, each request names its server.
        if (field(body, "tenantId") !== undefined) return answer({ error: "tenantId", hint: "a platform token has no tenant; the request's raftServerId decides" }, 400);
        await dir.issue({ hash, label, raftOrigin, scope });
        return answer({ token: t, hash, label, scope, raftOrigin }, 201);
      }
      const tenantId = field(body, "tenantId") ?? "";
      // The tenant is checked the way an object name checks it: what cannot name an object cannot be a tenant.
      try { agentObjectName(tenantId, "probe"); } catch (e) {
        const message = typeof e === "object" && e !== null && "message" in e ? (e as { message?: unknown }).message : e;
        return answer({ error: String(message) }, 400);
      }
      await dir.issue({ hash, label, scope, tenantId, raftOrigin });
      return answer({ token: t, hash, label, scope, tenantId, raftOrigin }, 201);
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
