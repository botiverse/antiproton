/**
 * The memory subagent in shadow (`memoryWriter: "shadow"`, src/plugins/state.ts): what it would have done, computed and
 * recorded, never applied. The agent keeps writing its own `memory` with its own tools; each direct write it makes is
 * also handed, as a request, to one short isolated model call that sees the document as it was before that write and
 * proposes its own edits, and the two are compared on the same intent. Beside it, after each finished turn, a smaller
 * call asks only whether a memory intent appeared in the turn (the observer), so a turn where the owner asked for
 * something to be kept and nothing was written can be counted.
 *
 * Who does what:
 * - The state plugin, as the agent's write to `memory` returns, writes the `memory.shadow_due` trace row and then queues
 *   a row in `memory_shadow` (src/store/memory-shadow.ts) with the document before the write and the request derived
 *   from it (`requestOf`). It never waits for the subagent, so the write is neither delayed nor failed by it.
 * - The runtime, once the run that made the write has ended (cf/src/runtime.ts `#memoryAfterRun`), posts one short
 *   session per queued row, keyed `SHADOW_KEY_PREFIX`, and one observer session per finished turn, keyed
 *   `OBSERVE_KEY_PREFIX`. Either is offered no tools at all and answers with JSON in its final text, so nothing it says
 *   can write anything: in shadow there is no tool for it to apply an edit with.
 * - When such a session ends, the runtime reads its answer, judges each proposed edit against the document it was shown
 *   with the state store's own line rules (`simulate`), records the result on the row, and writes the heartbeat: one
 *   `memory.shadow` row (changed, no_change or failed with a code) per run, or one `memory.observe` row per turn.
 *
 * Due rows and heartbeats come from different code: a queued row the runtime never ran shows as a due row with no
 * heartbeat. Every trace row is counts only; the memory, the request and the edits stay in the agent's own storage.
 *
 * Lines that record the owner's explicit preferences or rules carry `OWNER_TAG` at their start, written by the subagent
 * when it writes the line. Which lines are tagged is decided then and never judged again: `simulate` refuses any edit
 * that leaves fewer tagged lines than it found, whatever the edit says about why (`owner_line_deleted`).
 *
 * Compiled by both typecheck programs.
 */
import { appendLines, insertLines, putRefusal, reviseText } from "../store/state-lines.ts";
import { STATE_INLINE_MAX, STATE_KEY } from "../plugins/state-key.ts";

/** The mark at the start of a line, after any list bullet, that records something the owner explicitly asked for (`isOwnerLine`). */
export const OWNER_TAG = "[owner]";

/** A shadow run's short session key: `memory.shadow:<row id>`. */
export const SHADOW_KEY_PREFIX = "memory.shadow:";
/** An observer's short session key: `memory.observe:<trigger>:<called 0|1>:<posted at>`. */
export const OBSERVE_KEY_PREFIX = "memory.observe:";

/** Whether a short session's key is one of this module's: offered no tools, prompted by `MEMORY_SHADOW_PROMPT` or `MEMORY_OBSERVE_PROMPT`. */
export const isMemorySessionKey = (key: string | null | undefined): key is string =>
  typeof key === "string" && (key.startsWith(SHADOW_KEY_PREFIX) || key.startsWith(OBSERVE_KEY_PREFIX));

/** The state tools that write a key: a call of one on `memory` is the agent's direct write. */
export const MEMORY_WRITE_TOOLS: readonly string[] = ["remember", "put", "revise", "insert", "forget"];

/** Whether a state tool call writes `memory`. */
export function isMemoryWrite(tool: string, args: unknown): boolean {
  return MEMORY_WRITE_TOOLS.includes(tool) && !!args && typeof args === "object" && (args as { key?: unknown }).key === "memory";
}

/** The longest request, in characters: a whole `put` of the document fits, with room for the sentence around it. */
export const REQUEST_MAX = 9_000;
/** The most of the conversation one call is shown, in characters; the oldest part is cut first. */
export const CONTEXT_MAX = 12_000;
/** The most of one message or tool result the conversation shows, in characters. */
export const ENTRY_MAX = 1_500;
/** Without a marker, the most recent messages a first run is shown. */
export const FIRST_CONTEXT_MESSAGES = 20;
/**
 * The most shadow runs one run of the agent's starts: each is a model call, and a run that writes `memory` ten times
 * should not cost ten. The rest are finished as `skipped` (`per_run_cap`) with their heartbeats. Three covers the
 * usual turn (one or two writes) with room, and keeps a write-heavy one to a known cost.
 */
