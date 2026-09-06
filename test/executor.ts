/**
 * JS Executor conformance. The rows here are the ones that only a real sandbox
 * can answer: no state across executions, a runaway loop actually dies, and the
 * only doors out are `tool` and `output`.
 */
import { QuickJsExecutor, DEFAULT_LIMITS, type ExecutorHost } from "../src/runtime/executor.ts";
import type { ToolResult } from "../src/core/tools.ts";

const exec = new QuickJsExecutor();
let calls: Array<{ tool: string; args: unknown; opts: unknown }> = [];

const host = (impl?: (c: { tool: string; args: any }) => Promise<ToolResult>): ExecutorHost => ({
  async invoke(c) {
    calls.push(c);
    if (impl) return impl(c as any);
    return { status: "succeeded", operationId: `op_${calls.length}`, result: { echo: c.args } };
  },
});

type Test = { row: string; name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (row: string, name: string, fn: () => Promise<void>) => tests.push({ row, name, fn });
function assert(c: unknown, w: string): asserts c {
  if (!c) throw new Error(`assertion failed: ${w}`);
}
const eq = (a: unknown, b: unknown, w: string) =>
  assert(Object.is(a, b), `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

test("JS 两次执行", "no variable, closure or promise survives into the next execution", async () => {
  calls = [];
  const first = await exec.execute(
    `globalThis.leaked = 42; var v = 1; output({ set: globalThis.leaked });`,
    host(),
  );
  eq(first.status, "completed", "first run ok");
  const second = await exec.execute(
    `output({ leaked: typeof globalThis.leaked, v: typeof globalThis.v });`,
    host(),
  );
  eq(JSON.stringify(second.outputs[0]), '{"leaked":"undefined","v":"undefined"}', "fresh context");
});

test("纯 JS 死循环", "a runaway loop is killed inside the budget and the host survives", async () => {
  const t0 = Date.now();
  const r = await exec.execute(`while (true) {}`, host(), { ...DEFAULT_LIMITS, wallTimeMs: 300 });
  const ms = Date.now() - t0;
  eq(r.status, "interrupted", "interrupted");
  eq(r.error!.code, "wall_time_exceeded", "reason reported");
  assert(ms < 3000, `terminated promptly (${ms}ms)`);
  const after = await exec.execute(`output("still alive")`, host());
  eq(after.outputs[0], "still alive", "host still usable afterwards");
});

test("统一入口", "tool tag is the only route out, and it carries business args only", async () => {
  calls = [];
  const r = await exec.execute(
    `const res = await tool\`gh_work.issues.list \${ { repo: "example/project" } }\`;
     output({ status: res.status, echo: res.result.echo });`,
    host(),
  );
  eq(r.status, "completed", "completed");
  eq(calls.length, 1, "one host call");
  eq(calls[0]!.tool, "gh_work.issues.list", "mount-qualified name reached the gateway");
  eq(JSON.stringify(calls[0]!.args), '{"repo":"example/project"}', "no platform fields injected");
  eq(r.acceptedOperationIds.join(","), "op_1", "accepted operation reported upward");
});

test("无逃逸面", "no filesystem, process, network or timer globals exist", async () => {
  const r = await exec.execute(
    `output(["fetch","process","require","XMLHttpRequest","setTimeout","WebSocket","Deno"]
       .map(n => n + ":" + typeof globalThis[n]).join(" "));`,
    host(),
  );
  const line = r.outputs[0] as string;
  for (const g of ["fetch", "process", "require", "XMLHttpRequest", "WebSocket"]) {
    assert(line.includes(`${g}:undefined`), `${g} absent (${line})`);
  }
});

test("单一通道", "a malformed call comes back as a value, not a thrown exception", async () => {
  calls = [];
  const r = await exec.execute(
    `const bad = await tool\`gh_work.issues.list \${ { repo: "x/y", connection: "work" } }\`;
     output({ status: bad.status, code: bad.error.code, hasOpId: "operationId" in bad });`,
    host(),
  );
  eq(r.status, "completed", "script did not throw");
  eq(JSON.stringify(r.outputs[0]), '{"status":"rejected","code":"reserved_argument","hasOpId":false}', "rejected in-band");
  eq(calls.length, 0, "nothing dispatched");
});

test("调用预算", "the host-call budget is enforced in-band", async () => {
  calls = [];
  const r = await exec.execute(
    `let last;
     for (let i = 0; i < 5; i++) last = await tool\`m.t \${ { i } }\`;
     output({ last: last.status, code: last.error && last.error.code });`,
    host(),
    { ...DEFAULT_LIMITS, maxHostCalls: 3 },
  );
  eq(calls.length, 3, "dispatched exactly the budget");
  eq(JSON.stringify(r.outputs[0]), '{"last":"rejected","code":"host_call_budget_exceeded"}', "refused in-band");
});

test("输出上限", "oversized output is truncated, not silently dropped", async () => {
  const r = await exec.execute(`output("x".repeat(500)); output("second");`, host(), {
    ...DEFAULT_LIMITS,
    maxOutputBytes: 100,
  });
  eq((r.outputs[0] as any).truncated, true, "first marked truncated");
  eq(r.outputs[1], "second", "later small output still recorded");
});

test("工具期间中断", "cancelling mid-call reports accepted operations rather than losing them", async () => {
  calls = [];
  const ac = new AbortController();
  const slow = host(
    async () =>
      new Promise<ToolResult>((res) =>
        setTimeout(() => res({ status: "succeeded", operationId: "op_slow", result: {} }), 250),
      ),
  );
  setTimeout(() => ac.abort(), 40);
  const r = await exec.execute(
    `const res = await tool\`m.slow \${ {} }\`; output(res.status);`,
    slow,
    DEFAULT_LIMITS,
    ac.signal,
  );
  eq(r.status, "interrupted", "interrupted");
  eq(r.acceptedOperationIds.join(","), "op_slow", "already-accepted operation survives the cancellation");
});

test("并发上限", "concurrent host calls are capped in-band", async () => {
  calls = [];
  let peak = 0, live = 0;
  const slow = host(async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 30));
    live--;
    return { status: "succeeded", operationId: `op_${calls.length}`, result: {} };
  });
  const r = await exec.execute(
    `const rs = await Promise.all([1,2,3,4,5,6].map(i => tool\`m.t \${ { i } }\`));
     output(rs.map(x => x.status).join(","));`,
    slow,
    { ...DEFAULT_LIMITS, maxConcurrentHostCalls: 2 },
  );
  assert(peak <= 2, `peak concurrency ${peak} <= 2`);
  assert((r.outputs[0] as string).includes("rejected"), "excess calls refused in-band");
});

let pass = 0, fail = 0;
console.log(`\n  JS Executor (QuickJS)\n  ${"─".repeat(62)}`);
for (const t of tests) {
  try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.row.padEnd(14)} ${t.name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.row.padEnd(14)} ${t.name}\n      \x1b[31m${(e as Error).message}\x1b[0m`); }
}
console.log(`  ${"─".repeat(62)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
