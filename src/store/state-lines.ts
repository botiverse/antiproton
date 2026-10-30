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

/**
 * `text` added as the document's last line, and the oldest whole lines dropped
 * until the result is at most `max` characters. A line that does not fit even
 * alone is refused rather than cut, so the document is never left holding part
 * of the line the agent wrote.
 */
export function appendLines(before: string, text: string, max: number): { kept: string; dropped: string[] } {
  if (text.length > max) {
    throw new Error(`that line is ${text.length} characters; a document holds at most ${max}, so nothing was written`);
  }
  if (!before) return { kept: text, dropped: [] };
  const lines = before.split("\n");
  // The length of `lines.slice(i).join("\n") + "\n" + text`, kept as `i` moves.
  let length = before.length + 1 + text.length;
  let i = 0;
  while (length > max && i < lines.length) {
    // The line and the newline that followed it.
    length -= lines[i]!.length + 1;
    i++;
  }
  const rest = lines.slice(i);
  return { kept: rest.length ? `${rest.join("\n")}\n${text}` : text, dropped: lines.slice(0, i) };
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
  const next = replace === null
    ? [...lines.slice(0, index), ...lines.slice(index + 1)]
    : [...lines.slice(0, index), replace, ...lines.slice(index + 1)];
  const kept = next.join("\n");
  if (kept.length > max) {
    throw new Error(`that would make \`${key}\` ${kept.length} characters; a document holds at most ${max}, so nothing was changed`);
  }
  return { kept, line: hits[0]!, was };
}
