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
  /** Set when the plugin's mount owns a shared resource, so its calls must not
   *  overlap. pi executes a turn's tool calls in parallel by default. */
  exclusive?: boolean;
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

/** Providers cap a tool name; 64 is the smallest cap among the ones we target. */
const MAX_NAME = 64;

/**
 * Model-facing names must be unique, because that is all the model can say —
 * and they must be *stable*, because the model writes them down.
 *
 * Bare API names are unique inside one service and collide across several:
 * `show_profile` exists in ten of AppWorld's apps. This used to qualify only
 * what actually clashed, which made a bare name friendlier and made every name
 * a function of the whole mounted set: mounting `web`, which has a `get`,
 * renamed the memory plugin's `get` to `state__get`. So an operator attaching an
 * unrelated mount could invalidate an agent's own note about which tool to call,
 * and nothing anywhere would report it. A name that can change for a reason
 * outside the tool is not a name.
 *
 * So every tool is qualified, always. `<alias>__<tool>` is one deterministic
 * string that depends on this mount alone, and it is the same string discovery
 * hands back — `builtin.ts` reads this function rather than formatting its own.
 * The dotted `address` is untouched: that is the gateway's dispatch key and the
 * model never sees it.
 *
 * Sanitising happens first, because it can create a clash that did not exist in
 * the plugin's own names. Two names can still meet at the cap, so the last step
 * is a deterministic tie-break rather than a silent collapse — two tools sharing
 * one name is the one outcome the model cannot work around.
 */
export function qualifyMountedTools<T extends MountedTool>(tools: T[]): T[] {
  const used = new Set<string>();
  return tools.map((t) => {
    const alias = modelName(t.address.split(".")[0]!);
    const bare = modelName(t.name);
    const room = Math.max(1, MAX_NAME - alias.length - 2);
    let name = `${alias}__${bare.slice(0, room)}`;
    for (let n = 2; used.has(name); n++) {
      const tag = String(n);
      name = `${name.slice(0, MAX_NAME - tag.length)}${tag}`;
    }
    used.add(name);
    return t.name === name ? t : { ...t, name };
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
    // pi runs a turn's tool calls in parallel unless a tool says otherwise, and
    // a plugin whose mount owns one container cannot survive that.
    ...(t.exclusive ? { executionMode: "sequential" as const } : {}),
    async execute(_toolCallId: string, params: Json) {
      const res = await host.invoke({ tool: t.address, args: params });
      if (res.status !== "succeeded") {
        // pi asks tools to throw rather than encode failure in content, so the
        // harness can tell a refusal from an answer.
        const e = res.error;
        const message = typeof e === "string" ? e : (e?.message ?? e?.code ?? res.status);
        // The model reads this, so it is named the way the model can name it
        // back. The address is still in `details`, where the transcript and the
        // audit record want it.
        throw new Error(`${t.name}: ${message}`);
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
  opts: {
    limits?: unknown;
    onCalls?: (n: number) => void | Promise<void>;
    /** The tools the model was offered, so a script may name them the way the
     *  model's own tool list names them. Without this the prompt asks for two
     *  different strings for one tool: `web__get` outside the sandbox, and the
     *  gateway's `web.get` inside it, with nothing saying which is which. */
    tools?: MountedTool[];
  } = {},
): AgentHarnessTool<undefined> {
  let seq = 0;
  // Unknown strings pass through untouched: an address still works, so a model
  // that learned one from an older transcript is not punished for it, and a
  // genuinely wrong name is refused by the gateway with its own message rather
  // than by a lookup here.
  const byName = new Map((opts.tools ?? []).map((t) => [t.name, t.address]));
  const address = (name: unknown) =>
    typeof name === "string" ? (byName.get(name) ?? name) : name;
  return {
    name: "run_js",
    label: "run_js",
    description: RUN_JS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "JavaScript body. Use await tool`name ${args}` and output(value), " +
            "where `name` is the tool's name as it appears in your tool list.",
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
          tool: address(call.tool),
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

/**
 * Tools the model is never offered, by mount-qualified address.
 *
 * This is for the case where something the runner owns must not be the
 * agent's to call. The one instance so far: a benchmark whose grader runs
 * *after* the agent in the same container. `node.release` says it destroys
 * the box and stops the meter, so an agent tidying up calls it — rightly, in
 * production — and the grader then scores a fresh box from the base image:
 * no diff, every test still failing, a zero that looks exactly like the model
 * being wrong. Withholding the tool is the fix; the runner releases instead.
 *
 * Applied before the names are qualified, so the address is the mount's own
 * (`node.release`), not whatever the provider-safe name became.
 */
export function withholdTools<T extends { address: string }>(
  tools: T[],
  addresses: Iterable<string>,
): T[] {
  const held = new Set(addresses);
  return tools.filter((t) => !held.has(t.address));
}
