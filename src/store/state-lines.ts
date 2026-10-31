/**
 * The line rules of an agent's text documents, written once for both stores.
 *
 * `appendState`, `reviseState` and `insertState` are a read and a write inside
 * one store method, so each store keeps its own; what the new text *is* is
 * decided here, so the sqlite store and the Durable Object store cannot come to
 * disagree about which lines a full document gives up, which text a revision
 * touches or where an insert lands.
 *
 * A line is the unit of what a full document gives up and of where `insert`
 * puts text. A document over its cap gives up whole lines from its head, never
 * the end of one: a line cut in half reads as a complete fact that says
 * something else. And what was given up is handed back, so the agent is told
 * what it lost instead of only that it lost something. `revise` is the
 * exception: it replaces exact text, which may be part of a line or span
 * several, because the document is one text the agent edits, not a list of
 * entries (`reviseText`).
 */
import type { Json } from "../core/types.ts";

/**
 * The text of a document an edit may change, or why it may not be changed.
 * Absent is empty. A value kept in object storage would have to be fetched and
 * rewritten, the read-modify-write appending exists to avoid; a value `put`
 * stored that is not a string has no lines, and treating it as empty is how an
 * append used to throw it away.
 */
export function documentText(key: string, prior: { value: Json; ref: string | null } | null, verb: string): string {
  if (!prior) return "";
  if (prior.ref) throw new Error(`\`${key}\` is too large to ${verb}; read it and put a new one`);
  if (typeof prior.value !== "string") {
    throw new Error(
      `\`${key}\` holds ${prior.value === null ? "null" : Array.isArray(prior.value) ? "a list" : typeof prior.value === "object" ? "an object" : `a ${typeof prior.value}`}, `
      + `not a text document, so it has no lines to ${verb}; it is unchanged. Use another key, or put a new value here`,
    );
  }
  return prior.value;
}

/** Whether a line says nothing: empty, or only spaces and a `\r`. */
const blank = (line: string) => !line.trim();

/**
 * What a document does when a line does not fit: give up its oldest lines, or
 * refuse the line. A log's oldest lines are the ones least worth keeping; a
 * document of standing facts or open commitments is the other way round, and
 * losing its head silently is losing what the owner said or what was promised.
 */
export type WhenFull = "drop" | "refuse";

/**
 * The refusal of a `remember` that would take a document that refuses when
 * full (`WhenFull`) from `size` to `after` characters, past `max`, or of an
 * `insert`, which never drops lines on any document. `short` is how much
 * content must go first, which is less than `after - max` when blank lines at
 * the head are given up for free. Every number is in the unit the cap is
 * checked in, the text's length, so one `revise` can free enough.
 *
 * The code is `<key>_full`, on the error for the call's record and also at the
 * start of the sentence: the gateway shows the model every plugin error as
 * `tool_error`, so the sentence is the only place the model can read it. `size`
 * is on the error too, so a caller can say whether the prompt shows all of it.
 *
 * The `put` it suggests for blank lines and layout has no number: what binds a
 * `put` is not this cap but `putRefusal`'s, in another unit.
 */
export function documentFull(
  key: string, size: number, after: number, max: number, short: number, text: string, lines: readonly string[],
  verb: "remember" | "insert" = "remember",
): Error {
  const code = `${key}_full`;
  return Object.assign(new Error(
    `${code}: \`${key}\` is full: it is ${size} characters, this ${multiline(text) ? "text" : "line"} adds ${after - size} `
    + `to make it ${after}, and it holds at most ${max}, so nothing was written. `
    + (verb === "insert" ? "An insert never drops lines to make room" : "It keeps its oldest lines rather than dropping them")
    + `: free at least ${short} characters first, by deleting or shortening a line that is no longer true `
    + `with \`revise\` or dropping the whole document with \`forget\`, then ${verb} this again. If what has to go is blank `
    + "lines or layout, `put` the document again, shorter, instead",
  ), { code, size, ...listing(key, lines) });
}

