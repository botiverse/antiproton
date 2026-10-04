/**
 * A provider's refusal of the request itself (HTTP 400/401/403/404/422, or an `invalid_request_error`) is
 * answered once, not retried: src/model/openai-compatible.ts makes one call and throws `ModelRequestRefused`,
 * and the queue consumer (`callQueuedModel`, cf/src/model-request.ts) answers the job with it as a failed turn
 * carrying the provider's status and message. 408/409/429, 5xx and network errors are retried as before. Both
 * engines are driven through the real runtime over node:sqlite, the real consumer and the real provider call,
 * with only `fetch` replaced.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { consumeModelCalls, replyingUnknownJob, type ModelJobStub, type ModelQueueDeps, type ModelQueueMessage } from "../cf/src/model-queue.ts";
import { callQueuedModel, operatorModelOf } from "../cf/src/model-request.ts";
import { readEntries } from "../cf/src/transcript-read.ts";
import { sessionTranscript } from "../cf/src/agents-api/transcript.ts";
import { ModelRequestRefused, OpenAiCompatibleModel, isPermanentRefusal } from "../src/model/openai-compatible.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { isRetryableAssistantError as retryable085 } from "@earendil-works/pi-ai";
import { isRetryableAssistantError as retryable1 } from "pi-ai-1";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

// The refusal measured through the gateway's /compat for gpt-5.6-luna (2026-10-04), verbatim.
const LUNA_400 = JSON.stringify({ error: {
  message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
  type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } });

/** `fetch` answering every call with `status` and `body`, counting the calls. */
function answering(status: number, body: string) {
  const real = globalThis.fetch;
  const seen = { calls: 0 };
  globalThis.fetch = (async () => { seen.calls++; return new Response(body, { status }); }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const model = (key = "sk-operatorkey123456", headers: Record<string, string> = {}) =>
  new OpenAiCompatibleModel({ baseUrl: "https://gw.example/compat", apiKey: key, model: "openai/gpt-5.6-luna", headers });

await check("classification: 400/401/403/404/422 and an invalid_request_error 4xx are permanent; 408/409/429 and 5xx are not", () => {
  for (const s of [400, 401, 403, 404, 422]) must(isPermanentRefusal(s, ""), `${s} read as retryable`);
  must(isPermanentRefusal(413, LUNA_400), "a 413 invalid_request_error read as retryable");
  for (const s of [408, 409, 429, 500, 502, 503, 504]) must(!isPermanentRefusal(s, LUNA_400), `${s} read as permanent`);
  must(!isPermanentRefusal(413, "too large"), "a 413 without invalid_request_error read as permanent");
});

await check("a 400 makes exactly one provider call and throws the provider's status and message", async () => {
  const f = answering(400, LUNA_400);
  let thrown: unknown;
  try { await model().complete([{ role: "user", content: "hi" }]); } catch (e) { thrown = e; } finally { f.restore(); }
  must(f.seen.calls === 1, `provider called ${f.seen.calls} times`);
  must(thrown instanceof ModelRequestRefused && thrown.status === 400, `threw ${String(thrown)}`);
  must(thrown.message === "the model provider refused the request (HTTP 400): Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead. (invalid_request_error, unsupported_parameter)",
    thrown.message);
});

await check("a refusal's message holds no credential the request carried, nothing key- or bearer-shaped, and is truncated", async () => {
  const body = JSON.stringify({ error: { message: `Incorrect API key provided: sk-operatorkey123456 and gwtoken-abcdef via Bearer zzzzzzzz; ${"x".repeat(1000)}`, type: "invalid_request_error" } });
  const f = answering(401, body);
  let thrown: unknown;
  try { await model("sk-operatorkey123456", { "cf-aig-authorization": "Bearer gwtoken-abcdef" }).complete([{ role: "user", content: "hi" }]); }
  catch (e) { thrown = e; } finally { f.restore(); }
  must(thrown instanceof ModelRequestRefused && f.seen.calls === 1, `${String(thrown)} after ${f.seen.calls} calls`);
  for (const secret of ["sk-operatorkey123456", "operatorkey123456", "gwtoken-abcdef", "zzzzzzzz"]) must(!thrown.message.includes(secret), `${secret} in ${thrown.message}`);
  must(thrown.message.includes("HTTP 401") && thrown.detail.length <= 301, `${thrown.detail.length}: ${thrown.message.slice(0, 200)}`);
});

for (const status of [429, 503]) {
  await check(`a ${status} is still retried: three provider calls, then a plain error the queue retries`, async () => {
    const f = answering(status, JSON.stringify({ error: { message: "slow down", type: status === 429 ? "rate_limit_error" : "server_error" } }));
    let thrown: unknown;
    try { await model().complete([{ role: "user", content: "hi" }]); } catch (e) { thrown = e; } finally { f.restore(); }
    must(f.seen.calls === 3, `provider called ${f.seen.calls} times`);
    must(thrown instanceof Error && !(thrown instanceof ModelRequestRefused) && thrown.message.startsWith(`model ${status}:`), String(thrown));
  });
}

const PROVIDERS = [
  { id: "deepseek", baseUrl: "https://model.example/v1", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
  { id: "gw", baseUrl: "https://gw.example/compat", auth: { secret: "GW_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model" },
];
const ENV = { DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "deepseek-flash",
  MODEL_PROVIDERS: JSON.stringify(PROVIDERS), GW_TOKEN: "gt" };

/** An agent on `engine` bound to gpt-5.6-luna through the gateway, its first turn dispatched, and the queue message for it. */
async function turnOn(engine: "pi085" | "pd") {
  const host = sqliteHost();
  if (engine === "pd") {
    const ap = new ApStore(host, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const sent: string[] = [];
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    sandbox: false, autoRelease: false,
    operatorModel: operatorModelOf(ENV),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  await rt.ready();
  await rt.bindOperatorModel("t", "a", { provider: "gw", model: "openai/gpt-5.6-luna" });
  await rt.postMessage("t", "a", "What's the weather in Oslo?");
  await rt.step("t", "a");
  must(sent.length === 1, `${engine}: dispatched ${show(sent)}`);
  const stub: ModelJobStub = {
    takeJob: (t, a, j, taker) => replyingUnknownJob(() => rt.takeJob(t, a, j, taker)),
    releaseJob: (t, a, j, taker) => replyingUnknownJob(() => rt.releaseJob(t, a, j, taker)),
    deliverAnswer: (t, a, j, answer, _ms, taker) => replyingUnknownJob(() => rt.deliverAnswer(t, a, j, answer, taker)),
  };
  const deps: ModelQueueDeps = {
    stub: () => stub,
    call: (taken, m) => callQueuedModel(ENV, taken, m.jobId),
    givenUp: (m) => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "given up", jobId: m.jobId }),
  };
  const q = { acked: 0, retried: 0 };
  const msg: ModelQueueMessage = { body: { doId: "do-1", tenantId: "t", agentId: "a", jobId: sent[0]! }, ack() { q.acked++; }, retry() { q.retried++; } };
  return { host, rt, deps, msg, q };
}

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: a 400 is one provider call and one delivery; the turn fails with the provider's message, which neither pi retries`, async () => {
    const { host, rt, deps, msg, q } = await turnOn(engine);
    try {
      const f = answering(400, LUNA_400);
      try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps); } finally { f.restore(); }
      must(f.seen.calls === 1 && q.acked === 1 && q.retried === 0, `provider calls ${f.seen.calls}, queue ${show(q)}`);
      await rt.step("t", "a");
      const entries = readEntries(host.sql as never, "main");
      const last = (entries.at(-1) as { message?: { stopReason?: string; errorMessage?: string } } | undefined)?.message;
      must(last?.stopReason === "error" && last.errorMessage?.includes("HTTP 400") && last.errorMessage.includes("max_completion_tokens"),
        `last entry ${show(entries.at(-1))}`);
      for (const [name, isRetryable] of [["pi-ai 0.85.1", retryable085], ["pi-ai 1.0.0", retryable1]] as const) {
        must(!isRetryable(last as never), `${name} reads the refusal as retryable: ${last.errorMessage}`);
      }
      // What the Agents API shows for the turn.
      const { turns } = sessionTranscript({ entries, running: false, pending: [] } as never, { sessionId: "s", agentId: "a" });
      const turn = turns.at(-1);
      must(turn?.status === "failed" && turn.error?.message === last.errorMessage, `turn ${show(turn)}`);
      // Delivered once: a redelivery of the message takes nothing and calls nothing.
      const again = answering(400, LUNA_400);
      try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps); } finally { again.restore(); }
      must(again.seen.calls === 0, `a redelivery called the provider ${again.seen.calls} times`);
    } finally { host.dispose(); }
  });

  await check(`${engine}: a 503 is still handed back to the queue to retry, and the retry answers the turn`, async () => {
    const { host, rt, deps, msg, q } = await turnOn(engine);
    const err = console.error; console.error = () => {};
    try {
      const f = answering(503, JSON.stringify({ error: { message: "upstream unavailable", type: "server_error" } }));
      try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps); } finally { f.restore(); }
      must(f.seen.calls === 3 && q.acked === 0 && q.retried === 1, `provider calls ${f.seen.calls}, queue ${show(q)}`);
      // The take was given back, so the retry takes the job and calls again.
      const ok = answering(200, JSON.stringify({ choices: [{ message: { content: "Sunny." }, finish_reason: "stop" }], usage: {} }));
      try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps); } finally { ok.restore(); }
      must(ok.seen.calls === 1 && Number(q.acked) === 1, `retry: provider calls ${ok.seen.calls}, queue ${show(q)}`);
      await rt.step("t", "a");
      const { turns } = sessionTranscript({ entries: readEntries(host.sql as never, "main"), running: false, pending: [] } as never, { sessionId: "s", agentId: "a" });
      must(turns.at(-1)?.status === "completed", `turn ${show(turns.at(-1))}`);
    } finally { console.error = err; host.dispose(); }
  });
}

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
