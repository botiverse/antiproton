import type { Plugin } from "./types.ts";
import type { R2Artifacts } from "../store/artifacts.ts";

/**
 * Reading back what the gateway parked. Without this the offload in §5.4 is a
 * dead end: the agent is handed a reference it can never open.
 *
 * Projection and slicing happen host-side on purpose — the point is to keep the
 * model's context small, so returning the whole blob would defeat the offload.
 */
export function artifactsPlugin(artifacts: R2Artifacts, bucket: string): Plugin {
  return {
    id: "artifacts",
    version: "1.0.0",
    tools: [
      {
        name: "read",
        summary:
          "Read back a parked result by its r2:// reference. Use fields to project, offset/limit to page.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string" },
            fields: { type: "array", items: { type: "string" }, description: "keys to keep from each array item" },
            offset: { type: "integer" },
            limit: { type: "integer" },
          },
          required: ["ref"],
        },
        sideEffects: "read",
        idempotency: "native",
      },
    ],
    async invoke(tool, args, ctx) {
      if (tool !== "read") throw new Error(`unknown tool: ${tool}`);
      const a = args as { ref: string; fields?: string[]; offset?: number; limit?: number };
      const prefix = `r2://${bucket}/t/${ctx.caller.tenantId}/${ctx.caller.agentId}/`;
      // Tenant isolation is enforced on the reference itself, not on a guess
      // about who parked it.
      if (typeof a.ref !== "string" || !a.ref.startsWith(prefix)) {
        throw new Error(`reference is not readable by this agent: ${String(a.ref).slice(0, 80)}`);
      }
      const key = a.ref.slice(`r2://${bucket}/`.length);
      const raw = new TextDecoder().decode(await artifacts.get(key));
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { kind: "text", bytes: raw.length, text: raw.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 4000)) };
      }
      if (!Array.isArray(parsed)) return { kind: "value", value: parsed };

      const offset = a.offset ?? 0;
      const limit = Math.min(a.limit ?? 50, 200);
      const page = parsed.slice(offset, offset + limit).map((item) => {
        if (!a.fields?.length || item === null || typeof item !== "object") return item;
        return Object.fromEntries(a.fields.map((f) => [f, (item as any)[f]]));
      });
      return { kind: "array", total: parsed.length, offset, returned: page.length, items: page };
    },
  };
}