/**
 * The refusal of a write that would grow a document already past its cap before it, `size` characters to `max`: a
 * cap lowered since it was written (`memory`'s to 8,000, from 64 KiB) leaves such a document, and no write that adds
 * to it can fit however little it adds. Coded `<key>_over_cap`, apart from `<key>_full`'s ordinary filling, so the
 * record can count the documents left there without opening any. It says what still works, so the agent is not left
 * thinking the document is stuck: a `revise` that does not lengthen it, a `forget`, or a shorter `put`. `size` and
 * the listing are as on `documentFull`'s.
 */
export function documentOverCap(key: string, size: number, max: number, lines: readonly string[]): Error {
  const code = `${key}_over_cap`;
  return Object.assign(new Error(
    `${code}: \`${key}\` is ${size} characters; its cap is ${max}, and it was already over before this write, so `
    + "nothing was written. What still works: `revise` and `forget` can shrink it (on a document over its cap, a "
    + "`revise` is refused only if it makes it longer), and so can a `put` of a shorter one",
  ), { code, size, ...listing(key, lines) });
}

/** How many of a full document's lines its refusal lists, and how much of each. */
export const LISTED_LINES_MAX = 50;
export const LISTED_LINE_CHARS = 200;

/**
 * A full document's lines as its refusal lists them, so the agent can choose what to free without reading the
 * document first: numbered as `insert` and `revise`'s refusals count them, blank lines left out (but still counted),
 * each cut to LISTED_LINE_CHARS, the first LISTED_LINES_MAX that say something, then how many more there are. This is
 * the agent's own writing, so it goes in `modelOnlyText`, never in the message, which the trace records. A document
 * with no line that says something lists nothing. A cut line still gives a `revise` `old`, as the header says: `old`
 * may be a piece of a line, so the part shown matches without the `…`.
 */
function listing(key: string, lines: readonly string[]): { modelOnlyText?: string } {
  const said = lines.map((l, n) => ({ n: n + 1, l: l.replace(/\r$/, "") })).filter((x) => !blank(x.l));
  if (!said.length) return {};
  // Whether a line was cut is recorded where it is cut, not read back from the text: a line the agent wrote may itself
  // end in "…".
  let cut = false;
  const shown = said.slice(0, LISTED_LINES_MAX).map(({ n, l }) => {
    if (l.length <= LISTED_LINE_CHARS) return `${n}: ${l}`;
    cut = true;
    return `${n}: ${l.slice(0, /[\uD800-\uDBFF]/.test(l[LISTED_LINE_CHARS - 1]!) ? LISTED_LINE_CHARS - 1 : LISTED_LINE_CHARS)}…`;
  });
  const more = said.length - shown.length;
  const header = `\`${key}\` now, by line number`
    + (cut ? " (a line ending in … is cut; a part of it without the … still works as `revise`'s `old`):" : ":");
  return { modelOnlyText: [header, ...shown,
    ...(more > 0 ? [`… and ${more} more ${more === 1 ? "line" : "lines"}; \`get\` reads all of it`] : [])].join("\n") };
}

/**
 * The refusal of a text `put` to a document that refuses when full, or null
 * when it may be written. Two limits, each in its own unit and its own
 * sentence.
 *
 * The document's cap, in characters of the text, as `remember` counts it, and
 * held as `revise` holds it: only growth past it is refused. `current` is the
 * document's length now, in that unit, read from its text and never from the
 * row's `bytes` (the encoded length); a document already past its cap (a lower
 * cap set since, as `memory`'s 8,000 is for one written under 64 KiB) can then
 * be brought back with one `put` that is shorter, even if still past it. Zero
 * when there is no document or it is not text; a document kept in object
 * storage is `Infinity`, since any value that stays inline is smaller than it.
 *
 * And the row's, which is absolute: only a `put` can leave a document in object
 * storage (`appendState` always writes it inline), and one left there can no
 * longer be appended to or revised (`documentText`), so a text `put` that would
 * be moved there is refused rather than stored where the next `remember` would
 * be refused for a reason the agent cannot fix by freeing space. `spills` is
 * `put`'s own decision to move the value, not a second judgement of it:
 * non-null exactly when `put` would, with the quantity and the limit it decided
 * by, the length of the JSON and STATE_INLINE_MAX (src/plugins/state-key.ts).
 * Its advice is about the encoding, never "shorter": a put with fewer
 * characters than the document can still encode longer, by its newlines and
 * quotes. Where the document is text kept inline (`editable`), it can be
 * shrunk where it is, by `revise` and `forget`, which no size of `put` stops:
 * a `todo` grown by `remember` can be inline at up to 64 KiB of text, past
 * what any `put` of it whole may encode to. No sentence about how much of the
 * document the prompt shows is added to this refusal (`withShown`): that is in
 * characters.
 *
 * The document's size now is left out of the encoded sentence: every number in
 * one message is in one unit, and the size in the encoded unit would be a
 * second read for a figure that does not change what fits.
 */
