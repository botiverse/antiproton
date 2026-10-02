/**
 * pi-durable's SQLite database facade over a Durable Object's own SQLite.
 *
 * `@earendil-works/pi-durable/storage/sqlite` is a portable storage core that asks for four async
 * statements and an async `transaction(callback)`. A Durable Object's only transaction that spans an
 * await, `ctx.storage.transaction`, is a savepoint over the object's one connection that any `sql.exec`
 * issued meanwhile joins and rolls back with. So we run a vendored storage
 * (src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js) that asks instead for `transactionSync`:
 * the host's `transactionSync`, with a synchronous handle, so each commit, migration and document read
 * runs whole before any other code does. Nothing of ours can join it, and nothing here orders, queues
 * or holds anything: every statement runs when it is called. `test/pi-durable.ts` pins the facade.
 *
 * pi-durable's schema names a table `tasks`, and so does `AgentDO`'s
 * (src/store/durable-object.ts). Its migrations say `CREATE TABLE tasks` with no
 * `IF NOT EXISTS`, so in an object that has ours pi-durable fails to open, and
 * in one where pi-durable came first ours would silently adopt its table. Every
 * name pi-durable's schema creates is therefore placed in a namespace handed to
 * the constructor (src/store/sql-namespace.ts): `pd_tasks` on Durable Object
 * SQLite, and on a store with real schemas it could be `pd.tasks` with nothing
 * here changing. The rewrite is an allowlist of the names below, and a
 * statement that would create any other name throws.
 */
import type { SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteSyncDatabase, SqliteSyncExecutor } from "../vendor/pi/pi-durable/dist/storage/sqlite/storage.js";
import { SqlQualifier, type SqlNamespace, type SqlObjects } from "./sql-namespace.ts";

/** The slice of `ctx.storage` this needs, and all that a test must fake. */
export type DurableSqlHost = {
  sql: { exec(query: string, ...bindings: SqlBinding[]): { toArray(): Array<Record<string, SqlCell>> } };
  /** A transaction that cannot span an await, and so cannot be joined. */
  transactionSync<T>(closure: () => T): T;
};
type SqlBinding = string | number | null | Uint8Array;
/** A Durable Object returns blobs as `ArrayBuffer`; node:sqlite returns `Uint8Array` and may return `bigint`. */
type SqlCell = string | number | bigint | null | ArrayBuffer | Uint8Array;

/**
 * Everything pi-durable's schema creates (`dist/storage/sqlite/migrations.js`):
 * its nine tables, `durable_schema` among them, and their sixteen indexes.
 * Indexes share the table namespace in SQLite, so they are namespaced too.
 * Depends on: @earendil-works/pi-durable 1.0.0 — an upgrade that adds a
 * migration fails here (a CREATE of an unlisted name) and in
 * test/spec/pi-durable-spec.ts, which compares this list with the migrations.
 */
export const PI_DURABLE_TABLES = [
  "durable_schema", "durable_metadata", "record_ids", "conversations", "entries",
  "tasks", "submissions", "documents", "document_revisions",
] as const;
export const PI_DURABLE_INDEXES = [
  "conversations_by_owner_conversation", "conversations_by_owner_task",
  "entries_by_conversation", "entry_heads_by_conversation",
  "tasks_by_status", "tasks_by_conversation", "tasks_by_kind", "tasks_by_abort_requested", "tasks_by_background",
  "submissions_by_request", "submissions_by_conversation", "submissions_by_status",
  "documents_by_address", "documents_by_scope", "documents_by_scope_kind",
  "document_revisions_by_kind",
] as const;
export const PI_DURABLE_OBJECTS: SqlObjects = { tables: PI_DURABLE_TABLES, indexes: PI_DURABLE_INDEXES };

/**
 * The Durable Object binds no `bigint`, and pi-durable's value type allows one. A safe integer is
 * passed as a number; anything else throws rather than being narrowed or stringified, because a
 * silently different value in a STRICT INTEGER column is worse than a refusal.
 */
function bindValue(value: SqliteValue): SqlBinding {
  if (typeof value !== "bigint") return value;
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  throw new RangeError(`cannot bind ${value}n: a Durable Object binds integers only as JavaScript numbers`);
}

