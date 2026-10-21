/**
 * Which tools a conversation's model was last offered, and the one-line notice for those it is offered now and was not.
 *
 * A turn can run on a tool list that is about to move: a mount's list re-taken after a deploy (cf/src/runtime.ts
 * `retakeStaleSnapshots`) lands after the turn that would have used it gave up waiting, and the model, told by its
 * instructions of a tool it was not offered, says it cannot do the thing. The next turn is offered the tool, but the
 * transcript still holds the refusal, and a model reads its own earlier answer as settled. So the message that first
 * reaches a harness offering tools the conversation has not had says so, at its head, naming them — the same place the
 * capability notices go (`#takeNotices`), never the system prompt, which holds what is true for the whole session.
 *
 * Kept per conversation, as the names the harness that took the last message offered. The first message of a
 * conversation records and says nothing: everything is new to it, and its tool list is already in front of it. Only
 * added names are told; a tool taken away is simply not offered, and the model's call to it is refused in words.
 */
type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const TABLE = `CREATE TABLE IF NOT EXISTS tools_seen (
  owner TEXT NOT NULL, conversation TEXT NOT NULL, names TEXT NOT NULL, PRIMARY KEY (owner, conversation))`;

/** How many added names the line spells out; the rest are counted. */
export const TOOLS_CHANGED_NAMES_MAX = 8;

/** A change taken for one message, and what to put back if the message is not written. */
export interface ToolsChange { notice: string; before: string | null; after: string }

const namesOf = (text: string): string[] => { try { const v = JSON.parse(text); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

/** The line for `added` (model tool names), after the harness's own prefix. */
export function toolsChangedLine(added: readonly string[]): string {
  const shown = added.slice(0, TOOLS_CHANGED_NAMES_MAX).map((n) => `\`${n}\``).join(", ");
  const more = added.length > TOOLS_CHANGED_NAMES_MAX ? ` and ${added.length - TOOLS_CHANGED_NAMES_MAX} more` : "";
  return `Your tools changed: you can now use ${shown}${more}. Earlier refusals that depended on missing tools no longer apply.`;
}

/**
 * Record `current` as what this conversation's model is offered, and the notice for what it adds to what was recorded,
 * in one synchronous step, so two messages racing tell it once between them. Null when nothing was recorded yet (the
 * conversation's first message) or nothing was added. `quiet` names tools another notice of the same message already
 * names (a mount's capability line): recorded, not told twice.
 */
export function takeToolsChange(
  sql: Sql, owner: string, conversation: string, current: readonly string[], header: string,
  quiet: (name: string) => boolean = () => false,
): ToolsChange | null {
  sql.exec(TABLE);
  const had = sql.exec("SELECT names FROM tools_seen WHERE owner = ? AND conversation = ?", owner, conversation).toArray()[0];
  const after = JSON.stringify([...new Set(current)].sort());
  const before = had ? String(had.names) : null;
  if (before === after) return null;
  sql.exec("INSERT INTO tools_seen(owner, conversation, names) VALUES (?,?,?) ON CONFLICT(owner, conversation) DO UPDATE SET names = excluded.names",
    owner, conversation, after);
  if (before === null) return null;
  const was = new Set(namesOf(before));
  const added = namesOf(after).filter((n) => !was.has(n) && !quiet(n));
  return added.length ? { notice: header + toolsChangedLine(added), before, after } : null;
}

/** Put back what `takeToolsChange` recorded when the message that carried it was not written, unless something has moved it since. */
export function returnToolsChange(sql: Sql, owner: string, conversation: string, change: ToolsChange): void {
  sql.exec(TABLE);
  const had = sql.exec("SELECT names FROM tools_seen WHERE owner = ? AND conversation = ?", owner, conversation).toArray()[0];
  if (!had || String(had.names) !== change.after || change.before === null) return;
  sql.exec("UPDATE tools_seen SET names = ? WHERE owner = ? AND conversation = ?", change.before, owner, conversation);
}
