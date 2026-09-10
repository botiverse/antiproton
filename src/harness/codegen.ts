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
- Each code block runs in a fresh isolate: no variables, no closures, nothing carried from the
  last one. Carry values forward with output and the next code block. This is about the isolate
  your code runs in — not about you, and not about the container below, which does persist.

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

It is not the isolate your code blocks run in. **The container persists between calls** until
you release it: packages you install, files you write and processes you leave running are all
still there on the next call. Do not reinstall something you already installed.

When you do need it:

- Do the work in as few calls as you can. The calls are not the cost; the wall clock between
  the first and the last is.
- Anything worth keeping — a build output, a report, a diff — save it with \`node.save\` the
  moment it exists. Everything inside the box is destroyed with the box.
- Release it as soon as the work that needed a machine is done, not at the end of the task.
  \`node.release \${ { save: ["/work/report.md"] } }\` does both at once.
- Setting a machine up is usually the slowest part of using one. When you have installed an
  interpreter, a toolchain or a repository, keep it: \`node.keep \${ { name: "py-scipy" } }\`.
  A later task starts from it with \`node.start_from\` instead of installing everything again.
  Keep the environment, not the results — results go to \`node.save\`.`;

/**
 * Messages carry a tag so compaction can distinguish requirements from scratch
 * work. A customer turn is the specification; an execution cycle is working out.
 */
type Tag = "system" | "customer" | "agent" | "execution" | "note";
interface TaggedMessage extends ModelMessage {
  tag: Tag;
}

interface CodegenState {
  /** @see initialize — the harness that owns this checkpoint. */
  harness?: "codegen";
  /**
   * Set while a summarisation request is out. The harness holds no I/O of its
   * own, so compaction is a command like any other: the next model reply is the
   * summary, and folding it in is what clears this.
   */
  compacting?: { keptFrom: number; prior?: string };
  /** Asked for, rather than reached: a person pressed compact, or a model call
   *  came back saying the context is too long. Either way the next advance
   *  summarises before doing anything else. */
  forceCompact?: boolean;
  /** The rolling handover, so a second compaction updates rather than restarts. */
  summary?: string;
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
  /** Whether any code has actually run on this task. */
  ran?: boolean;
}

export interface CompactionConfig {
  /**
   * "none" keeps everything; "cycles" drops old execution cycles; "summarise"
   * asks the model to write down what happened before dropping them.
   *
   * Dropping is cheap and loses the findings, which is the wrong trade for a
   * long investigation: the agent spends twenty turns learning something and
   * then throws away the part that was worth having. pi summarises for this
   * reason, and so does this.
   */
  mode: "none" | "cycles" | "summarise";
  /**
   * Compact once the measured prompt passes this share of the model's context
   * window. A fraction rather than a token count, because the number that
   * matters differs by an order of magnitude between models — 24k tokens is
   * most of a small window and a rounding error in a large one. pi expresses
   * the same thing as `contextWindow - reserveTokens`.
   */
  triggerFraction: number;
  /** Execution cycles kept verbatim after a compaction (the "cycles" mode). */
  keepCycles: number;
  /**
   * The share of the window kept verbatim as the recent tail.
   *
   * pi walks backward accumulating tokens to a budget; without a tokeniser here
   * the walk counts characters, at roughly four per token.
   */
  keepRecentFraction: number;
  /**
   * The other wall, and this one is genuinely absolute: past it the kernel
   * cannot commit the checkpoint at all, whatever model is in use. Compaction
   * starts at half.
   */
  maxCheckpointBytes: number;
}

/** Roughly, and only for turning a token budget into a character budget. */
export const CHARS_PER_TOKEN = 4;

export const NO_COMPACTION: CompactionConfig = {
  mode: "none", triggerFraction: Infinity, keepCycles: 0,
  keepRecentFraction: 1, maxCheckpointBytes: Infinity,
};
export const DEFAULT_COMPACTION: CompactionConfig = {
  mode: "summarise",
  // Leaves room for the reply and for the growth of one more turn.
  triggerFraction: 0.6,
  keepCycles: 3,
  keepRecentFraction: 0.25,
  maxCheckpointBytes: 256 * 1024,
};

/**
 * What a model can hold, when nobody has said.
 *
 * Deliberately small: guessing high means the first sign of trouble is the
 * provider refusing the call, and guessing low costs one early compaction. The
 * real number belongs in configuration next to the model it describes.
 */
