/**
 * pi's storage conformance suite, run against our SQLite backend.
 *
 * These cases are not ours. `createStorageConformance` ships inside
 * @earendil-works/pi-agent-core as runner-independent `{group, name, run()}`
 * objects, which is the reason for implementing pi's interface at all: the
 * invariants a session store has to hold — a mixed batch is all-or-nothing,
 * a failed transaction leaves overwritten values as they were, a cursor is
 * applied before a limit, two commits fired without awaiting land in admission
 * order — get checked by someone who did not also write the implementation.
 *
 * The Durable Object supplies `sql.exec` and `transactionSync` itself. Here the
 * same two are built over node:sqlite, so the class under test is the class that
 * runs in production rather than a port of it.
 */
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { PiSqliteStorage } from "../src/store/pi-storage.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const cases = createStorageConformance(async () => {
  const host = sqliteHost();
  return {
    storage: new PiSqliteStorage(host),
    async [Symbol.asyncDispose]() { host.dispose(); },
  };
});

const results: Array<{ group: string; name: string; ok: boolean; error?: string }> = [];
for (const c of cases) {
  try { await c.run(); results.push({ group: c.group, name: c.name, ok: true }); }
  catch (e) {
    results.push({ group: c.group, name: c.name, ok: false, error: String((e as Error)?.message ?? e) });
  }
}

console.log(`\n  pi Storage conformance — SQLite backend\n  ${"─".repeat(56)}`);
let group = "";
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`  ${group}`); }
  console.log(r.ok
    ? `    \x1b[32m✓\x1b[0m ${r.name}`
    : `    \x1b[31m✗\x1b[0m ${r.name}\n        \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
