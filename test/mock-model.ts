/**
 * The load-test model provider (tools/mock-model): its answers read through our own client exactly as a real
 * provider's do, a whole agent turn — tool call included — runs on it through the real runtime and queue
 * consumer, and only the preview deployment declares it.
 *
 * `fetch` is replaced by the mock Worker's own handler, so every byte the client sends and reads is the
 * Worker's; nothing leaves the process. The delay is a parameter of the handler, recorded here rather than slept.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_DELAY_MS, MAX_DELAY_MS, behaviourOf, handle, mockCompletion } from "../tools/mock-model/src/index.ts";
import { ModelRequestRefused, OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { parseProviders, providerRequest, providersFrom } from "../src/model/providers.ts";
import { parseUserModels, userModelsFrom } from "../src/model/user-models.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { consumeModelCalls, replyingUnknownJob, type ModelJobStub, type ModelQueueDeps } from "../cf/src/model-queue.ts";
import { callQueuedModel, operatorModelOf } from "../cf/src/model-request.ts";
import { readEntries } from "../cf/src/transcript-read.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

/** A wrangler config's `vars`, with whole-line comments dropped (the files carry no other kind). */
function varsOf(file: string): Record<string, any> {
  const text = readFileSync(new URL(`../cf/${file}`, import.meta.url), "utf8");
  return JSON.parse(text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")).vars;
}
const PREVIEW = varsOf("wrangler.preview.jsonc");
const KEY = "mock-key-for-tests";

/** `fetch` answered by the mock Worker, holding `key`; records each request's URL, auth and the delay it was asked to wait. */
function mockFetch(key: string | undefined) {
  const real = globalThis.fetch;
  const seen: Array<{ url: string; auth: string | null; slept: number }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const rec = { url: req.url, auth: req.headers.get("authorization"), slept: 0 };
    seen.push(rec);
    return handle(req, { MOCK_MODEL_KEY: key }, async (ms) => { rec.slept = ms; });
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const client = (model: string, apiKey = KEY) =>
  new OpenAiCompatibleModel({ baseUrl: "https://mock.example/v1", apiKey, model });
const TOOLS = [
  { name: "files__write", description: "w", parameters: { type: "object", properties: {} } },
  { name: "raft__receive_events", description: "r", parameters: { type: "object", properties: {} } },
  { name: "tools__mounts", description: "m", parameters: { type: "object", properties: {} } },
];

await check("names: mock, -tool, -inbox and -d<ms> in any order; the delay is bounded; anything else is refused", () => {
  must(show(behaviourOf("mock")) === show({ delayMs: DEFAULT_DELAY_MS, toolMode: "none" }), show(behaviourOf("mock")));
  must(show(behaviourOf("mock-d5000-tool")) === show({ delayMs: 5000, toolMode: "tool" }), show(behaviourOf("mock-d5000-tool")));
  must(show(behaviourOf("mock-inbox-d0")) === show({ delayMs: 0, toolMode: "inbox" }), show(behaviourOf("mock-inbox-d0")));
  must((behaviourOf("mock-d999999") as any).delayMs === MAX_DELAY_MS, "the delay was not bounded");
  for (const bad of ["deepseek-flash", "mock-fast", "mock-", "Mock", "openai/mock", 7, undefined]) must("error" in behaviourOf(bad), `accepted ${show(bad)}`);
});

await check("text: our client reads the answer as text, finish stop, no tool calls, and nonzero usage; the request went to <baseUrl>/chat/completions with the key", async () => {
  const f = mockFetch(KEY);
  try {
    const r = await client("mock").complete([{ role: "system", content: "s" }, { role: "user", content: "hello" }], { tools: TOOLS });
    must(r.finishReason === "stop" && !r.truncated && r.toolCalls === undefined && /^Mock reply to turn 1\./.test(r.text), show(r));
    must(r.usage.promptTokens > 0 && r.usage.completionTokens > 0 && r.usage.reasoningTokens === 0 && r.usage.cachedPromptTokens === 0, show(r.usage));
    must(f.seen.length === 1 && f.seen[0]!.url === "https://mock.example/v1/chat/completions" && f.seen[0]!.auth === `Bearer ${KEY}`, show(f.seen));
    must(f.seen[0]!.slept === DEFAULT_DELAY_MS, `slept ${f.seen[0]!.slept}`);
  } finally { f.restore(); }
});

await check("tool: one call to a read-only tool (mounts, else jobs) when tools are offered, then text once its result is in; inbox prefers receive_events; no tools is text", async () => {
  const f = mockFetch(KEY);
  try {
    const first = await client("mock-tool-d0").complete([{ role: "user", content: "go" }], { tools: TOOLS });
    must(first.finishReason === "tool_calls" && first.text === "" && show(first.toolCalls) === show([{ id: "call_mock_1", name: "tools__mounts", arguments: {} }]), show(first));
    const after = await client("mock-tool-d0").complete([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_mock_1", type: "function", function: { name: "tools__mounts", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_mock_1", content: "[]" },
    ] as never, { tools: TOOLS });
    must(after.finishReason === "stop" && after.toolCalls === undefined && after.text.includes("after the tool result"), show(after));
    // A new user turn calls the tool again.
    const next = await client("mock-tool-d0").complete([
      { role: "user", content: "go" }, { role: "tool", tool_call_id: "call_mock_1", content: "[]" }, { role: "user", content: "again" },
    ] as never, { tools: TOOLS });
    must(next.toolCalls?.[0]?.name === "tools__mounts", show(next));
    const inbox = await client("mock-inbox-d0").complete([{ role: "user", content: "go" }], { tools: TOOLS });
    must(inbox.toolCalls?.[0]?.name === "raft__receive_events", show(inbox));
    const bare = await client("mock-tool-d0").complete([{ role: "user", content: "go" }]);
    must(bare.finishReason === "stop" && bare.toolCalls === undefined, show(bare));
    // Never a tool the preference does not name, whatever else is offered; `jobs` (offered to every agent) as the fallback.
    const other = await client("mock-tool-d0").complete([{ role: "user", content: "go" }], { tools: [TOOLS[0]!, TOOLS[1]!] });
    must(other.toolCalls === undefined, show(other));
    const jobs = await client("mock-tool-d0").complete([{ role: "user", content: "go" }], { tools: [TOOLS[0]!, { ...TOOLS[0]!, name: "jobs" }] });
    must(show(jobs.toolCalls) === show([{ id: "call_mock_1", name: "jobs", arguments: { action: "list" } }]), show(jobs));
  } finally { f.restore(); }
});

await check("deterministic: the same body gets the same answer", () => {
  const body = { model: "mock-tool", messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "tools__mounts" } }] };
  must(show(mockCompletion(body, behaviourOf("mock-tool") as any)) === show(mockCompletion(structuredClone(body), behaviourOf("mock-tool") as any)), "two answers");
});

