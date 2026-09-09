/**
 * SWE-bench Verified through this harness.
 *
 * The first benchmark here that needs a real machine: a repository, its
 * dependencies, and its test suite. That is what the run9 mount is for, and it
 * is deliberately the only way the agent gets one — the QuickJS sandbox it
 * normally works in has no filesystem and no network, and nothing about that
 * changes for this benchmark. The box runs on someone else's machine and holds
 * none of our credentials, so an agent editing a repo there cannot reach the
 * gateway, the tenant's tokens, or anything else we hold.
 *
 * Scoring is SWE-bench's own: apply the official test patch, run the tests that
 * were failing, and require the ones that were passing to still pass.
 *
 *   N=1 node --experimental-strip-types bench/swebench/run.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SqliteStore } from "../../src/store/sqlite.ts";
import { Kernel } from "../../src/runtime/kernel.ts";
import { CommandExecutor } from "../../src/runtime/commands.ts";
import { QuickJsExecutor } from "../../src/runtime/executor.ts";
import { CodegenHarness } from "../../src/harness/codegen.ts";
import { ToolGateway } from "../../src/runtime/gateway.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import { run9Plugin } from "../../src/plugins/run9.ts";
import type { Plugin } from "../../src/plugins/types.ts";
import type { ToolResult } from "../../src/core/tools.ts";

for (const l of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

const N = Number(process.env.N ?? 1);
const OFFSET = Number(process.env.OFFSET ?? 0);
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 30);

interface Instance {
  instance_id: string; repo: string; base_commit: string;
  problem_statement: string; patch: string; test_patch: string;
  FAIL_TO_PASS: string; PASS_TO_PASS: string;
}

const rows = await (await fetch(
  "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified" +
  `&config=default&split=test&offset=${OFFSET}&length=${N}`,
)).json();
const instances: Instance[] = rows.rows.map((r: any) => r.row);

/** The image SWE-bench publishes for an instance, already holding the repo,
 *  its dependencies and a working test runner. */
const imageFor = (id: string) =>
  `docker.io/swebench/sweb.eval.x86_64.${id.replace("__", "_1776_")}:latest`;

const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!,
  model: process.env.HARNESS_MODEL ?? "deepseek-v4-pro",
});

const SYSTEM_EXTRA = `
You are fixing a bug in a Python repository checked out at /testbed.
Use node.shell to explore and edit it — that is a real machine with git, python and the test suite.
Work in small steps: read the failing code first, then make the smallest change that fixes it.
Do not modify test files; the graders supply their own.
When the fix is in place, say so and stop.
`.trim();

async function runOne(inst: Instance) {
  const t0 = Date.now();
  const T = "swe", AGENT = `a_${inst.instance_id}`.slice(0, 60), TASK = "t1";
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(T, AGENT);

  const plugins: Plugin[] = [run9Plugin, builtinToolsPlugin(store, () => plugins)];
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
  const ctx = { tenantId: T, agentId: AGENT, taskId: TASK };
  const host = { invoke: (c: any): Promise<ToolResult> => gw.invoke(ctx, c.tool, c.args, c.opts) };

  const harness = new CodegenHarness({ maxTurns: MAX_TURNS });
  await store.createTask(T, AGENT, TASK, await harness.initialize({
    mounts: (await store.listMounts(T, AGENT)).map((m) => ({
      alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: {} })),
    policy: SYSTEM_EXTRA,
  }), harness.stateVersion);

  const commands = new CommandExecutor(store, model, host, new QuickJsExecutor());
  const kernel = new Kernel(store, harness, { holder: "swe", leaseTtlMs: 900_000 });

  await store.appendEvent({
    tenantId: T, agentId: AGENT, taskId: TASK, kind: "message",
    payload: { text: `Fix this issue in the repository at /testbed.\n\n${inst.problem_statement.slice(0, 6000)}` },
  });

  let steps = 0;
  for (; steps < 200; steps++) {
    const r = await kernel.step(T, TASK, null, (cmd) => commands.dispatch(ctx, cmd));
    if (r.outcome === "no_work") break;
    const t = await store.loadTask(T, TASK);
    if (t && ["completed", "failed", "blocked"].includes(t.status)) break;
  }
  const agentSeconds = Math.round((Date.now() - t0) / 1000);

  // Grade with SWE-bench's own criterion, in the same box the agent worked in.
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const f2p: string[] = JSON.parse(inst.FAIL_TO_PASS);
  const p2p: string[] = JSON.parse(inst.PASS_TO_PASS);
  // Passing means the named tests pass and pytest reports no failures; the
  // agent's own claim that it fixed something is not evidence.
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
  const diffRes: any = await gw.invoke(ctx, "node.shell", { command: "cd /testbed && git diff --stat | tail -3" });
  const fail = await grade(f2p.slice(0, 12));
  const pass = await grade(p2p.slice(0, 12));
  await gw.releaseTask(ctx);
  await store.close();

  const usage = commands.trace.filter((x) => x.kind === "model")
    .reduce((a: any, x: any) => ({ calls: a.calls + 1, prompt: a.prompt + (x.detail.prompt ?? 0),
                                   out: a.out + (x.detail.completion ?? 0) }), { calls: 0, prompt: 0, out: 0 });
  return {
    id: inst.instance_id, resolved: fail.ok && pass.ok,
    failToPass: fail.ok, passToPass: pass.ok,
    diff: String(diffRes.result?.output ?? "").trim().split("\n").pop() ?? "",
    seconds: Math.round((Date.now() - t0) / 1000), agentSeconds, ...usage,
    failOut: fail.ok ? "" : fail.out.split("\n").slice(-4).join(" | ").slice(0, 220),
  };
}

console.log(`\n  SWE-bench Verified — ${instances.length} instance(s), model ` +
  `${process.env.HARNESS_MODEL ?? "deepseek-v4-pro"}\n  ${"─".repeat(80)}`);
const out: any[] = [];
for (const inst of instances) {
  console.log(`  ${inst.instance_id}  (${inst.repo})`);
  let r;
  try { r = await runOne(inst); }
  catch (e) { r = { id: inst.instance_id, resolved: false, error: (e as Error).message.slice(0, 200),
                    seconds: 0, calls: 0, prompt: 0, out: 0 }; }
  out.push(r);
  const mark = r.resolved ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} ${r.seconds}s  ${r.calls} model calls  ${r.prompt} tok` +
    (r.diff ? `  diff: ${r.diff}` : "") + (r.error ? `  ERROR ${r.error}` : ""));
  if (r.failOut) console.log(`      \x1b[31m${r.failOut}\x1b[0m`);
}
const solved = out.filter((r) => r.resolved).length;
console.log(`  ${"─".repeat(80)}\n  resolved ${solved}/${out.length}   ` +
  `${out.reduce((a, r) => a + r.seconds, 0)}s total   ` +
  `${out.reduce((a, r) => a + (r.prompt ?? 0), 0)} prompt tokens\n`);
