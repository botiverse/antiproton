/**
 * A model-call message whose job id the agent holds no row for. The runtime used to read that as the
 * main session's job, where `takeJob` found nothing and the message was acked as "already answered"
 * with no trace. Now the runtime throws `UnknownJob`, the object answers it as a value, and the
 * consumer acks and logs it rather than delivering or retrying. A job the agent does hold behaves as
 * before. The runtime is the real one over sqlite; the stub stands in for the object's RPC methods
 * with the same translation the object uses (`replyingUnknownJob`).
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { adoptProvisionedAgent } from "../cf/src/provision/steps.ts";
import {
  ATTEMPT_TRACE_BOUND_MS, UnknownJob, consumeModelCalls, isUnknownJobReply, replyingUnknownJob,
  type ModelJobStub, type ModelQueueDeps, type ModelQueueMessage, type QueuedModelCall,
} from "../cf/src/model-queue.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { MAIN_SESSION } from "../src/store/pi-storage.ts";
import { ensureAgentTables } from "../src/runtime/pi-agent.ts";
import { setLogSink } from "../src/core/log.ts";
import { callQueuedModel, operatorModelOf } from "../cf/src/model-request.ts";
import { ModelCallTimedOut, ModelHttpError } from "../src/model/openai-compatible.ts";
import { pendingTrace } from "../src/trace/outbox.ts";
import type { FailedAttempt } from "../cf/src/model-queue.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const T = "t", A = "agent-1", SESSION = "conv-a";
const REQUEST = { model: { api: "offloaded", provider: "openai-compatible", id: "m" }, context: { messages: [] } };

async function runtime(providers?: unknown[]) {
  const host = sqliteHost();
  // The one environment both sides read, as in the Worker: the object's operator model and the queue consumer's call.
  const env = { DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "deepseek-flash",
    ...(providers ? { MODEL_PROVIDERS: providers, GW_TOKEN: "gt" } : {}) } as any;
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    secretKek: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    operatorModel: operatorModelOf(env),
  } as any);
  await rt.ready();
  // An agent with a model binding, as provisioning makes one: the runtime opens a session only for that.
  const adopted = await adoptProvisionedAgent(rt, T, A, { name: "Cody", instructions: "", raftOrigin: "https://raft.example", avatar: "0badcafe" });
  if (!adopted.ok) throw new Error(`adopt: ${adopted.error}`);
  // Which sessions the runtime opens, so a fallback to the main one is visible.
  const opened: string[] = [];
  const agent = rt.agent.bind(rt);
  rt.agent = (tenantId: string, agentId: string, session?: string) => {
    opened.push(session ?? MAIN_SESSION);
    return agent(tenantId, agentId, session);
  };
  const addJob = (id: string, session: string) => (ensureAgentTables(host.sql, session), host.sql.exec(
    "INSERT INTO pi_model_jobs(id, request, created_at, session) VALUES (?,?,?,?)", id, JSON.stringify(REQUEST), Date.now(), session));
  const answerOf = (id: string) =>
    (host.sql.exec("SELECT answer FROM pi_model_jobs WHERE id = ?", id).toArray()[0] as { answer: string | null } | undefined)?.answer;
  return { rt, host, opened, addJob, answerOf, env };
}

/** The object's two RPC methods over a real runtime, translated as the object does. */
function stubOver(rt: AgentRuntime, calls: string[]): ModelJobStub {
  return {
    takeJob: (t, a, j, taker) => { calls.push(`take ${j}`); return replyingUnknownJob(() => rt.takeJob(t, a, j, taker)); },
    releaseJob: (t, a, j, taker) => { calls.push(`release ${j}`); return replyingUnknownJob(() => rt.releaseJob(t, a, j, taker)); },
    deliverAnswer: (t, a, j, answer, _ms, taker) => { calls.push(`deliver ${j}`); return replyingUnknownJob(() => rt.deliverAnswer(t, a, j, answer, taker)); },
  };
}

