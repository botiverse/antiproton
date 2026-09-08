import type { Json } from "../core/types.ts";
import type { Plugin } from "./types.ts";

/**
 * A small fake operations domain, so the approval gate can be demonstrated
 * without wiring a real production system to a demo.
 *
 * Reads are free; writes are the kind of thing a person should sign off. State
 * is per-agent and lives in the mount's connection record, which keeps the demo
 * honest — it uses the same storage a real plugin would.
 */
interface Fleet {
  servers: Array<{ id: string; role: string; version: string; healthy: boolean }>;
  history: Array<{ at: number; action: string; detail: string }>;
}

const FRESH: Fleet = {
  servers: [
    { id: "web-01", role: "web", version: "1.4.2", healthy: true },
    { id: "web-02", role: "web", version: "1.4.2", healthy: true },
    { id: "api-01", role: "api", version: "2.0.1", healthy: true },
    { id: "db-01", role: "database", version: "14.3", healthy: true },
  ],
  history: [],
};

export const demoPlugin: Plugin = {
  id: "demo",
  version: "1.0.0",
  tools: [
    {
      name: "list_servers",
      summary: "List the servers in the fleet with their role, version and health.",
      parameters: { type: "object", properties: { role: { type: "string" } } },
      sideEffects: "read",
      idempotency: "native",
    },
    {
      name: "deploy",
      summary: "Deploy a version to a server. Changes production.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "server id, e.g. web-01" },
          version: { type: "string", description: "version to deploy" },
        },
        required: ["server", "version"],
      },
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "restart",
      summary: "Restart a server. Causes downtime.",
      parameters: {
        type: "object",
        properties: { server: { type: "string" } },
        required: ["server"],
      },
      sideEffects: "write",
      idempotency: "none",
    },
  ],

  async invoke(tool, args, ctx): Promise<Json> {
    const state = ((await ctx.connection.get()) as Fleet | null) ?? structuredClone(FRESH);
    const a = (args ?? {}) as { server?: string; version?: string; role?: string };

    if (tool === "list_servers") {
      const rows = a.role ? state.servers.filter((s) => s.role === a.role) : state.servers;
      return { servers: rows, count: rows.length };
    }

    const target = state.servers.find((s) => s.id === a.server);
    if (!target) throw new Error(`no such server: ${a.server ?? "(none given)"}`);

    if (tool === "deploy") {
      if (!a.version) throw new Error("version is required");
      const from = target.version;
      target.version = a.version;
      state.history.push({ at: Date.now(), action: "deploy", detail: `${target.id} ${from} -> ${a.version}` });
      await ctx.connection.set(state);
      return { server: target.id, from, to: a.version, deployed: true };
    }

    if (tool === "restart") {
      state.history.push({ at: Date.now(), action: "restart", detail: target.id });
      await ctx.connection.set(state);
      return { server: target.id, restarted: true };
    }

    throw new Error(`unknown tool: ${tool}`);
  },
};
