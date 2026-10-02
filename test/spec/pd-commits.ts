/**
 * For tests that start work "during" a pi-durable commit: `host`, calling `after()` as each pi-durable
 * commit ends.
 *
 * pi-durable commits in one synchronous transaction (src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js),
 * so there is no "during" to start work in: no other code runs between its first statement and its end.
 * The earliest anything else can run is right after it, which is when `after` runs — synchronously, as the
 * host's `transactionSync` returns or throws, before the facade has seen the result. A transaction is a
 * pi-durable commit when it advanced `durable_metadata`, as every commit does last (storage.js `commit`):
 * migrations, document reads and units of ours (`exclusive`) do not, and are let through.
 */
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";

const COMMIT = /^\s*UPDATE pd_durable_metadata SET next_id\b/;

export function afterPdCommits(host: DurableSqlHost, after: (outcome: { ok: boolean }) => void): DurableSqlHost {
  let depth = 0;
  let wrote = false;
  return {
    sql: {
      exec(query, ...bindings) {
        if (depth > 0 && COMMIT.test(query)) wrote = true;
        return host.sql.exec(query, ...bindings);
      },
    },
    transaction: (closure) => host.transaction(closure),
    transactionSync(closure) {
      if (depth++ === 0) wrote = false;
      let ok = false;
      try { const out = host.transactionSync(closure); ok = true; return out; }
      finally { if (--depth === 0 && wrote) { wrote = false; after({ ok }); } }
    },
  };
}
