/**
 * pi-durable's `SqliteDatabase` facade over a Durable Object's own SQLite.
 *
 * `@earendil-works/pi-durable/storage/sqlite` is a portable storage core that
 * asks for four async statements and an async `transaction(callback)`. A Durable
 * Object offers neither directly: `transactionSync` takes only a synchronous
 * callback, and the runtime rejects SQL `BEGIN` and `SAVEPOINT`. What it does
 * offer is `ctx.storage.transaction(async () => ...)`, which commits `sql.exec`
 * writes made across awaits and rolls them back when the closure throws — a
 * savepoint over the object's one connection. Being a savepoint over the one
 * connection is also its hazard: any `sql.exec` issued while it is open, on any
 * table, joins it and rolls back with it. Every call through this facade waits
 * behind an open transaction (the queue below), but the queue orders only this
 * facade's calls — other code in the object that runs `sql.exec` while one is
 * open is not kept out, unless it runs through `exclusive` below. `test/pi-durable.ts`
 * pins the facade's half: a throwing transaction leaves no rows, and a write queued
 * behind it survives; `test/ap-store.ts` pins `exclusive`.
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
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { SqlQualifier, type SqlNamespace, type SqlObjects } from "./sql-namespace.ts";

/** The slice of `ctx.storage` this needs, and all that a test must fake. */
export type DurableSqlHost = {
  sql: { exec(query: string, ...bindings: SqlBinding[]): { toArray(): Array<Record<string, SqlCell>> } };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
  /** Only `exclusive` uses it: a transaction that cannot span an await, and so cannot be joined. */
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

/** Not globals: the constructors of `async function`, `function*` and `async function*`, which `exclusive` refuses. */
const ASYNC_FUNCTION = (async () => {}).constructor;
const GENERATOR_FUNCTION = function* () {}.constructor;
const ASYNC_GENERATOR_FUNCTION = async function* () {}.constructor;

function query(c: Connection, sql: string, params: readonly SqliteValue[]): Array<Record<string, SqliteValue>> {
  return c.host.sql.exec(c.names.rewrite(sql), ...params.map(bindValue)).toArray().map(readRow);
}

/**
 * One operation at a time, in call order. A plain statement runs at once when nothing is queued,
 * so a read outside a transaction costs no extra turn; anything issued while a transaction is open
 * waits for it to settle.
 */
class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  /** Async sections of ours running now (`apart`); a transaction does not open while any is. */
  #apart = 0;
  #apartDone: Array<() => void> = [];

  run<T>(operation: () => T): Promise<T> {
    // Sound only because a plain statement is synchronous: `query` has no await, so it cannot yield
    // and cannot interleave with anything. Only a transaction spans awaits, and it goes through
    // `enqueue`, which raises #pending so every other call queues behind it. This check is that
    // ordering, not an optimisation; without it a statement could run between
    // a transaction's statements and be committed or rolled back with them.
    if (this.#pending > 0) return this.enqueue(async () => operation());
    try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
  }

  enqueue<T>(operation: () => Promise<T>, opts: { transaction?: boolean } = {}): Promise<T> {
    this.#pending++;
    const start = opts.transaction ? async () => { while (this.#apart > 0) await new Promise<void>((r) => this.#apartDone.push(r)); return operation(); } : operation;
    const settled = this.#tail.then(start).finally(() => { this.#pending--; });
    this.#tail = settled.then(() => undefined, () => undefined);
    return settled;
  }

  /**
   * `fn` once no transaction is open or queued ahead of it, with every transaction queued after it held
   * until it settles. Sections run alongside one another: they keep transactions off, not each other.
   * `release` ends the hold early (see `PiDurableSqlite.apart`).
   */
  async apart<T>(fn: (release: () => void) => Promise<T>): Promise<T> {
    await this.enqueue(async () => { this.#apart++; });
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      if (--this.#apart === 0) for (const wake of this.#apartDone.splice(0)) wake();
    };
    try { return await fn(release); } finally { release(); }
  }
}

// The row type is the caller's claim about its own SELECT; nothing here can check it, which is the
// contract pi-durable's `get<T>`/`all<T>` declare.
const asRows = <T extends object>(rows: Array<Record<string, SqliteValue>>) => rows as unknown as T[];

class TransactionHandle implements SqliteExecutor {
  #connection: Connection;
  #active = true;
  constructor(connection: Connection) { this.#connection = connection; }
  revoke() { this.#active = false; }

  #use<T>(operation: (connection: Connection) => T): Promise<T> {
    if (!this.#active) return Promise.reject(new Error("SQLite transaction handle is no longer active"));
    try { return Promise.resolve(operation(this.#connection)); } catch (error) { return Promise.reject(error); }
  }
  exec(sql: string) { return this.#use((c) => { query(c, sql, []); }); }
  run(sql: string, ...params: SqliteValue[]) { return this.#use((c) => { query(c, sql, params); }); }
  get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((c) => asRows<T>(query(c, sql, params))[0]); }
  all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((c) => asRows<T>(query(c, sql, params))); }
}

export class PiDurableSqlite implements SqliteDatabase {
  #connection: Connection;
  #queue = new SerialQueue();
  #closed = false;
  #inTransaction = false;

  /** `namespace` places pi-durable's tables: `prefixedNamespace("pd")` on a Durable Object. */
  constructor(host: DurableSqlHost, namespace: SqlNamespace) {
    this.#connection = { host, names: new SqlQualifier(PI_DURABLE_OBJECTS, namespace) };
  }

  #use<T>(operation: (connection: Connection) => T): Promise<T> {
    return this.#queue.run(() => {
      if (this.#closed) throw new Error("database is closed");
      return operation(this.#connection);
    });
  }
  exec(sql: string) { return this.#use((c) => { query(c, sql, []); }); }
  run(sql: string, ...params: SqliteValue[]) { return this.#use((c) => { query(c, sql, params); }); }
  get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((c) => asRows<T>(query(c, sql, params))[0]); }
  all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((c) => asRows<T>(query(c, sql, params))); }

  /**
   * The host's transaction rejects with the closure's own error after rolling back. If the rollback
   * itself failed, the Durable Object gives no separate signal, so the "different error" pi-durable's
   * contract asks for in that case cannot be produced here.
   */
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#queue.enqueue(async () => {
      if (this.#closed) throw new Error("database is closed");
      const handle = new TransactionHandle(this.#connection);
      this.#inTransaction = true;
      try {
        return await this.#connection.host.transaction(async () => {
          try { return await callback(handle); } finally { handle.revoke(); }
        });
      } finally { handle.revoke(); this.#inTransaction = false; }
    }, { transaction: true });
  }

  /** True while a pi-durable transaction is open on the host: any `sql.exec` issued now would join it. */
  get inTransaction(): boolean { return this.#inTransaction; }

  /**
   * Runs a synchronous unit of our own SQL (src/store/ap-store.ts) as one transaction of its own,
   * after any pi-durable transaction that is open or queued has settled.
   *
   * Our SQL cannot simply call `sql.exec`: while a pi-durable transaction is open it is a savepoint
   * over the object's one connection, so our statements would join it, and be rolled back with it
   * when pi-durable's commit fails — a write we believed done, gone. Going through this facade's
   * queue keeps them out of it; `transactionSync` makes the unit atomic (a throw inside leaves
   * nothing written). It does not check `close()`: closing pi-durable's storage does not close the
   * object's database, and our tables outlive it.
   *
   * `fn` must be synchronous, because only what it does before it returns is inside the unit. What
   * is caught:
   * - a function declared `async` (function, arrow or method) or as a generator, async or not, is
   *   refused before it is called: none of its body runs, so nothing after its first `await` can
   *   land later, outside the unit or inside whatever transaction is open by then;
   * - a plain function that returns a thenable has its synchronous part rolled back and is refused.
   * What is not: the work behind that returned thenable (an async function it called, a `.then`
   * callback) still runs later, outside the unit, as does any promise `fn` starts and does not
   * return. Neither can be stopped once started, only not started; `fn` must not start them.
   */
  exclusive<T>(fn: () => T): Promise<T> {
    if (fn instanceof ASYNC_FUNCTION || fn instanceof ASYNC_GENERATOR_FUNCTION || fn instanceof GENERATOR_FUNCTION) {
      return Promise.reject(new TypeError("exclusive() takes a synchronous function; an async or generator one would run outside its transaction, so it is not called"));
    }
    return this.#queue.run(() => this.#connection.host.transactionSync(() => {
      const result = fn();
      if (typeof (result as { then?: unknown } | null)?.then === "function") {
        throw new TypeError("exclusive() takes a synchronous function; this one returned a thenable, whose work would run outside its transaction");
      }
      return result;
    }));
  }

  /**
   * Async work of ours that writes the object's SQL across awaits — a tool call through the gateway,
   * whose store writes operation, approval and usage rows as it goes — kept out of every pi-durable
   * transaction: it starts once none is open or queued ahead of it, and no transaction opens until
   * it settles. `exclusive` is the same guarantee for a synchronous unit; this is it for one that
   * awaits, at the price that pi-durable's commits wait for it.
   *
   * `fn` must not wait for a pi-durable transaction itself (a commit through the harness, `exclusive`
   * once one is queued): that transaction waits for `fn`, so neither would finish. It may call
   * `release` to end the hold before it settles — for work it stops waiting for, whose later writes
   * are then unguarded.
   */
  apart<T>(fn: (release: () => void) => Promise<T>): Promise<T> { return this.#queue.apart(fn); }

  close() { return this.#queue.run(() => { this.#closed = true; }); }
}