await check("delay: the model name's d<ms> is what is waited, and the x-mock-delay-ms header overrides it", async () => {
  const f = mockFetch(undefined);
  try {
    await client("mock-d5000", "").complete([{ role: "user", content: "x" }]);
    must(f.seen[0]!.slept === 5000, `slept ${f.seen[0]!.slept}`);
  } finally { f.restore(); }
  let slept = -1;
  const res = await handle(new Request("https://m/v1/chat/completions", { method: "POST", headers: { "x-mock-delay-ms": "7" }, body: show({ model: "mock-d5000", messages: [] }) }), {}, async (ms) => { slept = ms; });
  must(res.status === 200 && slept === 7 && res.headers.get("x-mock-delay-ms") === "7", `${res.status} slept ${slept}`);
  // And a real wait is a real wait.
  const t0 = Date.now();
  await handle(new Request("https://m/chat/completions", { method: "POST", body: show({ model: "mock-d60", messages: [] }) }), {});
  must(Date.now() - t0 >= 55, `answered in ${Date.now() - t0} ms`);
});

await check("refusals: a wrong or missing key is 401, an unknown model 404, streaming 400 — each a permanent refusal to our client, called once", async () => {
  for (const [model, key, status] of [["mock-d0", "wrong", 401], ["mock-d0", "", 401], ["mock-nope", KEY, 404]] as const) {
    const f = mockFetch(KEY);
    let thrown: unknown;
    try { await client(model, key).complete([{ role: "user", content: "x" }]); } catch (e) { thrown = e; } finally { f.restore(); }
    must(thrown instanceof ModelRequestRefused && thrown.status === status && f.seen.length === 1, `${model}/${key}: ${String(thrown)} after ${f.seen.length}`);
  }
  const s = await handle(new Request("https://m/v1/chat/completions", { method: "POST", body: show({ model: "mock", stream: true, messages: [] }) }), {}, async () => {});
  must(s.status === 400, `stream: ${s.status}`);
  const g = await handle(new Request("https://m/v1/models"), {});
  must(g.status === 404, `unknown route: ${g.status}`);
});

