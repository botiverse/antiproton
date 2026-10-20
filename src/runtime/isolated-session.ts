/**
 * A plugin's short session (`PluginNext.isolated`, src/plugins/types.ts): a turn posted in a session of its own, which
 * starts from nothing and is erased once its run has ended, so what it reads never reaches the main conversation and
 * the main conversation never reaches it. Its id is minted here alone, under a prefix nothing else uses (`sub_` is a
 * subagent's, `sess_` an Agents API session's, `main` the first conversation), and it is kept in one table until it is
 * erased (`AgentRuntime.#eraseIsolated`, cf/src/runtime.ts).
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
  sql.exec("CREATE TABLE IF NOT EXISTS isolated_sessions (session TEXT PRIMARY KEY, alias TEXT NOT NULL, at INTEGER NOT NULL)");
}

/** A short session about to be posted to, by the mount that asked for it. */
export function recordIsolated(sql: Sql, session: string, alias: string, at: number) {
  ensure(sql);
  sql.exec("INSERT OR IGNORE INTO isolated_sessions (session, alias, at) VALUES (?, ?, ?)", session, alias, at);
}

/** Every short session not yet erased, oldest first. An object that never had one is asked one read and given no table. */
export function isolatedSessions(sql: Sql): Array<{ session: string; alias: string; at: number }> {
  if (sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'isolated_sessions'").toArray().length === 0) return [];
  return sql.exec("SELECT session, alias, at FROM isolated_sessions ORDER BY at").toArray()
    .map((r) => ({ session: String(r.session), alias: String(r.alias), at: Number(r.at) }));
}

export function forgetIsolated(sql: Sql, session: string) {
  sql.exec("DELETE FROM isolated_sessions WHERE session = ?", session);
}
