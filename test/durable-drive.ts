/**
 * The park contract and the pi-ai 1.0 offloaded provider (test/spec/durable-drive-spec.ts),
 * over node:sqlite. `npm run durable-drive:do` runs the same cases on a real Durable Object.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai";
import { offloadedProvider } from "../src/model/pi-offloaded.ts";
import { SLEEPING_PHASES, WORKING_PHASES } from "../src/runtime/durable-drive.ts";
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

/**
 * The upstream tripwire. `parkVerdict` parks only on sleeps it knows (SLEEPING_PHASES) and calls
 * every other phase working or unrecognised — both mean "stay open". A sleep pi-durable adds in a
 * new version would therefore not loop, but it would be a billed wait nobody chose. So read the
 * installed `dist`: every `.sleep(` call and the phase handler it is in, and every checkpoint phase
 * each built-in task writes, must be exactly what the tables in src/runtime/durable-drive.ts say.
 */
const tripwireCase = {
  group: "provider", name: "pi-durable's sleep sites and checkpoint phases are exactly the ones the park table knows",
  run: async () => {
    const dist = new URL("../node_modules/@earendil-works/pi-durable/dist/", import.meta.url);
    const files = (readdirSync(dist, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".js") && !f.startsWith("testing"));
    const KIND_OF: Record<string, string> = {
      "harness/generation.js": "pi.generation", "harness/compaction.js": "pi.compaction", "harness/tool.js": "pi.tool",
    };
    const sleeps: string[] = [];
    const phases: Record<string, Set<string>> = {};
    for (const f of files) {
      const lines = readFileSync(new URL(f, dist), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/\.sleep\(/.test(line)) {
          let handler = "?";
          for (let j = i; j >= 0; j--) { const m = lines[j]!.match(/^\s+(\w+): async \(task, runtime/); if (m) { handler = m[1]!; break; } }
          sleeps.push(`${KIND_OF[f] ?? f}:${handler}`);
        }
        for (const m of line.matchAll(/phase: "(\w+)"/g)) (phases[KIND_OF[f] ?? f] ??= new Set()).add(m[1]!);
      });
    }
    const expectedSleeps = Object.entries(SLEEPING_PHASES).flatMap(([k, ps]) => ps.map((p) => `${k}:${p}`)).sort();
    if (JSON.stringify(sleeps.sort()) !== JSON.stringify(expectedSleeps)) {
      throw new Error(`sleep sites ${JSON.stringify(sleeps)}, the park table knows ${JSON.stringify(expectedSleeps)}`);
    }
    const kinds = new Set([...Object.keys(SLEEPING_PHASES), ...Object.keys(WORKING_PHASES)]);
    const expected = Object.fromEntries([...kinds].map((k) => [k, [...(SLEEPING_PHASES[k] ?? []), ...(WORKING_PHASES[k] ?? [])].sort()]));
    const found = Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, [...v].sort()]));
    if (JSON.stringify(found, Object.keys(found).sort()) !== JSON.stringify(expected, Object.keys(expected).sort())) {
      throw new Error(`checkpoint phases ${JSON.stringify(found)}, the park table knows ${JSON.stringify(expected)}`);
    }
  },
};

const results = await runDriveCases([
  versionCase,
  tripwireCase,
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
