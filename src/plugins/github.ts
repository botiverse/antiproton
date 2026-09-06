import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext } from "./types.ts";

const API = "https://api.github.com";

async function get(path: string, ctx: PluginContext): Promise<Json> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "agent-harness/0.1",
  };
  // Credential injection happens here, at dispatch, never in the JS sandbox.
  if (ctx.credential) headers.authorization = `Bearer ${ctx.credential}`;
  const res = await fetch(API + path, { headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(
      `github ${res.status}: ${(body as any)?.message ?? res.statusText}`,
    ) as Error & { retryable?: boolean };
    err.retryable = res.status === 403 || res.status >= 500;
    throw err;
  }
  return body;
}

export const githubPlugin: Plugin = {
  id: "github",
  version: "1.0.0",
  tools: [
    {
      name: "repos.get",
      summary: "Fetch a repository's metadata.",
      parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
      sideEffects: "read",
      idempotency: "native",
    },
    {
      name: "issues.list",
      summary: "List issues in a repository.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          perPage: { type: "integer" },
        },
        required: ["repo"],
      },
      sideEffects: "read",
      idempotency: "native",
    },
  ],
  async invoke(tool, args, ctx) {
    const a = args as Record<string, any>;
    switch (tool) {
      case "repos.get":
        return get(`/repos/${a.repo}`, ctx);
      case "issues.list": {
        const q = new URLSearchParams({
          state: a.state ?? "open",
          per_page: String(a.perPage ?? 10),
        });
        return get(`/repos/${a.repo}/issues?${q}`, ctx);
      }
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  },
};
