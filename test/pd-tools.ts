/**
 * Tools on the `pd` engine: the parity cases (test/spec/pd-tools-spec.ts) over node:sqlite, and,
 * node's only, the runtime's catalogue assembly (cf/src/runtime.ts `agent()`) for the same agent on
 * both engines, and the two upstream strings src/runtime/durable-tools.ts depends on, read from the
 * installed packages. `npm run pd-tools:do` runs the spec's cases on a real Durable Object.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { toRequest } from "../src/model/pi-bridge.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { DurableAgent } from "../src/runtime/durable-agent.ts";
import { PI085_INTERRUPTED, pdInterruptedBlock } from "../src/runtime/durable-tools.ts";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { runDriveCases, type DriveCase } from "./spec/durable-drive-spec.ts";
import { pdToolsCases } from "./spec/pd-tools-spec.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** An installed package's file, found through its main entry (an export map hides the rest). */
function packageFile(pkg: string, rel: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(pkg)));
  while (!dir.endsWith("dist")) dir = dirname(dir);
  return readFileSync(join(dir, rel), "utf8");
}

/** A plugin for the fixture agent's mount: one read, one write. */
const kv: Plugin = {
  id: "kv", version: "1.0.0",
  tools: [
    { name: "get", summary: "Read a note.", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] }, sideEffects: "read", idempotency: "none" },
    { name: "put", summary: "Write a note.", parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] }, sideEffects: "write", idempotency: "none" },
  ] as never,
  async invoke() { return {}; },
};

/** The first request the model is sent for "hello" on an AgentRuntime whose object runs `engine`. */
async function firstRequest(engine: "pi085" | "pd") {
  const host = sqliteHost();
  try {
    if (engine === "pd") {
      const ap = new ApStore(host, prefixedNamespace("ap"));
      ap.ensure();
      ap.setEngineOnce("pd");
    }
    const sent: string[] = [];
    const rt = new AgentRuntime({
      ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
      bucket: {} as never, bucketName: "b", models: { resolve: () => null },
      autoRelease: false, extraPlugins: [kv],
      operatorModel: { baseUrl: "https://model.example/v1", apiKey: "operator-key", model: "m1" },
      offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
    } as never);
    await rt.ready();
    await rt.store.createAgent("t", "a");
    await rt.store.setPluginChoice("t", "a", "kv", "enable");
    const added = await rt.addMount("t", "a", { alias: "notes", plugin: "kv", config: {} });
    check(added.ok, `${engine}: the mount was refused: ${show(added)}`);
    await rt.bindOperatorModel("t", "a");
    const agent = await rt.agent("t", "a");
    check(agent instanceof (engine === "pd" ? DurableAgent : PiAgent), `${engine}: opened ${agent.constructor.name}`);
    await rt.postMessage("t", "a", "hello");
    for (let i = 0; i < 20 && sent.length === 0; i++) { await rt.step("t", "a"); await sleep(10); }
    check(sent.length === 1, `${engine}: dispatched ${show(sent)}`);
    const job = await rt.takeJob("t", "a", sent[0]!) as { context: Parameters<typeof toRequest>[0] };
    const names = (await agent.tools()).map((t) => t.name);
    await agent.close();
    return { request: toRequest(job.context), names };
  } finally { host.dispose(); }
}

const nodeCases: DriveCase[] = [
  {
    group: "runtime", name: "AgentRuntime.agent() hands both engines one catalogue: the same tools, and the same system prompt (inside pd's <instructions> tag) with the sandbox paragraph",
    run: async () => {
      const pi = await firstRequest("pi085");
      const pd = await firstRequest("pd");
      const names = (pi.request.tools ?? []).map((t) => t.name);
      check(names.includes("notes__get") && names.includes("notes__put") && names.includes("run_js") && names.includes("resume"),
        `control: the fixture agent is offered ${show(names)}`);
      check(show(pd.request.tools) === show(pi.request.tools),
        `tools differ\n pi085 ${show(names)}\n pd    ${show((pd.request.tools ?? []).map((t) => t.name))}`);
      check(show(pd.names) === show(pi.names) && show(pd.names) === show(names), `engine.tools(): pi085 ${show(pi.names)}, pd ${show(pd.names)}`);
      const system = (r: typeof pi.request) => r.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
      check(system(pd.request).includes("special tool, run_js"), `pd's prompt has no sandbox paragraph: ${system(pd.request).slice(0, 300)}`);
      // pd renders the prompt as pi-durable's `instructions` section, which it tags; the text inside is
      // the same string. The tag is the prompt's own difference (DurableAgent.#conversation), not the tools'.
      const [a, b] = [`<instructions>\n${system(pi.request)}\n</instructions>`, system(pd.request)];
      let at = 0;
      while (at < a.length && a[at] === b[at]) at++;
      check(a === b, `system prompts differ at ${at}\n pi085 …${show(a.slice(Math.max(0, at - 60), at + 120))}\n pd    …${show(b.slice(Math.max(0, at - 60), at + 120))}`);
    },
  },
  {
    group: "upstream", name: "the interrupted texts durable-tools.ts maps between are the installed packages' own",
    run: async () => {
      const pi = packageFile("@earendil-works/pi-agent-core", "harness/runtime/drive/tools.js");
      check(pi.includes(`const INTERRUPTION_MARKER = ${show(PI085_INTERRUPTED)};`), "pi-agent-core's INTERRUPTION_MARKER is not PI085_INTERRUPTED");
      const pd = packageFile("@earendil-works/pi-durable", "harness/tool.js");
      check(pd.includes("const message = `Tool ${call.name} was interrupted and may have partially run`;") &&
        pd.includes("return `<harness>\\n${diagnostics.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.message}`).join(\"\\n\")}\\n</harness>`;"),
        "pi-durable's interrupted result is no longer built the way pdInterruptedBlock assumes");
      check(pdInterruptedBlock("x") === "<harness>\n[error] Tool x was interrupted and may have partially run\n</harness>", "pdInterruptedBlock");
    },
  },
];

const results = await runDriveCases([
  ...pdToolsCases(async (use) => {
    const host = sqliteHost();
    try { await use(host); } finally { host.dispose(); }
  }),
  ...nodeCases,
]);

console.log(`\n  pd tools: parity with pi085 — node:sqlite\n  ${"─".repeat(56)}`);
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
