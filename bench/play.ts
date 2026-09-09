/**
 * Drive the harness locally, to feel where it actually gets stuck.
 *
 * No Cloudflare, no Access, no UI — just the kernel, the gateway and a real
 * model, so a problem is the harness's and not the deployment's.
 *
 *   PROMPT="fetch X and summarise it" node --experimental-strip-types bench/play.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SqliteStore } from "../src/store/sqlite.ts";
import { Kernel } from "../src/runtime/kernel.ts";
import { CommandExecutor } from "../src/runtime/commands.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { CodegenHarness } from "../src/harness/codegen.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { builtinToolsPlugin } from "../src/plugins/builtin.ts";
import { demoPlugin } from "../src/plugins/demo.ts";
import { httpPlugin } from "../src/plugins/http.ts";
import { run9Plugin } from "../src/plugins/run9.ts";
import { statePlugin, workingSet } from "../src/plugins/state.ts";
import type { Plugin } from "../src/plugins/types.ts";
import type { ToolResult } from "../src/core/tools.ts";

for (const l of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

const T = "play", AGENT = "a1", TASK = "t1";
const store = new SqliteStore(process.env.STATE_DB ?? ":memory:");
await store.init();
await store.createAgent(T, AGENT);

const plugins: Plugin[] = [
  demoPlugin, httpPlugin, run9Plugin,
  statePlugin(store, null, "local"),
  builtinToolsPlugin(store, () => plugins),
];
for (const [alias, plugin, cfg, policy] of [
  ["tools", "tools", {}, null],
  ["ops", "demo", { account: "demo-fleet" }, { write: "approval" as const }],
  ["web", "http", { account: "open web", maxBytes: 24_000 }, null],
  ["node", "run9", { account: "sandbox" }, null],
  ["state", "state", { account: "agent memory" }, null],
] as const) {
  await store.addMount({
    tenantId: T, agentId: AGENT, alias, plugin, installationId: `i-${alias}`,
    connectionId: null, toolVersion: "1.0.0", publicConfig: cfg as any,
    secretRef: alias === "node" ? "env:RUN9" : null, policy: policy as any,
  });
}

const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!,
  model: process.env.HARNESS_MODEL ?? "deepseek-v4-pro",
});
const gw = new ToolGateway(store, plugins, {
  async resolve(ref) {
    // The agent addresses `node`; the keys stay here.
    return ref === "env:RUN9"
      ? JSON.stringify({ ak: process.env.SYS9_AK, sk: process.env.SYS9_SK })
      : null;
  },
});
const ctx = { tenantId: T, agentId: AGENT, taskId: TASK };
const host = { invoke: (c: any): Promise<ToolResult> => gw.invoke(ctx, c.tool, c.args, c.opts) };

const harness = new CodegenHarness({ maxTurns: Number(process.env.MAX_TURNS ?? 12) });
await store.createTask(T, AGENT, TASK, await harness.initialize({
  mounts: (await store.listMounts(T, AGENT)).map((m) => ({
    alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
  })),
  // What earlier runs wrote down. Set STATE_DB to a file to carry it between
  // runs; the default in-memory store starts each run blank.
  workingSet: await workingSet(store, T, AGENT),
}), harness.stateVersion);

const commands = new CommandExecutor(store, model, host, new QuickJsExecutor());
const kernel = new Kernel(store, harness, { holder: "play", leaseTtlMs: 300_000 });

const prompt = process.env.PROMPT ?? "List the servers, then deploy 2.0.0 to web-01.";
console.log(`\n\x1b[1m? ${prompt}\x1b[0m\n${"─".repeat(78)}`);
await store.appendEvent({ tenantId: T, agentId: AGENT, taskId: TASK, kind: "message", payload: { text: prompt } });

const t0 = Date.now();
let seen = 0;
for (let i = 0; i < 60; i++) {
  const r = await kernel.step(T, TASK, null, (cmd) => commands.dispatch(ctx, cmd));
  for (const tr of commands.trace.slice(seen)) {
    const d = tr.detail as any;
    const at = `\x1b[2m+${((Date.now() - t0) / 1000).toFixed(1)}s\x1b[0m`;
    if (tr.kind === "model") {
      console.log(`${at} \x1b[35mmodel\x1b[0m  ${d.prompt} in / ${d.completion} out  finish=${d.finish}`);
    } else if (tr.kind === "js") {
      console.log(`${at} \x1b[36mjs\x1b[0m     ${d.status}  hostCalls=${d.hostCalls}`);
      console.log(`        \x1b[2m${String(d.source).replace(/\n/g, "\n        ").slice(0, 400)}\x1b[0m`);
      if (d.error) console.log(`        \x1b[31m${JSON.stringify(d.error)}\x1b[0m`);
      console.log(`        → ${JSON.stringify(d.outputs).slice(0, 300)}`);
    } else if (tr.kind === "tool") {
      console.log(`${at} \x1b[33mtool\x1b[0m   ${d.tool} → ${d.status}`);
    } else if (tr.kind === "answer") {
      console.log(`${at} \x1b[32manswer\x1b[0m ${String(d).slice(0, 500)}`);
    }
  }
  seen = commands.trace.length;
  const cur = await store.loadTask(T, TASK);
  if (cur && ["completed", "failed", "blocked"].includes(cur.status)) {
    const rel = await gw.releaseTask(ctx);
    if (rel.released.length) {
      console.log(`\x1b[2m+${((Date.now() - t0) / 1000).toFixed(1)}s\x1b[0m \x1b[2mreleased\x1b[0m ${rel.released.join(", ")}`);
    }
  }
  if (r.outcome === "no_work") {
    // Approving from here is what a person does in the UI; doing it inline
    // proves the task resumes rather than merely parking politely.
    const pending = (await store.listApprovals(T, "pending")).filter((a) => a.taskId === TASK);
    if (process.env.AUTO_APPROVE === "1" && pending.length) {
      for (const a of pending) {
        console.log(`\x1b[2m+${((Date.now() - t0) / 1000).toFixed(1)}s\x1b[0m \x1b[33mapprove\x1b[0m ` +
          `${a.mountAlias}.${a.tool} ${JSON.stringify((a.request as any)?.args ?? {})}`);
        await gw.applyApproval(T, a.operationId, "approved", "operator");
      }
      continue;
    }
    if (pending.length) {
      console.log(`${"─".repeat(78)}\n\x1b[1mparked\x1b[0m waiting on ${pending.length} approval(s): ` +
        pending.map((a) => `${a.mountAlias}.${a.tool}`).join(", "));
    }
    break;
  }
  const t = await store.loadTask(T, TASK);
  if (t && ["completed", "failed", "blocked"].includes(t.status)) {
    console.log(`${"─".repeat(78)}\n\x1b[1mstatus\x1b[0m ${t.status}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const last = (t.checkpoint as any).messages?.at(-1);
    if (last && !commands.trace.some((x) => x.kind === "answer")) {
      console.log(`\x1b[32manswer\x1b[0m ${String(last.content).slice(0, 600)}`);
    }
    break;
  }
}
await store.close();
