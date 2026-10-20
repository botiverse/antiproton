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
 *   `posting` just before the post's write, and a row found `posting` later is dropped rather than posted twice;
 * - **a turn a hook asked for**, by its run's operation id, with the mount and the key it gave, so its end is told to
 *   that mount with that key (`TurnEnd.turnKey`) and to every other mount as a turn it did not ask for. The key is
 *   written down (`plugin_turn_asked`) in the same synchronous step as the post's write, before the run's id is known,
 *   and bound to it once it is; an eviction between the two is bound when the run's end is recorded;
 * - **a conversation's reasoning level** a hook set for the main conversation its `fresh` turn starts
 *   (`PluginNext.reasoning`), by that conversation's id, made only by the first hook that sets one.
 */
import type { PluginNext, TurnEnd } from "../plugins/types.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const HANDLED_KEPT_MS = 24 * 3_600_000;

export function ensurePluginWakeTables(sql: Sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS plugin_turn_ends (seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, at INTEGER NOT NULL, handled INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS plugin_wakes (alias TEXT PRIMARY KEY, at INTEGER NOT NULL, gen INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS plugin_turns (operation_id TEXT PRIMARY KEY, alias TEXT NOT NULL, turn_key TEXT NOT NULL, at INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS plugin_turn_asked (id INTEGER PRIMARY KEY CHECK (id = 1), alias TEXT NOT NULL, turn_key TEXT NOT NULL, at INTEGER NOT NULL)");
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
export function recordTurnEnd(sql: Sql, operationId: string, end: Omit<TurnEnd, "turnId" | "turnKey">, at: number) {
  ensurePluginWakeTables(sql);
  // A turn asked for whose run's id was never bound (an eviction right after its post) is this one: nothing else
  // starts a run between a post and its end being recorded.
  const asked = sql.exec("SELECT alias, turn_key FROM plugin_turn_asked WHERE id = 1").toArray()[0];
  if (asked && sql.exec("SELECT 1 AS x FROM plugin_turns WHERE operation_id = ?", operationId).toArray().length === 0) {
    bindTurn(sql, operationId, String(asked.alias), String(asked.turn_key), at);
  }
  sql.exec("INSERT OR IGNORE INTO plugin_turn_ends (operation_id, body, at) VALUES (?, ?, ?)", operationId, JSON.stringify(end), at);
}

/** The ends not yet told, each as a given mount is to be told it: with the key that mount gave, if it asked for the turn. */
export function pendingTurnEnds(sql: Sql): Array<{ seq: number; operationId: string; endFor(alias: string): TurnEnd }> {
  ensurePluginWakeTables(sql);
  return sql.exec("SELECT seq, operation_id, body FROM plugin_turn_ends WHERE handled IS NULL ORDER BY seq").toArray().map((r) => {
    const operationId = String(r.operation_id), end = JSON.parse(String(r.body)) as Omit<TurnEnd, "turnId" | "turnKey">;
    const asked = sql.exec("SELECT alias, turn_key FROM plugin_turns WHERE operation_id = ?", operationId).toArray()[0];
    return {
      seq: Number(r.seq), operationId,
      endFor: (alias: string) => ({ ...end, turnId: operationId, turnKey: asked && String(asked.alias) === alias ? String(asked.turn_key) : null }),
    };
  });
}

/** A turn about to be posted for a mount, under its key: called synchronously just before the post's write. */
export function askedTurn(sql: Sql, alias: string, turnKey: string, now: number) {
  ensurePluginWakeTables(sql);
  sql.exec("INSERT OR REPLACE INTO plugin_turn_asked (id, alias, turn_key, at) VALUES (1, ?, ?, ?)", alias, turnKey, now);
}

/** The turn a mount's answer started, by its run's operation id; a day of them is kept, past any turn's end. */
export function bindTurn(sql: Sql, operationId: string, alias: string, turnKey: string, now: number) {
  ensurePluginWakeTables(sql);
  sql.exec("DELETE FROM plugin_turn_asked WHERE id = 1 AND turn_key = ?", turnKey);
  sql.exec("INSERT OR REPLACE INTO plugin_turns (operation_id, alias, turn_key, at) VALUES (?, ?, ?, ?)", operationId, alias, turnKey, now);
  sql.exec("DELETE FROM plugin_turns WHERE at < ?", now - HANDLED_KEPT_MS);
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

/** Ask for the mount's `wake` at `at` only when none is kept: one already asked for, earlier or later, stays as it is. */
export function keepWake(sql: Sql, alias: string, at: number) {
  ensurePluginWakeTables(sql);
  sql.exec("INSERT OR IGNORE INTO plugin_wakes (alias, at, gen) VALUES (?, ?, 1)", alias, at);
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

/**
 * What a turn's end said of the conversation, gone: the model's text, and an error's, which can quote what the model
 * was sent. Kept ends say only how each turn ended.
 */
export function forgetTurnText(sql: Sql) {
  if (!keepsPluginCalls(sql)) return;
  for (const r of sql.exec("SELECT seq, body FROM plugin_turn_ends").toArray()) {
    const { error, ...end } = JSON.parse(String(r.body)) as { finalText?: unknown; error?: unknown };
    if ((end.finalText === null || end.finalText === undefined) && error === undefined) continue;
    sql.exec("UPDATE plugin_turn_ends SET body = ? WHERE seq = ?", JSON.stringify({ ...end, finalText: null }), Number(r.seq));
  }
}

/** An answer whose turn or erase waits for the main conversation to be free, kept as only those. */
export function keepTurnOnly(sql: Sql, seq: number, next: PluginNext) {
  const { turn, turnKey, fresh, forget, reasoning } = next;
  sql.exec("UPDATE plugin_answers SET body = ? WHERE seq = ?",
    JSON.stringify({ turn, ...(turnKey ? { turnKey } : {}), ...(fresh ? { fresh } : {}), ...(forget ? { forget } : {}), ...(reasoning ? { reasoning } : {}) }), seq);
}

/**
 * The reasoning level a plugin set for one main conversation (`PluginNext.reasoning`), by that conversation's id
 * (cf/src/fresh-context.ts `currentMainId`): written before the turn that starts it is posted, read for each of its
 * model calls (`AgentRuntime.takeJob`). A conversation with no row runs at the agent's own level.
 */
export function setConversationReasoning(sql: Sql, conversation: string, reasoning: "off" | "low" | "high", now: number) {
  sql.exec("CREATE TABLE IF NOT EXISTS plugin_conversation_reasoning (conversation TEXT PRIMARY KEY, reasoning TEXT NOT NULL, at INTEGER NOT NULL)");
  sql.exec("INSERT OR REPLACE INTO plugin_conversation_reasoning (conversation, reasoning, at) VALUES (?, ?, ?)", conversation, reasoning, now);
}

export function conversationReasoning(sql: Sql, conversation: string): "off" | "low" | "high" | undefined {
  if (!keepsPluginCalls(sql)) return undefined;
  try {
    const r = String(sql.exec("SELECT reasoning FROM plugin_conversation_reasoning WHERE conversation = ?", conversation).toArray()[0]?.reasoning ?? "");
    return r === "off" || r === "low" || r === "high" ? r : undefined;
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message ?? e))) return undefined;
    throw e;
  }
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
export function turnEndOf(status: string, last: unknown): Omit<TurnEnd, "turnId" | "turnKey"> {
  const m = last && typeof last === "object" ? last as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown; errorCode?: unknown } : null;
  const mine = m?.role === "assistant";
  const text = mine && Array.isArray(m!.content)
    ? m!.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text as string).join("")
    : "";
  const finalText = text.trim() ? text : null;
  if (status === "aborted" || (mine && m!.stopReason === "aborted")) return { finalText, outcome: "cancelled" };
  if (status === "failed" || (mine && m!.stopReason === "error")) {
    const error = mine && typeof m!.errorMessage === "string" && m!.errorMessage.trim() ? m!.errorMessage : `the run ended ${status}`;
    return { finalText, outcome: "failed", error: error.slice(0, 300), ...(mine && m!.errorCode === "output_limit" ? { errorCode: "output_limit" as const } : {}) };
  }
  return { finalText, outcome: "completed" };
}
