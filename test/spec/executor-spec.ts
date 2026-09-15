/**
 * JS executor CONTRACT. The engine is replaceable (§15); these assertions are
 * not. QuickJS in Node and Cloudflare Dynamic Workers at the edge must both
 * satisfy every row.
 */
import { DEFAULT_LIMITS } from "../../src/core/execution.ts";
import type { ExecutorHost, JsExecutor } from "../../src/core/execution.ts";
import type { ToolResult } from "../../src/core/tools.ts";

export interface SpecResult { row: string; name: string; ok: boolean; error?: string }

export async function executorSpec(exec: JsExecutor): Promise<SpecResult[]> {
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

  test("语法错误", "a script that does not parse fails as the script's own error, not the host's", async () => {
    // The Dynamic Worker reported "missing ) after argument list" as an interrupted host_failure, which tells
    // the model the outcome is unknown; QuickJS already called it eval_error. It is the script's (task #19).
    const r = await exec.execute(`output((1)`, host());
    eq(r.status, "failed", "failed, not interrupted");
    eq(r.error!.code, "eval_error", "the script's own error");
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

  test("无逃逸面", "nothing reachable: not the network, not a socket, not the host filesystem", async () => {
    // Deliberately phrased as reachability rather than "these globals are
    // absent". A Workers isolate inherits the Node compat surface — `process`
    // exists, `node:fs` imports, `node:net` exposes Socket — yet none of it
    // reaches anything. What must hold in every implementation is that no route
    // out actually works.
    const r = await exec.execute(
      `const probe = {};
       try { await fetch("https://example.com"); probe.fetch = "REACHED NETWORK"; }
       catch (e) { probe.fetch = "refused"; }
       try {
         const net = await import("node:net");
         probe.socket = await new Promise((resolve) => {
           try {
             const s = net.connect({ host: "example.com", port: 443 });
             const done = (v) => { try { s.destroy(); } catch (e2) {} resolve(v); };
             s.on("connect", () => done("REACHED NETWORK"));
             s.on("error", () => done("refused"));
             setTimeout(() => done("refused"), 2000);
           } catch (e) { resolve("refused"); }
         });
       } catch (e) { probe.socket = "refused"; }
       try {
         const fs = await import("node:fs");
         fs.readFileSync("/etc/passwd");
         probe.hostFs = "REACHED HOST FILESYSTEM";
       } catch (e) { probe.hostFs = "refused"; }
       probe.require = typeof require;
       output(probe);`,
      host(),
    );
    const p = r.outputs[0] as any;
    eq(r.status, "completed", "probe ran");
    eq(p.fetch, "refused", "outbound fetch is refused");
    eq(p.socket, "refused", "raw socket is refused");
    eq(p.hostFs, "refused", "host filesystem is not reachable");
    eq(p.require, "undefined", "no require");
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

  test("输出按码元计", "the output cap counts UTF-16 code units, not bytes, like every …Bytes cap on a string", async () => {
    // 50 CJK characters: 52 code units with the JSON quotes, 152 bytes. Under a
    // cap of 100 the first fits by units and not by bytes, so this case fails
    // the moment the cap goes back to counting bytes; the second takes the
    // running total to 104 and is cut either way.
    const r = await exec.execute(`output("汉".repeat(50)); output("汉".repeat(50)); output("tail");`, host(), {
      ...DEFAULT_LIMITS,
      maxOutputBytes: 100,
    });
    eq(r.outputs[0], "汉".repeat(50), "52 units fit under 100; 152 bytes would not");
    eq((r.outputs[1] as any).truncated, true, "52 more units do not");
    eq(r.outputs[2], "tail", "a small output after a truncation is still recorded");
  });

  test("工具期间中断", "cancelling mid-call reports accepted operations rather than losing them", async () => {
    calls = [];
    const ac = new AbortController();
    // Cancel once the call has actually been made, not after a fixed 40ms.
    // Loading a fresh isolate on the deployed sandbox can take longer than
    // that, and then the abort landed before any call existed — so the case
    // failed about one run in three while testing the scheduler rather than
    // the invariant, which is that an operation the host already accepted
    // survives the cancellation.
    let entered!: () => void;
    const called = new Promise<void>((r) => { entered = r; });
    const slow = host(
      async () => {
        entered();
        return new Promise<ToolResult>((res) =>
          setTimeout(() => res({ status: "succeeded", operationId: "op_slow", result: {} }), 250),
        );
      },
    );
    void called.then(() => ac.abort());
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


  const results: SpecResult[] = [];
  for (const t of tests) {
    try { await t.fn(); results.push({ row: t.row, name: t.name, ok: true }); }
    catch (err) { results.push({ row: t.row, name: t.name, ok: false, error: (err as Error).message }); }
  }
  return results;
}
