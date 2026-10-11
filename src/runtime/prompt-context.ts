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
 * differ the message carries one notice that says, section by section, what is new — appended lines where a document
 * only grew, the section as it now reads otherwise. Earlier messages are never rewritten; the notice is part of the
 * new message, so the request before it is the request the provider already has.
 *
 * A new conversation (a fresh context, or a transcript with no message yet, as a reused bench object starts) takes
 * the parts again, so a conversation starts from what is true when it starts.
 *
 * pd is not handled here: it records a changed prompt as an inline patch at its place in the transcript
 * (src/model/durable-offloaded.ts `jobContext`), which leaves the prefix before it alone.
 */
import { canonJson } from "../core/canon-json.ts";
import { fencedLines } from "../plugins/state.ts";
import { piTables } from "../store/pi-storage.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

/** The parts of the system prompt that can move between turns, as the prompt shows them. */
export interface PromptContext {
  /** The mounted plugins' paragraphs, in the gateway's order (`ToolGateway.promptContributions`). */
  contributions: string[];
  /** One line per held thing (src/runtime/held.ts `heldItems`). */
  held: string[];
}

const TABLE = `CREATE TABLE IF NOT EXISTS prompt_context (
  owner TEXT NOT NULL, conversation TEXT NOT NULL, snapshot TEXT NOT NULL, seen TEXT NOT NULL,
  taken_at INTEGER NOT NULL, PRIMARY KEY (owner, conversation))`;

const asText = (c: PromptContext) => canonJson({ contributions: c.contributions, held: c.held });

function parse(text: string): PromptContext {
  const v = JSON.parse(text) as Partial<PromptContext>;
  return { contributions: Array.isArray(v.contributions) ? v.contributions.map(String) : [], held: Array.isArray(v.held) ? v.held.map(String) : [] };
}

function row(sql: Sql, owner: string, conversation: string): { snapshot: string; seen: string } | null {
  sql.exec(TABLE);
  const r = sql.exec("SELECT snapshot, seen FROM prompt_context WHERE owner = ? AND conversation = ?", owner, conversation).toArray()[0];
  return r ? { snapshot: String(r.snapshot), seen: String(r.seen) } : null;
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
  sql.exec("INSERT INTO prompt_context(owner, conversation, snapshot, seen, taken_at) VALUES (?,?,?,?,?)" +
    " ON CONFLICT(owner, conversation) DO UPDATE SET snapshot = excluded.snapshot, seen = excluded.seen, taken_at = excluded.taken_at",
    owner, conversation, text, text, now);
  return current;
}

/** A change taken for one message: the notice it carries, and what to put back if the message is not written. */
export interface ContextChange { notice: string; before: string; after: string }

/**
 * The notice for what moved since the model last saw these parts, with `seen` moved to `current` in the same
 * synchronous step, so two messages racing tell it once between them. Null, and nothing written, when nothing moved
 * or the conversation has no parts taken yet (no harness of pi085's has opened on it).
 */
export function takeContextChange(sql: Sql, owner: string, conversation: string, current: PromptContext, header: string): ContextChange | null {
  const had = row(sql, owner, conversation);
  if (!had) return null;
  const after = asText(current);
  if (after === had.seen) return null;
  const body = contextNotice(parse(had.seen), current);
  sql.exec("UPDATE prompt_context SET seen = ? WHERE owner = ? AND conversation = ?", after, owner, conversation);
  // Unequal texts with nothing to say (a paragraph that only moved whitespace): seen moves, nobody is told.
  if (!body) return null;
  return { notice: header + body, before: had.seen, after };
}

/** Put back what `takeContextChange` moved, when the message that carried it was not written. Only if nothing moved it since. */
export function returnContextChange(sql: Sql, owner: string, conversation: string, change: ContextChange) {
  sql.exec(TABLE);
  sql.exec("UPDATE prompt_context SET seen = ? WHERE owner = ? AND conversation = ? AND seen = ?",
    change.before, owner, conversation, change.after);
}

// ---- the notice ------------------------------------------------------------------------------------------------

interface Section { key: string; heading: string | null; body: string[] }

