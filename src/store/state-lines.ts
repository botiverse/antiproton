/**
 * The line rules of an agent's text documents, written once for both stores.
 *
 * `appendState` and `reviseState` are a read and a write inside one store
 * method, so each store keeps its own; what the new text *is* is decided here,
 * so the sqlite store and the Durable Object store cannot come to disagree about
 * which lines a full document gives up or which line a revision touches.
 *
 * A line is the unit throughout. A document over its cap gives up whole lines
 * from its head, never the end of one: a line cut in half reads as a complete
 * fact that says something else. And what was given up is handed back, so the
 * agent is told what it lost instead of only that it lost something.
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
 * full (`WhenFull`) from `size` to `after` characters, past `max`. `short` is
 * how much content must go first, which is less than `after - max` when blank
 * lines at the head are given up for free. Every number is in the unit the cap
 * is checked in, the text's length, so one `revise` can free enough.
 *
 * The code is `<key>_full`, on the error for the call's record and also at the
 * start of the sentence: the gateway shows the model every plugin error as
 * `tool_error`, so the sentence is the only place the model can read it.
 *
 * The `put` it suggests for blank lines and layout has no number: what binds a
 * `put` is not this cap but `putRefusal`'s, in another unit.
 */
export function documentFull(
  key: string, size: number, after: number, max: number, short: number, text: string, lines: readonly string[],
): Error {
  const code = `${key}_full`;
  return Object.assign(new Error(
    `${code}: \`${key}\` is full: it is ${size} characters, this ${multiline(text) ? "text" : "line"} adds ${after - size} `
    + `to make it ${after}, and it holds at most ${max}, so nothing was written. It keeps its oldest lines rather than `
    + `dropping them: free at least ${short} characters first, by deleting or shortening a line that is no longer true `
    + "with `revise` or dropping the whole document with `forget`, then remember this again. If what has to go is blank "
    + "lines or layout, `put` the document again, shorter, instead: `revise` changes a line that has text on it",
  ), { code, ...listing(key, lines) });
}

/** How many of a full document's lines its refusal lists, and how much of each. */
export const LISTED_LINES_MAX = 50;
export const LISTED_LINE_CHARS = 200;

/**
 * A full document's lines as its refusal lists them, so the agent can choose what to free without reading the
 * document first: numbered as `revise` counts them, blank lines left out (but still counted), each cut to
 * LISTED_LINE_CHARS, the first LISTED_LINES_MAX that say something, then how many more there are. This is the agent's
 * own writing, so it goes in `modelOnlyText`, never in the message, which the trace records. A document with no line
 * that says something lists nothing. A cut line still gives a `revise` match, as the header says: `match` is a piece
 * of a line, so the part shown matches without the `…`.
 */
function listing(key: string, lines: readonly string[]): { modelOnlyText?: string } {
  const said = lines.map((l, n) => ({ n: n + 1, l: l.replace(/\r$/, "") })).filter((x) => !blank(x.l));
  if (!said.length) return {};
  const shown = said.slice(0, LISTED_LINES_MAX).map(({ n, l }) => {
    const cut = l.length > LISTED_LINE_CHARS ? `${l.slice(0, /[\uD800-\uDBFF]/.test(l[LISTED_LINE_CHARS - 1]!) ? LISTED_LINE_CHARS - 1 : LISTED_LINE_CHARS)}…` : l;
    return `${n}: ${cut}`;
  });
  const more = said.length - shown.length;
  const header = `\`${key}\` now, by line number`
    + (shown.some((x) => x.endsWith("…")) ? " (a line ending in … is cut; a part of it without the … still works as a `revise` match):" : ":");
  return { modelOnlyText: [header, ...shown,
    ...(more > 0 ? [`… and ${more} more ${more === 1 ? "line" : "lines"}; \`get\` reads all of it`] : [])].join("\n") };
}

/**
 * The refusal of a text `put` to a document that refuses when full, or null
 * when it may be written. Two limits, each in its own unit and its own
 * sentence. The document's cap, in characters of the text, as `remember`
 * counts it. And the row's: only a `put` can leave a document in object
 * storage (`appendState` always writes it inline), and one left there can no
 * longer be appended to or revised (`documentText`), so a text `put` that
 * would be moved there is refused rather than stored where the next
 * `remember` would be refused for a reason the agent cannot fix by freeing
 * space. `spills` is `put`'s own decision to move the value, not a second
 * judgement of it: non-null exactly when `put` would, with the quantity and the
 * limit it decided by, the length of the JSON and STATE_INLINE_MAX
 * (src/plugins/state-key.ts). No sentence about how much of the document the
 * prompt shows is added to this refusal (`withShown`): that is in characters.
 *
 * The document's size now is left out: every number in one message is in one
 * unit, and the size in the encoded unit would be a second read for a figure
 * that does not change what fits, since a `put` replaces the whole document.
 */
