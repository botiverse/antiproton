/**
 * The two methods a Durable Object gives PiSqliteStorage, over node:sqlite.
 *
 * Shared by the storage conformance and the loop spike so both exercise the
 * class production runs rather than a port of it.
 */
import { DatabaseSync } from "node:sqlite";
import type { SqlHost } from "../src/store/pi-storage.ts";

export function sqliteHost(): SqlHost & { dispose(): void } {
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
    dispose() { db.close(); },
  };
}
