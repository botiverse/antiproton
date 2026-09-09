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
- The sandbox keeps nothing between executions: no variables, no closures. Carry values forward
  with output and the next code block. That is about the sandbox, not about you — see below.

Keep each code block small and purposeful. Prefer one or two calls per block, look at the
result, then decide the next block.

# Remembering

You outlive this task. If a \`state\` mount is listed above, it is your own store, kept per
agent and readable by the person who runs you:

  tool\`state.remember \${ { key: "memory", text: "the deploy window is Tuesdays 02:00 UTC" } }\`

Three documents are shown back to you at the start of every task, so what you put in them you
will see again without going to look: \`memory\` for facts worth having next time, \`todo\` for
what is still open, \`journal\` for what happened. Use \`state.put\` / \`state.get\` for data
rather than notes.

- Write the fact, not the story. "Prefers a dry run first" is worth keeping; a retelling of
  this conversation is not.
- Wrong memory is worse than none, because you will act on it. When something you wrote turns
  out to be false, fix it or \`state.forget\` it.
- Never write a credential, token or key into memory, and do not copy one into output.

# The container

If a \`node\` mount is listed, it is a real machine, and the most expensive thing you can
reach: it is billed for every second it exists, not per call. Use it for what genuinely needs
one — installing packages, building, running a test suite, anything needing a filesystem. Not
for arithmetic, string work or JSON, all of which your ordinary code block does instantly and
for nothing.

When you do need it:

- Do the work in as few calls as you can. The calls are not the cost; the wall clock between
  the first and the last is.
- Anything worth keeping — a build output, a report, a diff — save it with \`node.save\` the
  moment it exists. Everything inside the box is destroyed with the box.
- Release it as soon as the work that needed a machine is done, not at the end of the task.
  \`node.release \${ { save: ["/work/report.md"] } }\` does both at once.`;

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
  /** Times the model was told to use a code block instead of some other
   *  tool-call syntax. Bounded, so a model that cannot comply still answers. */
  formatNudges?: number;
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

/**
 * What to show when the turn budget ran out mid-answer. The model was asked for
 * prose and sometimes returns more code; `replace(fence, "")` removed only the
 * first block because the pattern is not global, so a two-block reply reached
 * the page as a wall of code with no sentence in it.
 */
export function finalText(text: string): string {
  const stripped = text
    .replace(/```(?:js|javascript)\s*\n[\s\S]*?```/g, "")
    .replace(/<\/?(?:pre|code)>/g, "")
    .trim();
  return stripped || "I ran out of execution turns before I could answer. Ask again and I will start fresh.";
}

/**
 * A reply that is plainly an attempted tool call, just not in this harness's
 * syntax. Models drift into whatever convention they were trained on —
 * `<tool_calls><invoke name=...>`, `<function_call>`, a bare JSON call object —
 * and the harness used to treat every one of them as the final answer, so the
 * task "completed" having done nothing and the page showed markup to the user.
 */
export function looksLikeToolAttempt(text: string): boolean {
  return /<\s*(tool_calls?|invoke|function_calls?|antml:invoke)\b/i.test(text)
    || /\btool_call\b\s*[:{]/.test(text)
    || /```(?:json|xml)\s*\n\s*[{<][^`]*"(?:tool|name|function)"/.test(text);
}

/**
 * Translate an attempted tool call in someone else's syntax into this harness's.
 *
 * Cheaper and more reliable than asking the model to rewrite it: the call it
 * meant is fully determined by the markup, so a round trip buys nothing. The
 * output is ordinary code that goes through `js.execute` like any other, so
 * policy, approvals and quota still apply — this changes the syntax accepted,
 * not what is allowed.
 *
 * Handles the two shapes that actually turn up: `<invoke name="alias.tool">`
 * with `<parameter>` children, and `<tool_call>` with a JSON `<arguments>`.
 */
export function codeFromToolAttempt(text: string): string | null {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const invoke = /<(?:antml:)?invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/(?:antml:)?invoke\s*>/gi;
  for (let m = invoke.exec(text); m; m = invoke.exec(text)) {
    const args: Record<string, unknown> = {};
    const param = /<(?:antml:)?parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:antml:)?parameter\s*>/gi;
    for (let q = param.exec(m[2]!); q; q = param.exec(m[2]!)) args[q[1]!] = coerce(q[2]!.trim());
    calls.push({ name: m[1]!.trim(), args });
  }

  const pair = /<tool_call[^>]*>([\s\S]*?)<\/tool_call\s*>/gi;
  for (let m = pair.exec(text); m; m = pair.exec(text)) {
    const name = /<tool_name\s*>([\s\S]*?)<\/tool_name\s*>/i.exec(m[1]!)?.[1]?.trim();
    if (!name) continue;
    const raw = /<arguments\s*>([\s\S]*?)<\/arguments\s*>/i.exec(m[1]!)?.[1]?.trim() ?? "{}";
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
    } catch { /* an unparseable argument block is not a call we can honour */ continue; }
    calls.push({ name, args });
  }

  if (!calls.length) return null;
  // A dotted name is a mount alias plus a tool; anything else the gateway will
  // reject by its own rules, which is where that judgement belongs.
  return calls
    .map(({ name, args }) =>
      `const res = await tool\`${name} \${ ${JSON.stringify(args)} }\`;\noutput(res);`)
    .join("\n");
}

/** `"3"` and `"true"` mean the scalar, not the string, when they parse as one. */
function coerce(v: string): unknown {
  if (/^(-?\d+(\.\d+)?|true|false|null|\{[\s\S]*\}|\[[\s\S]*\])$/.test(v)) {
    try { return JSON.parse(v); } catch { /* it was text after all */ }
  }
  return v;
}

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
    // Injected once, when the task opens, rather than before every turn the way
    // a local harness can afford to: editing the system message costs 6.6x the
    // uncached tokens here, so a working set that changed each turn would cost
    // more than it is worth. Anything written during the task is already in the
    // transcript as a tool result.
    const known = (config as any)?.workingSet ? String((config as any).workingSet) : "";
    return {
      messages: [{ role: "system", tag: "system", content: SYSTEM + preamble + rules + known }],
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
          // A new request from the person gets a fresh execution budget. The
          // budget bounds one request, not the conversation: without this a
          // chat task that has spent its turns can never act again, and every
          // later message is answered "you are out of execution turns" — which
          // is what left a real session unable to do anything but apologise.
          state.turns = 0;
          state.finalizing = false;
          state.formatNudges = 0;
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
      // Accept the harness's own syntax first, then translate a call written in
      // another convention rather than discarding it.
      const code = extractCode(sawModelReply) ?? codeFromToolAttempt(sawModelReply);
      // A spent budget must not discard the work already done: ask for a final
      // answer from what is in context instead of blocking the task.
      if (state.finalizing) {
        return {
          state: { ...state, done: true },
          status: "completed",
          commands: [{ kind: "message.out", payload: { text: finalText(sawModelReply) } }],
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
      // No code, but visibly an attempt to call something: correct the syntax
      // rather than accept markup as the answer.
      const nudges = state.formatNudges ?? 0;
      if (looksLikeToolAttempt(sawModelReply) && nudges < 2) {
        messages.push({
          role: "user",
          tag: "note",
          content:
            "That is not how you call a tool here, so nothing ran. The only way to act is a " +
            "```js code block, using await tool`alias.name ${args}` and output(...). " +
            "Rewrite your last step as one code block, or answer in plain prose if you are done.",
        });
        return {
          state: { ...state, formatNudges: nudges + 1 },
          status: "waiting",
          commands: [{ kind: "model.request", payload: { messages: plain(messages) } }],
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
