/**
 * `ctx.db`: a plugin's declaration (`Plugin.database`) applied to the rows in
 * `src/store/plugin-db.ts`. This is where a store name is checked against the
 * declaration, a key is taken from a value's `keyPath`, an indexed field is
 * extracted, and the version rule runs — once, before the first use of a
 * database opened here, so a call that never touches storage pays nothing.
 *
 * The rules for versions live on `DbSpec` in src/plugins/types.ts and are
 * implemented in `ready()` below, in the same order they are stated there.
 */
import type { Json } from "../core/types.ts";
import type { DbKey, DbKeyRange, DbOperations, DbQuery, DbSpec, DbStoreSpec, PluginDatabase } from "../plugins/types.ts";
import type { DbScope, PluginDbTables } from "../store/plugin-db.ts";

const isKey = (v: unknown): v is DbKey => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** The value at a dotted path, or undefined when any step is missing or not an object. */
function at(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const step of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[step];
  }
  return cur;
}

export interface OpenOptions {
  /**
   * A reader that must not change anything: a diagnosis. No `upgrade` runs
   * (it would write), and every write is refused with a message that says
   * whose rule it is.
   */
  readOnly?: boolean;
}

const READ_ONLY = "read-only: a diagnosis does not change a mount's state";

/**
 * Build the database a plugin is handed for one mount. `spec` undefined means
 * the plugin declares none, and every operation says so rather than storing
 * into a database nothing declared.
 */
export function openPluginDatabase(
  tables: PluginDbTables, scope: DbScope, spec: DbSpec | undefined, opts: OpenOptions = {},
): PluginDatabase {
  const who = `plugin ${scope.plugin}`;
  const readOnly = opts.readOnly === true;
  if (spec && (!Number.isInteger(spec.version) || spec.version < 1)) {
    throw new Error(`${who} declares database version ${String(spec.version)}; it must be a positive integer`);
  }
  for (const [name, s] of Object.entries(spec?.stores ?? {})) {
    if (Object.keys(s.indexes ?? {}).length > 1) {
      throw new Error(`${who} declares ${Object.keys(s.indexes!).length} indexes on store ${name}; this version allows one`);
    }
  }

  const storeOf = (name: string): DbStoreSpec => {
    if (!spec) throw new Error(`${who} declares no database`);
    const s = Object.prototype.hasOwnProperty.call(spec.stores, name) ? spec.stores[name] : undefined;
    if (!s) throw new Error(`${who} declares no store named ${name}`);
    return s;
  };

  /** The operations, with the declaration applied; `writes` false refuses put and delete. */
  const ops = (writes: boolean): DbOperations => ({
    get(store, key) {
      storeOf(store);
      if (!isKey(key)) throw new Error("key must be a string or a finite number");
      return tables.get(scope, store, key);
    },
    put(store, value, key) {
      const s = storeOf(store);
      if (!writes) throw new Error(readOnly ? READ_ONLY : "put in a readonly transaction");
      const text = JSON.stringify(value);
      if (text === undefined) throw new Error("value must be JSON");
      let k: DbKey;
      if (s.keyPath !== undefined) {
        if (key !== undefined) throw new Error(`store ${store} takes its key from ${s.keyPath}; do not pass one`);
        const found = at(value, s.keyPath);
        if (!isKey(found)) throw new Error(`value has no key at ${s.keyPath}`);
        k = found;
      } else {
        if (!isKey(key)) throw new Error(`store ${store} has no keyPath; put needs a key`);
        k = key;
      }
      const [, path] = Object.entries(s.indexes ?? {})[0] ?? [];
      const indexed = path === undefined ? undefined : at(value, path);
      tables.put(scope, store, k, value as Json, isKey(indexed) ? indexed : null);
      return k;
    },
    delete(store, query) {
      storeOf(store);
      if (!writes) throw new Error(readOnly ? READ_ONLY : "delete in a readonly transaction");
      tables.delete(scope, store, query);
    },
    getAll(store, query, count) {
      storeOf(store);
      return tables.getAll(scope, store, query, count ?? null);
    },
    getAllFromIndex(store, index, query, count) {
      const s = storeOf(store);
      if (!s.indexes || !Object.prototype.hasOwnProperty.call(s.indexes, index)) {
        throw new Error(`${who} declares no index named ${index} on store ${store}`);
      }
      return tables.getAllFromIndex(scope, store, query, count ?? null);
    },
    count(store, query) {
      storeOf(store);
      return tables.count(scope, store, query);
    },
  });

  let upgraded = false;
  /**
   * The version rule, once per opened database. Stored below declared (or
   * absent, which `upgrade` sees as 0): run `upgrade` and record the version
   * in one transaction; a throw undoes both and leaves `upgraded` false, so
   * the next use tries again. Stored above declared: open as is, lower
   * nothing. Read-only openings never write, so they never upgrade.
   */
  const ready = (): void => {
    if (upgraded || readOnly || !spec) return;
    const stored = tables.version(scope);
    if (stored === null || stored < spec.version) {
      const from = stored ?? 0;
      try {
        tables.transaction(() => {
          spec.upgrade?.(ops(true), from);
          tables.setVersion(scope, spec.version);
        });
      } catch (e) {
        throw new Error(`${who} database upgrade from ${from} to ${spec.version} failed: ${String((e as Error)?.message ?? e)}`);
      }
    }
    upgraded = true;
  };

  const rw = ops(!readOnly);
  return {
    async get(store, key) { ready(); return rw.get(store, key); },
    async put(store, value, key) { ready(); return rw.put(store, value, key); },
    async delete(store, query) { ready(); rw.delete(store, query); },
    async getAll(store, query, count) { ready(); return rw.getAll(store, query, count); },
    async getAllFromIndex(store, index, query, count) { ready(); return rw.getAllFromIndex(store, index, query, count); },
    async count(store, query) { ready(); return rw.count(store, query); },
    async transaction(stores, mode, fn) {
      ready();
      for (const name of typeof stores === "string" ? [stores] : stores) storeOf(name);
      if (mode === "readwrite" && readOnly) throw new Error(READ_ONLY);
      return tables.transaction(() => fn(ops(mode === "readwrite")));
    },
  };
}

export type { DbKey, DbKeyRange, DbQuery };
