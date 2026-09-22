import type { StorageAdapter } from "../core/store.ts";
import type { Plugin } from "./types.ts";
// The one function that decides what the model may call a tool. Imported rather
// than reimplemented: discovery that formats its own names is discovery that can
// disagree with dispatch, which is what it did — it answered `node.save`, the
// gateway's address, while the harness offered `node__save`.
import { qualifyMountedTools } from "../runtime/pi-tools.ts";

/**
 * Discovery tools. They answer with the name the harness registered, so a tool
 * found here can be called by the string it was found under.
 */
export function builtinToolsPlugin(store: StorageAdapter, registry: () => Plugin[]): Plugin {
  return {
    id: "tools",
    version: "1.0.0",
    tools: [
      { name: "search", summary: "Search available tools by keyword.", parameters: { type: "object", properties: { query: { type: "string" } } }, sideEffects: "read", idempotency: "native" },
      { name: "describe", summary: "Full schema for one tool.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, sideEffects: "read", idempotency: "native" },
      // "which account" was true of one seeded mount out of five. The others
      // carry a label describing what the mount is — "open web", "agent
      // memory", "container" — so the field promised an identity and delivered
      // a description, and the model had no way to tell which it had.
      { name: "mounts", summary: "List this agent's mounts and what each one is.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "native" },
    ],
    async invoke(tool, args, ctx) {
      const { tenantId, agentId } = ctx.caller;
      const mounts = await store.listMounts(tenantId, agentId);
      const plugins = new Map(registry().map((p) => [p.id, p]));
      // Qualified against the whole mounted set, the way the harness does it,
      // because that is the only way the two agree by construction.
      const catalogue = qualifyMountedTools(mounts.flatMap((m) =>
        (plugins.get(m.plugin)?.tools ?? []).map((t) => ({
          name: t.name,
          address: `${m.alias}.${t.name}`,
          description: t.summary,
          parameters: t.parameters,
          plugin: m.plugin,
          version: m.toolVersion,
          // Named for what it holds: the operator's word for this mount,
          // which is an account only when the operator made it one.
          label: m.publicConfig.account ?? null,
          summary: t.summary,
          sideEffects: t.sideEffects,
        })),
      )).map(({ parameters: _p, description: _d, ...rest }) => rest);
      // The address is the gateway's key and stays out of every answer: an agent
      // that is shown one will use one. It is kept on the entry above only so
      // `describe` can still recognise a name an older transcript taught it.
      const shown = <T extends { address: string }>(t: T) => {
        const { address: _a, ...rest } = t;
        return rest;
      };
      switch (tool) {
        case "mounts":
          return mounts.map((m) => ({
            alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
          }));
        case "search": {
          const terms = String((args as any)?.query ?? "").toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
          if (!terms.length) return catalogue.map(shown);
          const scored = catalogue
            .map((t) => {
              const hay = `${t.name} ${t.plugin} ${t.summary}`.toLowerCase();
              return { t, score: terms.filter((w) => hay.includes(w)).length };
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score);
          // Never answer a search with nothing: an empty list reads as "no such
          // capability" and sends the agent down a dead end.
          return scored.length
            ? scored.map((x) => shown(x.t))
            : { matches: [], allTools: catalogue.map((t) => t.name) };
        }
        case "describe": {
          const want = String((args as any).name);
          // Three ways an agent may ask, and only the first is the name it was
          // offered: a model that read `node.save` in an older transcript, or
          // typed the bare `save`, gets an answer rather than a correction.
          const bare = catalogue.filter((t) => t.address.split(".").slice(1).join(".") === want);
          // A bare name can belong to two mounts — `get` is both memory's and
          // the web's. Answering with whichever came first would describe one
          // tool under a name that means two, so say so and let the next call
          // be exact.
          if (bare.length > 1 && !catalogue.some((t) => t.name === want || t.address === want)) {
            return { error: "that name belongs to more than one mount", candidates: bare.map((t) => t.name) };
          }
          const hit = catalogue.find((t) => t.name === want)
            ?? catalogue.find((t) => t.address === want)
            ?? bare[0];
          if (!hit) {
            const onMount = catalogue.filter((t) => t.address.startsWith(`${want}.`));
            if (onMount.length) return { mount: want, tools: onMount.map(shown) };
            return { error: "unknown tool", candidates: catalogue.map((t) => t.name) };
          }
          const [alias, ...rest] = hit.address.split(".");
          const mount = mounts.find((m) => m.alias === alias)!;
          const schema = plugins.get(mount.plugin)!.tools.find((t) => t.name === rest.join("."))!;
          return { ...shown(hit), parameters: schema.parameters, idempotency: schema.idempotency };
        }
        default:
          throw new Error(`unknown tool: ${tool}`);
      }
    },
  };
}