export const ASSUMED_CONTEXT_WINDOW = 32_000;

/**
 * What each model can actually hold.
 *
 * A single deployment-wide number was wrong the moment two models were in play,
 * and it was wrong by a factor of eight for the one we were running:
 * `deepseek-v4-pro` holds a million tokens and compaction was firing at 79k.
 * pi keeps this per model in `models.json` for the same reason, which is the
 * shape borrowed here.
 *
 * A name not listed falls back to the conservative assumption: compacting early
 * costs one summary, and guessing high means finding out from a refused call.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4.1-flash-expires-on-0910": 1_000_000,
};

export function contextWindowFor(model: string | undefined, fallback = ASSUMED_CONTEXT_WINDOW): number {
  if (!model) return fallback;
  if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model]!;
  // Dated or suffixed variants of a known model share its window.
  const base = Object.keys(CONTEXT_WINDOWS).find((k) => model.startsWith(k));
  return base ? CONTEXT_WINDOWS[base]! : fallback;
}

/**
 * What the summary must contain, taken from pi's template because it was
 * arrived at by watching agents lose the wrong things: the goal survives, the
 * constraints survive, and what is still open survives. Prose alone does not.
 */
const SUMMARY_SECTIONS = [
  "## Goal", "## Constraints and preferences", "## Progress",
  "## Key decisions", "## Next steps", "## Critical context",
].join("\n");

const SUMMARY_INITIAL =
  "You are compacting a working session so it can continue in a smaller context. " +
  "Write a handover in markdown with exactly these sections:\n\n" + SUMMARY_SECTIONS +
  "\n\nUnder Progress use Done / In progress / Blocked. Record findings, not narration: " +
  "concrete values, identifiers, URLs, file paths and decisions, so the work does not have " +
  "to be redone. Say what was tried and failed, because that is what stops it being tried " +
  "again. Do not include credentials. Output the markdown and nothing else.";

const SUMMARY_UPDATE =
  "You are updating an existing handover with what has happened since. Merge the two into " +
  "one document with the same sections, keeping everything from the old summary that is " +
  "still true, correcting what is not, and folding in the new work. Do not simply append. " +
  "Output the markdown and nothing else.";

/**
 * Where the verbatim tail begins.
 *
 * pi walks backward from the newest message accumulating tokens to a budget and
 * summarises everything before that point. The same walk here counts
 * characters, at roughly four per token. Index 0 is the system message and is
 * never summarised — it is instructions, not history.
 *
 * Shared by both harnesses on purpose: two copies of a retention rule drift,
 * and the one that drifts is the one nobody is looking at.
 */
/**
 * A model call that failed because the context is too long.
 *
 * pi treats this as a compaction trigger rather than an error, and it is the
 * only trigger that is certain: the thresholds are estimates, this is the
 * provider saying it outright. Retrying the same prompt cannot help, so the
 * bounded retry must not be what handles it.
 */
export function isContextOverflow(error: string): boolean {
  return /context.{0,20}(length|window|limit)|too many tokens|maximum context|prompt is too long|reduce the length/i
    .test(error);
}

/**
 * How much of the tail to keep, in characters.
 *
 * Two constraints, and the tail has to satisfy both. It must fit the model's
 * window, which is what `keepRecentFraction` expresses. It must also leave the
 * checkpoint comfortably under the size that triggers a compaction — otherwise
 * compaction cannot make progress: it summarises, keeps a tail that is itself
 * over the threshold, and immediately qualifies again.
 *
 * That is not hypothetical. With a 131,072-token window the first rule alone
 * gave a 128 KB tail against a 128 KB trigger, and one agent compacted twenty-
 * nine times, paying for a model call each time and never getting below the
 * line. Taking the smaller of the two is what makes the operation terminate.
 */
export function keepRecentChars(contextWindow: number, c: CompactionConfig): number {
  const fitsTheModel = contextWindow * c.keepRecentFraction * CHARS_PER_TOKEN;
  // 0.35 of the budget against a trigger at 0.5, so a compacted checkpoint
  // lands well clear of the line rather than just under it.
  const fitsTheStore = c.maxCheckpointBytes * 0.35;
  return Math.min(fitsTheModel, fitsTheStore);
}

