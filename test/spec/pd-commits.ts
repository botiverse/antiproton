/**
 * For tests that start work "during" a pi-durable commit: `host`, calling `after()` as each pi-durable
 * commit ends.
 *
 * pi-durable commits in one synchronous transaction (src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js),
 * so there is no "during" to start work in: no other code runs between its first statement and its end.
 * The earliest anything else can run is right after it, which is when `after` runs — synchronously, as the
 * host's `transactionSync` returns or throws, before the facade has seen the result. A transaction is
 * pi-durable's when it wrote a `pd_` object; a unit of ours (`exclusive`) writes none, and is let through.
 */
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";

const PD_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE)\b[^]*\bpd_/i;

export function afterPdCommits(host: DurableSqlHost, after: (outcome: { ok: boolean }) => void): DurableSqlHost {
  let depth = 0;
  let wrote = false;
  return {
    sql: {
      exec(query, ...bindings) {
        if (depth > 0 && PD_WRITE.test(query)) wrote = true;
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
