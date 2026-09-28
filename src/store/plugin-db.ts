/**
 * The rows behind every plugin database: one table for the values, one for the
 * version each database was written under, both keyed by (tenant, agent,
 * mount alias, plugin id). The plugin id is part of the key on purpose — a
 * database opened under another plugin id is empty, and old rows are never
 * handed over — so two plugins that ever share an alias share nothing.
 *
 * Keys and indexed fields are stored as SQLite values in a column with no
 * declared type, which keeps a number a number and a string a string, and
 * SQLite orders every number before every text: the ordering IndexedDB
 * promises, for free, on the storage engine itself. Values are JSON text.
 *
 * Shared by both storage backends and by the diagnosis reader, so the shape of
 * a row is defined exactly once. The kernel's `openPluginDatabase`
 * (src/runtime/plugin-db.ts) is the only thing that should call the methods
 * from a plugin's context; this class knows rows, not declarations.
 */
import type { Json } from "../core/types.ts";
import type { DbKey, DbKeyRange, DbQuery } from "../plugins/types.ts";
import type { SqlHost } from "./pi-storage.ts";

export interface DbScope {
  tenantId: string;
  agentId: string;
  alias: string;
  plugin: string;
}

export const PLUGIN_DB_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS plugin_db (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL, plugin TEXT NOT NULL,
     store TEXT NOT NULL, key NOT NULL, value TEXT NOT NULL, idx, updated_at INTEGER NOT NULL,
     PRIMARY KEY (tenant_id, agent_id, alias, plugin, store, key))`,
  `CREATE INDEX IF NOT EXISTS plugin_db_by_idx ON plugin_db (tenant_id, agent_id, alias, plugin, store, idx)`,
  `CREATE TABLE IF NOT EXISTS plugin_db_versions (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL, plugin TEXT NOT NULL,
     version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (tenant_id, agent_id, alias, plugin))`,
];

const isRange = (q: unknown): q is DbKeyRange =>
  !!q && typeof q === "object" && "lowerOpen" in (q as object) && "upperOpen" in (q as object);

/** The WHERE fragment for a key or range over `column`, and its bindings. Null query means every row. */
function where(column: string, query: DbQuery): { sql: string; bindings: DbKey[] } {
  if (query === null || query === undefined) return { sql: "", bindings: [] };
  if (!isRange(query)) return { sql: ` AND ${column} = ?`, bindings: [query] };
  const parts: string[] = [];
  const bindings: DbKey[] = [];
  if (query.lower !== undefined) { parts.push(` AND ${column} ${query.lowerOpen ? ">" : ">="} ?`); bindings.push(query.lower); }
  if (query.upper !== undefined) { parts.push(` AND ${column} ${query.upperOpen ? "<" : "<="} ?`); bindings.push(query.upper); }
  return { sql: parts.join(""), bindings };
}

const SCOPE = "tenant_id=? AND agent_id=? AND alias=? AND plugin=?";
const scopeOf = (s: DbScope): [string, string, string, string] => [s.tenantId, s.agentId, s.alias, s.plugin];

export class PluginDbTables {
  #host: SqlHost;
  #now: () => number;

  constructor(host: SqlHost, opts: { now?: () => number } = {}) {
    this.#host = host;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Creates the tables when they are missing. Returns `this`, so a fixture is one expression. */
  ensure(): this {
    for (const stmt of PLUGIN_DB_SCHEMA) this.#host.sql.exec(stmt);
    return this;
  }

  #all(q: string, ...b: unknown[]): any[] { return this.#host.sql.exec(q, ...b).toArray(); }

  transaction<T>(fn: () => T): T { return this.#host.transactionSync(fn); }

  /** The version this database was last written under; null when it has never been opened. */
  version(scope: DbScope): number | null {
    const r = this.#all(`SELECT version FROM plugin_db_versions WHERE ${SCOPE}`, ...scopeOf(scope))[0];
    return r ? Number(r.version) : null;
  }

  setVersion(scope: DbScope, version: number): void {
    this.#host.sql.exec(
      `INSERT INTO plugin_db_versions(tenant_id, agent_id, alias, plugin, version, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(tenant_id, agent_id, alias, plugin) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at`,
      ...scopeOf(scope), version, this.#now(),
    );
  }

  get(scope: DbScope, store: string, key: DbKey): unknown {
    const r = this.#all(`SELECT value FROM plugin_db WHERE ${SCOPE} AND store=? AND key=?`, ...scopeOf(scope), store, key)[0];
    return r ? JSON.parse(String(r.value)) : undefined;
  }

  put(scope: DbScope, store: string, key: DbKey, value: Json, idx: DbKey | null): void {
    this.#host.sql.exec(
      `INSERT INTO plugin_db(tenant_id, agent_id, alias, plugin, store, key, value, idx, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, agent_id, alias, plugin, store, key) DO UPDATE SET
         value=excluded.value, idx=excluded.idx, updated_at=excluded.updated_at`,
      ...scopeOf(scope), store, key, JSON.stringify(value), idx, this.#now(),
    );
  }

  delete(scope: DbScope, store: string, query: DbKey | DbKeyRange): void {
    const w = where("key", query);
    this.#host.sql.exec(`DELETE FROM plugin_db WHERE ${SCOPE} AND store=?${w.sql}`, ...scopeOf(scope), store, ...w.bindings);
  }

  getAll(scope: DbScope, store: string, query: DbQuery, count: number | null): unknown[] {
    const w = where("key", query);
    return this.#all(
      `SELECT value FROM plugin_db WHERE ${SCOPE} AND store=?${w.sql} ORDER BY key${count === null ? "" : " LIMIT ?"}`,
      ...scopeOf(scope), store, ...w.bindings, ...(count === null ? [] : [count]),
    ).map((r) => JSON.parse(String(r.value)));
  }

  /** Rows whose indexed field is set, ordered by it then by key; rows it was missing from are not here. */
  getAllFromIndex(scope: DbScope, store: string, query: DbQuery, count: number | null): unknown[] {
    const w = where("idx", query);
    return this.#all(
      `SELECT value FROM plugin_db WHERE ${SCOPE} AND store=? AND idx IS NOT NULL${w.sql} ORDER BY idx, key${count === null ? "" : " LIMIT ?"}`,
      ...scopeOf(scope), store, ...w.bindings, ...(count === null ? [] : [count]),
    ).map((r) => JSON.parse(String(r.value)));
  }

  count(scope: DbScope, store: string, query: DbQuery): number {
    const w = where("key", query);
    return Number(this.#all(`SELECT COUNT(*) AS n FROM plugin_db WHERE ${SCOPE} AND store=?${w.sql}`, ...scopeOf(scope), store, ...w.bindings)[0]?.n ?? 0);
  }

  /** Moves every database filed under one mount alias to another; the plugin ids travel with the rows. */
  rename(tenantId: string, agentId: string, from: string, to: string): void {
    for (const table of ["plugin_db", "plugin_db_versions"]) {
      this.#host.sql.exec(`UPDATE ${table} SET alias=? WHERE tenant_id=? AND agent_id=? AND alias=?`, to, tenantId, agentId, from);
    }
  }

  /**
   * One line per (mount, plugin, store) for an operator's storage page: how many
   * keys and when the last one changed. Never a key, never a value — which keys
   * may be named is the plugin's declaration to make (`listed`), and a page that
   * printed the rest would be reading past it.
   */
  summary(tenantId: string, agentId: string): Array<{ alias: string; plugin: string; store: string; keys: number; updatedAt: number }> {
    return this.#all(
      `SELECT alias, plugin, store, COUNT(*) AS keys, MAX(updated_at) AS updated_at FROM plugin_db
       WHERE tenant_id=? AND agent_id=? GROUP BY alias, plugin, store ORDER BY alias, plugin, store`,
      tenantId, agentId,
    ).map((r) => ({ alias: String(r.alias), plugin: String(r.plugin), store: String(r.store), keys: Number(r.keys), updatedAt: Number(r.updated_at) }));
  }
}
