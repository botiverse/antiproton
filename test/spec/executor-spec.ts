/**
 * JS executor CONTRACT. The engine is replaceable (§15); these assertions are
 * not. QuickJS in Node and Cloudflare Dynamic Workers at the edge must both
 * satisfy every row.
 */
import { DEFAULT_LIMITS } from "../../src/core/execution.ts";
import type { ExecutorHost, JsExecutor } from "../../src/core/execution.ts";
import type { ToolResult } from "../../src/core/tools.ts";

export interface SpecResult { row: string; name: string; ok: boolean; error?: string }

/** `only` picks rows by name, for a harness that can run some rows and not others (a Node stand-in for the Worker). */
export async function executorSpec(exec: JsExecutor, only?: (row: string) => boolean): Promise<SpecResult[]> {
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

  // pause(): the program stops itself. Every row here is about the host's
  // state deciding, not the throw: the throw can be caught, the state cannot.
  test("暂停", "pause() ends the program: nothing after it runs, and the run reports paused with what came before", async () => {
    calls = [];
    const r = await exec.execute(
      `await tool\`m.first \${ { i: 1 } }\`;
       output("before");
       pause("which one?", { options: ["a", "b"] });
       output("after");
       await tool\`m.second \${ {} }\`;`,
      host(),
    );
    eq(r.status, "paused", "paused, not failed or completed");
    eq(r.pause?.cause, "pause", "the program asked");
    eq(r.pause?.reason, "which one?", "reason kept");
    eq(JSON.stringify(r.pause?.data), '{"options":["a","b"]}', "data kept");
    eq(JSON.stringify(r.outputs), '["before"]', "outputs so far, nothing after");
    eq(calls.map((c) => c.tool).join(","), "m.first", "the call after pause was never made");
    eq(r.hostCalls, 1, "one call counted");
    eq(r.error, undefined, "not reported as an error");
    eq(r.continuation, undefined, "a pause the program never awaited ends it: nothing to resume");
  });

  test("暂停不可吞", "a try/catch around pause() does not swallow it: later outputs and calls are refused, the run is still paused", async () => {
    calls = [];
    const r = await exec.execute(
      `try { pause("stop here", 1); } catch (e) { output("caught " + e.name); }
       try { await tool\`m.after \${ {} }\`; } catch (e) { output("caught again"); }
       output("still going");
       return 42;`,
      host(),
    );
    eq(r.status, "paused", "paused although the program caught it and returned");
    eq(r.pause?.reason, "stop here", "the pause is the one reported");
    eq(JSON.stringify(r.outputs), "[]", "nothing output after pause was kept");
    eq(calls.length, 0, "no call after pause reached the host");
    // Ended by a throw of its own, not a return: still the pause.
    const thrown = await exec.execute(`try { pause("p"); } catch (e) {} throw new Error("mine");`, host());
    eq(thrown.status, "paused", "a later throw does not turn it into a failure");
    // The first stop is the one reported.
    const twice = await exec.execute(`try { pause("first"); } catch (e) {} pause("second");`, host());
    eq(twice.pause?.reason, "first", "a second pause does not overwrite the first");
  });

  test("暂停数据", "data that is not JSON-serialisable is reported in the result, not a crash; oversized data is cut like an output", async () => {
    const circular = await exec.execute(`const o = {}; o.self = o; output("x"); pause("loop", o);`, host());
    eq(circular.status, "paused", "a circular object still pauses");
    eq(circular.pause?.data, null, "nothing of it kept");
    assert(/not JSON-serialisable/.test(String(circular.pause?.dataError)), `the problem is named: ${circular.pause?.dataError}`);
    eq(JSON.stringify(circular.outputs), '["x"]', "outputs still there");
    const big = await exec.execute(`pause("b", 10n);`, host());
    assert(/not JSON-serialisable/.test(String(big.pause?.dataError)), `a BigInt is named: ${big.pause?.dataError}`);
    const fn = await exec.execute(`pause("f", () => 1);`, host());
    assert(/not JSON-serialisable/.test(String(fn.pause?.dataError)), `a function is named: ${fn.pause?.dataError}`);
    const none = await exec.execute(`pause("n");`, host());
    eq(none.pause?.data, null, "no data is null");
    eq(none.pause?.dataError, undefined, "no data is not a problem");
    // Outputs and data share one cap: 60 units of output leave 40 for data.
    const cut = await exec.execute(`output("y".repeat(58)); pause("c", "z".repeat(50));`, host(), {
      ...DEFAULT_LIMITS, maxOutputBytes: 100,
    });
    eq((cut.pause?.data as any)?.truncated, true, "data past the cap is marked truncated");
    const fits = await exec.execute(`output("y".repeat(58)); pause("c", "z".repeat(30));`, host(), {
      ...DEFAULT_LIMITS, maxOutputBytes: 100,
    });
    eq(fits.pause?.data, "z".repeat(30), "data within the room is kept");
  });

  test("暂停于审批", "a call held for approval ends the program as paused, reports the held operation, and the next call is never made", async () => {
    calls = [];
    const gate = host(async (c) => c.tool === "m.send"
      ? ({ status: "pending", operationId: "op_held", error: { code: "awaiting_approval", message: "held" } } as any)
      : { status: "succeeded", operationId: `op_${calls.length}`, result: {} });
    const r = await exec.execute(
      `await tool\`m.read \${ {} }\`;
       output("read");
       let res;
       try { res = await tool\`m.send \${ { confirm: true } }\`; } catch (e) { output("caught"); }
       output({ after: res && res.status });
       await tool\`m.next \${ {} }\`;`,
      gate,
    );
    eq(r.status, "paused", "paused");
    eq(r.pause?.cause, "hold", "a hold, not the program's own pause");
    eq(r.pause?.reason, "awaiting_approval", "the gateway's code");
    eq(JSON.stringify(r.pause?.data), '{"tool":"m.send","operationId":"op_held"}', "which call, which operation");
    eq(JSON.stringify(r.held), '[{"tool":"m.send","operationId":"op_held","status":"pending"}]', "held lists it");
    eq(calls.map((c) => c.tool).join(","), "m.read,m.send", "the call after the held one was never made");
    eq(JSON.stringify(r.outputs), '["read"]', "nothing after the hold was output, caught or not");
    assert(r.acceptedOperationIds.includes("op_held"), "the held operation is among the accepted");
    eq(r.continuation, undefined, "a hold is not resumable");
  });

  test("暂停于未等的调用", "a call the program did not await that comes back held after the program ended still pauses the run", async () => {
    calls = [];
    const gate = host(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { status: "pending", operationId: "op_late", error: { code: "awaiting_approval", message: "held" } } as any;
    });
    const r = await exec.execute(`tool\`m.send \${ {} }\`; output("done");`, gate);
    eq(r.status, "paused", "paused, though the program returned first");
    eq(r.pause?.cause, "hold", "by the hold");
    eq(JSON.stringify(r.held), '[{"tool":"m.send","operationId":"op_late","status":"pending"}]', "held lists it");
    eq(JSON.stringify(r.outputs), '["done"]', "what the program output is kept");
  });

  test("其它状态照旧", "a call that comes back rejected or failed is still a value the program reads; it does not pause", async () => {
    calls = [];
    const gate = host(async (c) => c.tool === "m.bad"
      ? ({ status: "failed", operationId: "op_f", error: { code: "boom", message: "boom" } } as any)
      : { status: "rejected", error: { code: "policy_denied", message: "no" } });
    const r = await exec.execute(
      `const a = await tool\`m.bad \${ {} }\`;
       const b = await tool\`m.denied \${ {} }\`;
       output([a.status, b.status]);
       await tool\`m.more \${ {} }\`;`,
      gate,
    );
    eq(r.status, "completed", "completed, not paused");
    eq(JSON.stringify(r.outputs), '[["failed","rejected"]]', "both read as values");
    eq(calls.length, 3, "the program went on calling");
    eq(r.pause, undefined, "no pause");
  });


  // await pause(): the program waits in memory for the model's answer.
  test("暂停续行", "an awaited pause suspends the program; resume makes the answer pause()'s value and the program goes on, to the next pause and to its end", async () => {
    calls = [];
    const r = await exec.execute(
      `await tool\`m.first \${ {} }\`;
       output("before");
       const pick = await pause("which?", { options: ["a", "b"] });
       output({ picked: pick });
       await tool\`m.second \${ { pick } }\`;
       const again = await pause("sure?");
       output({ again });
       return 1;`,
      host(),
    );
    eq(r.status, "paused", "paused");
    assert(r.continuation, "an awaited pause can be resumed");
    eq(r.pause?.reason, "which?", "reason");
    eq(JSON.stringify(r.outputs), '["before"]', "outputs so far");
    eq(r.hostCalls, 1, "one call so far");
    const r2 = await r.continuation!.resume("b");
    eq(r2.status, "paused", "the second pause");
    eq(r2.pause?.reason, "sure?", "its own reason");
    assert(r2.continuation && r2.continuation !== r.continuation, "a new continuation");
    eq(JSON.stringify(r2.outputs), '["before",{"picked":"b"}]', "the answer was pause()'s return value; outputs are the whole program's");
    eq(calls.map((c) => c.tool).join(","), "m.first,m.second", "the program went on calling after the resume");
    eq(JSON.stringify(calls[1]!.args), '{"pick":"b"}', "with the answer");
    eq(r2.hostCalls, 2, "calls counted across the stops");
    let reused: unknown = null;
    try { await r.continuation!.resume("again"); } catch (e) { reused = e; }
    assert(reused, "a continuation is used once");
    const r3 = await r2.continuation!.resume({ yes: true });
    eq(r3.status, "completed", "ran to its end");
    eq(r3.continuation, undefined, "nothing left to resume");
    eq(JSON.stringify(r3.outputs.at(-1)), '{"again":{"yes":true}}', "the second answer too");
  });

  test("暂停取消", "cancel ends a suspended program: its pause rejects, a try/catch cannot keep it going, the outputs so far come back", async () => {
    calls = [];
    const r = await exec.execute(
      `output("before");
       try { await pause("go on?"); } catch (e) { output("caught " + e.name); }
       await tool\`m.after \${ {} }\`.catch(() => {});
       output("after");
       return 1;`,
      host(),
    );
    assert(r.continuation, "suspended");
    const c = await r.continuation!.cancel();
    eq(c.status, "interrupted", "ended, not completed");
    eq(c.error?.code, "cancelled", "by the cancel");
    eq(JSON.stringify(c.outputs), '["before"]', "outputs so far, nothing after the pause");
    eq(calls.length, 0, "no call after the pause reached the host");
    eq(c.continuation, undefined, "nothing to resume");
  });

  test("暂停后的挂起", "a call still out when the program awaits its pause that comes back held ends the run as a hold: no continuation", async () => {
    calls = [];
    const gate = host(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { status: "pending", operationId: "op_late", error: { code: "awaiting_approval", message: "held" } } as any;
    });
    const r = await exec.execute(`tool\`m.send \${ {} }\`.catch(() => {}); output("x"); await pause("wait");`, gate);
    eq(r.status, "paused", "paused");
    eq(r.continuation, undefined, "not resumable once a call is held");
    eq(JSON.stringify(r.held), '[{"tool":"m.send","operationId":"op_late","status":"pending"}]', "held lists it");
    // Held between the pause() and its await: the program has not suspended yet when the hold lands.
    const between = await exec.execute(
      `const t = tool\`m.send \${ {} }\`.catch(() => {}); const p = pause("wait"); await t; output("y"); await p;`, gate);
    eq(between.status, "paused", "paused");
    eq(between.continuation, undefined, "not resumable once a call is held, however the two interleave");
  });

  test("暂停不计时", "time suspended at a pause is not taken from the program's wall-time budget", async () => {
    // The loop after the resume is there so the engine checks its budget at all.
    const r = await exec.execute(
      `const a = await pause("p"); let x = 0; for (let i = 0; i < 100000; i++) x += i; output(a);`,
      host(), { ...DEFAULT_LIMITS, wallTimeMs: 200 });
    assert(r.continuation, "suspended");
    await new Promise((res) => setTimeout(res, 400));
    const r2 = await r.continuation!.resume("late");
    eq(r2.status, "completed", `completed after a suspension longer than the budget (${JSON.stringify(r2.error ?? null)})`);
    eq(JSON.stringify(r2.outputs), '["late"]', "with the answer");
  });

  const results: SpecResult[] = [];
  for (const t of tests.filter((t) => !only || only(t.row))) {
    try { await t.fn(); results.push({ row: t.row, name: t.name, ok: true }); }
    catch (err) { results.push({ row: t.row, name: t.name, ok: false, error: (err as Error).message }); }
  }
  return results;
}
