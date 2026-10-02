/**
 * The three reads of one agent's surface, behind one entry each surface calls: the public API
 * (`/v1/agents/:agentId/...`, cf/src/agents-api/handlers.ts) and the provider binding
 * (`/provision/agents/:id/...`, cf/src/provision/handlers.ts). Each caller has already decided which
 * tenant and agent the request may see; this decides nothing about that, parses the query, and answers
 * the same body for both. A caller adds how it named the agent and its own error envelope.
 */
import { agentUsage, parseUsageQuery, type AgentUsage, type UsageDeps } from "./usage.ts";
import { workspaceList, workspaceRead, type FileNode, type FileRead, type WorkspaceDeps } from "./workspace.ts";

export type SurfaceDeps = { usage: UsageDeps; workspace: WorkspaceDeps };
export type SurfaceRead = "usage" | "files" | "read";
export type SurfaceAnswer =
  | { ok: true; body: AgentUsage | { files: FileNode[] } | FileRead }
  | { ok: false; status: 400 | 404; param?: string; message: string };

/** The read a path's tail names (`usage`, `workspace-files`, `workspace-files/read`), or null. */
export function surfaceReadOf(tail: readonly string[], spelling: "provider" | "v1"): SurfaceRead | null {
  const t = tail.join("/");
  if (t === "usage") return "usage";
  if (spelling === "provider") return t === "workspace-files" ? "files" : t === "workspace-files/read" ? "read" : null;
  return t === "workspace/files" ? "files" : t === "workspace/files/read" ? "read" : null;
}

const flag = (v: string | null) => v === "1" || v === "true";

export async function surface(deps: SurfaceDeps, read: SurfaceRead, tenantId: string, agentId: string, query: URLSearchParams): Promise<SurfaceAnswer> {
  if (read === "usage") {
    const q = parseUsageQuery(query, deps.usage.now());
    if ("param" in q) return { ok: false, status: 400, param: q.param, message: q.message };
    return { ok: true, body: await agentUsage(deps.usage, tenantId, agentId, q) };
  }
  if (read === "files") {
    const h = query.get("includeHidden");
    if (h !== null && !["1", "0", "true", "false"].includes(h)) return { ok: false, status: 400, param: "includeHidden", message: "includeHidden is true or false" };
    const r = await workspaceList(deps.workspace, tenantId, agentId, query.get("dirPath") ?? "", flag(h));
    return r.ok ? { ok: true, body: { files: r.files } } : r;
  }
  const path = query.get("path");
  if (path === null || path === "") return { ok: false, status: 400, param: "path", message: "path is required" };
  const r = await workspaceRead(deps.workspace, tenantId, agentId, path);
  return r.ok ? { ok: true, body: r.file } : r;
}
