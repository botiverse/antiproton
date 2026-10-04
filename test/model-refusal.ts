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
import { entriesToEvents } from "../cf/src/pi-view.ts";
import { GATEWAY_401_HINT, ModelRequestRefused, OpenAiCompatibleModel, isPermanentRefusal } from "../src/model/openai-compatible.ts";
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

// Provider refusals whose own text matches pi-ai's retryable patterns (`timeout`, `502`): the refusal's text is
// kept out of the string the harness scans, or pd sends the job again (measured on the first version of this file's subject).
const TIMEOUT_SCHEMA_400 = JSON.stringify({ error: {
  message: "Invalid schema for function 'run_js': In context=('properties', 'timeout'), 'additionalProperties' is required to be supplied and to be false.",
  type: "invalid_request_error", param: "tools[0].function.parameters", code: "invalid_function_parameters" } });
const MESSAGES_502_400 = JSON.stringify({ error: {
  message: "Invalid 'messages[502].content': string too long. Expected a string with maximum length 10485760.",
  type: "invalid_request_error", param: "messages[502].content", code: "string_above_max_length" } });

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

await check("a 400 makes exactly one provider call; its error says only the status, and the turn's error carries the provider's message", async () => {
  const f = answering(400, LUNA_400);
  let thrown: unknown;
  try { await model().complete([{ role: "user", content: "hi" }]); } catch (e) { thrown = e; } finally { f.restore(); }
  must(f.seen.calls === 1, `provider called ${f.seen.calls} times`);
  must(thrown instanceof ModelRequestRefused && thrown.status === 400, `threw ${String(thrown)}`);
  must(thrown.message === "model refused (HTTP 400, permanent): see the turn's error", thrown.message);
  must(thrown.turnError === "the model provider refused the request (HTTP 400): Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead. (invalid_request_error, unsupported_parameter)",
    thrown.turnError);
});

await check("a refusal's text holds no credential the request carried, nothing key- or bearer-shaped, and is truncated", async () => {
  const body = JSON.stringify({ error: { message: `Incorrect API key provided: sk-operatorkey123456 and gwtoken-abcdef via Bearer zzzzzzzz; ${"x".repeat(1000)}`, type: "invalid_request_error" } });
  const f = answering(401, body);
  let thrown: unknown;
  try { await model("sk-operatorkey123456", { "cf-aig-authorization": "Bearer gwtoken-abcdef" }).complete([{ role: "user", content: "hi" }]); }
  catch (e) { thrown = e; } finally { f.restore(); }
  must(thrown instanceof ModelRequestRefused && f.seen.calls === 1, `${String(thrown)} after ${f.seen.calls} calls`);
  for (const secret of ["sk-operatorkey123456", "operatorkey123456", "gwtoken-abcdef", "zzzzzzzz"]) {
    must(!thrown.turnError.includes(secret) && !thrown.message.includes(secret), `${secret} in ${thrown.turnError}`);
  }
  must(thrown.turnError.includes("HTTP 401") && thrown.detail.length <= 301, `${thrown.detail.length}: ${thrown.turnError.slice(0, 200)}`);
});

await check("a 401 for a vendor/model the gateway keyed itself says an unknown model id looks like that; one with our key, or a bare name, does not", async () => {
  const unknown = JSON.stringify({ error: { message: "You didn't provide an API key. You need to provide your API key in an Authorization header.", type: "invalid_request_error" } });
  const turnErrorOf = async (apiKey: string, name: string) => {
    const f = answering(401, unknown);
    try { await new OpenAiCompatibleModel({ baseUrl: "https://gw.example/compat", apiKey, model: name, headers: { "cf-aig-authorization": "Bearer gt" } }).complete([{ role: "user", content: "hi" }]); }
    catch (e) { return (e as ModelRequestRefused).turnError; } finally { f.restore(); }
    return "no refusal";
  };
  const keyedByGateway = await turnErrorOf("", "openai/gpt-nonexistent-rev749");
  must(keyedByGateway.endsWith(` ${GATEWAY_401_HINT}`) && keyedByGateway.includes("You didn't provide an API key"), keyedByGateway);
  for (const [key, name] of [["dk", "deepseek/deepseek-flash"], ["dk", "deepseek-flash"]] as const) {
    const t = await turnErrorOf(key, name);
    must(t.includes("HTTP 401") && !t.includes(GATEWAY_401_HINT), `${name}: ${t}`);
  }
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
  return { host, rt, deps, msg, q, sent };
}

for (const engine of ["pi085", "pd"] as const) {
  for (const [what, body, said] of [
    ["max_tokens refused", LUNA_400, "max_completion_tokens"],
    ["a refusal whose text says 'timeout'", TIMEOUT_SCHEMA_400, "'timeout'"],
    ["a refusal whose text says '502'", MESSAGES_502_400, "messages[502]"],
  ] as const) {
    await check(`${engine}: ${what}: one model call, one delivery, no second job; the turn fails with the provider's message, and pi's retry check sees only fixed text`, async () => {
      const { host, rt, deps, msg, q, sent } = await turnOn(engine);
      try {
        const f = answering(400, body);
        try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps); } finally { f.restore(); }
        must(f.seen.calls === 1 && q.acked === 1 && q.retried === 0, `provider calls ${f.seen.calls}, queue ${show(q)}`);
        // Let the engine do whatever it means to with the failure, a harness retry included: pd's waits 2 s
        // (pi-durable's DEFAULT_RETRY_POLICY) and then sends the job again.
        for (let pass = 0; pass < 3; pass++) {
          const r = await rt.step("t", "a");
          if (r.wakeInMs === null || r.wakeInMs > 10_000) break;
          await new Promise((res) => setTimeout(res, r.wakeInMs! + 50));
        }
        must(sent.length === 1, `${engine} sent the model job ${sent.length} times: ${show(sent)}`);
        const entries = readEntries(host.sql as never, "main");
        const last = (entries.at(-1) as { message?: { stopReason?: string; errorMessage?: string; providerError?: string } } | undefined)?.message;
        must(last?.stopReason === "error" && last.errorMessage === "model refused (HTTP 400, permanent): see the turn's error"
          && last.providerError?.includes("HTTP 400") && last.providerError.includes(said), `last entry ${show(entries.at(-1))}`);
        for (const [name, isRetryable] of [["pi-ai 0.85.1", retryable085], ["pi-ai 1.0.0", retryable1]] as const) {
          must(!isRetryable(last as never), `${name} reads the refusal as retryable: ${last.errorMessage}`);
        }
        // What the Agents API shows for the turn: the provider's message, read from the stored entry.
        const { turns } = sessionTranscript({ entries, running: false, pending: [] } as never, { sessionId: "s", agentId: "a" });
        const turn = turns.at(-1);
        must(turn?.status === "failed" && turn.error?.message === last.providerError, `turn ${show(turn)}`);
        // What the console shows for it: the same message, on its failed-model event.
        const failedEvents = entriesToEvents(entries as never).filter((e) => e.kind === "model.failed");
        must(failedEvents.length === 1 && (failedEvents[0]!.payload as { error?: string }).error === last.providerError,
          `console events ${show(failedEvents)}`);
        // Delivered once: a redelivery of the message takes nothing and calls nothing.
        const again = answering(400, body);
        try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps); } finally { again.restore(); }
        must(again.seen.calls === 0, `a redelivery called the provider ${again.seen.calls} times`);
      } finally { host.dispose(); }
    });
  }

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
