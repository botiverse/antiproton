/**
 * What a pi085 conversation's system prompt shows of the things that move between turns, kept fixed for the
 * conversation's life, and what changed since told as a notice at the head of a later message.
 *
 * The provider caches a request by prefix. On pi085 the system prompt is built when the harness opens, and two of
 * its parts are read from state that a turn can change: the plugins' contributions (the state mount's working set —
 * memory, todo, journal, the seeded files' sizes and `MEMORY.md` — rendered in full) and what the agent is holding
 * (src/runtime/held.ts). The harness is reused while its key (catalogue, persona, binding) holds, which leaves both
 * out, so after a write the prompt stayed as it was until the harness was next opened — an eviction, an idle spell,
 * a mount change — and then came back different a few thousand characters in. Everything after that point, the tool
 * list and the whole conversation, was then sent uncached: 27.1M of 28.6M uncached DeepSeek prompt tokens in one
 * production reading (2026-10).
 *
 * So the two parts are taken once per conversation (`promptContextFor`) and every later open of a harness for it is
 * built from what was taken, byte for byte. What moved since is not lost: before a message reaches the model the
 * runtime compares the parts as they are now with what the model last saw (`takeContextChange`), and when they
 * differ the message carries one notice that says, part by part, what is new — appended lines where a document only
 * grew, the part as it now reads otherwise. The parts are the plugin's own (`Plugin.promptParts`: the state plugin's
 * documents, its seeded files, its headings), compared by key and never parsed, so what the agent wrote cannot be
 * mistaken for structure; text the agent or the setup wrote is fenced in the notice and said to be theirs. Earlier
 * messages are never rewritten; the notice is part of the new message, so the request before it is the request the
 * provider already has.
 *
 * A new conversation (a fresh context, or a transcript with no message yet, as a reused bench object starts) takes
 * the parts again, so a conversation starts from what is true when it starts.
 *
 * pd is not handled here: it records a changed prompt as an inline patch at its place in the transcript
 * (src/model/durable-offloaded.ts `jobContext`), which leaves the prefix before it alone.
 */
import { canonJson } from "../core/canon-json.ts";
import { fenceFor } from "../plugins/state.ts";
import type { PromptPart } from "../plugins/types.ts";
import { piTables } from "../store/pi-storage.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

/** The parts of the system prompt that can move between turns, as the prompt shows them. */
export interface PromptContext {
  /** The mounted plugins' paragraphs, in the gateway's order (`ToolGateway.promptContributions`). */
  contributions: string[];
  /** The same paragraphs as the units a change is told by (`ToolGateway.promptParagraphs`). */
  parts: PromptPart[];
  /** One line per held thing (src/runtime/held.ts `heldItems`). */
  held: string[];
}

/** The key `held` is owed under (`returnContextChange`), beside the parts' own. */
const HELD = "held";

const TABLE = `CREATE TABLE IF NOT EXISTS prompt_context (
  owner TEXT NOT NULL, conversation TEXT NOT NULL, snapshot TEXT NOT NULL, seen TEXT NOT NULL,
  owed TEXT NOT NULL DEFAULT '[]', taken_at INTEGER NOT NULL, PRIMARY KEY (owner, conversation))`;

const asText = (c: PromptContext) => canonJson({ contributions: c.contributions, parts: c.parts, held: c.held });
/** What the model is told about, so what "nothing moved" compares: the parts and the held lines. */
const toldOf = (c: PromptContext) => canonJson({ parts: c.parts, held: c.held });

function parse(text: string): PromptContext {
  const v = JSON.parse(text) as Partial<PromptContext>;
  return {
    contributions: Array.isArray(v.contributions) ? v.contributions.map(String) : [],
    parts: Array.isArray(v.parts) ? v.parts.map((p: any) => ({ key: String(p?.key), label: String(p?.label ?? ""), text: String(p?.text ?? ""), by: p?.by === "agent" || p?.by === "setup" ? p.by : "plugin" })) : [],
    held: Array.isArray(v.held) ? v.held.map(String) : [],
  };
}

