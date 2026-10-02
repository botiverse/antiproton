/**
 * The pd engine's usage and trace outboxes (test/spec/pd-outbox-spec.ts) over node:sqlite.
 * `npm run pd-outbox:do` runs the same cases on a real Durable Object.
 */
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { runDriveCases } from "./spec/durable-drive-spec.ts";
import { pdOutboxCases } from "./spec/pd-outbox-spec.ts";

const results = await runDriveCases(pdOutboxCases(async (use) => {
  const host = sqliteHost();
  try { await use(host); } finally { host.dispose(); }
}));

console.log(`\n  pd outbox: usage and trace from pi-durable's entries — node:sqlite\n  ${"─".repeat(56)}`);
let group = "";
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`  ${group}`); }
  console.log(r.ok
    ? `    \x1b[32m✓\x1b[0m ${r.name} \x1b[2m(${r.ms} ms)\x1b[0m`
    : `    \x1b[31m✗\x1b[0m ${r.name}\n        \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