export const MEMORY_SHADOW_RUNS_PER_RUN = 3;
/** The most edits one answer may propose; past it the rest are refused as `too_many_ops`. */
export const OPS_MAX = 12;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters]` : s);
const cutHead = (s: string, max: number) => (s.length > max ? `[${s.length - max} earlier characters cut] …${s.slice(s.length - max)}` : s);
const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? null));

/**
 * The request a direct write stands for, in the words the subagent is asked in: the same intent the agent acted on, so
 * its edit and the subagent's can be compared.
 */
export function requestOf(tool: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const said = (() => {
    switch (tool) {
      // The text on lines of its own, as in the other requests, so a line the agent later removes is a whole line here
      // too and is redacted as one (src/store/memory-shadow.ts `redactRow`).
      case "remember": return `Remember this:\n${str(a.text)}`;
      case "insert": return `Add this, at line ${str(a.after_line)}:\n${str(a.text)}`;
      case "revise": return typeof a.new === "string" && a.new !== ""
        ? `Change this text:\n${str(a.old)}\nto:\n${a.new}`
        : `Delete this text:\n${str(a.old)}`;
      case "put": return `Replace the whole memory with:\n${str(a.value)}`;
      case "forget": return "Forget the whole memory.";
      default: return `${tool}: ${str(args)}`;
    }
  })();
  return cut(said, REQUEST_MAX);
}

/** One entry of a session's branch, as the engine gives it (src/runtime/engine.ts `EngineEntry`). */
export type BranchEntry = { id?: unknown; type?: unknown; message?: unknown };
type Msg = { role?: unknown; content?: unknown; toolName?: unknown };

const messageOf = (e: BranchEntry): Msg | null =>
  e?.type === "message" && e.message && typeof e.message === "object" ? e.message as Msg : null;

const textOf = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("") : "";

/** The tool calls an assistant message makes, by the name the model used and the arguments. */
const callsOf = (m: Msg | null): Array<{ name: string; args: unknown }> =>
  m?.role === "assistant" && Array.isArray(m.content)
    ? m.content.filter((c: any) => c?.type === "toolCall" && typeof c.name === "string").map((c: any) => ({ name: c.name as string, args: c.arguments }))
    : [];

/**
 * Messages as the subagent is shown them: who said it, and a tool call or result by name, each cut to `ENTRY_MAX`, the
 * whole kept to `CONTEXT_MAX` by dropping the oldest first. No thinking and no images.
 */
export function renderConversation(entries: readonly BranchEntry[], max = CONTEXT_MAX): string {
  const lines: string[] = [];
  for (const e of entries) {
    const m = messageOf(e);
    if (!m) continue;
    // A user message is cut from its head: the harness puts its notices there, and the person's words come last.
    if (m.role === "user") { const t = textOf(m.content).trim(); if (t) lines.push(`user: ${cutHead(t, ENTRY_MAX)}`); }
    else if (m.role === "assistant") {
      const t = textOf(m.content).trim();
      if (t) lines.push(`assistant: ${cut(t, ENTRY_MAX)}`);
      for (const c of callsOf(m)) lines.push(`assistant called ${c.name} ${cut(JSON.stringify(c.args ?? {}), ENTRY_MAX)}`);
    } else if (m.role === "toolResult") {
      lines.push(`result of ${typeof m.toolName === "string" ? m.toolName : "a tool"}: ${cut(textOf(m.content).trim(), ENTRY_MAX)}`);
    }
  }
  let out = lines.join("\n");
  if (out.length > max) out = `[earlier part cut]\n${out.slice(out.length - max)}`;
  return out;
}

/**
 * The part of a conversation each queued run of one session is shown: the conversation since the previous run's marker,
 * so two writes in one turn are not shown the same messages twice. `since` is the id of the last entry the previous run
 * was shown; when it is null or no longer in the branch (a new conversation, a compaction), a first run is shown the
 * last `FIRST_CONTEXT_MESSAGES` messages. Run k ends at the assistant message that made the k-th memory write after the
 * start (`isWrite`, by the name the model called and its arguments), or at the branch's end when fewer are found (a
 * write from a program, which is no call of the model's). `marker` is the id of the last entry shown, for the next run.
 */
export function contextSlices(
  entries: readonly BranchEntry[], since: string | null, runs: number, isWrite: (name: string, args: unknown) => boolean,
): { slices: BranchEntry[][]; marker: string | null } {
  const found = since === null ? -1 : entries.findIndex((e) => e?.id === since);
  let start: number;
  if (found >= 0) start = found + 1;
  else {
    start = entries.length;
    for (let n = 0; start > 0 && n < FIRST_CONTEXT_MESSAGES; start--) if (messageOf(entries[start - 1]!)) n++;
  }
  const writes: number[] = [];
  for (let i = start; i < entries.length; i++) for (const c of callsOf(messageOf(entries[i]!))) if (isWrite(c.name, c.args)) writes.push(i);
  const slices: BranchEntry[][] = [];
  let from = start, last = start - 1;
  for (let k = 0; k < runs; k++) {
    const end = writes[k] ?? entries.length - 1;
    const to = Math.max(end, from - 1);
    slices.push(entries.slice(from, to + 1));
    last = Math.max(last, to);
    from = to + 1;
  }
  const id = last >= 0 ? entries[last]?.id : null;
  return { slices, marker: typeof id === "string" ? id : since };
}

/** The memory document with its lines numbered, as `insert`'s `after_line` counts them. */
function numbered(memory: string): string {
  if (!memory) return "(empty)";
  return memory.split("\n").map((l, i) => `${i + 1}| ${l}`).join("\n");
}

/** The shadow run's system prompt: the design's rules (docs/plugins.md, "Memory writer"). */
export function memoryShadowPrompt(cap: number): string {
  return [
    `You keep one document, \`memory\`: the standing facts a personal assistant keeps about its owner and its work. It is shown whole to the assistant at the start of every conversation and holds at most ${cap} characters. The assistant has asked for a change to it; you decide the edits.`,
    `Reply with JSON only, nothing else: {"ops": [...]}, at most ${OPS_MAX} edits, each one of:
- {"op": "revise", "key": "memory", "old": "the exact text as it is now, occurring once", "new": "what replaces it; leave out to delete it"}
- {"op": "insert", "key": "memory", "after_line": 0, "text": "one line or several"}  (0 puts it at the top; otherwise after that line, numbered from 1)
- {"op": "remember", "key": "memory", "text": "one line, added at the end"}
- {"op": "put", "key": "notes/<topic>", "value": "text"}  (a separate document for details; it is not shown automatically)
- {"op": "put", "key": "memory", "value": "the whole new document"}  (only when most of it changes)
Reply {"ops": []} when nothing should change.`,
    `Rules:
1. A line that records something the owner explicitly asked for (a preference, a rule, "always", "never", "remember that") starts with "${OWNER_TAG} ", after the list bullet if it has one ("- ${OWNER_TAG} ..."). Decide that when you write the line, from the request and the conversation. Never add the tag to a line already written, and never take it off.
2. Never delete a line that carries "${OWNER_TAG}", and never change what it says. When the document is full you may shorten its wording with a revise of that one line, keeping the tag and the meaning. A put that drops, swaps or untags one is refused.
3. Write the fact, not the story, one fact per line. When something stops being true, replace its line rather than adding one that contradicts it.
4. When the change does not fit in ${cap} characters: first shorten wording, merge duplicates and drop what the conversation shows is no longer true; then move details out: put them into a document of their own (notes/<topic>) and leave a short line in memory that says where they are. Never make room by deleting the oldest lines: being old is not a reason to forget something.
5. Never write a credential.`,
    "The line numbers you are shown are not part of the text: leave them out of `old`.",
  ].join("\n\n");
}