const keysOf = (text: string): string[] => { try { const v = JSON.parse(text); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

function row(sql: Sql, owner: string, conversation: string): { snapshot: string; seen: string; owed: string } | null {
  sql.exec(TABLE);
  const r = sql.exec("SELECT snapshot, seen, owed FROM prompt_context WHERE owner = ? AND conversation = ?", owner, conversation).toArray()[0];
  return r ? { snapshot: String(r.snapshot), seen: String(r.seen), owed: String(r.owed ?? "[]") } : null;
}

/**
 * Whether the conversation in `session`'s transcript has a message yet. Until it has, nothing has been sent under
 * the prompt it would be built with, so taking the parts again costs no cached prefix.
 */
export function conversationStarted(sql: Sql, session: string): boolean {
  try { return sql.exec(`SELECT 1 FROM ${piTables(session).entries} WHERE type = 'message' LIMIT 1`).toArray().length > 0; }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return false; throw e; }
}

/**
 * The parts a harness for this conversation is built with: the ones taken when it started, or `current`, taken now,
 * when there are none yet or the conversation has not started (`started` false). Taking them also sets what the model
 * has seen, so a change is told against the prompt it was built with.
 */
export function promptContextFor(sql: Sql, owner: string, conversation: string, current: PromptContext, started: boolean, now: number): PromptContext {
  const had = row(sql, owner, conversation);
  if (had && started) return parse(had.snapshot);
  const text = asText(current);
  sql.exec("INSERT INTO prompt_context(owner, conversation, snapshot, seen, owed, taken_at) VALUES (?,?,?,?,'[]',?)" +
    " ON CONFLICT(owner, conversation) DO UPDATE SET snapshot = excluded.snapshot, seen = excluded.seen, owed = '[]', taken_at = excluded.taken_at",
    owner, conversation, text, text, now);
  return current;
}

/** A change taken for one message: the notice it carries, and what to put back if the message is not written. */
export interface ContextChange { notice: string; before: string; beforeOwed: string; after: string; told: string[] }

/**
 * The notice for what moved since the model last saw these parts, with `seen` moved to `current` in the same
 * synchronous step, so two messages racing tell it once between them. Null when nothing moved and nothing is owed,
 * or the conversation has no parts taken yet (no harness of pi085's has opened on it). `seen` moves only when a notice
 * is returned, so a change is never marked seen without being told.
 */
export function takeContextChange(sql: Sql, owner: string, conversation: string, current: PromptContext, header: string): ContextChange | null {
  const had = row(sql, owner, conversation);
  if (!had) return null;
  const seen = parse(had.seen);
  const owed = new Set(keysOf(had.owed));
  if (toldOf(seen) === toldOf(current) && !owed.size) return null;
  const said = contextNotice(seen, current, owed);
  if (!said) {
    // Nothing a reader could be told: what was owed no longer exists, or only the paragraphs' joins moved.
    if (toldOf(seen) === toldOf(current)) sql.exec("UPDATE prompt_context SET owed = '[]' WHERE owner = ? AND conversation = ?", owner, conversation);
    return null;
  }
  const after = asText(current);
  sql.exec("UPDATE prompt_context SET seen = ?, owed = '[]' WHERE owner = ? AND conversation = ?", after, owner, conversation);
  return { notice: header + said.text, before: had.seen, beforeOwed: had.owed, after, told: said.keys };
}

/**
 * Put back what `takeContextChange` moved, when the message that carried it was not written. When nothing moved it
 * since, `seen` is as it was, so the next message tells the same change. When another message has taken a change in
 * between, `seen` stays — that message told its part — and what this one would have told is owed instead: the next
 * notice gives each of those parts in full, whether or not it moved again.
 */
export function returnContextChange(sql: Sql, owner: string, conversation: string, change: ContextChange) {
  const had = row(sql, owner, conversation);
  if (!had) return;
  if (had.seen === change.after && keysOf(had.owed).length === 0) {
    sql.exec("UPDATE prompt_context SET seen = ?, owed = ? WHERE owner = ? AND conversation = ?",
      change.before, change.beforeOwed, owner, conversation);
    return;
  }
  const owed = [...new Set([...keysOf(had.owed), ...change.told])];
  sql.exec("UPDATE prompt_context SET owed = ? WHERE owner = ? AND conversation = ?", JSON.stringify(owed), owner, conversation);
}

// ---- the notice ------------------------------------------------------------------------------------------------

/** The marker the working set puts where a document was cut to its budget (src/plugins/state.ts `workingSet`). */
const CUT = "…";

/**
 * The lines `now` adds to `before` when it only grew: `before` whole and then more, or — where the document is kept
 * from its end and `now` was cut — some tail of `before` and then more. The cut is at a character, not a line, so the
 * first line kept after it may be the end of a line `before` has whole (or had cut too): it is matched as a suffix.
 * Null when anything else changed.
 */
export function addedLines(before: readonly string[], now: readonly string[]): string[] | null {
  const cutNow = now[0] === CUT;
  // A document that ends in a newline splits into a last empty line, which an append moves; it is not a line of its own.
  const trimEnd = (l: string[]) => { while (l.length && l[l.length - 1] === "") l.pop(); return l; };
  const b = trimEnd(before[0] === CUT ? before.slice(1) : [...before]);
  const n = trimEnd(cutNow ? now.slice(1) : [...now]);
  const equal = (i: number, partialFirst: boolean) => {
    for (let k = 0; k < i; k++) {
      const was = b[b.length - i + k]!, is = n[k]!;
      if (k === 0 && partialFirst ? !was.endsWith(is) : was !== is) return false;
    }
    return true;
  };
  // Only grew: every line it had, then more.
  if (n.length > b.length && equal(b.length, false)) return n.slice(b.length);
  // Cut from the front to fit, so a tail of what it had, then more. The longest overlap is the honest reading.
  if (cutNow) {
    for (let i = Math.min(b.length, n.length - 1); i >= 1; i--) if (equal(i, true)) return n.slice(i);
  }
  return null;
}

const fenced = (text: string) => { const f = fenceFor(text); return `${f}\n${text}\n${f}`; };

/** One part's entry: who wrote it decides whether its text is fenced and said to be theirs. */
function entry(p: PromptPart, how: "added" | "reads" | "empty", text: string): string {
  const whose = p.by === "agent" ? `Your ${p.label}, written by you` : p.label;
  if (how === "empty") return p.by === "plugin" ? `${whose} — no longer applies.` : `${whose} — is now empty.`;
  const what = how === "added" ? "lines added since you last saw it" : "now reads";
  return `${whose} — ${what}:\n${p.by === "plugin" ? text : fenced(text)}`;
}

/**
 * What changed from `before` to `now`, as the body of a notice, with the keys it told; null when nothing a reader could
 * see did. Each part in `owed` is told in full whatever it was compared against.
 */
export function contextNotice(before: PromptContext, now: PromptContext, owed: ReadonlySet<string> = new Set()): { text: string; keys: string[] } | null {
  const was = new Map(before.parts.map((p) => [p.key, p]));
  const is = new Map(now.parts.map((p) => [p.key, p]));
  const out: string[] = [];
  const keys: string[] = [];
  for (const key of [...is.keys(), ...[...was.keys()].filter((k) => !is.has(k))]) {
    const old = was.get(key), cur = is.get(key);
    const oldText = old?.text ?? "", curText = cur?.text ?? "";
    const owing = owed.has(key);
    if (oldText === curText && !owing) continue;
    const part = cur ?? old!;
    if (!curText) {
      if (!oldText && !owing) continue;
      out.push(entry(part, "empty", ""));
    } else {
      const added = oldText && !owing ? addedLines(oldText.split("\n"), curText.split("\n")) : null;
      out.push(added ? entry(part, "added", added.join("\n")) : entry(part, "reads", curText));
    }
    keys.push(key);
  }
  if (before.held.join("\n") !== now.held.join("\n") || owed.has(HELD)) {
    out.push(now.held.length ? `What you are holding now:\n${now.held.join("\n")}` : "You are no longer holding anything.");
    keys.push(HELD);
  }
  if (!out.length) return null;
  return {
    text: "Your instructions above show what was true when this conversation began. This has changed since you " +
      "last saw it, and where the two differ, this is current:\n\n" + out.join("\n\n"),
    keys,
  };
}