export function keepFrom(messages: Array<{ content?: unknown }>, budget: number): number {
  let used = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    used += String(messages[i]!.content ?? "").length;
    if (used > budget) return Math.min(i + 1, messages.length - 1);
  }
  return 1;
}

/** The request that produces the handover: its own instructions, not part of
 *  the conversation, and iterative when a handover already exists. */
export function summaryRequest(
  history: Array<{ role: string; content: string }>,
  prior?: string,
): ModelMessage[] {
  const text = history.map((m) => `${m.content}`).join("\n\n");
  return [
    { role: "system", content: prior ? SUMMARY_UPDATE : SUMMARY_INITIAL },
    {
      role: "user",
      content: (prior ? `# The handover so far\n\n${prior}\n\n# What has happened since\n\n` : "") + text,
    },
  ];
}

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
/**
 * A reply with nothing in it.
 *
 * Chasing calling syntaxes one at a time is a losing game — five turned up —
 * but they share a shape that does not need recognising: once the markup is
 * stripped there is no text. A model that meant to act and mis-said it leaves
 * an empty tag; a model that has finished leaves an answer. So an empty reply
 * is never a finished one, whatever tag it came wrapped in.
 *
 * The two that cost real work: `<semdoc style="display:none"></semdoc>`, which
 * ended a SWE-bench instance after one turn while the reasoning trace showed
 * the model had planned the fix correctly, and `<USER></USER>`.
 */
export function isEmptyReply(text: string): boolean {
  // "No content", not "short content": `Done.` is a real answer and must not be
  // second-guessed. What an empty tag leaves behind is nothing at all.
  const visible = String(text ?? "").replace(/<[^>]*>/g, "");
  return !/[\p{L}\p{N}]/u.test(visible);
}