/** The shadow run's input: the document it is to edit, the request, and the conversation since the last run. */
export function shadowInput(o: { memory: string; cap: number; request: string; conversation: string }): string {
  return [
    `The memory document now (${o.memory.length} of ${o.cap} characters), lines numbered:`,
    `<memory>\n${numbered(o.memory)}\n</memory>`,
    "The assistant's request:",
    `<request>\n${o.request}\n</request>`,
    "The conversation since the memory was last updated (the oldest part is cut first when it is long):",
    `<conversation>\n${o.conversation || "(none)"}\n</conversation>`,
  ].join("\n");
}

/** The observer's system prompt: one question, answered with one boolean. */
export const MEMORY_OBSERVE_PROMPT = [
  "You read one turn of a personal assistant's conversation and answer one question: did a memory intent appear in it? It did when the owner asked the assistant to remember something, stated a standing preference or rule (\"always\", \"never again\", \"from now on\"), or said something that contradicts the memory document you are shown. Whether the assistant acted on it does not matter.",
  'Reply with JSON only, nothing else: {"intent": true} or {"intent": false}.',
].join("\n\n");

/** The observer's input: the memory document, then the turn. */
export function observeInput(o: { memory: string; conversation: string }): string {
  return [
    "The memory document:", `<memory>\n${o.memory || "(empty)"}\n</memory>`,
    "The turn:", `<conversation>\n${o.conversation || "(none)"}\n</conversation>`,
  ].join("\n");
}

