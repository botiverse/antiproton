/** Runs the executor contract against the Node/QuickJS implementation. */
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { executorSpec } from "./spec/executor-spec.ts";

const results = await executorSpec(new QuickJsExecutor());
console.log(`\n  JS Executor contract — implementation: QuickJS (node)\n  ${"─".repeat(62)}`);
for (const r of results) {
  if (r.ok) console.log(`  \x1b[32m✓\x1b[0m ${r.row.padEnd(14)} ${r.name}`);
  else console.log(`  \x1b[31m✗\x1b[0m ${r.row.padEnd(14)} ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(62)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
