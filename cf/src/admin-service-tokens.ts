/**
 * `/admin/service-tokens` (task #7): the operator issues, lists and revokes service tokens.
 *
 * Operator header only, and closed when no token is configured, like /admin/diagnose: a route that
 * mints identities does not open for a local dev server. The token appears in the POST answer and
 * nowhere else; the table keeps its hash, and the listing carries the hash because it names the
 * row and cannot be presented as a token.
 */
import { isOperator, uiAgent } from "./auth.ts";
import { agentObjectName } from "./object-name.ts";
import type { ServiceTokenDirectory } from "./control-plane.ts";
import { hashServiceToken, newServiceToken } from "./service-token.ts";

const answer = (body: unknown, status = 200, allow?: string) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...(allow ? { allow } : {}) } });

/** A string field of a JSON body, or undefined: no cast, the body is whatever the caller sent. */
function field(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export const LABEL_MAX = 64;

export async function adminServiceTokens(request: Request, token: string | undefined, dir: ServiceTokenDirectory, url: URL): Promise<Response> {
  if (!isOperator(token, request.headers.get("x-harness-token"))) return answer({ error: "unauthorized" }, 401);
  switch (request.method) {
    case "GET":
      return answer({ tokens: await dir.list() });
    case "POST": {
      const body: unknown = await request.json().catch(() => null);
      const label = (field(body, "label") ?? "").trim();
      if (!label || label.length > LABEL_MAX) return answer({ error: "label", hint: `a label of 1 to ${LABEL_MAX} characters` }, 400);
      const tenantId = field(body, "tenantId") ?? "demo";
      // One agent per token unless the operator pinned one: the label names it, the way an email names a person's.
      const agentId = field(body, "agentId") ?? uiAgent(label);
      try { agentObjectName(tenantId, agentId); } catch (e) {
        // Asked, not asserted: `e` is unknown, and the shape #543 settled on for a catch reads the message only if there is one.
        const message = typeof e === "object" && e !== null && "message" in e ? (e as { message?: unknown }).message : e;
        return answer({ error: String(message) }, 400);
      }
      const t = newServiceToken();
      const hash = await hashServiceToken(t);
      await dir.issue({ hash, label, tenantId, agentId });
      return answer({ token: t, hash, label, tenantId, agentId }, 201);
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
