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

/**
 * Messages carry a tag so compaction can distinguish requirements from scratch
 * work. A customer turn is the specification; an execution cycle is working out.
 */
type Tag = "system" | "customer" | "agent" | "execution" | "note";
interface TaggedMessage extends ModelMessage {
  tag: Tag;
}

interface CodegenState {
  messages: TaggedMessage[];
  turns: number;
  done: boolean;
  /** Set once the turn budget is spent: the next reply is taken as the answer. */
  finalizing: boolean;
  /** Last measured prompt size, reported by the provider. */
  promptTokens: number;
  compactions: number;
  modelFailures?: number;
}

export interface CompactionConfig {
  /** "none" keeps everything; "cycles" drops old execution cycles. */
  mode: "none" | "cycles";
  /** Compact once the measured prompt exceeds this. */
  triggerTokens: number;
  /** Execution cycles kept verbatim after a compaction. */
  keepCycles: number;
}

export const NO_COMPACTION: CompactionConfig = { mode: "none", triggerTokens: Infinity, keepCycles: 0 };
export const DEFAULT_COMPACTION: CompactionConfig = { mode: "cycles", triggerTokens: 24_000, keepCycles: 3 };

const fence = /```(?:js|javascript)\s*\n([\s\S]*?)```/;

/** Tags are internal bookkeeping; the provider never sees them. */
const plain = (msgs: TaggedMessage[]): ModelMessage[] =>
  msgs.map(({ role, content }) => ({ role, content }));

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
  readonly stateVersion = 2;
  #maxTurns: number;
  #compaction: CompactionConfig;
  /** Set by the last compaction, for reporting. */
  lastCompaction: { dropped: number; from: number } | null = null;

  constructor(opts: { maxTurns?: number; compaction?: CompactionConfig } = {}) {
    this.#maxTurns = opts.maxTurns ?? 8;
    this.#compaction = opts.compaction ?? NO_COMPACTION;
  }

  /**
   * Drops old execution cycles, keeps every customer turn.
   *
   * Two constraints shape this. Provider prompt caching means a rewritten prefix
   * is a cache miss for everything after the edit, so compaction has to be rare
   * and leave the head untouched — hysteresis, not a moving window. And what the
   * agent must not lose is the requirements, which live in customer turns; the
   * code it wrote three cycles ago is scratch work.
   */
  #compact(state: CodegenState): boolean {
    const c = this.#compaction;
    if (c.mode === "none" || state.promptTokens < c.triggerTokens) return false;

    const msgs = state.messages;
    // Index execution cycles: an agent reply followed by its execution result.
    const cycleIdx: number[] = [];
    for (let i = 0; i < msgs.length; i++) if (msgs[i]!.tag === "execution") cycleIdx.push(i);
    if (cycleIdx.length <= c.keepCycles) return false;

    const keepFrom = cycleIdx[cycleIdx.length - c.keepCycles]!;
    const dropped: TaggedMessage[] = [];
    const kept: TaggedMessage[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      const isScratch = m.tag === "agent" || m.tag === "execution";
      if (i < keepFrom && isScratch) dropped.push(m);
      else kept.push(m);
    }
    if (!dropped.length) return false;

    // A structural note, not an LLM summary: no extra model call, and the text
    // is deterministic so it does not itself churn the prefix.
    const tools = new Set<string>();
    const refs = new Set<string>();
    for (const d of dropped) {
      for (const m of d.content.matchAll(/tool`\s*([a-z0-9_]+(?:\.[a-z0-9_]+)+)/g)) tools.add(m[1]!);
      for (const m of d.content.matchAll(/r2:\/\/[^\s"',)]+/g)) refs.add(m[0]);
    }
    const note: TaggedMessage = {
      role: "user",
      tag: "note",
      content:
        `[Context compacted: ${dropped.length} earlier messages of your own code and its output were removed ` +
        `to stay within budget. Every customer message is still above.` +
        (tools.size ? ` Tools you already used: ${[...tools].sort().join(", ")}.` : "") +
        (refs.size ? ` Artifacts you parked: ${[...refs].sort().join(", ")}.` : "") +
        ` If you need something you no longer see, fetch it again rather than guessing.]`,
    };
    // Insert the note where the dropped span began, so the head stays byte-identical.
    const firstDrop = msgs.findIndex((m) => dropped.includes(m));
    kept.splice(Math.max(1, kept.findIndex((m) => msgs.indexOf(m) > firstDrop)), 0, note);
    state.messages = kept;
    state.compactions++;
    this.lastCompaction = { dropped: dropped.length, from: state.promptTokens };
    return true;
  }

  async initialize(config: Json): Promise<Json> {
    const mounts = (config as any)?.mounts ?? [];
    const policy = (config as any)?.policy as string | undefined;
    const preamble =
      mounts.length > 0
        ? `\n\nMounts available to you right now:\n${mounts
            .map((m: any) => `  ${m.alias}  (${m.plugin} v${m.version}, account: ${JSON.stringify(m.config?.account ?? null)})`)
            .join("\n")}`
        : "";
    const rules = policy ? `\n\n# Domain policy you must follow\n${policy}` : "";
    return {
      messages: [{ role: "system", tag: "system", content: SYSTEM + preamble + rules }],
      turns: 0, done: false, finalizing: false, promptTokens: 0, compactions: 0,
    } satisfies CodegenState;
  }

  async migrate(state: Json, _from = 0): Promise<Json> {
    return state;
  }

  async advance(input: { state: Json; events: RuntimeEvent[] }): Promise<AdvanceOutput> {
    const state = structuredClone(input.state) as CodegenState;
    const messages = state.messages;
    let sawModelReply: string | null = null;
    let lastFailure: string | null = null;
    /** Calls the policy is holding for a person. */
    const held: string[] = [];

    for (const e of input.events) {
      const p = e.payload as any;
      switch (e.kind) {
        case "message":
          messages.push({ role: "user", tag: "customer", content: String(p.text) });
          break;
        case "model.failed":
          state.modelFailures = (state.modelFailures ?? 0) + 1;
          lastFailure = String(p.error ?? "model call failed");
          break;
        case "model.response":
          messages.push({ role: "assistant", tag: "agent", content: String(p.text) });
          sawModelReply = String(p.text);
          state.turns++;
          if (p.usage?.promptTokens) state.promptTokens = Number(p.usage.promptTokens);
          break;
        case "js.result": {
          for (const id of (p.heldOperationIds ?? []) as string[]) held.push(id);
          const left = Math.max(0, this.#maxTurns - state.turns);
          messages.push({
            role: "user",
            tag: "execution",
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
            tag: "execution",
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
            tag: "note",
            content:
              "You are out of execution turns. Do not write any more code. " +
              "Answer the original question now using what you already have, and say plainly " +
              "what is missing if anything is.",
          });
          return {
            state: { ...state, finalizing: true },
            status: "waiting",
            commands: [{ kind: "model.request", payload: { messages: plain(messages) } }],
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

    this.#compact(state);
    // A call the policy is holding is not a failure and not something to work
    // around: it is a wait. Asking the model what to do next here is what made
    // it announce that "the restarts could not be completed automatically" and
    // stop — it had no way to know a person was about to decide.
    //
    // Pi answers a blocked call with an ordinary tool result carrying an
    // explanation, which is right; the part that does not carry over is that Pi
    // asks synchronously in a live terminal. Here the task parks instead, and
    // the decision wakes it.
    if (held.length) {
      messages.push({
        role: "user",
        tag: "note",
        content:
          `Held for approval: ${held.length} call(s) require a person to sign off. ` +
          `You are not blocked and nothing failed — the task is paused here and will ` +
          `resume by itself once the decision is made. Do not retry them or look for ` +
          `another route around them.`,
      });
      return {
        state,
        status: "waiting",
        commands: [],
        waits: held.map((operationId) => ({ kind: "operation" as const, operationId })),
      };
    }

    return {
      state,
      status: "waiting",
      commands: [{ kind: "model.request", payload: { messages: plain(state.messages) } }],
      waits: [],
    };
  }
}
