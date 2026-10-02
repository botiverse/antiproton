/**
 * The methods a Durable Object's storage gives PiSqliteStorage and
 * PiDurableSqlite, over node:sqlite.
 *
 * Shared by the tests and the benchmarks, so both exercise the class production
 * runs rather than a port of it.
 */
import { DatabaseSync } from "node:sqlite";
import type { SqlHost } from "./pi-storage.ts";
import type { DurableSqlHost } from "./pi-durable-sqlite.ts";

export function sqliteHost(): SqlHost & DurableSqlHost & { dispose(): void } {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const rows = db.prepare(query).all(...(bindings as any[]));
        return { toArray: () => rows };
      },
    },
    // node:sqlite has no transaction helper, so the three statements are the
    // helper. Nothing nests: a commit is the only writer, and commits are
    // serialised by the storage itself.
    transactionSync<T>(cb: () => T): T {
      db.exec("BEGIN");
      try { const result = cb(); db.exec("COMMIT"); return result; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    // The async form, as `ctx.storage.transaction` behaves: one transaction on
    // the one connection, held across awaits, so a statement issued by anyone
    // while it is open joins it — the same hazard the Durable Object has, which
    // is what lets test/pi-durable.ts show the facade's queue keeping it out.
    async transaction<T>(cb: () => Promise<T>): Promise<T> {
      db.exec("BEGIN");
      let result: T;
      try { result = await cb(); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
      db.exec("COMMIT");
      return result;
    },
    dispose() { db.close(); },
  };
}
