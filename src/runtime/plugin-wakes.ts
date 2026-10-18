/**
 * The plugin code the runtime owes a call (`Plugin.afterTurn`, `Plugin.wake`, src/plugins/types.ts), kept in the
 * agent's own storage, so an eviction between "owed" and "done" asks again rather than forgetting. Read and cleared by
 * the alarm pass (`AgentRuntime.step` → `#runPluginHooks`, cf/src/runtime.ts).
 *
 * Three tables, one per stage:
 * - **a turn's end**, owed once per turn to every mount whose plugin takes it: keyed by the turn's operation id, and
 *   kept after it is handled (`handled`), so one recorded again — a cancel and a step can both see the same run
 *   end — is told once. Handled rows go after a day;
 * - **a wake**, owed per mount at a time: one row per alias, which a second ask can only bring forward. `gen` moves
 *   with every ask, so the pass that ran a wake drops only the row it ran, and an ask that landed meanwhile stays;
 * - **an answer** a hook gave (`PluginNext`), written in the same transaction that marks its turn end handled or
 *   drops its wake, so a hook that has answered is never asked again. Its turn is posted once: the row is marked
 *   `posting` just before the post's write, and a row found `posting` later is dropped rather than posted twice.
 */
import type { PluginNext, TurnEnd } from "../plugins/types.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const HANDLED_KEPT_MS = 24 * 3_600_000;

export function ensurePluginWakeTables(sql: Sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS plugin_turn_ends (seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, at INTEGER NOT NULL, handled INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS plugin_wakes (alias TEXT PRIMARY KEY, at INTEGER NOT NULL, gen INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS plugin_answers (seq INTEGER PRIMARY KEY AUTOINCREMENT, alias TEXT NOT NULL, body TEXT NOT NULL, posting INTEGER NOT NULL DEFAULT 0)");
}

/**
 * Whether this agent was ever owed a plugin call: the tables are made by the first record of one, so an agent that
 * never had a plugin taking these hooks is asked one read and given no tables.
 */
export function keepsPluginCalls(sql: Sql): boolean {
  return sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'plugin_answers'").toArray().length > 0;
}

/** A turn's end, owed to the plugins that take it. The same turn told again is ignored. */
export function recordTurnEnd(sql: Sql, operationId: string, end: TurnEnd, at: number) {
  ensurePluginWakeTables(sql);
  sql.exec("INSERT OR IGNORE INTO plugin_turn_ends (operation_id, body, at) VALUES (?, ?, ?)", operationId, JSON.stringify(end), at);
}

export function pendingTurnEnds(sql: Sql): Array<{ seq: number; operationId: string; end: TurnEnd }> {
  ensurePluginWakeTables(sql);
  return sql.exec("SELECT seq, operation_id, body FROM plugin_turn_ends WHERE handled IS NULL ORDER BY seq").toArray()
    .map((r) => ({ seq: Number(r.seq), operationId: String(r.operation_id), end: JSON.parse(String(r.body)) as TurnEnd }));
}

export function turnEndHandled(sql: Sql, seq: number, now: number) {
  sql.exec("UPDATE plugin_turn_ends SET handled = ? WHERE seq = ?", now, seq);
  sql.exec("DELETE FROM plugin_turn_ends WHERE handled IS NOT NULL AND handled < ?", now - HANDLED_KEPT_MS);
}

/** Ask for the mount's `wake` at `at`; an earlier ask already kept stays. */
export function askWake(sql: Sql, alias: string, at: number) {
  ensurePluginWakeTables(sql);
  sql.exec("INSERT INTO plugin_wakes (alias, at, gen) VALUES (?, ?, 1) " +
    "ON CONFLICT(alias) DO UPDATE SET at = MIN(at, excluded.at), gen = gen + 1", alias, at);
}

export function dueWakes(sql: Sql, now: number): Array<{ alias: string; gen: number }> {
  ensurePluginWakeTables(sql);
  return sql.exec("SELECT alias, gen FROM plugin_wakes WHERE at <= ? ORDER BY at, alias", now).toArray()
    .map((r) => ({ alias: String(r.alias), gen: Number(r.gen) }));
}

/** The wake that ran, unless it was asked for again meanwhile. */
export function dropWake(sql: Sql, alias: string, gen: number) {
  sql.exec("DELETE FROM plugin_wakes WHERE alias = ? AND gen = ?", alias, gen);
}

/** When the next wake is due, or null with none kept. */
export function nextWakeAt(sql: Sql): number | null {
  ensurePluginWakeTables(sql);
  const r = sql.exec("SELECT MIN(at) AS at FROM plugin_wakes").toArray()[0];
  return r && r.at !== null && r.at !== undefined ? Number(r.at) : null;
}

export function keepAnswer(sql: Sql, alias: string, next: PluginNext) {
  ensurePluginWakeTables(sql);
  sql.exec("INSERT INTO plugin_answers (alias, body) VALUES (?, ?)", alias, JSON.stringify(next));
}

export function pendingAnswers(sql: Sql): Array<{ seq: number; alias: string; next: PluginNext; posting: boolean }> {
  ensurePluginWakeTables(sql);
  return sql.exec("SELECT seq, alias, body, posting FROM plugin_answers ORDER BY seq").toArray()
    .map((r) => ({ seq: Number(r.seq), alias: String(r.alias), next: JSON.parse(String(r.body)) as PluginNext, posting: Number(r.posting) === 1 }));
}

export function markAnswerPosting(sql: Sql, seq: number) {
  sql.exec("UPDATE plugin_answers SET posting = 1 WHERE seq = ?", seq);
}

export function dropAnswer(sql: Sql, seq: number) {
  sql.exec("DELETE FROM plugin_answers WHERE seq = ?", seq);
}

/**
 * How a settled run ended, from its status and the branch's last message: the model's text when that message is the
 * model's, a cancel when the run or the message was aborted, a failure when either says so.
 */
export function turnEndOf(status: string, last: unknown): TurnEnd {
  const m = last && typeof last === "object" ? last as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown } : null;
  const mine = m?.role === "assistant";
  const text = mine && Array.isArray(m!.content)
    ? m!.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text as string).join("")
    : "";
  const finalText = text.trim() ? text : null;
  if (status === "aborted" || (mine && m!.stopReason === "aborted")) return { finalText, outcome: "cancelled" };
  if (status === "failed" || (mine && m!.stopReason === "error")) {
    const error = mine && typeof m!.errorMessage === "string" && m!.errorMessage.trim() ? m!.errorMessage : `the run ended ${status}`;
    return { finalText, outcome: "failed", error: error.slice(0, 300) };
  }
  return { finalText, outcome: "completed" };
}