/** The JSON object in a model's final text: the whole text, or the first fenced block, or the outermost braces. */
function jsonIn(text: string): unknown {
  const t = text.trim();
  const tries = [t, /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1]?.trim(), t.includes("{") ? t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1) : undefined];
  for (const s of tries) {
    if (!s) continue;
    try { return JSON.parse(s); } catch { /* the next form */ }
  }
  return undefined;
}

export type ProposedOp = Record<string, unknown>;

/** A shadow run's answer: its edits, or `unparseable` (no JSON) or `not_ops` (JSON without an `ops` list). */
export function parseProposal(text: string | null): { ok: true; ops: ProposedOp[] } | { ok: false; code: "unparseable" | "not_ops" } {
  const v = text === null ? undefined : jsonIn(text);
  if (v === undefined) return { ok: false, code: "unparseable" };
  const ops = Array.isArray(v) ? v : v && typeof v === "object" ? (v as { ops?: unknown }).ops : undefined;
  if (!Array.isArray(ops)) return { ok: false, code: "not_ops" };
  return { ok: true, ops: ops.map((o) => (o && typeof o === "object" && !Array.isArray(o) ? o as ProposedOp : { op: null })) };
}

/** An observer's answer: whether an intent appeared, or why it could not be read. */
export function parseObservation(text: string | null): { ok: true; intent: boolean } | { ok: false; code: "unparseable" | "not_intent" } {
  const v = text === null ? undefined : jsonIn(text);
  if (v === undefined) return { ok: false, code: "unparseable" };
  const intent = v && typeof v === "object" ? (v as { intent?: unknown }).intent : undefined;
  return typeof intent === "boolean" ? { ok: true, intent } : { ok: false, code: "not_intent" };
}

/** What one proposed edit would have come to. Kept on the private row; only counts of these reach a trace row. */
export interface ShadowOpResult {
  op: string;
  key: string | null;
  /** The edit's arguments as proposed, each string cut at `REQUEST_MAX`. */
  args: Record<string, unknown>;
  result: "accepted" | "refused";
  code?: string;
  /** Whether it changes or removes a line that carries `OWNER_TAG`. */
  touchesOwner: boolean;
  /** Tagged lines it would have removed: non-zero only on a refusal (`owner_line_deleted`). */
  taggedDeleted: number;
}

/** Whether a line carries `OWNER_TAG` at its start, after any list bullet (`- `, `* `). */
export const isOwnerLine = (line: string) => /^\s*(?:[-*]\s+)?\[owner\]/.test(line);
const tagged = (doc: string) => doc.split("\n").filter(isOwnerLine);

/** How many of `before`'s tagged lines are not in `after` as they were, counted with repeats. */
function taggedGone(before: string, after: string): number {
  const left = new Map<string, number>();
  for (const l of tagged(after)) left.set(l, (left.get(l) ?? 0) + 1);
  let gone = 0;
  for (const l of tagged(before)) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1); else gone++;
  }
  return gone;
}

/**
 * Whether `after` is `before` with one tagged line revised in place: the same number of lines, exactly one line
 * different, and that line tagged in both. What "the same line" means for the exception in `simulate`: its position
 * is kept and nothing else in the document moved, so a revise that spans lines, joins or splits them, or drops the tag
 * is not one.
 */
