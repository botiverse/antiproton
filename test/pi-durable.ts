/**
 * pi-durable's storage conformance, and our facade's own cases, over node:sqlite.
 *
 * The facade (src/store/pi-durable-sqlite.ts) is written against a Durable
 * Object's `sql.exec` and async `transaction`; `sqliteHost` supplies the same
 * methods over node:sqlite, so this runs the class the object will run.
 * `npm run pi-durable:do` runs the same cases on real Durable Object storage,
 * which is the reading that counts for the savepoint semantics — node's
 * BEGIN/COMMIT only stands in for them.
 */
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { piDurableCases, runPiDurableCases } from "./spec/pi-durable-spec.ts";

const results = await runPiDurableCases(piDurableCases(async (use) => {
  const host = sqliteHost();
  try { await use(host); } finally { host.dispose(); }
}));

console.log(`\n  pi-durable Storage conformance + prefix facade — node:sqlite\n  ${"─".repeat(56)}`);
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