/** A heading's identity across renders: its text without a trailing parenthetical, which can carry a size. */
const keyOf = (heading: string) => heading.replace(/\s*\([^()]*\)\s*$/, "").trim();

/**
 * A paragraph's sections, split at its markdown headings outside code fences. Text before the first heading is a
 * section of its own, keyed by its whole text, so any change to it reads as the old one gone and a new one there.
 */
export function sectionsOf(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const { line, fenced } of fencedLines(text)) {
    if (!fenced && /^#{1,6} /.test(line)) {
      cur = { key: keyOf(line), heading: line, body: [] };
      out.push(cur);
      continue;
    }
    if (!cur) { cur = { key: "", heading: null, body: [] }; out.push(cur); }
    cur.body.push(line);
  }
  for (const s of out) {
    while (s.body.length && !s.body[s.body.length - 1]!.trim()) s.body.pop();
    while (s.body.length && !s.body[0]!.trim()) s.body.shift();
    if (s.heading === null) s.key = `¶${s.body.join("\n")}`;
  }
  return out.filter((s) => s.heading !== null || s.body.length);
}

/** The marker the working set puts where a document was cut to its budget (src/plugins/state.ts `workingSet`). */
const CUT = "…";

/**
 * The lines `now` adds to `before` when it only grew: `before` whole and then more, or — where the document is kept
 * from its end and `now` was cut — some tail of `before` and then more. Null when anything else changed.
 */
export function addedLines(before: readonly string[], now: readonly string[]): string[] | null {
  const cutNow = now[0] === CUT;
  const b = before[0] === CUT ? before.slice(1) : [...before];
  const n = cutNow ? now.slice(1) : [...now];
  const equal = (i: number) => {
    for (let k = 0; k < i; k++) if (n[k] !== b[b.length - i + k]) return false;
    return true;
  };
  // Only grew: every line it had, then more.
  if (n.length > b.length && equal(b.length)) return n.slice(b.length);
  // Cut from the front to fit, so a tail of what it had, then more. The longest overlap is the honest reading.
  if (cutNow) {
    for (let i = Math.min(b.length, n.length - 1); i >= 1; i--) if (equal(i)) return n.slice(i);
  }
  return null;
}

/** What changed from `before` to `now`, as the lines of a notice; null when nothing a reader could see did. */
export function contextNotice(before: PromptContext, now: PromptContext): string | null {
  const was = new Map<string, Section>();
  for (const c of before.contributions) for (const s of sectionsOf(c)) if (!was.has(s.key)) was.set(s.key, s);
  const is = new Map<string, Section>();
  for (const c of now.contributions) for (const s of sectionsOf(c)) if (!is.has(s.key)) is.set(s.key, s);
  const parts: string[] = [];
  for (const [key, s] of is) {
    const old = was.get(key);
    if (old && old.heading === s.heading && old.body.join("\n") === s.body.join("\n")) continue;
    const added = old && old.heading === s.heading ? addedLines(old.body, s.body) : null;
    if (s.heading === null) parts.push(`New:\n${s.body.join("\n")}`);
    else if (added) parts.push(`${s.heading} — added since you last saw it:\n${added.join("\n")}`);
    else parts.push(`${s.heading} — now reads:${s.body.length ? `\n${s.body.join("\n")}` : " (empty)"}`);
  }
  for (const [key, s] of was) {
    if (is.has(key)) continue;
    parts.push(s.heading !== null ? `${s.heading} — no longer there.`
      : `No longer applies: "${cutTo(s.body.join(" "), 160)}"`);
  }
  if (before.held.join("\n") !== now.held.join("\n")) {
    parts.push(now.held.length ? `What you are holding now:\n${now.held.join("\n")}` : "You are no longer holding anything.");
  }
  if (!parts.length) return null;
  return "Your instructions above show what was true when this conversation began. This has changed since you " +
    "last saw it, and where the two differ, this is current:\n\n" + parts.join("\n\n");
}

const cutTo = (s: string, n: number) => s.length <= n ? s : `${s.slice(0, n - 1)}…`;
