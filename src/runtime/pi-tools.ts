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
 * Providers restrict what a tool may be called: `^[a-zA-Z0-9_-]+$`, no dots.
 * Plugin authors do not know that, and two of ours name tools `repos.get` and
 * `issues.list`, which the provider rejects with a 400 for the whole request —
 * one badly named tool anywhere in the catalogue stops every call.
 */
const modelName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * Model-facing names must be unique, because that is all the model can say.
 *
 * Bare API names are unique inside one service and collide across several:
 * `show_profile` exists in ten of AppWorld's apps. A bare name is friendlier, so
 * keep it where it is unambiguous and qualify only what actually clashes — the
 * same rule the gateway applies to mount resolution.
 *
 * Sanitising happens first, because it can create a clash that did not exist in
 * the plugin's own names.
 */
export function qualifyMountedTools<T extends MountedTool>(tools: T[]): T[] {
  const named = tools.map((t) => (t.name === modelName(t.name) ? t : { ...t, name: modelName(t.name) }));
  const counts = new Map<string, number>();
  for (const t of named) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return named.map((t) => {
    if ((counts.get(t.name) ?? 0) < 2) return t;
    const prefix = modelName(t.address.split(".")[0]!);
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

/**
 * JavaScript in the sandbox, as one more tool.
 *
 * In the previous harness this was a command the loop emitted and the kernel
 * dispatched. As a pi tool it is just a function, and the interesting property
 * is unchanged and in fact easier to see: the script reaches the same gateway
 * the model reaches directly, through the same host, so the sandbox gains no
 * exit of its own.
 *
 * `replay: "never"` — a script is arbitrary, so an execution whose outcome was
 * lost must not be repeated on the agent's behalf.
 */
export interface Sandbox {
  execute(source: string, host: { invoke(call: any): Promise<any> }, limits?: unknown): Promise<{
    status: string;
    outputs?: unknown[];
    error?: unknown;
    hostCalls?: number;
    acceptedOperationIds?: string[];
  }>;
}

export const RUN_JS_DESCRIPTION =
  "Execute JavaScript in a sandbox to compose several tool calls, loop, filter, " +
  "or project fields. Use it instead of many separate calls, or to avoid pulling " +
  "a large payload into the conversation. Not for a single simple call.";

export function runJsTool(
  sandbox: Sandbox,
  host: ToolHost,
  opts: { limits?: unknown; onCalls?: (n: number) => void | Promise<void> } = {},
): AgentHarnessTool<undefined> {
  let seq = 0;
  return {
    name: "run_js",
    label: "run_js",
    description: RUN_JS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "JavaScript body. Use await tool`name ${args}` and output(value).",
        },
      },
      required: ["source"],
    } as any,
    replay: "never",
    async execute(toolCallId: string, params: { source: string }) {
      let n = 0;
      const r = await sandbox.execute(String(params.source), {
        // A stable key per call inside one execution, so a repeat reaches the
        // same operation rather than minting a new one.
        invoke: (call: any) => host.invoke({
          ...call,
          opts: { ...(call.opts ?? {}), idempotencyKey: `${toolCallId}:${n++}` },
        }),
      }, opts.limits);
      await opts.onCalls?.(r.hostCalls ?? 0);
      if (r.status !== "ok" && r.status !== "succeeded") {
        throw new Error(`run_js ${r.status}: ${JSON.stringify(r.error ?? null).slice(0, 300)}`);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(r.outputs ?? []) }],
        details: { hostCalls: r.hostCalls, operations: r.acceptedOperationIds },
      };
    },
  } as AgentHarnessTool<undefined>;
}
