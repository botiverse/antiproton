/**
 * The three reads of one agent's surface, behind one entry each surface calls: the public API
 * (`/v1/agents/:agentId/...`, cf/src/agents-api/handlers.ts) and the provider binding
 * (`/provision/agents/:id/...`, cf/src/provision/handlers.ts). Each caller has already decided which
 * tenant and agent the request may see; this decides nothing about that, parses the query, and answers
 * the same body for both. A caller adds how it named the agent and its own error envelope.
 */
import { agentUsage, parseUsageQuery, type AgentUsage, type UsageDeps } from "./usage.ts";
import { workspaceList, workspaceRead, type FileRead, type Listing, type WorkspaceDeps } from "./workspace.ts";

export type SurfaceDeps = { usage: UsageDeps; workspace: WorkspaceDeps };
export type SurfaceRead = "usage" | "files" | "read";
export type SurfaceAnswer =
  | { ok: true; body: AgentUsage | Listing | FileRead }
  | { ok: false; status: 400 | 404 | 502; param?: string; message: string };

/** The read a path's tail names (`usage`, `workspace-files`, `workspace-files/read`), or null. */
export function surfaceReadOf(tail: readonly string[], spelling: "provider" | "v1"): SurfaceRead | null {
  const t = tail.join("/");
  if (t === "usage") return "usage";
  if (spelling === "provider") return t === "workspace-files" ? "files" : t === "workspace-files/read" ? "read" : null;
  return t === "workspace/files" ? "files" : t === "workspace/files/read" ? "read" : null;
}

const flag = (v: string | null) => v === "1" || v === "true";

/**
 * A failure underneath (the ledger, the agent's object, the bucket, the container's provider) is
 * logged here in full and answered with a sentence that names none of it: a provider's error carries
 * its own project, a box id, a request path, none of which is the caller's to see.
 */
export async function surface(deps: SurfaceDeps, read: SurfaceRead, tenantId: string, agentId: string, query: URLSearchParams): Promise<SurfaceAnswer> {
  try {
    return await answer(deps, read, tenantId, agentId, query);
  } catch (e) {
    (deps.usage.warn ?? console.warn)(`agent surface: ${read} for ${tenantId}/${agentId} failed: ${String((e as Error)?.message ?? e).slice(0, 500)}`);
    return { ok: false, status: 502, message: read === "usage" ? "the agent's usage could not be read just now; try again" : "the agent's workspace could not be read just now; try again" };
  }
}

async function answer(deps: SurfaceDeps, read: SurfaceRead, tenantId: string, agentId: string, query: URLSearchParams): Promise<SurfaceAnswer> {
  if (read === "usage") {
    const q = parseUsageQuery(query, deps.usage.now());
    if ("param" in q) return { ok: false, status: 400, param: q.param, message: q.message };
    return { ok: true, body: await agentUsage(deps.usage, tenantId, agentId, q) };
  }
  if (read === "files") {
    const h = query.get("includeHidden");
    if (h !== null && !["1", "0", "true", "false"].includes(h)) return { ok: false, status: 400, param: "includeHidden", message: "includeHidden is true or false" };
    const r = await workspaceList(deps.workspace, tenantId, agentId, query.get("dirPath") ?? "", flag(h));
    if (!r.ok) return r;
    const { ok: _ok, ...listing } = r;
    return { ok: true, body: listing };
  }
  const path = query.get("path");
  if (path === null || path === "") return { ok: false, status: 400, param: "path", message: "path is required" };
  const r = await workspaceRead(deps.workspace, tenantId, agentId, path);
  return r.ok ? { ok: true, body: r.file } : r;
}
