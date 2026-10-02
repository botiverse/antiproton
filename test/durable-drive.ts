/**
 * The park contract and the pi-ai 1.0 offloaded provider (test/spec/durable-drive-spec.ts),
 * over node:sqlite. `npm run durable-drive:do` runs the same cases on a real Durable Object.
 */
import { existsSync, readFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai";
import { offloadedProvider } from "../src/model/pi-offloaded.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { durableDriveCases, runDriveCases, wireFormatCases } from "./spec/durable-drive-spec.ts";

// Timers alive in this process: what a parked object must not leave behind.
const activeTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

// The live runtime's provider on pi-ai 0.85, for the wire-format comparison. Only JSON leaves this
// function: the 0.85 world's objects stay in it.
async function startOldJob(conversationJson: string): Promise<string> {
  let request = "";
  const models = createModels();
  models.setProvider(offloadedProvider({
    port: { async start(r) { request = JSON.stringify(r); return "mj_old"; }, async poll() { return null; } },
    id: "queue", models: [{ id: "m1", contextWindow: 100_000 }],
  }));
  const model = models.getModel("queue", "m1");
  if (!model) throw new Error("0.85 model not registered");
  await models.stream(model, JSON.parse(conversationJson), { deferred: true }).result();
  return request;
}

/**
 * `pi-ai-1` (our alias) and the pi-ai pi-durable resolves are two installs of what must be one
 * version: the provider is built with one and its streams and messages are read by the other.
 * docs/pi-upstream.md says why that is tolerable at all; this says when it stops being so.
 */
const versionCase = {
  group: "provider", name: "pi-ai-1 is the same pi-ai version pi-durable resolves",
  run: async () => {
    const version = (path: string) => String(JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).version);
    const nested = "../node_modules/@earendil-works/pi-durable/node_modules/@earendil-works/pi-ai/package.json";
    const theirs = version(existsSync(new URL(nested, import.meta.url)) ? nested : "../node_modules/@earendil-works/pi-ai/package.json");
    const ours = version("../node_modules/pi-ai-1/package.json");
    if (ours !== theirs) throw new Error(`pi-ai-1 is ${ours}, pi-durable resolves ${theirs}`);
  },
};

const results = await runDriveCases([
  versionCase,
  ...await wireFormatCases({ startOldJob }),
  ...durableDriveCases(async (use) => {
    const host = sqliteHost();
    try { await use(host); } finally { host.dispose(); }
  }, activeTimers),
]);

console.log(`\n  durable drive: park contract + offloaded provider — node:sqlite\n  ${"─".repeat(56)}`);
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