function message(jobId: string) {
  const m = { acked: 0, retried: 0 };
  const msg: ModelQueueMessage = {
    body: { doId: "do-1", tenantId: T, agentId: A, jobId },
    ack() { m.acked++; },
    retry() { m.retried++; },
  };
  return { msg, m };
}

function deps(stub: ModelJobStub, providerCalls: string[]): ModelQueueDeps {
  return {
    stub: () => stub,
    async call(_job: unknown, m: QueuedModelCall) {
      providerCalls.push(m.jobId);
      return { role: "assistant", content: [{ type: "text", text: "hi" }], jobId: m.jobId };
    },
    givenUp: (m: QueuedModelCall) => ({ role: "assistant", content: [], stopReason: "error", jobId: m.jobId }),
  };
}

function captureLog() {
  const lines: Array<Record<string, unknown>> = [];
  setLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return lines;
}

await check("runtime: an unknown job id throws UnknownJob on take and on deliver, and never opens the main session", async () => {
  const { rt, host, opened, addJob } = await runtime();
  // First with no jobs table at all, then with one that holds another job.
  must(host.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'pi_model_jobs'").toArray().length === 0, "the jobs table already exists");
  for (const op of ["take", "deliver", "addJob", "take", "deliver"] as const) {
    if (op === "addJob") { addJob("job-other", SESSION); continue; }
    let thrown: unknown = null;
    try {
      if (op === "take") await rt.takeJob(T, A, "job-missing");
      else await rt.deliverAnswer(T, A, "job-missing", { role: "assistant", content: [] }, undefined);
    } catch (e) { thrown = e; }
    must(thrown instanceof UnknownJob && thrown.jobId === "job-missing", `${op}: ${String(thrown)}`);
  }
  must(opened.length === 0, `sessions opened for an unknown job: ${opened.join(",")}`);
  host.dispose();
});

await check("runtime: a take names the provider the agent is bound to, so the consumer calls that provider", async () => {
  const { rt, host, addJob } = await runtime([
    { id: "deepseek", baseUrl: "https://model.example/v1", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
    { id: "gw", baseUrl: "https://gw.example/compat", auth: { secret: "GW_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model" },
  ]);
  await rt.bindOperatorModel(T, A, { provider: "gw", model: "openai/gpt-5" });
  addJob("job-g", SESSION);
  const job = await rt.takeJob(T, A, "job-g") as Record<string, unknown> | null;
  must(job && job.operatorModel === "openai/gpt-5" && job.operatorProvider === "gw", JSON.stringify(job));
  let refused = "";
  try { await rt.bindOperatorModel(T, A, { provider: "gw", model: "gpt-5" }); } catch (e) { refused = String((e as Error).message); }
  must(/vendor\/model/.test(refused), `a binding was written for a name its provider refuses: ${refused || "no refusal"}`);
  host.dispose();
});

const PROVIDERS = [
  { id: "deepseek", baseUrl: "https://model.example/v1", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
  { id: "gw", baseUrl: "https://gw.example/compat", auth: { secret: "GW_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model",
    passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
];

/** Take a job from the real runtime and hand it to the real consumer call, recording what reached fetch. */
async function callThrough(r: Awaited<ReturnType<typeof runtime>>, jobId: string) {
  r.addJob(jobId, SESSION);
  const job = await r.rt.takeJob(T, A, jobId);
  const seen: Array<{ url: string; headers: Record<string, string>; model: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()), model: JSON.parse(init.body).model });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { headers: { "content-type": "application/json" } });
  }) as any;
  try { await callQueuedModel(r.env, { ...(job as object), context: { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }] } }, jobId); }
  finally { globalThis.fetch = real; }
  return seen[0]!;
}