export function putRefusal(
  key: string,
  // A value that is not text has no lines and no character cap: it was never appendable, and the only thing to
  // protect is that it can still be replaced in place.
  value: { text: string; max: number } | { notText: true },
  spills: { encoded: number; inlineMax: number } | null,
): Error | null {
  const code = `${key}_full`;
  const textual = !("notText" in value);
  const text = textual ? value.text : "";
  const max = textual ? value.max : Number.POSITIVE_INFINITY;
  const why = !textual
    ? (spills ? `a value this large is kept in object storage (its JSON encodes to ${spills.encoded}; the limit here is `
        + `${spills.inlineMax}), where \`${key}\` could not be rewritten in place, so nothing was written.` : null)
    : text.length > max
    ? `\`${key}\` holds at most ${max} characters, and this put is ${text.length}, so nothing was written.`
    : spills
      ? `a \`put\` is kept where it can still be appended to and revised only up to ${spills.inlineMax} of its JSON `
        + `encoding, and this one encodes to ${spills.encoded}, so nothing was written. That is the encoded length, not the character count `
        + "`remember` uses: newlines, quotes, backslashes and other control characters count extra."
      : null;
  if (!why) return null;
  const advice = textual ? "Put a shorter document: keep the lines that are still true" : "Put a smaller value";
  return Object.assign(new Error(`${code}: ${why} ${advice}`), { code });
}

/** Whether `text` is more than one line. */
const multiline = (text: string) => /[\r\n]/.test(text);

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
  if (text.length > max) {
    // A document that refuses when full says so by its code here too: the model reads the code only in the sentence.
    const code = whenFull === "refuse" ? `${key}_full` : null;
    // `max` is the whole document's cap, so no freeing of space can make this fit: the only next step is to shorten
    // it or split it. The lines are listed as for a full document, so the agent sees what is already kept.
    throw Object.assign(new Error(
      `${code ? `${code}: ` : ""}${multiline(text) ? "that text" : "that line"} is ${text.length} characters; `
      + `a document holds at most ${max}, so nothing was written`
      + (code ? ". Shorten this, or add it in several smaller pieces, one `remember` per line"
        : ": it is too long; shorten it, or add it in smaller pieces"),
    ), code ? { code, ...listing(key, before.replace(/\r?\n$/, "").split("\n")) } : {});
  }
  const size = before.length;
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  if (before.endsWith(eol)) before = before.slice(0, -eol.length);
  if (!before) return { kept: text, dropped: [] };
  // Split on `\n` alone, so a CRLF line keeps its `\r` and the lengths below stay exact.
  const lines = before.split("\n");
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

/**
 * The document with the one line that contains `match` replaced by `replace`,
 * or removed when `replace` is null.
 *
 * `match` is a piece of a line, not a whole one, and must occur exactly once in
 * the document. A whole-line rule turns a missed space or a retyped date into a
 * refusal and asks the agent to reproduce long lines from a prompt it read many
 * turns ago; the uniqueness rule already guarantees that exactly one line is
 * touched, and the line as it was is handed back, so the wrong one would be
 * visible. Occurrences are counted overlapping, so `aa` in `aaa` is two and is
 * refused: an occurrence count that depends on how it was scanned is not one.
 *
 * The cap refuses only growth: a document already past it (a lower cap set
 * since, or a `put`) can still lose a line or have one shortened. A CRLF line
 * keeps its `\r` when replaced, and `was` is given without it.
 */
export function reviseLines(
  key: string, doc: string, match: string, replace: string | null, max: number,
): { kept: string; line: number; was: string } {
  if (!match) throw new Error("`match` is empty; give a piece of the line to change");
  if (/[\r\n]/.test(match)) throw new Error("`match` is within one line, and this one has a line break in it");
  if (replace !== null && /[\r\n]/.test(replace)) {
    throw new Error("`replace` is one line; add more lines with `remember`");
  }
  const lines = doc.split("\n");
  const hits: number[] = [];
  let occurrences = 0;
  lines.forEach((l, n) => {
    let found = false;
    for (let at = l.indexOf(match); at !== -1; at = l.indexOf(match, at + 1)) { occurrences++; found = true; }
    if (found) hits.push(n + 1);
  });
  if (occurrences === 0) {
    throw new Error(`\`match\` occurs in no line of \`${key}\` (0 matches); get it to see its lines as they are now`);
  }
  if (occurrences > 1) {
    const shown = hits.slice(0, 10).join(", ") + (hits.length > 10 ? `, and ${hits.length - 10} more` : "");
    throw new Error(
      `\`match\` occurs ${occurrences} times in \`${key}\` (line${hits.length === 1 ? "" : "s"} ${shown}); `
      + "nothing was changed. Give a longer piece of the one line you mean",
    );
  }
  const index = hits[0]! - 1;
  const was = lines[index]!;
  const cr = was.endsWith("\r") ? "\r" : "";
  const next = replace === null
    ? [...lines.slice(0, index), ...lines.slice(index + 1)]
    : [...lines.slice(0, index), replace + cr, ...lines.slice(index + 1)];
  const kept = next.join("\n");
  if (kept.length > max && kept.length > doc.length) {
    throw new Error(`that would make \`${key}\` ${kept.length} characters; a document holds at most ${max}, so nothing was changed`);
  }
  return { kept, line: hits[0]!, was: was.slice(0, was.length - cr.length) };
}
