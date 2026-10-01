/**
 * The pause rows of the executor contract, against the Dynamic Worker executor,
 * in node.
 *
 * The loader here evaluates the module the executor generates — the real
 * runner, with its pause(), output() and tool tag — as an ES module, and its
 * tool binding goes straight to handleSandboxCall, as the platform's does
 * through SandboxTools. So the Worker's half of pause (the runner) and its
 * supervisor's half (handleSandboxCall, the answer it reads) are both the
 * shipped code. Only the pause rows: the others need the platform's isolation
 * (a runaway loop would hang node; node has a network) and run on a deployment
 * (bench/cf-conformance.mjs).
 */
import { DynamicWorkerExecutor, handleSandboxCall } from "../src/runtime/dynamic-worker-executor.ts";
import { executorSpec } from "./spec/executor-spec.ts";

const exec = new DynamicWorkerExecutor({
  loader: {
    load: (code: any) => ({
      getEntrypoint: () => ({
        fetch: async (req: Request) => {
          const src = code.modules[code.mainModule] as string;
          const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
          return mod.default.fetch(req, code.env);
        },
      }),
    }),
  },
  makeToolBinding: (execId) => ({
    invoke: (strings: string[], values: unknown[]) => handleSandboxCall(execId, strings, values),
  }),
});

const extra: Array<{ ok: boolean; row: string; name: string; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); extra.push({ ok: true, row: "worker", name }); }
  catch (e) { extra.push({ ok: false, row: "worker", name, error: String((e as Error)?.message ?? e) }); }
}
const okHost = { async invoke() { return { status: "succeeded", operationId: "op", result: {} }; } } as any;

await check("the program cannot reach env, so it cannot call the tool binding around the tag", async () => {
  const r = await exec.execute(`output([typeof env, typeof request]);`, okHost);
  if (JSON.stringify(r.outputs) !== '[["undefined","undefined"]]') throw new Error(`reachable: ${JSON.stringify(r)}`);
});

await check("a program may still declare its own output or pause", async () => {
  const r = await exec.execute(`const pause = 1; const output = 2; return pause + output;`, okHost);
  if (r.status !== "completed") throw new Error(`shadowing broke: ${JSON.stringify(r)}`);
});

await check("after a hold the supervisor refuses further calls itself, whatever the sandbox does", async () => {
  const { executions } = await import("../src/runtime/dynamic-worker-executor.ts");
  const { DEFAULT_LIMITS } = await import("../src/core/execution.ts");
  const seen: string[] = [];
  executions.set("exec-held", {
    host: { async invoke(c: any) { seen.push(c.tool); return { status: "pending", operationId: "op_h" }; } },
    limits: DEFAULT_LIMITS, hostCalls: 0, inFlight: 0, accepted: [], aborted: false, pending: new Set(),
  } as any);
  try {
    const first = await handleSandboxCall("exec-held", ["m.send ", ""], [{}]);
    const second = await handleSandboxCall("exec-held", ["m.next ", ""], [{}]);
    if (first.status !== "pending") throw new Error(`first: ${JSON.stringify(first)}`);
    if (second.status !== "rejected" || second.error.code !== "execution_paused") throw new Error(`second: ${JSON.stringify(second)}`);
    if (seen.join() !== "m.send") throw new Error(`a call after the hold reached the host: ${seen}`);
  } finally {
    executions.delete("exec-held");
  }
});

const PAUSE_ROWS = new Set(["暂停", "暂停不可吞", "暂停数据", "暂停于审批", "暂停于未等的调用", "其它状态照旧", "统一入口", "单一通道"]);
const results = await executorSpec(exec, (row) => PAUSE_ROWS.has(row));
for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.row} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
for (const r of extra) console.log(`${r.ok ? "ok " : "FAIL"} ${r.row} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
results.push(...extra);
const failed = results.filter((r) => !r.ok).length;
// A filter that matched nothing would pass vacuously.
if (results.length !== PAUSE_ROWS.size + extra.length) {
  console.log(`FAIL ran ${results.length - extra.length} contract rows, expected ${PAUSE_ROWS.size}`);
  process.exit(1);
}
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
