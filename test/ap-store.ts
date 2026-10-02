/**
 * The `ap` namespace (src/store/ap-store.ts) and `PiDurableSqlite.exclusive`, over node:sqlite.
 * `npm run ap-store:do` runs the same cases on real Durable Object storage, which is the reading
 * that counts for `exclusive`: node's BEGIN/COMMIT only stands in for the object's savepoint.
 */
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { apStoreCases } from "./spec/ap-store-spec.ts";
import { runPiDurableCases } from "./spec/pi-durable-spec.ts";

const results = await runPiDurableCases(apStoreCases(async (use) => {
  const host = sqliteHost();
  try { await use(host); } finally { host.dispose(); }
}));

console.log(`\n  ap namespace + exclusive — node:sqlite\n  ${"─".repeat(56)}`);
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