export function revisedInPlace(before: string, after: string): boolean {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length !== b.length) return false;
  const diff = a.map((l, i) => i).filter((i) => a[i] !== b[i]);
  return diff.length === 1 && isOwnerLine(a[diff[0]!]!) && isOwnerLine(b[diff[0]!]!);
}

/** A refusal's code: the store's own (`<key>_full`, `<key>_over_cap`), else a name for the reason. */
function codeOf(e: unknown, fallback: string): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" && /^[a-z_]{1,40}$/.test(c) ? c : fallback;
}

/**
 * Each string argument cut at `REQUEST_MAX`, so a row's size is bounded and not by what the model wrote: a proposal's,
 * and the agent's own write's as its run keeps it (src/plugins/state.ts).
 */
export function boundedArgs(o: ProposedOp): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "op") continue;
    out[k] = typeof v === "string" ? cut(v, REQUEST_MAX) : typeof v === "number" || typeof v === "boolean" || v === null ? v : cut(JSON.stringify(v), REQUEST_MAX);
  }
  return out;
}

/** A line diff, by longest common subsequence: lines added, revised (a removed line paired with an added one in the same place) and deleted. */
export function lineDiff(before: string, after: string): { added: number; revised: number; deleted: number; oldestDeleted: number } {
  const a = before ? before.split("\n") : [], b = after ? after.split("\n") : [];
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return { added: Math.max(0, m - n), revised: Math.min(n, m), deleted: Math.max(0, n - m), oldestDeleted: 0 };
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  let i = 0, j = 0, added = 0, revised = 0, deleted = 0, oldestDeleted = 0, del = 0, add = 0, hunkAt = -1;
  const close = () => {
    const r = Math.min(del, add);
    revised += r; deleted += del - r; added += add - r;
    // A hunk at the very top that removes more than it adds is the document giving up its oldest lines.
    if (hunkAt === 0 && del > add) oldestDeleted += del - add;
    del = 0; add = 0; hunkAt = -1;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { if (del || add) close(); i++; j++; continue; }
    if (hunkAt < 0) hunkAt = i;
    if (j >= m || (i < n && L[i + 1]![j]! >= L[i]![j + 1]!)) { del++; i++; } else { add++; j++; }
  }
  if (del || add) close();
  return { added, revised, deleted, oldestDeleted };
}

/** The counts a shadow run's heartbeat carries: numbers and fixed codes, never text. */
export interface ShadowCounts {
  ops: number; put: number; revise: number; insert: number; remember: number; forget: number; other: number;
  accepted: number; refused: number; refusedCodes: Record<string, number>;
  touchesOwner: number; taggedDeletions: number; taggedAdded: number;
  /** Tagged lines reworded in place (`revisedInPlace`), which may change what they say: counted apart, not refused. */
  taggedRevised: number;
  moved: number; movedWithPointer: number;
  linesAdded: number; linesRevised: number; linesDeleted: number; oldestDeleted: number;
  charsBefore: number; charsAfter: number; cap: number;
}

/**
 * The proposed edits applied in order to a copy of `memory`, with the state store's own line rules (src/store/state-lines.ts)
 * and cap, so a refusal is the one the real tool would have given, by its code; a refused edit leaves the copy as it
 * was, as the tool does. Nothing is written anywhere: this is what the edits would have come to.
 *
 * Held to more than the tools are, since the subagent is the writer under test:
 * - an edit that leaves any of the `OWNER_TAG` lines it found not as they were is refused as `owner_line_deleted` and
 *   counted in `taggedDeletions`, one per such line, whatever it adds in their place: a `put` that swaps one tagged line
 *   for another, or untags one, is a deletion. The one exception is a `revise` of one tagged line in place
 *   (`revisedInPlace`), counted in `taggedRevised`. It may change what the line says, not only shorten it: code cannot
 *   tell a compression from a change of meaning, and the agent's own direct writes can make the same change today, so
 *   it is counted for the comparison rather than refused;
 * - only `memory` is edited: a `put` of another key is the move the rules ask for and is accepted (`moved`, and
 *   `movedWithPointer` when the document it leaves names that key); any other edit of another key, or a `forget` of
 *   anything, is refused (`outside_memory`, `forget_refused`).
 */
