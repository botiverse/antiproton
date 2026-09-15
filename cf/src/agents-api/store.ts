/**
 * What the OpenAI-compatible agents API remembers (task #17).
 *
 * Agents and sessions created through the API are indexed in the owner's
 * object — the one the API key names — so a key can list, find and delete
 * them without a directory service. Each agent is still its own object; each
 * session is a conversation in that agent's object. Keys live in the
 * "identities" object beside the sign-in table, as hashes only.
 *
 * Everything takes the same two-method SQL a Durable Object has, so node:sqlite
 * tests it exactly as the object runs it.
 */
import type { StoredAgent, StoredSession } from "./shapes.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };

const hex = (n: number) => {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

/**
 * An agent id that is also a valid object name (letters, digits, . _ -, at most
 * 64) and cannot collide within one owner: the owner's id, the time, and randomness.
 */
export function mintAgentId(ownerAgentId: string, now: number = Date.now()): string {
  const id = `${ownerAgentId}_${now.toString(36)}${hex(3)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`owner id too long to derive an agent id: ${ownerAgentId}`);
  return id;
}

export const mintSessionId = () => `sess_${hex(12)}`;

// ---- agents and sessions (in the owner's object) ---------------------------

export function ensureApiTables(sql: Sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS api_agents(
    agent_id TEXT PRIMARY KEY, config TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS api_sessions(
    session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, environment TEXT NOT NULL, metadata TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, deleted_at INTEGER)`);
}

export function putApiAgent(sql: Sql, agentId: string, a: StoredAgent) {
  ensureApiTables(sql);
  sql.exec(
    "INSERT INTO api_agents(agent_id, config, created_at, updated_at) VALUES (?,?,?,?) " +
    "ON CONFLICT(agent_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at",
    agentId, JSON.stringify(a), a.createdAt, a.updatedAt);
}

/** Deleted agents are gone as far as the API is concerned. */
export function getApiAgent(sql: Sql, agentId: string): StoredAgent | null {
  ensureApiTables(sql);
  const r = sql.exec("SELECT config FROM api_agents WHERE agent_id = ? AND deleted_at IS NULL", agentId).toArray()[0] as any;
  return r ? (JSON.parse(String(r.config)) as StoredAgent) : null;
}

/** Oldest first; the page decides the order the caller asked for. */
export function listApiAgents(sql: Sql): Array<{ id: string; agent: StoredAgent }> {
  ensureApiTables(sql);
  return sql.exec("SELECT agent_id, config FROM api_agents WHERE deleted_at IS NULL ORDER BY created_at ASC, agent_id ASC").toArray()
    .map((r: any) => ({ id: String(r.agent_id), agent: JSON.parse(String(r.config)) as StoredAgent }));
}

export function deleteApiAgent(sql: Sql, agentId: string, now = Date.now()): boolean {
  ensureApiTables(sql);
  const had = sql.exec("SELECT 1 AS x FROM api_agents WHERE agent_id = ? AND deleted_at IS NULL", agentId).toArray().length > 0;
  sql.exec("UPDATE api_agents SET deleted_at = ? WHERE agent_id = ? AND deleted_at IS NULL", now, agentId);
  return had;
}

const rowToSession = (r: any): StoredSession => ({
  id: String(r.session_id), agentId: String(r.agent_id), environment: r.environment === "none" ? "none" : "container",
  metadata: JSON.parse(String(r.metadata)), createdAt: Number(r.created_at), lastActiveAt: Number(r.last_active_at),
});

export function putApiSession(sql: Sql, s: StoredSession) {
  ensureApiTables(sql);
  sql.exec(
    "INSERT INTO api_sessions(session_id, agent_id, environment, metadata, created_at, last_active_at) VALUES (?,?,?,?,?,?) " +
    "ON CONFLICT(session_id) DO UPDATE SET metadata = excluded.metadata, last_active_at = excluded.last_active_at",
    s.id, s.agentId, s.environment, JSON.stringify(s.metadata), s.createdAt, s.lastActiveAt);
}

export function getApiSession(sql: Sql, sessionId: string): StoredSession | null {
  ensureApiTables(sql);
  const r = sql.exec("SELECT * FROM api_sessions WHERE session_id = ? AND deleted_at IS NULL", sessionId).toArray()[0];
  return r ? rowToSession(r) : null;
}

export function listApiSessions(sql: Sql, agentId?: string | null): StoredSession[] {
  ensureApiTables(sql);
  const rows = agentId
    ? sql.exec("SELECT * FROM api_sessions WHERE agent_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, session_id ASC", agentId).toArray()
    : sql.exec("SELECT * FROM api_sessions WHERE deleted_at IS NULL ORDER BY created_at ASC, session_id ASC").toArray();
  return rows.map(rowToSession);
}

export function touchApiSession(sql: Sql, sessionId: string, now = Date.now()) {
  ensureApiTables(sql);
  sql.exec("UPDATE api_sessions SET last_active_at = ? WHERE session_id = ? AND deleted_at IS NULL", now, sessionId);
}

export function deleteApiSession(sql: Sql, sessionId: string, now = Date.now()): boolean {
  ensureApiTables(sql);
  const had = sql.exec("SELECT 1 AS x FROM api_sessions WHERE session_id = ? AND deleted_at IS NULL", sessionId).toArray().length > 0;
  sql.exec("UPDATE api_sessions SET deleted_at = ? WHERE session_id = ? AND deleted_at IS NULL", now, sessionId);
  return had;
}