export function putRefusal(
  key: string,
  // A value that is not text has no lines and no character cap: it was never appendable, and the only thing to
  // protect is that it can still be replaced in place.
  // `lines`, the current text's, for the listing of an over-cap refusal.
  value: { text: string; max: number; current: number; editable: boolean; lines?: readonly string[] } | { notText: true; editable: boolean },
  spills: { encoded: number; inlineMax: number } | null,
): Error | null {
  const code = `${key}_full`;
  const textual = !("notText" in value);
  const shrink = value.editable
    ? ` To shrink the \`${key}\` kept now where it is, delete or shorten text in it with \`revise\`, or drop it with \`forget\`.`
    : "";
  if (textual && value.text.length > value.max && value.text.length > value.current) {
    if (value.current > value.max && Number.isFinite(value.current)) {
      return documentOverCap(key, value.current, value.max, value.lines ?? []);
    }
    return Object.assign(new Error(
      `${code}: \`${key}\` holds at most ${value.max} characters, and this put is ${value.text.length}, so nothing was written. `
      + "Put a shorter document: keep the lines that are still true",
    ), { code, size: value.current });
  }
  if (!spills) return null;
  const why = !textual
    ? `a value this large is kept in object storage (its JSON encodes to ${spills.encoded}; the limit here is `
      + `${spills.inlineMax}), where \`${key}\` could not be rewritten in place, so nothing was written. Put a smaller value.`
    : `a \`put\` is kept where it can still be appended to and revised only up to ${spills.inlineMax} of its JSON `
      + `encoding, and this one encodes to ${spills.encoded}, so nothing was written. That is the encoded length, not the character count `
      + "`remember` uses: newlines, quotes, backslashes and other control characters count extra. A `put` of text fits "
      + "only if it encodes to that or less: fewer of those characters, or less text.";
  return Object.assign(new Error(`${code}: ${why}${textual ? shrink : ""}`), { code });
}

/** Whether `text` is more than one line. */
const multiline = (text: string) => /[\r\n]/.test(text);

/**
 * The refusal of text longer than the whole cap, `max`, which no freeing of space can make fit: the only next step is
 * to shorten it or split it. With `verb`, the call that refuses rather than drops (`remember` on a document that
 * refuses when full, or any `insert`), it carries the code `<key>_full`, in the sentence too, since the model reads the
 * code only there, and lists the document's lines as for a full document, so the agent sees what is already kept.
 * `size`, the document's length now, is on the error as on `documentFull`'s, so a caller can say whether the prompt
 * shows all of it.
 */
function tooLong(
  key: string, size: number, text: string, max: number, verb: "remember" | "insert" | null, lines: readonly string[],
): Error {
  const code = verb ? `${key}_full` : null;
  return Object.assign(new Error(
    `${code ? `${code}: ` : ""}${multiline(text) ? "that text" : "that line"} is ${text.length} characters; `
    + `a document holds at most ${max}, so nothing was written`
    + (verb ? `. Shorten this, or add it in several smaller pieces, one \`${verb}\` per ${verb === "insert" ? "piece" : "line"}`
      : ": it is too long; shorten it, or add it in smaller pieces"),
  ), code ? { code, size, ...listing(key, lines) } : {});
}