export function simulate(memory: string, proposed: readonly ProposedOp[], cap: number): { after: string; results: ShadowOpResult[]; counts: ShadowCounts } {
  let doc = memory;
  const results: ShadowOpResult[] = [];
  const movedKeys: string[] = [];
  let taggedAdded = 0, taggedRevised = 0;
  proposed.forEach((o, n) => {
    const op = typeof o.op === "string" ? o.op : "other";
    const key = typeof o.key === "string" ? o.key : null;
    const base = { op, key, args: boundedArgs(o) };
    const refuse = (code: string, extra: Partial<ShadowOpResult> = {}) =>
      results.push({ ...base, result: "refused", code, touchesOwner: false, taggedDeleted: 0, ...extra });
    if (n >= OPS_MAX) return refuse("too_many_ops");
    if (key === null || !STATE_KEY.test(key) || key.split("/").some((s) => s === "." || s === "..")) return refuse("invalid_key");
    if (op === "forget") return refuse("forget_refused", { touchesOwner: tagged(doc).length > 0 && key === "memory" });
    if (key !== "memory") {
      if (op !== "put") return refuse("outside_memory");
      if (typeof o.value !== "string" || !o.value.trim()) return refuse("value_not_text");
      if (JSON.stringify(o.value).length > STATE_INLINE_MAX) return refuse("value_too_large");
      movedKeys.push(key);
      return results.push({ ...base, result: "accepted", touchesOwner: false, taggedDeleted: 0 });
    }
    let next: string;
    try {
      switch (op) {
        case "revise": {
          if (typeof o.old !== "string" || !o.old) return refuse("revise_no_old");
          const count = doc.split(o.old).length - 1;
          if (count === 0) return refuse("revise_no_match");
          if (count > 1) return refuse("revise_ambiguous");
          next = reviseText("memory", doc, o.old, typeof o.new === "string" && o.new !== "" ? o.new : null, cap).kept;
          break;
        }
        case "insert": {
          if (typeof o.after_line !== "number" || !Number.isInteger(o.after_line) || typeof o.text !== "string" || !o.text.trim()) return refuse("bad_args");
          next = insertLines("memory", doc, o.after_line, o.text.trimEnd(), cap).kept;
          break;
        }
        case "remember": {
          const text = typeof o.text === "string" ? o.text.trim() : "";
          if (!text) return refuse("bad_args");
          next = appendLines("memory", doc, text, cap, "refuse").kept;
          break;
        }
        case "put": {
          if (typeof o.value !== "string") return refuse("value_not_text");
          const spills = JSON.stringify(o.value).length > STATE_INLINE_MAX;
          const refused = putRefusal("memory", { text: o.value, max: cap, current: doc.length, editable: true, lines: doc.split("\n") },
            spills ? { encoded: JSON.stringify(o.value).length, inlineMax: STATE_INLINE_MAX } : null);
          if (refused) return refuse(codeOf(refused, "memory_full"));
          next = o.value;
          break;
        }
        default: return refuse("unknown_op");
      }
    } catch (e) {
      // The store's errors without a code are a revise past the cap (`memory_full` in all but name) and an insert's line
      // number out of range.
      return refuse(codeOf(e, op === "insert" && !(e as { size?: unknown })?.size ? "insert_out_of_range" : "memory_full"));
    }
    const gone = taggedGone(doc, next);
    // The one change a tagged line may take: a `revise` of that line alone, in place (`revisedInPlace`). Any other edit
    // that leaves one of its tagged lines not as it was is a deletion, however many tagged lines it leaves: a swap of
    // one for another loses the first.
    const inPlace = gone > 0 && op === "revise" && revisedInPlace(doc, next);
    if (gone > 0 && !inPlace) return refuse("owner_line_deleted", { touchesOwner: true, taggedDeleted: gone });
    if (inPlace) taggedRevised++;
    taggedAdded += Math.max(0, tagged(next).length - tagged(doc).length);
    results.push({ ...base, result: "accepted", touchesOwner: gone > 0, taggedDeleted: 0 });
    doc = next;
  });
  const diff = lineDiff(memory, doc);
  const refusedCodes: Record<string, number> = {};
  for (const r of results) if (r.result === "refused") refusedCodes[r.code!] = (refusedCodes[r.code!] ?? 0) + 1;
  const count = (op: string) => results.filter((r) => r.op === op).length;
  const counts: ShadowCounts = {
    ops: results.length, put: count("put"), revise: count("revise"), insert: count("insert"), remember: count("remember"), forget: count("forget"),
    other: results.filter((r) => !["put", "revise", "insert", "remember", "forget"].includes(r.op)).length,
    accepted: results.filter((r) => r.result === "accepted").length, refused: results.filter((r) => r.result === "refused").length, refusedCodes,
    touchesOwner: results.filter((r) => r.touchesOwner).length, taggedDeletions: results.reduce((s, r) => s + r.taggedDeleted, 0), taggedAdded,
    taggedRevised, moved: movedKeys.length, movedWithPointer: movedKeys.filter((k) => doc.includes(k)).length,
    linesAdded: diff.added, linesRevised: diff.revised, linesDeleted: diff.deleted, oldestDeleted: diff.oldestDeleted,
    charsBefore: memory.length, charsAfter: doc.length, cap,
  };
  return { after: doc, results, counts };
}

