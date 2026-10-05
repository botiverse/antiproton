/**
 * The bench runners' stand-in for the queue (bench/node-worker.ts, used by bench/tau2/run.ts and
 * bench/swebench/run.ts) answers a failed provider call the way the queue consumer does: a refusal's
 * `errorMessage` is its fixed text, and the provider's own message is kept beside it as `providerError`,
 * so a bench record still says why a call was refused. Any other failure is answered exactly as before,
 * with no new field.
 */
import { nodeWorker } from "../bench/node-worker.ts";
import { ModelRequestRefused } from "../src/model/openai-compatible.ts";
import { errorMessage } from "../src/model/pi-bridge.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const IDENTITY = { api: "offloaded", provider: "openai-compatible", id: "openai/gpt-5.6-luna" };

/** Dispatch one job to a worker whose provider call throws `thrown`; the answer it delivers. */
async function answerFor(thrown: unknown): Promise<Record<string, unknown>> {
  let delivered: Record<string, unknown> | undefined;
  const agent = {
    takeJob: () => ({ model: IDENTITY, context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] } }),
    deliver: (_id: string, answer: Record<string, unknown>) => { delivered = answer; },
  };
  const model = { id: "m", complete: async () => { throw thrown; } };
  const w = nodeWorker(model as never, () => agent as never, "fallback");
  w.dispatch("job-1");
  for (let i = 0; i < 50 && !delivered; i++) await new Promise((r) => setTimeout(r, 2));
  must(delivered, "nothing was delivered");
  return delivered;
}

const LUNA_400 = JSON.stringify({ error: {
  message: "Invalid schema for function 'run_js': In context=('properties', 'timeout'), 'additionalProperties' is required to be supplied and to be false.",
  type: "invalid_request_error" } });

await check("a refusal is delivered with its fixed errorMessage and the provider's message as providerError", async () => {
  const refused = new ModelRequestRefused(400, LUNA_400);
  const a = await answerFor(refused);
  must(a.stopReason === "error" && a.errorMessage === "model refused (HTTP 400, permanent): see the turn's error", show(a));
  must(a.providerError === refused.turnError && String(a.providerError).includes("'timeout'"), show(a));
});

await check("any other failure is delivered exactly as before: the same fields, no providerError", async () => {
  const a = await answerFor(new Error(`model 503: ${"x".repeat(400)}`));
  const before = errorMessage(`model 503: ${"x".repeat(400)}`.slice(0, 300), IDENTITY) as unknown as Record<string, unknown>;
  must(!("providerError" in a), show(a));
  must(show(Object.keys(a).sort()) === show(Object.keys(before).sort()) && a.errorMessage === before.errorMessage, `${show(a)} vs ${show(before)}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
