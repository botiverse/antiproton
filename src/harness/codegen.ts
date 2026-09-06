import type { HarnessAdapter, AdvanceOutput } from "../runtime/kernel.ts";
import type { Json, RuntimeEvent } from "../core/types.ts";
import type { ModelMessage } from "../model/types.ts";

const SYSTEM = `You are a long-running agent. You act by writing JavaScript that the runtime executes in a sandbox.

Reply with EXACTLY ONE of:
  (a) a single \`\`\`js code block — the runtime runs it and shows you the result, or
  (b) a plain final answer with no code block — this ends the task.

Inside the sandbox:
  const res = await tool\`ALIAS.TOOL \${ { ...business arguments... } }\`;
  output(anything);            // what you want recorded and shown to yourself/the user

Rules that matter:
- The tool name must be a literal at the start of the template. Never build it from a variable.
- The argument object contains ONLY the tool's own parameters. Never pass connection,
  installation, tenant or agent — accounts are bound to the alias at configuration time.
- Every call returns { status, ... }. Check it:
    "succeeded" -> res.result holds the value
    "rejected"  -> res.error.code says why (bad name, ambiguous alias, not mounted, bad args)
    "failed" | "unknown" | "pending" -> handle or report; "unknown" means it may have landed.
- There is no fetch, require, fs, process, console, or setTimeout. The tool tag is the only way out.
- Large results may come back summarised with an "artifact" reference instead of full data.
- Ordinary JavaScript works: map, filter, JSON, string methods. Do the data wrangling in code,
  not in your head.
- Discovery: tool\`tools.mounts \${ {} }\`, tool\`tools.search \${ { query: "..." } }\`,
  tool\`tools.describe \${ { name: "alias.tool" } }\`.
- Nothing persists between executions: no variables, no closures. Carry state via output and
  the next code block.

Keep each code block small and purposeful. Prefer one or two calls per block, look at the
result, then decide the next block.`;

interface CodegenState {
  messages: ModelMessage[];
  turns: number;
  done: boolean;
  /** Set once the turn budget is spent: the next reply is taken as the answer. */
  finalizing: boolean;
}

const fence = /```(?:js|javascript)\s*\n([\s\S]*?)```/;

export function extractCode(text: string): string | null {
  const m = fence.exec(text);
  return m ? m[1]!.trim() : null;
}

/**
 * First harness: a direct model -> code -> execute loop. It holds no I/O of its
 * own; every external effect leaves as a command, which is what lets the Runtime
 * stay in charge of retries, fencing and recovery.
 */
export class CodegenHarness implements HarnessAdapter {
  readonly kind = "codegen";
  readonly stateVersion = 1;
  #maxTurns: number;

  constructor(opts: { maxTurns?: number } = {}) {
    this.#maxTurns = opts.maxTurns ?? 8;
  }

  async initialize(config: Json): Promise<Json> {
    const mounts = (config as any)?.mounts ?? [];
    const preamble =
      mounts.length > 0
        ? `\n\nMounts available to you right now:\n${mounts
            .map((m: any) => `  ${m.alias}  (${m.plugin} v${m.version}, account: ${JSON.stringify(m.config?.account ?? null)})`)
            .join("\n")}`
        : "";
    return {
      messages: [{ role: "system", content: SYSTEM + preamble }],
      turns: 0, done: false, finalizing: false,
    } satisfies CodegenState;
  }

  async migrate(state: Json): Promise<Json> {
    return state;
  }

  async advance(input: { state: Json; events: RuntimeEvent[] }): Promise<AdvanceOutput> {
    const state = structuredClone(input.state) as CodegenState;
    const messages = state.messages;
    let sawModelReply: string | null = null;

    for (const e of input.events) {
      const p = e.payload as any;
      switch (e.kind) {
        case "message":
          messages.push({ role: "user", content: String(p.text) });
          break;
        case "model.response":
          messages.push({ role: "assistant", content: String(p.text) });
          sawModelReply = String(p.text);
          state.turns++;
          break;
        case "js.result": {
          const left = Math.max(0, this.#maxTurns - state.turns);
          messages.push({
            role: "user",
            content:
              `Execution ${p.status}` +
              (p.error ? ` (${p.error.code}: ${p.error.message})` : "") +
              `\noutput: ${JSON.stringify(p.outputs).slice(0, 8000)}` +
              `\n[${left} execution turn(s) left — answer before they run out]`,
          });
          break;
        }
        case "operation.completed":
          messages.push({
            role: "user",
            content: `Operation ${p.operationId} finished: ${p.status}${p.resultRef ? ` -> ${p.resultRef}` : ""}`,
          });
          break;
      }
    }

    if (sawModelReply !== null) {
      const code = extractCode(sawModelReply);
      // A spent budget must not discard the work already done: ask for a final
      // answer from what is in context instead of blocking the task.
      if (state.finalizing) {
        return {
          state: { ...state, done: true },
          status: "completed",
          commands: [{ kind: "message.out", payload: { text: sawModelReply.replace(fence, "").trim() } }],
          waits: [],
        };
      }
      if (code) {
        if (state.turns >= this.#maxTurns) {
          messages.push({
            role: "user",
            content:
              "You are out of execution turns. Do not write any more code. " +
              "Answer the original question now using what you already have, and say plainly " +
              "what is missing if anything is.",
          });
          return {
            state: { ...state, finalizing: true },
            status: "waiting",
            commands: [{ kind: "model.request", payload: { messages } }],
            waits: [],
          };
        }
        return {
          state,
          status: "waiting",
          commands: [{ kind: "js.execute", payload: { source: code } }],
          waits: [],
        };
      }
      return {
        state: { ...state, done: true },
        status: "completed",
        commands: [{ kind: "message.out", payload: { text: sawModelReply } }],
        waits: [],
      };
    }

    return {
      state,
      status: "waiting",
      commands: [{ kind: "model.request", payload: { messages } }],
      waits: [],
    };
  }
}
