/** Runs the executor contract against the Node/QuickJS implementation. */
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { executorSpec } from "./spec/executor-spec.ts";

const results = await executorSpec(new QuickJsExecutor());

// QuickJS has no SDK bridge (`ExecutorHost.bridges`, botiverse/antiproton#1092): an `sdk:` import is refused with a
// message naming the executor that loads one, and a program that lets it go ends with that code, not `uncaught`.
async function bridgeRow(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ ok: true, row: "bridge", name }); }
  catch (e) { results.push({ ok: false, row: "bridge", name, error: String((e as Error)?.message ?? e) }); }
}
const bridgeHost = {
  bridges: [{ specifiers: ["sdk:svc"], alias: "svc", plugin: "svc", files: { "i.js": "" }, entry: "i.js", exports: [] }],
  async invoke() { throw new Error("no host call is made"); },
} as any;
await bridgeRow("an uncaught sdk: import ends the run failed with bridge_unavailable, naming the dynamic worker", async () => {
  const r = await new QuickJsExecutor().execute(`const { svc } = await import("sdk:svc"); output("after");`, bridgeHost);
  if (r.status !== "failed" || r.error?.code !== "bridge_unavailable" || !/dynamic worker/.test(r.error.message) || r.outputs.length) {
    throw new Error(`the import was not refused as bridge_unavailable: ${JSON.stringify(r)}`);
  }
});
await bridgeRow("a caught sdk: import lets the program go on, and any other import is not called a bridge", async () => {
  const r = await new QuickJsExecutor().execute(
    `try { await import("sdk:svc"); } catch (e) { output(/dynamic worker/.test(e.message)); }
     await import("./other.js");`, bridgeHost);
  if (JSON.stringify(r.outputs) !== "[true]" || r.error?.code !== "uncaught") throw new Error(`unexpected: ${JSON.stringify(r)}`);
});
console.log(`\n  JS Executor contract — implementation: QuickJS (node)\n  ${"─".repeat(62)}`);
for (const r of results) {
  if (r.ok) console.log(`  \x1b[32m✓\x1b[0m ${r.row.padEnd(14)} ${r.name}`);
  else console.log(`  \x1b[31m✗\x1b[0m ${r.row.padEnd(14)} ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(62)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
