/**
 * `await pause(...)` as a continuation: run_js hands the model a token, the
 * program waits in memory, `resume` carries the answer back in as pause()'s
 * value — through both executors, the registry's clock, and the runtime's
 * keep-alive.
 *
 * The Dynamic Worker rows use the same node stand-in as
 * test/dynamic-worker-pause.ts (spec/worker-stand-in.ts): the generated module
 * is evaluated for real, and its binding reaches the supervisor's handlers
 * the way the platform's RPC does — late, and not after the handler returns.
 */
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { DynamicWorkerExecutor, executions } from "../src/runtime/dynamic-worker-executor.ts";
import {
  EXPIRED_NOTE, RESUME_DESCRIPTION, RUN_JS_DESCRIPTION, qualifyMountedTools, resumeTool, runJsTool, runJsTools,
} from "../src/runtime/pi-tools.ts";
import { RUN_JS_KEEP_ALIVE_MS, RUN_JS_RESUME_MS, RunJsContinuations, answerProblem, answerSpecOf } from "../src/runtime/run-js-resume.ts";
import { nextAlarm } from "../cf/src/alarm-next.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import type { Continuation } from "../src/core/execution.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const named = (name: string, address: string) =>
  ({ name, address, description: "", parameters: { type: "object" }, sideEffects: "read" as const });
const TOOLS = qualifyMountedTools([named("get", "web.get"), named("send", "web.send")]);

// The platform's binding, as close as node gets: calls arrive late and out of
// order, and a call outstanding when the handler returns is dropped (spec/worker-stand-in.ts).
const standIn = standInLoader();
const dw = new DynamicWorkerExecutor({ loader: standIn.loader, makeToolBinding: standIn.makeToolBinding });

const EXECUTORS: Array<[string, any]> = [["quickjs", new QuickJsExecutor()], ["worker", dw]];

/** Wraps an executor so every continuation it hands out reports being cancelled. */
function watched(exec: any) {
  const cancelled: number[] = [];
  const wrap = (r: any): any => {
    if (!r?.continuation) return r;
    const c: Continuation = r.continuation;
    return {
      ...r,
      continuation: {
        resume: async (a: any) => wrap(await c.resume(a)),
        cancel: async () => { cancelled.push(1); return wrap(await c.cancel()); },
      },
    };
  };
  return { sandbox: { execute: async (...a: any[]) => wrap(await exec.execute(...a)) }, cancelled };
}

function recordingHost() {
  const seen: any[] = [];
  return {
    seen,
    async invoke(call: any) {
      seen.push(call);
      if (call.opts?.confirm) return { status: "pending", operationId: "op_wait", error: { code: "awaiting_approval", message: "held" } };
      return { status: "succeeded", operationId: `op${seen.length}`, result: { n: seen.length, args: call.args } };
    },
  };
}
const body = (out: any) => JSON.parse(out.content[0].text);

