/** Runs the kernel contract against a Node-hosted backend.
 *  HARNESS_STORE=sqlite (default) | postgres */
import { SqliteStore } from "../src/store/sqlite.ts";
import { kernelSpec } from "./spec/kernel-spec.ts";
import type { StorageAdapter } from "../src/core/store.ts";

const BACKEND = process.env.HARNESS_STORE ?? "sqlite";
const newStore = async (): Promise<StorageAdapter> => {
  if (BACKEND === "postgres") {
    const { PostgresStore } = await import("../src/store/postgres.ts");
    return new PostgresStore({ connectionString: process.env.DB9_DSN!, max: 6 });
  }
  return new SqliteStore(":memory:");
};

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
