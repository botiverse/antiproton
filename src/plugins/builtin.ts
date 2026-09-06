import type { StorageAdapter } from "../core/store.ts";
import type { Plugin } from "./types.ts";

/**
 * Discovery tools. They return mount-qualified names, because an alias is what
 * the agent can actually call; a bare plugin id may be ambiguous.
 */
export function builtinToolsPlugin(store: StorageAdapter, registry: () => Plugin[]): Plugin {
  return {
    id: "tools",
    version: "1.0.0",
    tools: [
      { name: "search", summary: "Search available tools by keyword.", parameters: { type: "object", properties: { query: { type: "string" } } }, sideEffects: "read", idempotency: "native" },
      { name: "describe", summary: "Full schema for one tool.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, sideEffects: "read", idempotency: "native" },
      { name: "mounts", summary: "List this agent's mounts and which account each is bound to.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "native" },
    ],
    async invoke(tool, args, ctx) {
      const { tenantId, agentId } = ctx.caller;
      const mounts = await store.listMounts(tenantId, agentId);
      const plugins = new Map(registry().map((p) => [p.id, p]));
      const catalogue = mounts.flatMap((m) =>
        (plugins.get(m.plugin)?.tools ?? []).map((t) => ({
          name: `${m.alias}.${t.name}`,
          plugin: m.plugin,
          version: m.toolVersion,
          account: m.publicConfig.account ?? null,
          summary: t.summary,
          sideEffects: t.sideEffects,
        })),
      );
      switch (tool) {
        case "mounts":
          return mounts.map((m) => ({
            alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
          }));
        case "search": {
          const terms = String((args as any)?.query ?? "").toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
          if (!terms.length) return catalogue;
          const scored = catalogue
            .map((t) => {
              const hay = `${t.name} ${t.plugin} ${t.summary}`.toLowerCase();
              return { t, score: terms.filter((w) => hay.includes(w)).length };
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score);
          // Never answer a search with nothing: an empty list reads as "no such
          // capability" and sends the agent down a dead end.
          return scored.length ? scored.map((x) => x.t) : { matches: [], allTools: catalogue.map((t) => t.name) };
        }
        case "describe": {
          const want = String((args as any).name);
          const hit = catalogue.find((t) => t.name === want);
          if (!hit) {
            const onMount = catalogue.filter((t) => t.name.startsWith(`${want}.`));
            if (onMount.length) return { mount: want, tools: onMount };
            return { error: "unknown tool", candidates: catalogue.map((t) => t.name) };
          }
          const [alias, ...rest] = want.split(".");
          const mount = mounts.find((m) => m.alias === alias)!;
          const schema = plugins.get(mount.plugin)!.tools.find((t) => t.name === rest.join("."))!;
          return { ...hit, parameters: schema.parameters, idempotency: schema.idempotency };
        }
        default:
          throw new Error(`unknown tool: ${tool}`);
      }
    },
  };
}