for (const [label, exec] of EXECUTORS) {
  await check(`${label}: await pause() gives a token; resume makes the answer pause()'s value and the program goes on to the next pause, under the same call id and key numbering`, async () => {
    const host = recordingHost();
    const reg = new RunJsContinuations();
    const runs: any[] = [];
    const calls: number[] = [];
    const counting = { onRun: (r: any) => { runs.push(r); }, onCalls: (n: number) => { calls.push(n); } };
    const run: any = runJsTool(exec, host as any, { tools: TOOLS, continuations: reg, scope: "s", ...counting });
    const resume: any = resumeTool(reg, { scope: "s", ...counting });
    const first = body(await run.execute("p1", { source:
      "const a = await tool`web__get ${{ i: 0 }}`; output('before'); " +
      "const pick = await pause('which?', { options: ['x', 'y'] }); output({ pick }); " +
      "await tool`web__get ${{ pick }}`; " +
      "const sure = await pause('sure?'); await tool`web__get ${{ sure }}`; output({ sure });" }));
    must(first.state === "yielded" && first.paused === true && first.question === "which?", `not yielded: ${JSON.stringify(first)}`);
    must(typeof first.token === "string" && !Number.isNaN(Date.parse(first.expiresAt)), `no token: ${JSON.stringify(first)}`);
    must(JSON.stringify(first.soFar) === '{"outputs":["before"],"calls":1}', `so far: ${JSON.stringify(first)}`);
    must(JSON.stringify(first.data) === '{"options":["x","y"]}' && !("outputs" in first), `data, and outputs only once: ${JSON.stringify(first)}`);
    must(/call resume with this token/.test(first.note), `the note does not say how to go on: ${first.note}`);
    must(reg.size === 1, "held in the registry");

    const second = await resume.execute("r1", { token: first.token, answer: "y" });
    const b2 = body(second);
    must(b2.state === "yielded" && b2.question === "sure?", `the second pause: ${JSON.stringify(b2)}`);
    must(b2.token && b2.token !== first.token, "a new token for the new pause");
    must(JSON.stringify(b2.soFar.outputs) === '["before",{"pick":"y"}]', `the answer is pause()'s value: ${JSON.stringify(b2.soFar)}`);
    must(second.details?.callId === "p1", `the resume names the run it continues: ${JSON.stringify(second.details)}`);

    const third = await resume.execute("r2", { token: b2.token, answer: { ok: true } });
    must(JSON.stringify(body(third)) === '["before",{"pick":"y"},{"sure":{"ok":true}}]', `ran to its end: ${third.content[0].text}`);
    must(reg.size === 0, "nothing left suspended");
    // One run_js call made all three requests, so all three name it, and the keys go on counting.
    must(host.seen.map((c) => c.callId).join() === "p1,p1,p1", `callIds: ${host.seen.map((c) => c.callId)}`);
    must(host.seen.map((c) => c.opts.idempotencyKey).join() === "p1:0,p1:1,p1:2", `keys: ${host.seen.map((c) => c.opts.idempotencyKey)}`);
    must(JSON.stringify(host.seen[1].args) === '{"pick":"y"}', "the answer reached the next call");
    // Usage: one run, two resumed stretches; the calls each stretch made.
    must(runs.length === 3 && !runs[0].resumed && runs[1].resumed && runs[2].resumed && runs.every((r) => r.ok), `runs: ${JSON.stringify(runs)}`);
    must(calls.join() === "1,1,1", `calls per stretch: ${calls}`);
    // A used token is gone.
    const again = body(await resume.execute("r3", { token: first.token, answer: 1 }));
    must(again.expired === true && again.note === EXPIRED_NOTE, `a used token: ${JSON.stringify(again)}`);
  });

  await check(`${label}: resume with cancel ends the program — its pause cannot be swallowed — and returns the outputs so far`, async () => {
    const host = recordingHost();
    const reg = new RunJsContinuations();
    const run: any = runJsTool(exec, host as any, { tools: TOOLS, continuations: reg });
    const resume: any = resumeTool(reg);
    const first = body(await run.execute("c1", { source:
      "output('before'); try { await pause('go?'); } catch (e) { output('caught'); } " +
      "await tool`web__get ${{}}`.catch(() => {}); output('after');" }));
    const out = await resume.execute("c2", { token: first.token, cancel: true });
    const b = body(out);
    must(b.cancelled === true && JSON.stringify(b.outputs) === '["before"]', `cancel: ${JSON.stringify(b)}`);
    must(host.seen.length === 0, `a call after the pause reached the host: ${host.seen.length}`);
    must(reg.size === 0, "gone from the registry");
  });

  await check(`${label}: a token unknown, used, from another session, or past RUN_JS_RESUME_MS answers the expired note; the expired program is discarded`, async () => {
    let now = 1_000_000;
    const { sandbox, cancelled } = watched(exec);
    const reg = new RunJsContinuations({ ttlMs: 5_000, now: () => now });
    const run: any = runJsTool(sandbox as any, recordingHost() as any, { tools: TOOLS, continuations: reg, scope: "a" });
    const mine: any = resumeTool(reg, { scope: "a" });
    const theirs: any = resumeTool(reg, { scope: "b" });
    const unknown = body(await mine.execute("u", { token: "rjc_nothing", answer: 1 }));
    must(unknown.expired === true && unknown.note === EXPIRED_NOTE, `unknown: ${JSON.stringify(unknown)}`);
    const notString = body(await mine.execute("u2", { answer: 1 }));
    must(notString.expired === true, "no token at all");

    const first = body(await run.execute("e1", { source: "const a = await pause('p'); output(a);" }));
    must(Date.parse(first.expiresAt) === now + 5_000, `expiresAt: ${first.expiresAt}`);
    must(body(await theirs.execute("x", { token: first.token, answer: 1 })).expired === true, "another session's token");
    now += 5_000;
    const late = body(await mine.execute("e2", { token: first.token, answer: 1 }));
    must(late.expired === true && late.note === EXPIRED_NOTE, `expired: ${JSON.stringify(late)}`);
    must(cancelled.length === 1, `the expired program was not discarded: ${cancelled.length}`);
    // The sweep the keep-alive runs discards one nobody asked about.
    const second = body(await run.execute("e3", { source: "const a = await pause('p'); output(a);" }));
    must(second.token, "suspended");
    now += 4_999;
    must(reg.wakeInMs() === 1, "still held one ms before its time, and the wake comes no later than that");
    now += 1;
    must(reg.wakeInMs() === null && reg.size === 0 && cancelled.length === 2, `swept: ${reg.size} ${cancelled.length}`);
    if (label === "worker") {
      await new Promise((r) => setTimeout(r, 10));
      must(executions.size === 0, `the worker's executions were not released: ${executions.size}`);
    }
  });

  await check(`${label}: resume is refused from inside a program`, async () => {
    const reg = new RunJsContinuations();
    const host = recordingHost();
    const run: any = runJsTool(exec, host as any, { tools: TOOLS, continuations: reg });
    const out = body(await run.execute("f1", { source: "const r = await tool`resume ${{ token: 'rjc_x', answer: 1 }}`; output(r);" }));
    must(out[0]?.status === "rejected" && out[0]?.error?.code === "not_from_a_program", `not refused: ${JSON.stringify(out)}`);
    must(host.seen.length === 0, "nothing reached the host");
  });

  await check(`${label}: a held call still ends the program, with no token`, async () => {
    const reg = new RunJsContinuations();
    const run: any = runJsTool(exec, recordingHost() as any, { tools: TOOLS, continuations: reg });
    const out = body(await run.execute("h1", { source:
      "output('got'); await tool`web__send ${{ confirm: true }}`; const a = await pause('never'); output(a);" }));
    must(out.paused === true && out.reason === "awaiting_approval", `not held: ${JSON.stringify(out)}`);
    must(out.token === undefined && out.state === undefined && reg.size === 0, `a hold was made resumable: ${JSON.stringify(out)}`);
    must(/nothing to resume/.test(out.note), `the note does not say it cannot be resumed: ${out.note}`);
  });

  await check(`${label}: with nowhere to keep it, an awaited pause ends the program as before`, async () => {
    const { sandbox, cancelled } = watched(exec);
    const host = recordingHost();
    const run: any = runJsTool(sandbox as any, host as any, { tools: TOOLS });
    const out = body(await run.execute("n1", { source: "const a = await pause('p'); await tool`web__get ${{}}`;" }));
    must(out.paused === true && out.token === undefined && out.state === undefined, `a token with nowhere to keep it: ${JSON.stringify(out)}`);
    must(/new run starts from nothing/.test(out.note), `the old note: ${out.note}`);
    must(cancelled.length === 1 && host.seen.length === 0, `the program was not ended: ${cancelled.length} ${host.seen.length}`);
  });

  await check(`${label}: pause()'s third argument is echoed as answer; an answer that does not fit is refused, the program still waits, the same token works`, async () => {
    const reg = new RunJsContinuations();
    const [run, resume] = runJsTools(exec, recordingHost() as any, { tools: TOOLS, continuations: reg, scope: "s" }) as any[];
    const y = body(await run.execute("v1", { source:
      "const c = await pause('pick one', null, { choices: ['red', 'blue'] }); output(c);" }));
    must(JSON.stringify(y.answer) === '{"choices":["red","blue"]}', `answer echoed: ${JSON.stringify(y)}`);
    const wrong = body(await resume.execute("v2", { token: y.token, answer: "green" }));
    must(wrong.state === "yielded" && /exactly one of "red", "blue"/.test(wrong.invalidAnswer), `refused: ${JSON.stringify(wrong)}`);
    must(wrong.token === y.token && wrong.expiresAt === y.expiresAt && wrong.question === "pick one", `the same token: ${JSON.stringify(wrong)}`);
    must(reg.size === 1, "still suspended");
    const right = await resume.execute("v3", { token: y.token, answer: "blue" });
    must(JSON.stringify(body(right)) === '["blue"]', `delivered once it fits: ${right.content[0].text}`);
    // A cancel is never refused for its answer.
    const y2 = body(await run.execute("v4", { source: "await pause('ok?', null, { kind: 'yes_no' }); output('never');" }));
    must(body(await resume.execute("v5", { token: y2.token, answer: "maybe" })).invalidAnswer, "yes_no wants a boolean");
    must(body(await resume.execute("v6", { token: y2.token, cancel: true })).cancelled === true, "cancel goes through");
    // A third argument that cannot be used says so, and the pause goes on without a check.
    const y3 = body(await run.execute("v7", { source: "const a = await pause('q', null, { kind: 'number' }); output(a);" }));
    must(y3.answer === undefined && /must be "yes_no" or "text"/.test(y3.answerError), `a bad spec: ${JSON.stringify(y3)}`);
    must(JSON.stringify(body(await resume.execute("v8", { token: y3.token, answer: 7 }))) === "[7]", "no check applies");
    const y4 = body(await run.execute("v9", { source: "const a = await pause('q', null, () => 1); output(a);" }));
    must(/not JSON/.test(y4.answerError), `a function as the spec: ${JSON.stringify(y4)}`);
    await resume.execute("v10", { token: y4.token, cancel: true });
  });

  await check(`${label}: several programs wait at once, other calls happen in between, each token resumes its own`, async () => {
    let now = 0;
    const reg = new RunJsContinuations({ now: () => now });
    const host = recordingHost();
    const [run, resume] = runJsTools(exec, host as any, { tools: TOOLS, continuations: reg, scope: "s" }) as any[];
    const src = (name: string) => `const a = await pause('${name}'); await tool\`web__get \${{ who: '${name}', a }}\`; output('${name}:' + a);`;
    const [ya, yb] = (await Promise.all([run.execute("A", { source: src("a") }), run.execute("B", { source: src("b") })])).map(body);
    must(ya.token && yb.token && ya.token !== yb.token && reg.size === 2, `two tokens: ${ya.token} ${yb.token} ${reg.size}`);
    now += 3_000;
    must(reg.wakeInMs() === RUN_JS_KEEP_ALIVE_MS, "the keep-alive holds for both");
    // Something else entirely, in between.
    const other = body(await run.execute("C", { source: "output(1 + 1);" }));
    must(JSON.stringify(other) === "[2]", "another run between the yield and the resume");
    const rb = body(await resume.execute("rB", { token: yb.token, answer: "B!" }));
    must(JSON.stringify(rb) === '["b:B!"]' && reg.size === 1, `b resumed first: ${JSON.stringify(rb)} ${reg.size}`);
    must(reg.wakeInMs() === RUN_JS_KEEP_ALIVE_MS, "the keep-alive goes on while one is left");
    const ra = body(await resume.execute("rA", { token: ya.token, answer: "A!" }));
    must(JSON.stringify(ra) === '["a:A!"]', `a: ${JSON.stringify(ra)}`);
    must(reg.size === 0 && reg.wakeInMs() === null, "and stops after the last");
    // Each program's calls stay under its own run_js call.
    const keys = host.seen.map((c) => `${c.args.who}=${c.opts.idempotencyKey}`).sort().join();
    must(keys === "a=A:0,b=B:0", `keys: ${keys}`);
  });

  await check(`${label}: run_js and resume built together share a scope, so the resume answers run_js's tokens`, async () => {
    const reg = new RunJsContinuations();
    const [run, resume] = runJsTools(exec, recordingHost() as any, { tools: TOOLS, continuations: reg, scope: "sess-7" }) as any[];
    const y = body(await run.execute("t1", { source: "const a = await pause('q'); output(a);" }));
    must(JSON.stringify(body(await resume.execute("t2", { token: y.token, answer: 3 }))) === "[3]", "resumed in its own session");
    must(resume.name === "resume" && run.name === "run_js", "names");
  });
}