export function looksLikeToolAttempt(text: string): boolean {
  // Not anchored to "<" immediately followed by the word. DeepSeek's DSML
  // writes `<｜｜DSML｜｜tool_calls>` with full-width bars in between, and the
  // anchor missed it — which ended three SWE-bench instances on their first
  // turn each. The words themselves are the signal; prose does not say
  // "tool_calls".
  return /\b(tool_calls?|function_calls?)\b/i.test(text)
    || /\binvoke\b[\s\S]{0,40}?\bname\s*=/i.test(text)
    // Any tag naming something that looks like a mount address. The one that
    // slipped through was `<system name="tools.search">query: "..."</system>` —
    // a channel the model invented — and because nothing recognised it as an
    // attempt, the harness took the markup for a final answer and ended the
    // task mid-job. The dotted name is the tell, and prose does not have one.
    || /<\s*[a-z_][a-z0-9_]*\s+name\s*=\s*["'][a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*["']/i.test(text)
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

  // Tolerant of whatever decorates the tag name. The anchor used to require
  // "<" then "invoke"; DeepSeek writes `<｜｜DSML｜｜invoke name="shell">` with
  // full-width bars between, and the call was legible to a person and invisible
  // to this. What identifies it is the word and the name attribute, not the
  // punctuation around them.
  const invoke = /<[^>]*?\binvoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<[^>]*?\/\s*[^>]*?\binvoke\b[^>]*>/gi;
  for (let m = invoke.exec(text); m; m = invoke.exec(text)) {
    const args: Record<string, unknown> = {};
    const param = /<[^>]*?\bparameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<[^>]*?\/\s*[^>]*?\bparameter\b[^>]*>/gi;
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
  #contextWindow: number;
  /** Set by the last compaction, for reporting. */
  lastCompaction: { dropped: number; from: number } | null = null;

  constructor(opts: {
    maxTurns?: number;
    compaction?: CompactionConfig;
    /** What the bound model can hold. Configuration, because only the operator
     *  knows which model is bound and what its window is. */
    contextWindow?: number;
  } = {}) {
    this.#maxTurns = opts.maxTurns ?? 8;
    this.#compaction = opts.compaction ?? NO_COMPACTION;
    this.#contextWindow = opts.contextWindow ?? ASSUMED_CONTEXT_WINDOW;
  }

  /** @see keepRecentChars */
  get #keepRecentChars(): number {
    return keepRecentChars(this.#contextWindow, this.#compaction);
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
  /**
   * Drop execution cycles until the checkpoint fits, oldest first.
   *
   * The ordinary compaction is driven by measured prompt size and runs inside
   * advance. That is no help when the *checkpoint* is what is too large,
   * because then advance is the thing being refused. This is the same knife
   * held by the kernel instead, and it keeps the system message and the most
   * recent cycles because those are what the next turn actually needs.
   */
  async shrink(state: Json, targetBytes: number): Promise<Json | null> {
    const s = structuredClone(state) as CodegenState;
    if (!Array.isArray(s.messages) || s.messages.length < 4) return null;
    const size = () => JSON.stringify(s).length;
    let dropped = 0;
    // Never the system message, and never the last few turns.
    while (size() > targetBytes && s.messages.length > 4) {
      const i = s.messages.findIndex((m, idx) => idx > 0 && idx < s.messages.length - 3);
      if (i < 0) break;
      s.messages.splice(i, 1);
      dropped++;
    }
    if (!dropped) return null;
    s.messages.splice(1, 0, {
      role: "user", tag: "note",
      content: `[${dropped} earlier step(s) dropped to fit the checkpoint budget. ` +
        `Anything you still need from them, read back with state.get or re-derive.]`,
    });
    return size() > targetBytes ? null : (s as unknown as Json);
  }

  /**
   * Where the verbatim tail starts.
   *
   * pi walks backward from the newest message accumulating tokens until a
   * budget is reached; everything before that point is summarised. The same
   * walk here counts characters. Index 0 is the system message and is never
   * summarised — it is instructions, not history.
   */
  #keepFrom(state: CodegenState): number {
    return keepFrom(state.messages, this.#keepRecentChars);
  }

  /**
   * The history to be summarised, as plain text.
   *
   * Tool output is truncated hard, the way pi truncates it: a summariser given
   * a megabyte of fetched page will summarise the page instead of the work.
   */
  #serialize(msgs: TaggedMessage[]): string {
    return msgs.map((m) => {
      const who = m.tag === "customer" ? "User" : m.tag === "agent" ? "Assistant"
        : m.tag === "execution" ? "Tool result" : "Note";
      const body = String(m.content ?? "");
      return `[${who}]: ${m.tag === "execution" ? body.slice(0, 2000) : body}`;
    }).join("\n\n");
  }

  /** The request that produces the handover. Not a tool call and not part of
   *  the conversation: a separate ask, with its own instructions. */
  #summaryRequest(state: CodegenState, keptFrom: number): ModelMessage[] {
    return summaryRequest(
      state.messages.slice(1, keptFrom).map((m) => ({
        role: m.role,
        content: `[${m.tag === "customer" ? "User" : m.tag === "agent" ? "Assistant"
          : m.tag === "execution" ? "Tool result" : "Note"}]: ` +
          (m.tag === "execution" ? String(m.content).slice(0, 2000) : String(m.content)),
      })),
      state.summary,
    );
  }

  #compact(state: CodegenState): boolean {
    const c = this.#compaction;
    // "summarise" replaces this rather than running alongside it. Left in, the
    // drop went first and ate the history the summariser was about to be given,
    // so compaction quietly degraded back to forgetting.
    if (c.mode !== "cycles" || state.promptTokens < this.#contextWindow * c.triggerFraction) return false;

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
      // Which harness wrote this. Two harnesses read the same reply in opposite
      // ways — one wants a fenced block, the other native tool calls — so a
      // task must keep the one it started with, whatever the deployment now
      // defaults to. stateVersion cannot carry this: both are version 2.
      harness: "codegen",
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
        // Asked for by a person, through the console.
        case "compact.requested":
          state.forceCompact = true;
          break;
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
        case "model.failed": {
          const err = String(p.error ?? "model call failed");
          // Not a failure to retry: a statement that the prompt does not fit.
          // Retrying it sends the same prompt again and burns the budget.
          if (isContextOverflow(err)) {
            state.forceCompact = true;
            state.compacting = undefined;
            break;
          }
          state.modelFailures = (state.modelFailures ?? 0) + 1;
          lastFailure = err;
          break;
        }
        case "model.response":
          messages.push({ role: "assistant", tag: "agent", content: String(p.text) });
          sawModelReply = String(p.text);
          state.turns++;
          if (p.usage?.promptTokens) state.promptTokens = Number(p.usage.promptTokens);
          break;
        case "js.result": {
          state.ran = true;
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

    // A reply arriving while a summarisation is out is the handover itself, not
    // a turn of the conversation. Fold it in and carry on from where the tail
    // begins; the full history stays in the event log, so shortening what the
    // model is shown destroys nothing.
    if (state.compacting && sawModelReply !== null) {
      const { keptFrom } = state.compacting;
      const summary = sawModelReply.trim();
      // The middle is already gone; the handover takes its place. Any previous
      // handover goes with it, because this one supersedes it.
      const tail = messages.slice(1)
        .filter((m) => !(m.tag === "note" && String(m.content).startsWith("[compacted")));
      state.messages = [
        messages[0]!,
        { role: "user", tag: "note",
          content: `[compacted] Everything before this point has been summarised.\n\n${summary}` },
        ...tail,
      ];
      state.summary = summary;
      state.compacting = undefined;
      state.compactions++;
      this.lastCompaction = { dropped: keptFrom - 1, from: state.promptTokens };
      return {
        state,
        status: "waiting",
        commands: [{ kind: "model.request", payload: { messages: plain(state.messages) } }],
        waits: [],
      };
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
      // The backstop, and the only rule here that does not depend on
      // recognising someone's markup. A task that was asked to do something
      // and finishes before running anything has almost certainly not
      // finished — it has failed to say what it meant, in a syntax nobody has
      // seen yet. Six of those turned up in two days; loosening a pattern
      // after each one is not a strategy. Bounded like the others, so a
      // genuine one-line answer costs one extra round trip and no more.
      const finishedWithoutWorking = !state.ran && state.turns <= 1;
      if (
        (looksLikeToolAttempt(sawModelReply) || isEmptyReply(sawModelReply) || finishedWithoutWorking)
        && nudges < 2
      ) {
        messages.push({
          role: "user",
          tag: "note",
          content:
            "Your last reply contained nothing that could be acted on, so nothing ran. The only " +
            "way to act is a ```js code block, using await tool`alias.name ${args}` and " +
            "output(...). Write your next step as one code block, or answer in plain prose if you " +
            "are genuinely finished — but an empty or markup-only reply is neither.",
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

    // Before asking the model to do more work, check whether it can still be
    // asked at all. Dropping old turns keeps the task alive and loses what it
    // learned; summarising keeps the findings and costs one model call.
    if (this.#shouldSummarise(state)) {
      const keptFrom = this.#keepFrom(state);
      if (keptFrom > 1) {
        const request = this.#summaryRequest(state, keptFrom);
        // Trimmed now, not when the handover comes back. The middle has already
        // been serialised into the request, so keeping it costs the very bytes
        // the compaction exists to reclaim — and when the checkpoint is what is
        // over budget, a compaction that only shrinks later cannot be committed
        // at all. The events are untouched; this is the model's view.
        state.messages = [state.messages[0]!, ...state.messages.slice(keptFrom)];
        state.compacting = { keptFrom, prior: state.summary };
        state.forceCompact = undefined;
        return {
          state,
          status: "waiting",
          commands: [{
            kind: "model.request",
            payload: {
              messages: request,
              // Carried through to the event, so the log says a compaction
              // happened here and where the kept window starts. Nothing is
              // destroyed — the whole history is still in the log — but without
              // this the handover is indistinguishable from an ordinary reply
              // and the seam is invisible.
              purpose: "compaction",
              keptFrom,
              summarised: keptFrom - 1,
            },
          }],
          waits: [],
        };
      }
    }

    return {
      state,
      status: "waiting",
      commands: [{ kind: "model.request", payload: { messages: plain(state.messages) } }],
      waits: [],
    };
  }

  /**
   * Two thresholds, because there are two different walls.
   *
   * The measured prompt is the cost wall and moves first. The checkpoint size
   * is the hard one: past it the kernel cannot commit at all, and the only
   * thing that would shrink the state runs inside the advance being refused —
   * a deadlock that stopped a real session for hours.
   */
  #shouldSummarise(state: CodegenState): boolean {
    if (this.#compaction.mode !== "summarise" || state.compacting) return false;
    // Asked for outright, so neither the finalizing guard nor a threshold
    // applies: a person pressed it, or the provider said the prompt does not fit.
    if (state.forceCompact) return true;
    if (state.finalizing) return false;
    // Relative to what this model can hold, not to a number picked once.
    if (state.promptTokens >= this.#contextWindow * this.#compaction.triggerFraction) return true;
    // And the wall that belongs to this runtime rather than to the model.
    return JSON.stringify(state).length >= this.#compaction.maxCheckpointBytes / 2;
  }
}