await check("live path: an agent bound to openai/ under the gateway is called at the gateway's current URL with its token and no DeepSeek key, whatever URL its binding recorded", async () => {
  const r = await runtime(PROVIDERS);
  await r.rt.bindOperatorModel(T, A, { provider: "gw", model: "openai/gpt-5" });
  // A binding row whose recorded URL is not the provider's: a credential goes only where it is declared to go now.
  const b = (await r.rt.store.getModelBinding(T, A))!;
  await r.rt.store.setModelBinding({ ...b, baseUrl: "https://stale.example/compat" });
  const s = await callThrough(r, "job-live");
  // gpt-5 is a reasoning model, called through the Responses API at the same provider (src/model/openai-responses.ts).
  must(s.url === "https://gw.example/compat/responses" && s.model === "openai/gpt-5" && s.headers["cf-aig-authorization"] === "Bearer gt"
    && !("authorization" in s.headers) && !JSON.stringify(s).includes("operator-key"), JSON.stringify(s));
  r.host.dispose();
});

await check("live path: a binding written before providers (operator:model) is DeepSeek's, called as before, with a gateway declared", async () => {
  const r = await runtime(PROVIDERS);
  // The row exactly as the code before providers wrote it.
  await r.rt.store.setModelBinding({ tenantId: T, agentId: A, provider: "openai-compatible", model: "deepseek-flash", baseUrl: "https://model.example/v1", secretRef: "operator:model" });
  const s = await callThrough(r, "job-legacy");
  must(s.url === "https://model.example/v1/chat/completions" && s.model === "deepseek-flash" && s.headers.authorization === "Bearer operator-key"
    && !("cf-aig-authorization" in s.headers), JSON.stringify(s));
  r.host.dispose();
});

await check("runtime: a known job is taken and answered in its own session, unchanged", async () => {
  const { rt, host, opened, addJob, answerOf } = await runtime();
  addJob("job-a", SESSION);
  const job = await rt.takeJob(T, A, "job-a") as Record<string, unknown> | null;
  must(job && JSON.stringify(job.model) === JSON.stringify(REQUEST.model) && job.operatorModel === "deepseek-flash" && job.operatorProvider === "deepseek", JSON.stringify(job));
  must(await rt.deliverAnswer(T, A, "job-a", { role: "assistant", content: [], jobId: "job-a" }, undefined) === true, "deliver did not write");
  must(answerOf("job-a"), "no answer on the row");
  must(await rt.takeJob(T, A, "job-a") === null, "an answered job was taken again");
  must(await rt.deliverAnswer(T, A, "job-a", { role: "assistant", content: [] }, undefined) === false, "an answered job was answered twice");
  must(opened.length === 4 && opened.every((s) => s === SESSION), `sessions opened: ${opened.join(",")}`);
  host.dispose();
});

await check("consumer: an unknown job id is acked and logged with job, tenant and agent; not delivered, not retried, no provider call", async () => {
  const { rt, host, opened } = await runtime();
  const lines = captureLog();
  const calls: string[] = [], provider: string[] = [];
  const { msg, m } = message("job-missing");
  await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(stubOver(rt, calls), provider));
  setLogSink(null);
  must(m.acked === 1 && m.retried === 0, JSON.stringify(m));
  must(calls.join("|") === "take job-missing", `stub calls: ${calls.join("|")}`);
  must(provider.length === 0, "the provider was called");
  must(opened.length === 0, `sessions opened: ${opened.join(",")}`);
  const line = lines.find((l) => l.evt === "model_job.unknown");
  must(line && line.jobId === "job-missing" && line.tenantId === T && line.agentId === A && line.phase === "take", JSON.stringify(lines));
  host.dispose();
});

await check("consumer: an unknown job id on the dead letter queue is acked and logged, and given up on nothing", async () => {
  const { rt, host } = await runtime();
  const lines = captureLog();
  const calls: string[] = [];
  const { msg, m } = message("job-missing");
  await consumeModelCalls({ queue: "model-calls-dlq", messages: [msg] }, deps(stubOver(rt, calls), []));
  setLogSink(null);
  must(m.acked === 1 && m.retried === 0, JSON.stringify(m));
  must(calls.join("|") === "take job-missing", `stub calls: ${calls.join("|")}`);
  must(lines.some((l) => l.evt === "model_job.unknown" && l.jobId === "job-missing" && l.phase === "give_up"), JSON.stringify(lines));
  host.dispose();
});