/**
 * The tool a memory subagent that is the only writer would be called through (`memoryWriter: "subagent"`, not built
 * yet). Named here so a turn that calls it counts as one where the agent changed its memory (`calledMemory`), the same
 * definition in every mode, and the observer's counts stay comparable across them.
 */
export const MEMORY_UPDATE_TOOL = "memory_update";

/**
 * Whether a call the model made, by the name it used and its arguments, is a write to `memory` on one of `aliases` (the
 * agent's state mounts), or a `MEMORY_UPDATE_TOOL` call. Names are `modelToolName(alias, tool)`, always qualified
 * (src/runtime/pi-tools.ts), so no other mount's tool can match.
 */
export function memoryCallMatcher(aliases: readonly string[], nameOf: (alias: string, tool: string) => string): {
  isWrite: (name: string, args: unknown) => boolean; isChange: (name: string, args: unknown) => boolean;
} {
  const writes = new Map<string, string>();
  const updates = new Set<string>();
  for (const a of aliases) {
    for (const t of MEMORY_WRITE_TOOLS) writes.set(nameOf(a, t), t);
    updates.add(nameOf(a, MEMORY_UPDATE_TOOL));
  }
  const isWrite = (name: string, args: unknown) => { const t = writes.get(name); return t !== undefined && isMemoryWrite(t, args); };
  return { isWrite, isChange: (name, args) => isWrite(name, args) || updates.has(name) };
}

/** The entries of the last turn in a branch: from its last user message to its end. */
export function lastTurn(entries: readonly BranchEntry[]): BranchEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) if (messageOf(entries[i]!)?.role === "user") return entries.slice(i);
  return [...entries];
}

/** Whether any assistant message in `entries` makes a call `isChange` counts. */
export function calledMemory(entries: readonly BranchEntry[], isChange: (name: string, args: unknown) => boolean): boolean {
  return entries.some((e) => callsOf(messageOf(e)).some((c) => isChange(c.name, c.args)));
}

/** An observer session's key, carrying what its row needs: which session it read, whether the turn changed memory, and when it was posted. */
export function observeKey(trigger: "chat" | "check", called: boolean, at: number): string {
  return `${OBSERVE_KEY_PREFIX}${trigger}:${called ? 1 : 0}:${at}`;
}

export function readObserveKey(key: string): { trigger: "chat" | "check"; called: boolean; at: number } | null {
  const m = /^memory\.observe:(chat|check):([01]):(\d+)$/.exec(key);
  return m ? { trigger: m[1] as "chat" | "check", called: m[2] === "1", at: Number(m[3]) } : null;
}

/**
 * A finished shadow run's heartbeat attributes: its counts, the agent's own edit as a line diff of the same document, and
 * whether the two left the same document. Numbers, booleans and fixed codes only.
 */
export function heartbeatAttrs(o: {
  job: string; trigger: "chat" | "check"; error?: string; counts?: ShadowCounts; before?: string; main?: string; after?: string; mainResult?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { job: o.job, trigger: o.trigger };
  if (o.error) out.error = o.error;
  if (o.counts) Object.assign(out, o.counts);
  if (o.before !== undefined && o.main !== undefined) {
    const d = lineDiff(o.before, o.main);
    Object.assign(out, { mainLinesAdded: d.added, mainLinesRevised: d.revised, mainLinesDeleted: d.deleted, mainResult: o.mainResult ?? "ok" });
    if (o.after !== undefined) out.sameAsMain = o.after === o.main;
  }
  return out;
}