await check("registry: holding asks for a wake within the keep-alive interval; the wake stops once nothing is suspended", async () => {
  let now = 0;
  const asked: number[] = [];
  const fake = (): Continuation => ({ resume: async () => ({}) as any, cancel: async () => ({}) as any });
  const reg = new RunJsContinuations({ now: () => now, onHold: (at) => asked.push(at) });
  must(reg.ttlMs === RUN_JS_RESUME_MS && RUN_JS_RESUME_MS === 60_000, "default sixty seconds");
  must(reg.wakeInMs() === null, "nothing held: no wake");
  const { token } = reg.hold({ continuation: fake(), scope: "", callId: "c", hostCalls: 0, operations: 0 });
  must(asked.join() === String(RUN_JS_KEEP_ALIVE_MS) && RUN_JS_KEEP_ALIVE_MS === 10_000, `asked: ${asked}`);
  must(reg.wakeInMs() === RUN_JS_KEEP_ALIVE_MS, "wakes every ten seconds while held");
  // As the alarm pass combines it (cf/src/index.ts alarm): armed while held...
  must(nextAlarm(null, now + reg.wakeInMs()!) === now + 10_000, "armed");
  now += 55_000;
  must(reg.wakeInMs() === 5_000, "no later than the expiry");
  must(reg.take(token, "")?.callId === "c", "taken");
  // ...and not once nothing is held: the alarm is deleted if nothing else wants it.
  must(reg.wakeInMs() === null && nextAlarm(null, null) === null, "stops");
  const short = new RunJsContinuations({ ttlMs: 2_000, now: () => now, onHold: (at) => asked.push(at) });
  short.hold({ continuation: fake(), scope: "", callId: "c", hostCalls: 0, operations: 0 });
  must(asked.at(-1) === now + 2_000, `a short life asks for its own end: ${asked.at(-1)}`);
  must(new RunJsContinuations({ ttlMs: Number("nope") }).ttlMs === RUN_JS_RESUME_MS, "a bad override falls back");
});