/**
 * `text` added as the document's last line, and the oldest whole lines dropped
 * until the result is at most `max` characters. Text that does not fit even
 * alone is refused rather than cut, so the document is never left holding part
 * of what the agent wrote. With `whenFull` "refuse", text that would need any
 * line with something on it dropped is refused instead, with the code
 * `<key>_full`, and the document is unchanged: the agent decides what to give
 * up, with `revise`, `forget` or `put`. Blank lines at its head still go.
 *
 * `dropped` is the lines that said something, oldest first, without a CRLF
 * document's `\r`: a blank line carries nothing to save again, and counting it
 * would make "3 lines were dropped" mean fewer. Once anything is dropped, blank
 * lines that would now open the document go too, so it does not begin with a
 * gap. A document written with CRLF is appended to with CRLF, and one that
 * ends with a line break (as a seeded file does) has the text added after it,
 * not after a blank line.
 */
export function appendLines(
  key: string, before: string, text: string, max: number, whenFull: WhenFull,
): { kept: string; dropped: string[] } {
  // How the document splits into lines is worked out once, here, for every branch below.
  const size = before.length;
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  if (before.endsWith(eol)) before = before.slice(0, -eol.length);
  // Split on `\n` alone, so a CRLF line keeps its `\r` and the lengths below stay exact.
  const lines = before.split("\n");
  // Past its cap already, nothing added can fit, whatever its length: that is what the agent has to be told first.
  if (whenFull === "refuse" && size > max) throw documentOverCap(key, size, max, lines);
  if (text.length > max) throw tooLong(key, size, text, max, whenFull === "refuse" ? "remember" : null, lines);
  if (!before) return { kept: text, dropped: [] };
  // The length of `lines.slice(i).join("\n") + eol + text`, kept as `i` moves.
  let length = before.length + eol.length + text.length;
  let i = 0;
  if (length > max && whenFull === "refuse") {
    // Blank lines at the head say nothing, so giving them up loses nothing and is not the loss refusing prevents:
    // they go for free, and only content that would still have to go is refused. `revise` could not remove them.
    let free = length;
    while (free > max && i < lines.length && blank(lines[i]!)) { free -= lines[i]!.length + 1; i++; }
    if (free > max) throw documentFull(key, size, length, max, free - max, text, lines);
    length = free;
  }
  while (length > max && i < lines.length) {
    // The line and the newline that followed it.
    length -= lines[i]!.length + 1;
    i++;
  }
  if (i > 0) while (i < lines.length && blank(lines[i]!)) i++;
  const rest = lines.slice(i);
  const dropped = lines.slice(0, i).filter((l) => !blank(l)).map((l) => l.replace(/\r$/, ""));
  return { kept: rest.length ? `${rest.join("\n")}${eol}${text}` : text, dropped };
}


/** The line breaks of `text` made `eol`'s, so text written with `\n` matches and lands in a CRLF document as CRLF. */
const withEol = (text: string, eol: string) => eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;

/** `text` as a reply quotes it: a CRLF document's `\r` left out. */
const unCr = (text: string) => text.replace(/\r\n/g, "\n");

/** The 1-based line `at` (an index into `doc`) falls on. */
const lineAt = (doc: string, at: number) => {
  let n = 1;
  for (let i = doc.indexOf("\n"); i !== -1 && i < at; i = doc.indexOf("\n", i + 1)) n++;
  return n;
};

/**
 * The document with the one occurrence of `old` replaced by `next`, or removed when `next` is null or empty: the
 * `str_replace` of Anthropic's memory tool and Letta's core memory, because the document is one text the agent edits
 * freely, not a list of entries. Only `old` itself changes; the text around it on its lines is kept.
 *
 * `old` may span lines, and must occur exactly once in the whole document: with zero or several occurrences nothing is
 * changed, and the refusal gives the count and the lines they start on, so the agent can give more of the text around
 * the one it means. Occurrences are counted overlapping, so `aa` in `aaa` is two and is refused: an occurrence count
 * that depends on how it was scanned is not one.
 *
 * Deleting text that is a whole line or several, from a line's start to a line's end and not itself beginning or ending
 * with a line break, takes one line break with it, so deleting a line leaves no blank line where it was; any other
 * deletion removes exactly `old`.
 *
 * The cap refuses only growth: a document already past it (a lower cap set since, or a `put`) can still lose text or
 * have it shortened. In a CRLF document `old` and `next` are read with their line breaks as CRLF, and `was` and `now`
 * are given without the `\r`; `line` and `lastLine` are where the replaced text started and ended, from 1.
 */
