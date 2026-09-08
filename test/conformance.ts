/** Runs the kernel contract against the Node-hosted backend.
 *
 *  There used to be a db9-over-pgwire backend here as well. It passed, but at
 *  61s for twelve cases against sqlite's 162ms and the Durable Object's 0ms,
 *  and without SERIALIZABLE it raised 40001 on plain concurrent inserts. Two
 *  backends that both pass the contract is enough to keep the seam honest, and
 *  the two that earn their place are sqlite and Durable Objects. */
import { SqliteStore } from "../src/store/sqlite.ts";
import { kernelSpec } from "./spec/kernel-spec.ts";
import type { StorageAdapter } from "../src/core/store.ts";

const BACKEND = "sqlite";
const newStore = async (): Promise<StorageAdapter> => new SqliteStore(":memory:");

const t0 = Date.now();
const results = await kernelSpec(newStore);
console.log(`\n  Runtime conformance — backend: ${BACKEND}\n  ${"─".repeat(62)}`);
for (const r of results) {
  if (r.ok) console.log(`  \x1b[32m✓\x1b[0m ${r.row.padEnd(22)} ${r.name}`);
  else console.log(`  \x1b[31m✗\x1b[0m ${r.row.padEnd(22)} ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(62)}\n  ${pass} passed, ${results.length - pass} failed  (${Date.now() - t0} ms)\n`);
process.exit(pass === results.length ? 0 : 1);
