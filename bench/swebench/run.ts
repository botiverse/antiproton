/**
 * SWE-bench Verified through this harness.
 *
 * The first benchmark here that needs a real machine: a repository, its
 * dependencies, and its test suite. That is what the run9 mount is for, and it
 * is deliberately the only way the agent gets one — the sandbox it normally
 * works in has no filesystem and no network, and nothing about that changes for
 * this benchmark. The box runs on someone else's machine and holds none of our
 * credentials, so an agent editing a repo there cannot reach the gateway, the
 * tenant's tokens, or anything else we hold.
 *
 * Scoring is SWE-bench's own: apply the official test patch, run the tests that
 * were failing, and require the ones that were passing to still pass. The
 * agent's own claim that it fixed something is not evidence.
 *
 * What is different since the loop was replaced: there is no kernel to step and
 * no command executor. The object-side runtime is `PiAgent`, driven exactly as
 * an alarm drives it, and the model call goes through the same deferred port
 * production uses — with a plain Node function where Cloudflare has a queue.
 * The point of that is to measure the code that ships.
 *
 *   N=1 node bench/swebench/run.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SqliteStore } from "../../src/store/sqlite.ts";
import { sqliteHost } from "../../src/store/sqlite-host.ts";
import { PiAgent } from "../../src/runtime/pi-agent.ts";
import { QuickJsExecutor } from "../../src/runtime/executor.ts";
import { ToolGateway } from "../../src/runtime/gateway.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { toRequest, fromResponse, errorMessage } from "../../src/model/pi-bridge.ts";
import { contextWindowFor } from "../../src/model/context-windows.ts";
import { systemPrompt } from "../../src/runtime/pi-prompt.ts";
import { runJsTool, bridgeTools, type MountedTool } from "../../src/runtime/pi-tools.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import { run9Plugin } from "../../src/plugins/run9.ts";
import type { Plugin } from "../../src/plugins/types.ts";
import type { ToolResult } from "../../src/core/tools.ts";
import { readMeter, ratesFromEnv, meterLine } from "../meter.ts";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";

for (const l of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

const N = Number(process.env.N ?? 1);
const OFFSET = Number(process.env.OFFSET ?? 0);
/** Wall clock, not turns. pi's harness stops when the model stops asking for
 *  tools, so the guard that matters is how long one instance may take. */
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 900_000);
const MODEL_ID = process.env.HARNESS_MODEL ?? "deepseek-v4-pro";

interface Instance {
  instance_id: string; repo: string; base_commit: string;
  problem_statement: string; patch: string; test_patch: string;
  FAIL_TO_PASS: string; PASS_TO_PASS: string;
}

const res = await fetch(
  "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified" +
  `&config=default&split=test&offset=${OFFSET}&length=${N}`,
);
// The dataset server rate-limits and answers with an HTML page, which used to
// surface as `Unexpected token '<'` from JSON.parse — a benchmark that cannot
// fetch its instances should say that, not produce a syntax error.
const raw = await res.text();
let rows: any;
try {
  rows = JSON.parse(raw);
} catch {
  console.error(
    `\n  could not load SWE-bench instances: HTTP ${res.status}, ` +
    `${raw.slice(0, 120).replace(/\s+/g, " ")}\n  (the dataset server rate-limits; try again shortly)\n`,
  );
  process.exit(1);
}
const instances: Instance[] = rows.rows.map((r: any) => r.row);

/** The image SWE-bench publishes for an instance, already holding the repo,
 *  its dependencies and a working test runner. */
const imageFor = (id: string) =>
  `docker.io/swebench/sweb.eval.x86_64.${id.replace("__", "_1776_")}:latest`;

const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!,
  model: MODEL_ID,
});

const POLICY = `
You are fixing a bug in a Python repository checked out at /testbed.
Use node.shell to explore and edit it — that is a real machine with git, python and the test suite.
Work in small steps: read the failing code first, then make the smallest change that fixes it.
Do not modify test files; the graders supply their own.
When the fix is in place, say so and stop.
`.trim();

/**
 * What the queue does in production, as a function.
 *
 * The shape that matters is preserved, and it is the reason this is not simply
 * an inline call: `dispatch` returns immediately, so `step()` is never blocked
 * on the provider, and the answer arrives later through `deliver()` exactly as
 * it does when a Worker hands it back. On Cloudflare the waiting happens in a
 * Worker billed for CPU; here it happens on a promise nobody is awaiting.
 */
