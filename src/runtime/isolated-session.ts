/**
 * A plugin's short session (`PluginNext.isolated`, src/plugins/types.ts): a turn posted in a session of its own, which
 * starts from nothing and is erased once its run has ended, so what it reads never reaches the main conversation and
 * the main conversation never reaches it. Its id is minted here alone, under a prefix nothing else uses (`sub_` is a
 * subagent's, `sess_` an Agents API session's, `main` the first conversation), and it is kept in one table until it is
 * erased (`AgentRuntime.#eraseIsolated`, cf/src/runtime.ts), with what the mount asked for with it: the tools it may be
 * offered at most (`PluginNext.tools`) and its `turnKey`, handed to that mount's calls in it (`caller.turnKey`).
 *
 * Compiled by both typecheck programs.
 */
import { randomUUID } from "node:crypto";

export const ISOLATED_SESSION_PREFIX = "iso_";

export function isIsolatedSession(session: unknown): session is string {
  return typeof session === "string" && session.startsWith(ISOLATED_SESSION_PREFIX);
}

export function newIsolatedSessionId(): string {
  return `${ISOLATED_SESSION_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

function ensure(sql: Sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS isolated_sessions (session TEXT PRIMARY KEY, alias TEXT NOT NULL, at INTEGER NOT NULL, tools TEXT, turn_key TEXT)");
  // A table made before the two columns (#1020) gets them, empty: its sessions were asked for with neither.
  // A select of a missing column fails as it is prepared, so it writes nothing either way (src/store/ap-store.ts).
  for (const column of ["tools", "turn_key"]) {
    try { sql.exec(`SELECT ${column} FROM isolated_sessions WHERE 0`).toArray(); }
    catch { sql.exec(`ALTER TABLE isolated_sessions ADD COLUMN ${column} TEXT`); }
  }
}

/** What a mount asked for with its short session: the tools it may be offered at most (`PluginNext.tools`), and its key. */
export interface IsolatedAsk { tools?: readonly string[] | null; turnKey?: string | null }

/** A short session about to be posted to, by the mount that asked for it. */
export function recordIsolated(sql: Sql, session: string, alias: string, at: number, ask: IsolatedAsk = {}) {
  ensure(sql);
  const tools = Array.isArray(ask.tools) ? JSON.stringify(ask.tools.filter((t) => typeof t === "string")) : null;
  const key = typeof ask.turnKey === "string" && ask.turnKey ? ask.turnKey : null;
  sql.exec("INSERT OR IGNORE INTO isolated_sessions (session, alias, at, tools, turn_key) VALUES (?, ?, ?, ?, ?)", session, alias, at, tools, key);
}

const hasTable = (sql: Sql) => sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'isolated_sessions'").toArray().length > 0;

/** Every short session not yet erased, oldest first. An object that never had one is asked one read and given no table. */
export function isolatedSessions(sql: Sql): Array<{ session: string; alias: string; at: number }> {
  if (!hasTable(sql)) return [];
  return sql.exec("SELECT session, alias, at FROM isolated_sessions ORDER BY at").toArray()
    .map((r) => ({ session: String(r.session), alias: String(r.alias), at: Number(r.at) }));
}

/**
 * One short session as its mount asked for it: the mount, the tools it may be offered at most (null: no narrowing) and
 * its key (null: none). Null for a session that is not one, or is gone.
 */
export function isolatedSession(sql: Sql, session: string): { alias: string; tools: string[] | null; turnKey: string | null } | null {
  if (!isIsolatedSession(session) || !hasTable(sql)) return null;
  ensure(sql);
  const r = sql.exec("SELECT alias, tools, turn_key FROM isolated_sessions WHERE session = ?", session).toArray()[0];
  if (!r) return null;
  let tools: string[] | null = null;
  if (typeof r.tools === "string") {
    // A list that does not read back narrows to nothing rather than to everything: never wider than was asked.
    try { const v = JSON.parse(r.tools); tools = Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []; } catch { tools = []; }
  }
  return { alias: String(r.alias), tools, turnKey: typeof r.turn_key === "string" && r.turn_key ? r.turn_key : null };
}

export function forgetIsolated(sql: Sql, session: string) {
  sql.exec("DELETE FROM isolated_sessions WHERE session = ?", session);
}