await check("runtime: a suspended program asks the object to stay awake and the pass plans a wake within ten seconds; none once it is gone", async () => {
  const { AgentRuntime } = await import("../cf/src/runtime.ts");
  const { sqliteHost } = await import("../src/store/sqlite-host.ts");
  const host = sqliteHost();
  const kept: number[] = [];
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", loader: {} as any, makeToolBinding: () => ({}),
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "k", model: "deepseek-flash" },
    runJsResumeMs: 30_000, keepAlive: (at: number) => { kept.push(at); },
    autoRelease: false,
  } as any);
  await rt.ready();
  await rt.store.createAgent("t", "a");
  await rt.bindOperatorModel("t", "a");
  const idle = await rt.step("t", "a");
  must(idle.wakeInMs === null, `an idle agent plans no wake: ${idle.wakeInMs}`);
  let cancelled = 0;
  const t0 = Date.now();
  const { token, expiresAt } = rt.runJsContinuations.hold({
    continuation: { resume: async () => ({}) as any, cancel: async () => { cancelled++; return {} as any; } },
    scope: "main", callId: "c", hostCalls: 0, operations: 0,
  });
  must(expiresAt - t0 >= 30_000 && expiresAt - t0 < 31_000, `the override: ${expiresAt - t0}`);
  must(kept.length === 1 && kept[0]! - t0 >= 10_000 && kept[0]! - t0 < 11_000, `asked to stay awake: ${kept.map((k) => k - t0)}`);
  const held = await rt.step("t", "a");
  must(held.wakeInMs !== null && held.wakeInMs <= 10_000, `the pass plans a wake while it is held: ${held.wakeInMs}`);
  must(rt.runJsContinuations.take(token, "main"), "taken");
  const after = await rt.step("t", "a");
  must(after.wakeInMs === null && cancelled === 0, `no wake once nothing is held: ${after.wakeInMs}`);
  host.dispose();
});