function nodeWorker(agentOf: () => PiAgent) {
  let inFlight = 0;
  let calls = 0;
  return {
    get inFlight() { return inFlight; },
    get calls() { return calls; },
    dispatch(jobId: string) {
      const agent = agentOf();
      const job = agent.takeJob(jobId) as any;
      // Null means it was already answered — a second dispatch of the same job
      // must not call the provider again.
      if (!job) return;
      inFlight += 1;
      calls += 1;
      const identity = {
        api: String(job.model?.api ?? "offloaded"),
        provider: String(job.model?.provider ?? "openai-compatible"),
        id: String(job.model?.id ?? MODEL_ID),
      };
      void (async () => {
        try {
          const { messages, tools } = toRequest(job.context);
          const r = await model.complete(messages, tools ? { tools } : {});
          agent.deliver(jobId, fromResponse(r, identity));
        } catch (e: any) {
          agent.deliver(jobId, errorMessage(String(e?.message ?? e).slice(0, 300), identity));
        } finally { inFlight -= 1; }
      })();
    },
  };
}

async function runOne(inst: Instance) {
  const t0 = Date.now();
  const T = "swe", AGENT = `a_${inst.instance_id}`.slice(0, 60);

  // The domain store: mounts, quotas, approvals. Unchanged by the new loop.
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(T, AGENT);

  const plugins: Plugin[] = [run9Plugin(null, "local"), builtinToolsPlugin(store, () => plugins)];
  await store.addMount({
    tenantId: T, agentId: AGENT, alias: "node", plugin: "run9",
    installationId: "i-node", connectionId: null, toolVersion: "1.0.0",
    publicConfig: {
      image: imageFor(inst.instance_id), workdir: "/testbed", shape: "2c4g", timeoutMs: 300_000,
      // The image's toolchain lives in a conda env that `sh -lc` never enters.
      shell: "/bin/bash",
      shellPrefix: "source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && ",
    },
    secretRef: "env:RUN9", policy: null,
  });
  await store.addMount({
    tenantId: T, agentId: AGENT, alias: "tools", plugin: "tools",
    installationId: "i-tools", connectionId: null, toolVersion: "1.0.0",
    publicConfig: {}, secretRef: null, policy: null,
  });

  const gw = new ToolGateway(store, plugins, {
    async resolve(ref) {
      return ref === "env:RUN9"
        ? JSON.stringify({ ak: process.env.SYS9_AK, sk: process.env.SYS9_SK })
        : null;
    },
  });
  const ctx = { tenantId: T, agentId: AGENT, taskId: "main" };
  const host = { invoke: (c: any): Promise<ToolResult> => gw.invoke(ctx, c.tool, c.args, c.opts) };

  // The catalogue, built the way the deployment builds it, so the benchmark
  // measures the code that runs rather than a second wiring of its own.
  const mounted = await store.listMounts(T, AGENT);
  const byId = new Map(plugins.map((pl) => [pl.id, pl]));
  /**
   * The catalogue, minus the one tool that can destroy the evidence.
   *
   * `run9.release` says it destroys the container and stops the meter, so an
   * agent tidying up at the end of a task calls it — and it is right to, in
   * production. Here the grader runs *after* the agent, in the same box, so a
   * released container means grading a fresh one from the base image: no diff,
   * every test still failing, and a spurious zero that looks exactly like the
   * model being wrong. It cost one instance before it was noticed.
   *
   * The runner owns the container's lifetime, so the agent is not offered it.
   */
  const OWNED_BY_THE_RUNNER = new Set(["node.release"]);
  const tools: MountedTool[] = mounted.flatMap((m) =>
    (byId.get(m.plugin)?.tools ?? []).map((t) => ({
      name: t.name, description: t.summary, parameters: t.parameters,
      address: `${m.alias}.${t.name}`,
      sideEffects: t.sideEffects, idempotency: t.idempotency,
    }))).filter((t) => !OWNED_BY_THE_RUNNER.has(t.address));

  const holder: { agent?: PiAgent } = {};
  const w = nodeWorker(() => holder.agent!);
  const agent = await PiAgent.open({
    host: sqliteHost(),
    sessionId: `${T}/${AGENT}`,
    systemPrompt: systemPrompt({ policy: POLICY, sandbox: true }),
    model: { provider: "openai-compatible", id: MODEL_ID, contextWindow: contextWindowFor(MODEL_ID) },
    tools,
    toolHost: host,
    dispatch: async (jobId) => { w.dispatch(jobId); },
  });
  holder.agent = agent;
  // The sandbox is a tool like any other, added the same way the object adds
  // it: run_js is the one tool whose body is the runtime rather than a plugin.
  agent.harness.setTools([
    ...bridgeTools(tools, host),
    runJsTool(new QuickJsExecutor() as any, host),
  ] as any, CTX);

  await agent.say(
    `Fix this issue in the repository at /testbed.\n\n${inst.problem_statement.slice(0, 6000)}`);

  // Exactly the alarm's job: one pass, then come back when it said to.
  let passes = 0;
  while (Date.now() - t0 < BUDGET_MS) {
    const out = await agent.step();
    passes += 1;
    // Idle only counts when nothing is still out: a pass can find no open
    // operation while the provider is mid-answer.
    if (out.wakeInMs === null && w.inFlight === 0) break;
    await new Promise((r) => setTimeout(r, Math.max(200, Math.min(out.wakeInMs, 2_000))));
  }
  const agentSeconds = Math.round((Date.now() - t0) / 1000);

  const entries = await agent.storage.scanEntries({ order: "asc" }, CTX);
  const modelTurns = entries.filter((e: any) =>
    e.type === "message" && e.message?.role === "assistant" && e.message?.stopReason !== "deferred").length;
  const toolTurns = entries.filter((e: any) =>
    e.type === "message" && e.message?.role === "toolResult").length;

  // A run that ends in one turn is not a model being bad at the task, it is the
  // loop stopping — and without this the benchmark reports a failed instance
  // and no reason.
  if (process.env.TRACE === "1" || modelTurns <= 2) {
    console.log(`  \x1b[33m[trace] ${inst.instance_id}: ${modelTurns} model turn(s), ` +
      `${toolTurns} tool result(s), ${passes} passes\x1b[0m`);
    for (const e of entries.slice(-6) as any[]) {
      const d = JSON.stringify(e.message ?? e.summary ?? e).slice(0, 300).replace(/\\n/g, " ");
      console.log(`    ${e.seq} ${e.type}: ${d}`);
    }
  }

  // Grade with SWE-bench's own criterion, in the same box the agent worked in.
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const f2p: string[] = JSON.parse(inst.FAIL_TO_PASS);
  const p2p: string[] = JSON.parse(inst.PASS_TO_PASS);
  const grade = async (ids: string[]) => {
    if (!ids.length) return { ok: true, out: "(none)" };
    const res: any = await gw.invoke(ctx, "node.shell", {
      command:
        `cd /testbed && echo '${b64(inst.test_patch)}' | base64 -d > /tmp/test.patch && ` +
        `git checkout -- $(git diff --name-only -- '*test*' 2>/dev/null) 2>/dev/null; ` +
        `git apply -v /tmp/test.patch 2>&1 | tail -2; ` +
        `python -m pytest -q ${ids.map((i) => `'${i}'`).join(" ")} 2>&1 | tail -12`,
    });
    const out = String(res.result?.output ?? "");
    const tail = out.split("\n").slice(-3).join(" ");
    return { ok: /\d+ passed/.test(tail) && !/\d+ (failed|error)/.test(tail), out };
  };
  const diffRes: any = await gw.invoke(ctx, "node.shell",
    { command: "cd /testbed && git diff --stat | tail -3" });
  const fail = await grade(f2p.slice(0, 12));
  const pass = await grade(p2p.slice(0, 12));
  // A box that outlives its run is billed for existing, and this benchmark
  // starts one per instance. Silence here is how thirteen of them were once
  // found alive.
  const release = await gw.releaseTask(ctx);
  for (const f of release.failed) {
    console.log(`      \x1b[31mrelease failed: ${f.alias}: ${f.error}\x1b[0m`);
  }
  // A suspended turn is recorded as an assistant message carrying the handle
  // and no content, so counting every message with a `usage` field counts each
  // model call once for the answer and once for every poll that found it not
  // ready — 85 where there were 17.
  const usage = entries.reduce((a: any, e: any) => {
    const m = e.message;
    if (m?.role !== "assistant" || m.stopReason === "deferred") return a;
    a.calls += 1;
    a.prompt += m.usage?.input ?? 0;
    a.out += m.usage?.output ?? 0;
    // What the provider served from cache rather than re-read. It is the
    // number that decides what a long run actually costs, and reporting
    // prompt tokens without it overstates the bill several times over.
    a.cached += m.usage?.cacheRead ?? 0;
    return a;
  }, { calls: 0, prompt: 0, out: 0, cached: 0 });

  /**
   * Which tools were used, and how often.
   *
   * `run_js` earns its place only by replacing several calls with one, so a
   * total that lumps it in with everything else cannot say whether it did.
   * Reported separately for that reason, not for completeness.
   */
  const byTool: Record<string, number> = {};
  for (const e of entries as any[]) {
    const name = e.message?.role === "toolResult" ? e.message.toolName : null;
    if (name) byTool[name] = (byTool[name] ?? 0) + 1;
  }

  // Read after release: a session is written into the mount's connection state
  // when the box is handed back, precisely so the meter outlives the box.
  const meter = await readMeter(store, T, AGENT, ["node"], Date.now() - t0, {
    promptTokens: usage.prompt, cachedTokens: usage.cached, outputTokens: usage.out,
  });

  // Closed last, and after the meter: the container's session lives in the
  // store, so closing it first threw the measurement away.
  await agent.close();
  await store.close();

  return {
    id: inst.instance_id, resolved: fail.ok && pass.ok,
    failToPass: fail.ok, passToPass: pass.ok,
    diff: String(diffRes.result?.output ?? "").trim().split("\n").pop() ?? "",
    seconds: Math.round((Date.now() - t0) / 1000), agentSeconds, modelTurns, toolTurns,
    modelCalls: w.calls, byTool, meter, ...usage,
    failOut: fail.ok ? "" : fail.out.split("\n").slice(-4).join(" | ").slice(0, 220),
  };
}

