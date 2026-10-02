/**
 * Types of the vendored ./storage.js (antiproton's, not upstream's): upstream's `SqliteStorage`, opened over a
 * database that has a synchronous transaction, with an optional commit hook. See the header of ./storage.js.
 */
import type { StorageWrite } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteStorage as UpstreamSqliteStorage, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

/** upstream's `SqliteExecutor`, synchronous: each call has run its statement when it returns. */
export interface SqliteSyncExecutor {
  exec(sql: string): void;
  run(sql: string, ...params: SqliteValue[]): void;
  get<T extends object>(sql: string, ...params: SqliteValue[]): T | undefined;
  all<T extends object>(sql: string, ...params: SqliteValue[]): T[];
}

/**
 * What the vendored storage needs: upstream's facade with `transactionSync` in place of `transaction`.
 *
 * `transactionSync` runs `callback` in one transaction that no other statement can join: it must not return
 * a thenable, and everything it does happens before it returns. A throw rolls back and rejects with the
 * thrown error. The handle is invalid once the callback has returned.
 */
export interface SqliteSyncDatabase extends Omit<SqliteDatabase, "transaction"> {
  transactionSync<T>(callback: (transaction: SqliteSyncExecutor) => T): Promise<T>;
}

/**
 * Called by `commit` inside its transaction, after the batch's checks and before any of its writes is applied, with
 * the transaction's executor, the batch, and the sequence the batch commits as. What it reads through `exec` is the
 * state before the batch; what it writes on the same connection commits or rolls back with it. It must be
 * synchronous; a throw rolls the commit back and the commit rejects with that error.
 */
export type CommitHook = (exec: SqliteSyncExecutor, writes: readonly StorageWrite[], seq: number) => void;

export type SqliteStorage = UpstreamSqliteStorage;
export declare const SqliteStorage: {
  open(db: SqliteSyncDatabase, options?: { onCommit?: CommitHook }): Promise<SqliteStorage>;
};
