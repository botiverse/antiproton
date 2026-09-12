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

    /**
     * The sentence that makes an `r2://` reference actionable.
     *
     * It lived in the framework's prompt, behind a flag the runtime computed by
     * asking whether an artifacts tool was mounted — which is the plugin's own
     * question, asked from outside. Now the paragraph exists exactly when this
     * mount does, which is the same condition without anybody having to check
     * it.
     *
     * The tool is named the way the prose elsewhere names one — this mount and
     * the bare tool on it — rather than the qualified string, which is for
     * telling the model to call something right now, not for describing what it
     * has. `ctx.alias` because an operator may have mounted this under any name
     * and a sentence about "the artifacts tool" is wrong the moment they do.
     */
    async promptContribution(ctx) {
      return "Large results may come back summarised with an artifact reference instead of the "
        + `full payload; read them back with the \`read\` tool on \`${ctx.alias}\`, projecting only `
        + "the fields you need.";
    },

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