export function reviseText(
  key: string, doc: string, old: string, next: string | null, max: number,
): { kept: string; line: number; lastLine: number; was: string; now: string | null } {
  if (!old) throw new Error("`old` is empty; give the exact text to change, as it is now");
  const eol = doc.includes("\r\n") ? "\r\n" : "\n";
  const o = withEol(old, eol);
  const n = next ? withEol(next, eol) : "";
  const starts: number[] = [];
  for (let at = doc.indexOf(o); at !== -1; at = doc.indexOf(o, at + 1)) starts.push(at);
  if (starts.length === 0) {
    throw new Error(
      `\`old\` occurs nowhere in \`${key}\` (0 matches), so nothing was changed. It must be the text exactly as it is now, `
      + "spaces and line breaks included; `get` reads it",
    );
  }
  if (starts.length > 1) {
    const lines = [...new Set(starts.map((at) => lineAt(doc, at)))];
    const shown = lines.slice(0, 10).join(", ") + (lines.length > 10 ? `, and ${lines.length - 10} more` : "");
    throw new Error(
      `\`old\` occurs ${starts.length} times in \`${key}\`, starting on line${lines.length === 1 ? "" : "s"} ${shown}; `
      + "nothing was changed. Give more of the text around the one you mean, so that it occurs once",
    );
  }
  let from = starts[0]!, to = from + o.length;
  if (!n) {
    const startsLine = from === 0 || doc[from - 1] === "\n";
    const endsLine = to === doc.length || doc.startsWith(eol, to);
    if (startsLine && endsLine && !/^[\r\n]|[\r\n]$/.test(o)) {
      if (to < doc.length) to += eol.length;
      else if (from > 0) from -= doc.slice(0, from).endsWith(eol) ? eol.length : 1;
    }
  }
  const kept = doc.slice(0, from) + n + doc.slice(to);
  if (kept.length > max && kept.length > doc.length) {
    if (doc.length > max) throw documentOverCap(key, doc.length, max, doc.split("\n"));
    throw Object.assign(
      new Error(`that would make \`${key}\` ${kept.length} characters; a document holds at most ${max}, so nothing was changed`),
      { size: doc.length },
    );
  }
  const at = starts[0]!;
  return {
    kept, line: lineAt(doc, at), lastLine: lineAt(doc, at + Math.max(0, o.length - 1)),
    was: unCr(o), now: n ? unCr(n) : null,
  };
}

/**
 * The document with `text` put in as its own line or lines after line `afterLine` (0 for the top, the line count for
 * the end), counted as the refusal's listing counts them: a document that ends with a line break has no empty line
 * after it, and keeps the break. A line number past the end is refused, not clamped: the agent meant a place, and the
 * nearest one may be the wrong one.
 *
 * An insert never drops lines, on any document: what it adds goes where the agent put it, which may be the top, the
 * part a full document gives up first. So past the cap it is refused as `<key>_full`, with the listing, as `remember`
 * is on a document that refuses when full; only growth is refused, as for `revise`.
 */
