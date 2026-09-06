import type { HarnessAdapter, AdvanceOutput } from "../runtime/kernel.ts";
import type { Json, RuntimeEvent } from "../core/types.ts";
import type { ModelMessage, ToolDefinition } from "../model/types.ts";

/**
 * Tools are called natively; JavaScript is one of the tools.
 *
 * Code-mode pays two model turns and a whole fenced block for what a single
 * lookup needs, and it cannot batch. Native tool calling pays one turn and can
 * issue several calls at once — but it has no way to filter, page or project, so
 * a chatty tool empties itself into the context.
 *
 * So `run_js` is offered alongside the domain tools: cheap calls stay cheap, and
 * the sandbox is spent only when composition or trimming actually earns it. The
 * invariant is unchanged and in fact stated better — the Gateway is the only way
 * out, whether the model arrives there directly or from inside a script.
 */
const SYSTEM = `You are a long-running agent working on the user's behalf.

You have tools. Call them directly when you need one thing.

You also have a special tool, run_js, which executes JavaScript in a sandbox where
the same tools are reachable as:

    const res = await tool\`TOOL_NAME \${ { ...arguments... } }\`;
    output(anything);            // what you want to see back

Reach for run_js only when it earns its cost — it is a whole extra round trip:
- several calls whose results feed each other, or a loop over pages
- filtering, sorting, aggregating, or projecting fields out of a large result
- anything that would otherwise dump a large payload into this conversation

For a single lookup, call the tool directly instead. Never wrap one plain call
in run_js.

Inside run_js: every call returns { status, ... }. "succeeded" carries .result,
"rejected" carries .error.code. There is no fetch, require, fs or process — the
tool tag is the only way out. Nothing persists between runs.

Large results may come back summarised with an artifact reference instead of the
full payload; read them back with the artifacts tool, projecting only the fields
you need.

When you have the answer, reply in plain text with no tool call.`;

const RUN_JS: ToolDefinition = {
  name: "run_js",
  description:
    "Execute JavaScript in a sandbox to compose several tool calls, loop, filter, " +
    "or project fields. Use it instead of many separate calls, or to avoid pulling " +
    "a large payload into the conversation. Not for a single simple call.",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "JavaScript body. Use await tool`name ${args}` and output(value)." },
    },
    required: ["source"],
  },
};

/** Providers restrict tool names, so the model sees a plain name while the
 *  harness keeps the mount-qualified address it dispatches to. */
export interface MountedTool extends ToolDefinition {
  address: string;
}

interface HybridState {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  addresses: Record<string, string>;
  turns: number;
  done: boolean;
  finalizing: boolean;
  promptTokens: number;
}

export class HybridHarness implements HarnessAdapter {
  readonly kind = "hybrid";
  readonly stateVersion = 1;
  #maxTurns: number;

  constructor(opts: { maxTurns?: number } = {}) {
    this.#maxTurns = opts.maxTurns ?? 20;
  }

  async initialize(config: Json): Promise<Json> {
    const mounted = ((config as any)?.tools ?? []) as MountedTool[];
    const policy = (config as any)?.policy as string | undefined;
    const addresses: Record<string, string> = {};
    for (const t of mounted) addresses[t.name] = t.address ?? t.name;
    return {
      messages: [{ role: "system", content: SYSTEM + (policy ? `\n\n# Domain policy you must follow\n${policy}` : "") }],
      tools: [...mounted.map(({ name, description, parameters }) => ({ name, description, parameters })), RUN_JS],
      addresses,
      turns: 0, done: false, finalizing: false, promptTokens: 0,
    } satisfies HybridState;
  }

  async migrate(state: Json): Promise<Json> {
    return state;
  }

  async advance(input: { state: Json; events: RuntimeEvent[] }): Promise<AdvanceOutput> {
    const state = structuredClone(input.state) as HybridState;
    const msgs = state.messages;
    const commands: Array<{ kind: string; payload: Json }> = [];
    let sawReply: { text: string; toolCalls?: any[] } | null = null;

    for (const e of input.events) {
      const p = e.payload as any;
      switch (e.kind) {
        case "message":
          msgs.push({ role: "user", content: String(p.text) });
          break;
        case "model.response": {
          state.turns++;
          if (p.usage?.promptTokens) state.promptTokens = Number(p.usage.promptTokens);
          const calls = (p.toolCalls ?? []) as any[];
          msgs.push({
            role: "assistant",
            content: String(p.text ?? ""),
            ...(calls.length
              ? {
                  tool_calls: calls.map((c) => ({
                    id: c.id, type: "function",
                    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
                  })),
                }
              : {}),
          });
          sawReply = { text: String(p.text ?? ""), toolCalls: calls };
          break;
        }
        case "tool.result":
          msgs.push({ role: "tool", tool_call_id: String(p.callId), content: String(p.content) });
          break;
        case "js.result":
          msgs.push({
            role: "tool",
            tool_call_id: String(p.callId),
            content: JSON.stringify({
              status: p.status,
              outputs: p.outputs,
              ...(p.error ? { error: p.error } : {}),
            }).slice(0, 12_000),
          });
          break;
      }
    }

    if (sawReply) {
      const calls = sawReply.toolCalls ?? [];
      if (calls.length && !state.finalizing) {
        if (state.turns >= this.#maxTurns) {
          msgs.push({
            role: "tool", tool_call_id: String(calls[0].id),
            content: JSON.stringify({ status: "rejected", error: { code: "turn_budget_exhausted" } }),
          });
          msgs.push({
            role: "user",
            content: "You are out of tool turns. Answer now from what you already have, and say plainly what is missing.",
          });
          return { state: { ...state, finalizing: true }, status: "waiting",
            commands: [{ kind: "model.request", payload: { messages: msgs, tools: state.tools } }], waits: [] };
        }
        // Native calls fan out; run_js goes to the sandbox. Both land on the Gateway.
        for (const c of calls) {
          if (c.name === "run_js") {
            commands.push({ kind: "js.execute", payload: { callId: c.id, source: String(c.arguments?.source ?? "") } });
          } else {
            commands.push({
              kind: "tool.call",
              payload: { callId: c.id, tool: state.addresses[c.name] ?? c.name, args: c.arguments ?? {} },
            });
          }
        }
        return { state, status: "waiting", commands, waits: [] };
      }
      // No tool calls: this is the answer.
      return {
        state: { ...state, done: true },
        status: "completed",
        commands: [{ kind: "message.out", payload: { text: sawReply.text } }],
        waits: [],
      };
    }

    return {
      state, status: "waiting",
      commands: [{ kind: "model.request", payload: { messages: msgs, tools: state.tools } }],
      waits: [],
    };
  }
}
