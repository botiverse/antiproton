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
 * `text` added as the document's last line, and the oldest whole lines dropped
 * until the result is at most `max` characters. Text that does not fit even
 * alone is refused rather than cut, so the document is never left holding part
 * of what the agent wrote.
 *
 * `dropped` is the lines that said something, oldest first, without a CRLF
 * document's `\r`: a blank line carries nothing to save again, and counting it
 * would make "3 lines were dropped" mean fewer. Once anything is dropped, blank
 * lines that would now open the document go too, so it does not begin with a
 * gap. A document written with CRLF is appended to with CRLF, and one that
 * ends with a line break (as a seeded file does) has the text added after it,
 * not after a blank line.
 */
export function appendLines(before: string, text: string, max: number): { kept: string; dropped: string[] } {
  if (text.length > max) {
    throw new Error(
      `${/[\r\n]/.test(text) ? "that text" : "that line"} is ${text.length} characters; `
      + `a document holds at most ${max}, so nothing was written`,
    );
  }
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  if (before.endsWith(eol)) before = before.slice(0, -eol.length);
  if (!before) return { kept: text, dropped: [] };
  // Split on `\n` alone, so a CRLF line keeps its `\r` and the lengths below stay exact.
  const lines = before.split("\n");
  // The length of `lines.slice(i).join("\n") + eol + text`, kept as `i` moves.
  let length = before.length + eol.length + text.length;
  let i = 0;
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