export function insertLines(
  key: string, before: string, afterLine: number, text: string, max: number,
): { kept: string; line: number } {
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const trailing = before.endsWith(eol);
  const body = trailing ? before.slice(0, -eol.length) : before;
  // Split on `\n` alone, as the listing and `revise`'s line numbers are, so a line number means the same line to all
  // three in a document whose lines end differently; each line keeps its own `\r`.
  const lines = before ? body.split("\n") : [];
  if (!Number.isInteger(afterLine) || afterLine < 0 || afterLine > lines.length) {
    throw new Error(
      `\`after_line\` is ${afterLine}, and \`${key}\` has ${lines.length} ${lines.length === 1 ? "line" : "lines"}, so it must be `
      + `a whole number from 0 (the top) to ${lines.length} (the end); nothing was written`,
    );
  }
  // Only the inserted text and the one line break it adds take the document's `eol`: every character already there is
  // kept as it is, the break after line `afterLine` included.
  const t = withEol(text, eol);
  if (before.length > max) throw documentOverCap(key, before.length, max, lines);
  if (t.length > max) throw tooLong(key, before.length, text, max, "insert", lines);
  const head = lines.slice(0, afterLine).join("\n");
  const kept = (afterLine === 0
    ? (lines.length ? t + eol + body : t)
    : afterLine === lines.length
      ? head + eol + t
      : head + "\n" + t + eol + lines.slice(afterLine).join("\n")) + (trailing ? eol : "");
  if (kept.length > max && kept.length > before.length) {
    throw documentFull(key, before.length, kept.length, max, kept.length - max, text, lines, "insert");
  }
  return { kept, line: afterLine + 1 };
}

/**
 * What a row's `bytes` holds: the length of the value's JSON, the quantity `put` decides the inline limit and the
 * store's total by. One unit for every writer, so `stateUsage`, `list` and the total a `put` is checked against add up
 * the same thing; a text document's length in characters, the unit its cap is in, is what the replies call
 * `characters`.
 */
export const storedBytes = (value: Json) => JSON.stringify(value ?? null).length;

/**
 * The refusal of a write that would take the agent's store past `max`, its `maxTotalBytes`, from `current`, both in
 * `storedBytes`. Coded `store_full` so the plugin can name the tool on its own mount, which a store does not know.
 */
export function storeFull(max: number, current: number, alias?: string): Error {
  return Object.assign(new Error(
    `this would take the store past ${max} bytes (currently ${current}); `
    + `delete something with the \`forget\` tool${alias ? ` on \`${alias}\`` : ""}`,
  ), { code: "store_full", max, current });
}

/**
 * Whether a document written as `next` bytes over a row of `own` bytes would take a store of `total` past `max`; only
 * growth is refused, so a document can always be shrunk in a full store.
 */
export function totalRefusal(total: number, own: number, next: number, max: number, alias?: string): Error | null {
  return next > own && total - own + next > max ? storeFull(max, total, alias) : null;
}

/** The marker, in `counters`, that a store's rows have had their `bytes` made `storedBytes`. */
export const STATE_BYTES_MARKER = "agent_state_bytes_encoded";

/**
 * Once per store: every inline row's `bytes` made `storedBytes` of its value. Rows written before this held a text
 * document's length in characters there, rows `put` wrote held their JSON's, and the total was the sum of both units.
 * A row kept in object storage keeps the `bytes` `put` gave it, which was already the JSON's length. Done in JS rather
 * than SQL, since SQLite's `length` counts code points and the JSON's length here is in UTF-16 units, as `put`'s is.
 * Run inside the store's transaction; the marker makes every later open a single lookup.
 */
export function backfillStateBytes(
  all: (q: string, ...b: unknown[]) => any[], run: (q: string, ...b: unknown[]) => void,
): number {
  if (all("SELECT value FROM counters WHERE name=?", STATE_BYTES_MARKER).length) return 0;
  let changed = 0;
  for (const r of all("SELECT tenant_id, agent_id, key, value, bytes FROM agent_state WHERE ref IS NULL")) {
    const bytes = storedBytes(r.value == null ? null : JSON.parse(r.value));
    if (Number(r.bytes) === bytes) continue;
    run("UPDATE agent_state SET bytes=? WHERE tenant_id=? AND agent_id=? AND key=?", bytes, r.tenant_id, r.agent_id, r.key);
    changed++;
  }
  run("INSERT INTO counters(name, value) VALUES (?, 1)", STATE_BYTES_MARKER);
  return changed;
}
