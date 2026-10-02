/**
 * Types of the vendored ./storage.js (antiproton's, not upstream's): upstream's `SqliteStorage`, opened over a
 * database that has a synchronous transaction. See the header of ./storage.js.
 */
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

export type SqliteStorage = UpstreamSqliteStorage;
export declare const SqliteStorage: {
  open(db: SqliteSyncDatabase): Promise<SqliteStorage>;
};