await check("answer specs: the four forms, the schema subset, and what is refused as a spec", async () => {
  const spec = (raw: any) => { const r = answerSpecOf(raw); if ("error" in r) throw new Error(`spec refused: ${r.error}`); return r.spec; };
  const choices = spec({ choices: ["a", "b"] });
  must(answerProblem(choices, "a") === null && answerProblem(choices, "c") !== null && answerProblem(choices, 1) !== null, "choices");
  const yn = spec({ kind: "yes_no" });
  must(answerProblem(yn, false) === null && answerProblem(yn, "no") !== null && answerProblem(yn, undefined) !== null, "yes_no");
  const text = spec({ kind: "text" });
  must(answerProblem(text, "") === null && answerProblem(text, 3) !== null, "text");
  const schema = spec({ schema: {
    type: "object", required: ["n", "tags"],
    properties: { n: { type: "integer", enum: [1, 2, 3] }, tags: { type: "array", items: { type: "string" } }, note: { type: ["string", "null"] } },
  } });
  must(answerProblem(schema, { n: 2, tags: ["x"] }) === null, "fits");
  must(answerProblem(schema, { n: 2, tags: ["x"], note: null }) === null, "a list of types");
  must(/answer\.tags is required/.test(String(answerProblem(schema, { n: 2 }))), `required: ${answerProblem(schema, { n: 2 })}`);
  must(/answer\.n must be integer/.test(String(answerProblem(schema, { n: 2.5, tags: [] }))), "integer");
  must(/answer\.n must be one of 1, 2, 3/.test(String(answerProblem(schema, { n: 4, tags: [] }))), "enum");
  must(/answer\.tags\[1\] must be string/.test(String(answerProblem(schema, { n: 1, tags: ["a", 2] }))), "items");
  must(/answer must be object/.test(String(answerProblem(schema, "x"))), "type at the top");
  for (const bad of [null, "x", [], {}, { choices: [] }, { choices: [1] }, { kind: "number" }, { schema: 1 },
    { schema: { type: "date" } }, { schema: { enum: 1 } }, { schema: { required: [1] } }, { choices: ["a"], kind: "text" }]) {
    must("error" in answerSpecOf(bad as any), `accepted as a spec: ${JSON.stringify(bad)}`);
  }
});