await check("consumer: a job that disappears between take and deliver is acked and logged, not retried", async () => {
  const { rt, host, addJob } = await runtime();
  addJob("job-a", SESSION);
  const lines = captureLog();
  const calls: string[] = [];
  const inner = stubOver(rt, calls);
  const stub: ModelJobStub = {
    takeJob: inner.takeJob,
    releaseJob: inner.releaseJob,
    async deliverAnswer(t, a, j, answer, ms) {
      host.sql.exec("DELETE FROM pi_model_jobs WHERE id = ?", j); // cancelled while the provider ran
      return inner.deliverAnswer(t, a, j, answer, ms);
    },
  };
  const { msg, m } = message("job-a");
  await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(stub, []));
  setLogSink(null);
  must(m.acked === 1 && m.retried === 0, JSON.stringify(m));
  must(lines.some((l) => l.evt === "model_job.unknown" && l.jobId === "job-a" && l.phase === "deliver"), JSON.stringify(lines));
  host.dispose();
});

await check("consumer: a known job is taken, called and delivered into its session, then acked; nothing is logged as unknown", async () => {
  const { rt, host, addJob, answerOf, opened } = await runtime();
  addJob("job-a", SESSION);
  const lines = captureLog();
  const calls: string[] = [], provider: string[] = [];
  const { msg, m } = message("job-a");
  await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(stubOver(rt, calls), provider));
  setLogSink(null);
  must(m.acked === 1 && m.retried === 0, JSON.stringify(m));
  must(calls.join("|") === "take job-a|deliver job-a" && provider.join() === "job-a", `${calls.join("|")} / ${provider.join()}`);
  must(answerOf("job-a")?.includes("\"hi\""), `answer: ${answerOf("job-a")}`);
  must(opened.every((s) => s === SESSION), `sessions opened: ${opened.join(",")}`);
  must(!lines.some((l) => l.evt === "model_job.unknown"), JSON.stringify(lines));
  // A redelivery after success: taken as null, acked, no provider call, nothing logged.
  const again = message("job-a");
  await consumeModelCalls({ queue: "model-calls", messages: [again.msg] }, deps(stubOver(rt, calls), provider));
  must(again.m.acked === 1 && provider.length === 1, `${JSON.stringify(again.m)} / ${provider.join()}`);
  host.dispose();
});

await check("consumer: each attempt, giving up too, takes under a fresh name and delivers under it; a failed one releases that name and is retried", async () => {
  const log: string[] = [];
  const stub: ModelJobStub = {
    async takeJob(_t, _a, _j, taker) { log.push(`take ${taker}`); return REQUEST; },
    async releaseJob(_t, _a, _j, taker) { log.push(`release ${taker}`); return true; },
    async deliverAnswer(_t, _a, _j, _answer, _ms, taker) { log.push(`deliver ${taker}`); return true; },
  };
  const failing: ModelQueueDeps = { ...deps(stub, []), async call() { throw new Error("provider 503"); } };
  const { msg, m } = message("job-a");
  const err = console.error; console.error = () => {};
  try {
    await consumeModelCalls({ queue: "model-calls", messages: [msg, msg] }, failing);
    await consumeModelCalls({ queue: "model-calls-dlq", messages: [msg] }, deps(stub, []));
    await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(stub, []));
  } finally { console.error = err; }
  must(m.retried === 2 && m.acked === 2, JSON.stringify(m));
  const names = log.map((l) => l.split(" ")[1]);
  must(log.map((l) => l.split(" ")[0]).join("|") === "take|release|take|release|take|deliver|take|deliver", log.join("|"));
  must(names[0] && names[0] === names[1] && names[2] === names[3] && names[0] !== names[2] && names[4] && names[4] !== names[0] && names[4] !== names[2],
    `takers ${log.join("|")}`);
  // Each delivery names the attempt that made it, so a replay of that delivery is metered once (PdHost.deliver).
  must(names[5] === names[4] && names[6] && names[7] === names[6] && names[6] !== names[4], `delivered under ${log.join("|")}`);
});