function readRow(row: Record<string, SqlCell>): Record<string, SqliteValue> {
  const out: Record<string, SqliteValue> = {};
  for (const [key, cell] of Object.entries(row)) out[key] = cell instanceof ArrayBuffer ? new Uint8Array(cell) : cell;
  return out;
}

type Connection = { host: DurableSqlHost; names: SqlQualifier };

/** Not globals: the constructors of `async function`, `function*` and `async function*`, which `transactionSync` refuses. */
const ASYNC_FUNCTION = (async () => {}).constructor;
const GENERATOR_FUNCTION = function* () {}.constructor;
const ASYNC_GENERATOR_FUNCTION = async function* () {}.constructor;

function query(c: Connection, sql: string, params: readonly SqliteValue[]): Array<Record<string, SqliteValue>> {
  return c.host.sql.exec(c.names.rewrite(sql), ...params.map(bindValue)).toArray().map(readRow);
}

// The row type is the caller's claim about its own SELECT; nothing here can check it, which is the
// contract pi-durable's `get<T>`/`all<T>` declare.
const asRows = <T extends object>(rows: Array<Record<string, SqliteValue>>) => rows as unknown as T[];

/** The handle `transactionSync` hands its callback: each call has run its statement when it returns. */
class SyncTransactionHandle implements SqliteSyncExecutor {
  #connection: Connection;
  #active = true;
  constructor(connection: Connection) { this.#connection = connection; }
  revoke() { this.#active = false; }

  #use<T>(operation: (connection: Connection) => T): T {
    if (!this.#active) throw new Error("SQLite transaction handle is no longer active");
    return operation(this.#connection);
  }
  exec(sql: string) { this.#use((c) => { query(c, sql, []); }); }
  run(sql: string, ...params: SqliteValue[]) { this.#use((c) => { query(c, sql, params); }); }
  get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((c) => asRows<T>(query(c, sql, params))[0]); }
  all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((c) => asRows<T>(query(c, sql, params))); }
}

export class PiDurableSqlite implements SqliteSyncDatabase {
  #connection: Connection;
  #closed = false;

  /** `namespace` places pi-durable's tables: `prefixedNamespace("pd")` on a Durable Object. */
  constructor(host: DurableSqlHost, namespace: SqlNamespace) {
    this.#connection = { host, names: new SqlQualifier(PI_DURABLE_OBJECTS, namespace) };
  }

  #use<T>(operation: (connection: Connection) => T): Promise<T> {
    try {
      if (this.#closed) throw new Error("database is closed");
      return Promise.resolve(operation(this.#connection));
    } catch (error) { return Promise.reject(error); }
  }
  exec(sql: string) { return this.#use((c) => { query(c, sql, []); }); }
  run(sql: string, ...params: SqliteValue[]) { return this.#use((c) => { query(c, sql, params); }); }
  get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((c) => asRows<T>(query(c, sql, params))[0]); }
  all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((c) => asRows<T>(query(c, sql, params))); }

  /**
   * `callback` as one host `transactionSync`, every statement in it synchronous: no other code runs between
   * its first statement and its commit or rollback, so no statement of anyone else's can join it, and a
   * rollback removes only what `callback` wrote. A throw rolls back and rejects with the thrown error. A
   * function declared async or as a generator is not called, and a returned thenable rolls back and rejects:
   * the work behind either would run outside the transaction.
   */
  transactionSync<T>(callback: (transaction: SqliteSyncExecutor) => T): Promise<T> {
    if (callback instanceof ASYNC_FUNCTION || callback instanceof ASYNC_GENERATOR_FUNCTION || callback instanceof GENERATOR_FUNCTION) {
      return Promise.reject(new TypeError("transactionSync() takes a synchronous function; an async or generator one would run outside its transaction, so it is not called"));
    }
    if (this.#closed) return Promise.reject(new Error("database is closed"));
    const handle = new SyncTransactionHandle(this.#connection);
    try {
      return Promise.resolve(this.#connection.host.transactionSync(() => {
        const result = callback(handle);
        if (typeof (result as { then?: unknown } | null)?.then === "function") {
          throw new TypeError("transactionSync() takes a synchronous function; this one returned a thenable, whose work would run outside its transaction");
        }
        return result;
      }));
    } catch (error) { return Promise.reject(error); }
    finally { handle.revoke(); }
  }

  close() { this.#closed = true; return Promise.resolve(); }
}