console.log(`\n  SWE-bench Verified — ${instances.length} instance(s), model ${MODEL_ID}, ` +
  `harness pi\n  ${"─".repeat(80)}`);
const out: any[] = [];
for (const inst of instances) {
  console.log(`  ${inst.instance_id}  (${inst.repo})`);
  let r;
  try { r = await runOne(inst); }
  catch (e) {
    r = { id: inst.instance_id, resolved: false, error: (e as Error).message.slice(0, 200),
          seconds: 0, calls: 0, prompt: 0, out: 0 };
  }
  out.push(r);
  const mark = r.resolved ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const tools = Object.entries(r.byTool ?? {})
    .sort((a: any, b: any) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(" ");
  const cachePct = r.prompt ? Math.round((r.cached / r.prompt) * 100) : 0;
  const RATES = ratesFromEnv();
  console.log(`  ${mark} ${r.seconds}s  ${r.calls} model calls  ${r.prompt} tok ` +
    `(${cachePct}% cached)` + (tools ? `  [${tools}]` : "") +
    (r.diff ? `  diff: ${r.diff}` : "") + (r.error ? `  ERROR ${r.error}` : ""));
  if (r.meter) console.log(`      ${meterLine(r.meter, RATES)}`);
  if (r.failOut) console.log(`      \x1b[31m${r.failOut}\x1b[0m`);
}
const solved = out.filter((r) => r.resolved).length;
const totals = out.reduce((a: any, r: any) => {
  for (const [n, c] of Object.entries(r.byTool ?? {})) a.tools[n] = (a.tools[n] ?? 0) + (c as number);
  return { ...a, prompt: a.prompt + (r.prompt ?? 0), cached: a.cached + (r.cached ?? 0) };
}, { prompt: 0, cached: 0, tools: {} as Record<string, number> });
console.log(`  ${"─".repeat(80)}\n  resolved ${solved}/${out.length}   ` +
  `${out.reduce((a, r) => a + r.seconds, 0)}s total   ` +
  `${totals.prompt} prompt tokens ` +
  `(${totals.prompt ? Math.round((totals.cached / totals.prompt) * 100) : 0}% served from cache)\n` +
  `  tools: ${Object.entries(totals.tools).sort((a: any, b: any) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`).join("  ") || "(none)"}\n`);