await check("runtime: a suspended program holds off the idle pass that would hand its containers back", async () => {
  const { AgentRuntime } = await import("../cf/src/runtime.ts");
  const { sqliteHost } = await import("../src/store/sqlite-host.ts");
  const host = sqliteHost();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", loader: {} as any, makeToolBinding: () => ({}),
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "k", model: "deepseek-flash" },
    idle: { warnMs: 60_000, maxMs: 600_000 },
  } as any);
  await rt.ready();
  await rt.store.createAgent("t", "a");
  await rt.bindOperatorModel("t", "a");
  // The idle pass's first act is to make its table: whether it exists says whether the pass ran.
  const ran = () => host.sql.exec("SELECT name FROM sqlite_master WHERE name = 'held_warnings'").toArray().length > 0;
  const { token } = rt.runJsContinuations.hold({
    continuation: { resume: async () => ({}) as any, cancel: async () => ({}) as any },
    scope: "main", callId: "c", hostCalls: 0, operations: 0,
  });
  await rt.step("t", "a");
  must(!ran(), "the idle pass ran while a program was suspended");
  rt.runJsContinuations.take(token, "main");
  await rt.step("t", "a");
  must(ran(), "the idle pass did not run once nothing was suspended (the check above proves nothing)");
  host.dispose();
});

await check("texts: the sandbox section and both tool descriptions say how to answer a pause and what happens when it expired", async () => {
  const { systemPrompt } = await import("../src/runtime/pi-prompt.ts");
  const p = systemPrompt({ sandbox: true });
  must(p.includes("const answer = await pause(question, data, expected);"), "the sandbox section does not show the await");
  must(/choices[\s\S]*yes_no[\s\S]*text[\s\S]*schema/.test(p) && /same token\s+stays valid/.test(p), "expected answers are not described");
  must(/several programs can wait at once/.test(p), "several waiting programs are not described");
  must(/resume\(token, answer\)/.test(p) && /within\s+about a minute/.test(p), "resume and its time are not described");
  must(/expired[\s\S]*send a new run_js program/.test(p), "the expired case is not described");
  must(/no resume token/.test(p), "a held call's lack of a token is not said");
  must(p.includes("Never wrap one plain call"), "the plain-call rule went missing");
  must(RUN_JS_DESCRIPTION.includes("await pause(") && RUN_JS_DESCRIPTION.includes("resume(token, answer)"), "run_js description");
  must(/cancel: true/.test(RESUME_DESCRIPTION) && /new run_js program/.test(RESUME_DESCRIPTION), "resume description");
  must(/invalidAnswer/.test(RESUME_DESCRIPTION) && /same token stays valid/.test(RESUME_DESCRIPTION), "resume description: refused answers");
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