await check("consumer: any other failure is still retried, not acked", async () => {
  const stub: ModelJobStub = {
    async takeJob() { throw new Error("object unavailable"); },
    async releaseJob() { return true; },
    async deliverAnswer() { return true; },
  };
  const { msg, m } = message("job-a");
  const err = console.error; console.error = () => {};
  try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(stub, [])); }
  finally { console.error = err; }
  must(m.acked === 0 && m.retried === 1, JSON.stringify(m));
});

/** A stub whose take hands out `job` and whose failed attempts are collected, for the trace of a retry. */
function attemptStub(job: unknown = { ...REQUEST, operatorModel: "deepseek-flash" }) {
  const attempts: FailedAttempt[] = [];
  const stub: ModelJobStub = {
    async takeJob() { return job; },
    async releaseJob() { return true; },
    async deliverAnswer() { return true; },
    async recordModelAttempt(_t, _a, _j, a) { attempts.push(a); return true; },
  };
  return { stub, attempts };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = err; }
}

await check("consumer: each failed attempt is told to the object with its delivery number, the step, the HTTP status and the provider's time; never the error's text", async () => {
  // The case behind it: a 36 s model call whose trace said nothing about why. A retry in between was one of the
  // explanations, and nothing could rule it in or out.
  const { stub, attempts } = attemptStub();
  const body = "upstream said: account sk-live-0123456789abcdef is over quota";
  const failing: ModelQueueDeps = { ...deps(stub, []), async call() { await new Promise((r) => setTimeout(r, 30)); throw new ModelHttpError(503, `model 503: ${body}`); } };
  const { msg, m } = message("job-a");
  await quietly(() => consumeModelCalls({ queue: "model-calls", messages: [{ ...msg, attempts: 3 }] }, failing));
  must(m.retried === 1 && m.acked === 0, JSON.stringify(m));
  must(attempts.length === 1, JSON.stringify(attempts));
  const a = attempts[0]!;
  must(a.attempt === 3 && a.phase === "call" && a.outcome === "http" && a.httpStatus === 503 && a.model === "deepseek-flash", JSON.stringify(a));
  must(typeof a.providerMs === "number" && a.providerMs >= 25 && a.ms >= a.providerMs, `times: ${JSON.stringify(a)}`);
  must(!JSON.stringify(attempts).includes("quota") && !JSON.stringify(attempts).includes("sk-live"), `the error's text was sent: ${JSON.stringify(a)}`);
});

await check("consumer: a timeout, a transport error and a failed take are each told as what they were", async () => {
  const cases: Array<[string, ModelQueueDeps["call"] | null, (a: FailedAttempt) => boolean]> = [
    ["timeout", async () => { throw new ModelCallTimedOut("no answer within 120000 ms"); }, (a) => a.outcome === "timeout" && a.phase === "call" && a.httpStatus === undefined],
    ["transport", async () => { throw new TypeError("fetch failed"); }, (a) => a.outcome === "transport_error" && a.errorClass === "TypeError" && a.phase === "call"],
    ["take", null, (a) => a.phase === "take" && a.providerMs === undefined && a.model === undefined && a.attempt === null],
  ];
  for (const [name, call, ok] of cases) {
    const { stub, attempts } = attemptStub();
    const s: ModelJobStub = call ? stub : { ...stub, async takeJob() { throw new Error("object unavailable"); } };
    const d: ModelQueueDeps = { ...deps(s, []), ...(call ? { call } : {}) };
    const { msg, m } = message("job-a");
    await quietly(() => consumeModelCalls({ queue: "model-calls", messages: [msg] }, d));
    must(m.retried === 1 && attempts.length === 1 && ok(attempts[0]!), `${name}: ${JSON.stringify({ m, attempts })}`);
  }
});

