/**
 * Mounts, as tools pi's harness can call.
 *
 * The gateway stays exactly where it was. A pi tool is a function, so the
 * function body is the gateway call — the harness gains no way out that the
 * previous one did not have, and every check that made the gateway the only
 * exit still runs on the same path. What changes is only who asks.
 *
 * Two things the old harness could not express come free here:
 *
 * `replay` is pi's answer to an effect whose durable intent exists but whose
 * outcome is unknown — an invocation the platform cancelled between the call
 * and its result. We already recorded enough to decide it and never used it: a
 * read is always safe to repeat, a write is safe only if the plugin can make it
 * idempotent itself, and everything else must not be repeated.
 *
 * `details` carries the operation id and status to the transcript without
 * putting them in front of the model.
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { Json } from "../core/types.ts";

/** What the model is offered, and the mount-qualified address behind it. */
export interface MountedTool {
  name: string;
  description: string;
  parameters: Json;
  /** `alias.tool` — what the gateway resolves. Never shown to the model. */
  address: string;
  sideEffects?: "read" | "write";
  idempotency?: "native" | "key" | "none";
}

export interface ToolResult {
  status: string;
  operationId?: string;
  result?: unknown;
  error?: { code?: string; message?: string } | string;
}

export interface ToolHost {
  invoke(call: { tool: string; args: Json; opts?: unknown }): Promise<ToolResult>;
}

/**
 * Model-facing names must be unique, because that is all the model can say.
 *
 * Bare API names are unique inside one service and collide across several:
 * `show_profile` exists in ten of AppWorld's apps. A bare name is friendlier, so
 * keep it where it is unambiguous and qualify only what actually clashes — the
 * same rule the gateway applies to mount resolution.
 */
export function qualifyMountedTools<T extends MountedTool>(tools: T[]): T[] {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return tools.map((t) => {
    if ((counts.get(t.name) ?? 0) < 2) return t;
    const prefix = t.address.split(".")[0]!.replace(/[^A-Za-z0-9_-]/g, "_");
    return { ...t, name: `${prefix}__${t.name}`.slice(0, 64) };
  });
}

/** A read repeats safely; a write repeats only if the plugin makes it so. */
export function replayPolicy(t: MountedTool): "never" | "safe" {
  if ((t.sideEffects ?? "read") === "read") return "safe";
  return t.idempotency === "native" ? "safe" : "never";
}

export function bridgeTools(tools: MountedTool[], host: ToolHost): AgentHarnessTool<undefined>[] {
  return qualifyMountedTools(tools).map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: t.parameters as any,
    replay: replayPolicy(t),
    async execute(_toolCallId: string, params: Json) {
      const res = await host.invoke({ tool: t.address, args: params });
      if (res.status !== "succeeded") {
        // pi asks tools to throw rather than encode failure in content, so the
        // harness can tell a refusal from an answer.
        const e = res.error;
        const message = typeof e === "string" ? e : (e?.message ?? e?.code ?? res.status);
        throw new Error(`${t.address}: ${message}`);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res.result ?? null) }],
        details: { address: t.address, operationId: res.operationId },
      };
    },
  })) as AgentHarnessTool<undefined>[];
}
