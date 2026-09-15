/**
 * How the Dynamic Worker supervisor tells the script's failure from its own, in
 * node, with a loader that answers what the platform would.
 *
 * A module that does not parse is rejected at load: that is the script's error
 * (failed / eval_error), as QuickJS says it. Everything else that throws in the
 * supervisor is the host's, including a SyntaxError from parsing the isolate's
 * answer, and a platform message that merely mentions the word (task #19; Vera
 * on #341). The real platform's shape is checked by the executor contract on a
 * deployment (bench/cf-conformance.mjs).
 */
import { DynamicWorkerExecutor, isCompileError } from "../src/runtime/dynamic-worker-executor.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const host = { async invoke() { return { status: "succeeded", operationId: "op", result: {} }; } } as any;
const named = (name: string, message: string) => Object.assign(new Error(message), { name });
/** An executor whose isolate answers the load with `answer`. */
const executor = (answer: () => Promise<Response>) => new DynamicWorkerExecutor({
  loader: { load: () => ({ getEntrypoint: () => ({ fetch: answer }) }) } as any,
  makeToolBinding: () => ({}),
});
const run = async (answer: () => Promise<Response>) => {
  const r = await executor(answer).execute(`output(1)`, host);
  return { status: r.status, code: r.error?.code ?? null, outputs: r.outputs };
};

await check("a load rejected with a SyntaxError is the script's error: failed, eval_error", async () => {
  const byName = await run(async () => { throw named("SyntaxError", "missing ) after argument list"); });
  const byMessage = await run(async () => { throw new Error("Uncaught SyntaxError: missing ) after argument list"); });
  for (const [how, r] of [["by name", byName], ["by message", byMessage]] as const) {
    assert(r.status === "failed" && r.code === "eval_error", `${how}: ${JSON.stringify(r)}`);
  }
});

await check("a SyntaxError from reading the isolate's answer is the host's, not the script's", async () => {
  const r = await run(async () => new Response("<html>not json</html>", { headers: { "content-type": "text/html" } }));
  assert(r.status === "interrupted" && r.code === "host_failure", `a broken answer was blamed on the script: ${JSON.stringify(r)}`);
});

await check("a failure that only mentions SyntaxError is the host's", async () => {
  const r = await run(async () => { throw new Error("ReferenceError: SyntaxError is not defined"); });
  assert(r.status === "interrupted" && r.code === "host_failure", `${JSON.stringify(r)}`);
  assert(!isCompileError(new Error("my script said: SyntaxError handled ok")), "a message mentioning the word matched");
  assert(!isCompileError(null) && !isCompileError(named("TypeError", "x is not a function")), "other errors matched");
});

await check("the kills and a good answer are unchanged", async () => {
  const cpu = await run(async () => { throw new Error("Worker exceeded CPU time limit."); });
  assert(cpu.status === "interrupted" && cpu.code === "wall_time_exceeded", `CPU kill: ${JSON.stringify(cpu)}`);
  const ok = await run(async () => Response.json({ ok: true, outputs: ["hi"] }));
  assert(ok.status === "completed" && ok.outputs[0] === "hi", `good answer: ${JSON.stringify(ok)}`);
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