await check("consumer: an attempt whose record cannot be written is still retried, and a delivery that fails after the call keeps the provider's time", async () => {
  const lines = captureLog();
  const { stub } = attemptStub();
  const broken: ModelJobStub = {
    ...stub,
    async deliverAnswer() { throw new Error("object reset"); },
    async recordModelAttempt() { throw new Error("object reset"); },
  };
  const { msg, m } = message("job-a");
  await quietly(() => consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(broken, [])));
  setLogSink(null);
  must(m.retried === 1 && m.acked === 0, JSON.stringify(m));
  must(lines.some((l) => l.evt === "model_job.attempt_trace_failed" && l.jobId === "job-a" && l.reason === "error"), JSON.stringify(lines));
  // The same delivery failure, recorded: the call answered, so the step is the delivery and the provider's time is the call's.
  const { stub: s2, attempts } = attemptStub();
  await quietly(() => consumeModelCalls({ queue: "model-calls", messages: [message("job-b").msg] },
    deps({ ...s2, async deliverAnswer() { throw new Error("object reset"); } }, [])));
  must(attempts[0]?.phase === "deliver" && typeof attempts[0].providerMs === "number", JSON.stringify(attempts));
});

await check("consumer: an object that never answers the attempt's record does not hold up the retry", async () => {
  const lines = captureLog();
  const { stub } = attemptStub();
  const hung: ModelJobStub = { ...stub, recordModelAttempt: () => new Promise(() => {}) };
  const failing: ModelQueueDeps = { ...deps(hung, []), async call() { throw new ModelHttpError(503, "model 503"); } };
  const { msg, m } = message("job-a");
  const t0 = Date.now();
  await quietly(() => consumeModelCalls({ queue: "model-calls", messages: [msg] }, failing, 50));
  const took = Date.now() - t0;
  setLogSink(null);
  must(m.retried === 1 && m.acked === 0, JSON.stringify(m));
  must(took < 1_000, `the retry waited ${took} ms on the record`);
  must(lines.some((l) => l.evt === "model_job.attempt_trace_failed" && l.jobId === "job-a" && l.reason === "timeout"), JSON.stringify(lines));
  // The default bound is the short one the consumer uses in production, not the queue's whole visibility window.
  must(ATTEMPT_TRACE_BOUND_MS <= 2_000, `bound ${ATTEMPT_TRACE_BOUND_MS}`);
});

await check("runtime: a failed attempt becomes one model.attempt row on the job's span, with only checked fields", async () => {
  const { rt, host } = await runtime();
  const sent = {
    attempt: 2, phase: "call", outcome: "http", httpStatus: 429, ms: 36_050.4, providerMs: 35_990, model: "deepseek-flash",
    // What the consumer never sends, and the row must not carry if something did: words, and fields out of shape.
    error: "model 429: rate limited for key sk-live-0123456789abcdef", errorClass: "not a class", extra: { body: "x" },
  };
  must(await rt.recordModelAttempt(T, A, "job-a", sent) === true, "not written");
  must(await rt.recordModelAttempt(T, A, "job-a", null) === false, "a missing report was written");
  const rows = pendingTrace(host.sql as any, 0).rows.filter((r) => r.kind === "model.attempt");
  must(rows.length === 1, JSON.stringify(rows));
  const r = rows[0]!;
  must(r.spanId === "job-a" && r.status === "retried" && r.verdict === "failed" && r.ms === 36_050, JSON.stringify(r));
  must(JSON.stringify(r.attrs) === JSON.stringify({ attempt: 2, phase: "call", outcome: "http", httpStatus: 429, providerMs: 35_990, model: "deepseek-flash" }),
    `attrs: ${JSON.stringify(r.attrs)}`);
  host.dispose();
});

await check("the reply shape is recognised and nothing else is", async () => {
  must(isUnknownJobReply({ unknownJob: "j" }), "reply not recognised");
  for (const v of [null, false, true, {}, { unknownJob: 1 }, REQUEST]) must(!isUnknownJobReply(v), `misread ${JSON.stringify(v)}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