await check("preview config: declares the mock provider at the deployed Worker with its key named, and offers mock and mock-tool only once MOCK_MODEL_KEY is set", () => {
  const configs = parseProviders(PREVIEW.MODEL_PROVIDERS);
  const mock = configs.find((p) => p.id === "mock");
  must(show(mock) === show({ id: "mock", baseUrl: "https://antiproton-mock-model.botiverse.workers.dev/v1", auth: { secret: "MOCK_MODEL_KEY", header: "authorization" } }), show(mock));
  const declared = parseUserModels(PREVIEW.USER_MODELS, { configs, secrets: {} }).filter((o) => o.provider === "mock");
  must(show(declared.map((o) => [o.id, o.model])) === show([["mock", "mock"], ["mock-tool", "mock-tool"]]), show(declared));
  const withoutKey = userModelsFrom(PREVIEW, providersFrom({ ...PREVIEW, DEEPSEEK_API_KEY: "dk" }));
  must(!withoutKey.error && !withoutKey.offered.some((o) => o.provider === "mock"), show(withoutKey));
  const withKey = userModelsFrom(PREVIEW, providersFrom({ ...PREVIEW, DEEPSEEK_API_KEY: "dk", MOCK_MODEL_KEY: KEY }));
  must(!withKey.error && withKey.offered.filter((o) => o.provider === "mock").length === 2, show(withKey));
  // The request a mock choice makes: the mock's URL, its key and no other provider's.
  const req = providerRequest(providersFrom({ ...PREVIEW, DEEPSEEK_API_KEY: "dk", MOCK_MODEL_KEY: KEY }), { provider: "mock", model: "mock-d250" });
  must(req.baseUrl === mock!.baseUrl && req.apiKey === KEY && show(req.headers) === "{}", show(req));
});

await check("production config: declares no mock provider and offers no mock model", () => {
  const text = readFileSync(new URL("../cf/wrangler.jsonc", import.meta.url), "utf8");
  must(!/mock/i.test(text), "cf/wrangler.jsonc mentions a mock");
  must(!parseProviders(varsOf("wrangler.jsonc").MODEL_PROVIDERS).some((p) => p.id === "mock"), "production declares mock");
});

// The preview's providers as declared, with the secrets the preview would hold.
const ENV = { ...PREVIEW, DEEPSEEK_API_KEY: "dk", MOCK_MODEL_KEY: KEY } as any;

await check("a whole turn on mock-tool: the agent runs the tool the mock called (jobs, the one a bare agent is offered), the tool's result goes back, and the turn completes with the mock's text", async () => {
  const host = sqliteHost();
  const f = mockFetch(KEY);
  try {
    const sent: string[] = [];
    const rt = new AgentRuntime({
      ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
      bucket: {} as never, bucketName: "b", models: { resolve: () => null },
      sandbox: false, autoRelease: false,
      operatorModel: operatorModelOf(ENV),
      offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
    } as never);
    await rt.ready();
    await rt.bindOperatorModel("t", "a", { provider: "mock", model: "mock-tool" });
    await rt.postMessage("t", "a", "Look around.");
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
    let consumed = 0;
    for (let pass = 0; pass < 10; pass++) {
      await rt.step("t", "a");
      while (consumed < sent.length) {
        const jobId = sent[consumed++]!;
        await consumeModelCalls({ queue: "model-calls", messages: [{ body: { doId: "d", tenantId: "t", agentId: "a", jobId }, ack() {}, retry() { throw new Error("retried"); } }] }, deps);
      }
    }
    const messages = readEntries(host.sql as never, "main").map((e: any) => e.message).filter(Boolean);
    const roles = messages.map((m: any) => m.role);
    const call = messages.find((m: any) => m.role === "assistant" && m.content?.some((c: any) => c.type === "toolCall"));
    const result = messages.find((m: any) => m.role === "toolResult");
    const last = messages.at(-1);
    must(f.seen.length === 2 && f.seen.every((s) => s.url === "https://antiproton-mock-model.botiverse.workers.dev/v1/chat/completions"), `provider calls ${show(f.seen)}`);
    must(call?.content.find((c: any) => c.type === "toolCall").name === "jobs", `roles ${show(roles)}; call ${show(call)}`);
    must(result && result.toolName === "jobs" && !result.isError, `tool result ${show(result)}`);
    must(last?.role === "assistant" && last.stopReason === "stop" && /after the tool result/.test(show(last.content)), `last ${show(last)}`);
  } finally { f.restore(); host.dispose(); }
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
