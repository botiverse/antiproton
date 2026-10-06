/**
 * The exact HTTP request the queue consumer sends for a job, pinned byte for byte.
 *
 * `callQueuedModel` (cf/src/model-request.ts) is the one place a model call leaves the Worker, and its request is
 * what the benchmark's baseline was measured with: a DeepSeek call, or a call through the gateway's /compat, whose
 * URL, headers or body moved by one field would change the model's behaviour without failing anything. Each case
 * below runs the real consumer path (provider declaration, `toRequest`, OpenAiCompatibleModel) with only `fetch`
 * replaced, and compares what reached `fetch` — URL, method, every header sorted by name, and the body string as
 * sent — with a literal. The answer it builds from a fixed reply is pinned the same way, minus its timestamp.
 *
 * The cases are the shapes a live job takes: version 1 (pi085, untagged 0.85 Context) and version 2 (pd, tagged,
 * system messages inline), each with tools, a tool round and an earlier reasoning trace that must not be replayed;
 * at DeepSeek directly, and through the gateway's /compat for a DeepSeek and an OpenAI model. The OpenAI model is
 * a reasoning one, called through the Responses API (src/model/openai-responses.ts) with a Responses reply, and
 * one more case pins its own earlier reasoning item being replayed.
 * Beside them, the tool-less shapes (no `tools`, or an empty set: no `tools` key is sent), and a job whose options
 * ask a tool choice, which the consumer does not forward. The providers are
 * declared here, not read from cf/wrangler*.jsonc, so a change to a deployment's providers does not move these
 * literals; a change to how a declared provider is called does.
 *
 * A literal that no longer matches is printed in full, ready to paste, but only a change meant to alter what a
 * provider is sent should ever paste it.
 */
import { callQueuedModel, type ModelEnv } from "../cf/src/model-request.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

// Test values standing in for the secrets: they appear in the snapshots, so they must never be real ones.
const ENV: ModelEnv & Record<string, unknown> = {
  HARNESS_MODEL: "deepseek-flash",
  DEEPSEEK_API_KEY: "sk-snapshot-deepseek",
  AI_GATEWAY_TOKEN: "snapshot-gateway-token",
  MODEL_PROVIDERS: JSON.stringify([
    { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
    { id: "cloudflare", baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
      auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" },
      modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
  ]),
};

// A deployment that predates MODEL_PROVIDERS: DeepSeek from DEEPSEEK_BASE_URL and DEEPSEEK_API_KEY.
const LEGACY_ENV: ModelEnv = { HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "sk-snapshot-deepseek" };

const TOOLS = [
  { name: "read", description: "Read a page", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "run_js", description: "Run code", parameters: { type: "object", properties: { code: { type: "string" }, timeout: { type: "number" } } } },
];

/** Version 1, as the pi085 provider writes it: one top prompt, no tag. */
const V1 = {
  systemPrompt: "You are a careful agent.",
  messages: [
    { role: "user", content: "Read https://example.com", timestamp: 1 },
    { role: "assistant", api: "offloaded", provider: "openai-compatible", model: "deepseek-flash",
      content: [{ type: "thinking", thinking: "I should read it." }, { type: "text", text: "Reading." },
        { type: "toolCall", id: "call_1", name: "read", arguments: { url: "https://example.com" } }],
      stopReason: "toolUse", jobId: "mj_1", timestamp: 2 },
    { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "Example Domain" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: "And now " }, { type: "text", text: "summarise." }], timestamp: 4 },
  ],
  tools: TOOLS,
};

/** Version 2, as the pd provider writes it (src/model/durable-offloaded.ts `jobContext`): the prompt first, a later one in place. */
const V2 = {
  version: 2,
  messages: [
    { role: "system", content: "You are a careful agent." },
    { role: "user", content: "Read https://example.com", timestamp: 1 },
    { role: "assistant", api: "offloaded", provider: "openai-compatible", model: "deepseek-flash",
      content: [{ type: "thinking", thinking: "I should read it." },
        { type: "toolCall", id: "call_1", name: "read", arguments: { url: "https://example.com" } }],
      stopReason: "toolUse", jobId: "mj_1", timestamp: 2 },
    { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "Example Domain" }], isError: false, timestamp: 3 },
    { role: "system", content: "Updated system prompt section \"time\":\n\n<time>2026-10-05</time>" },
    { role: "user", content: "summarise", timestamp: 4 },
  ],
  tools: TOOLS,
};

/** A reasoning item as `fromResponse` stores it: the item, as JSON, in the thinking block's `thinkingSignature`. */
const reasoningBlock = (id: string, text: string) => ({ type: "thinking", thinking: text,
  thinkingSignature: JSON.stringify({ type: "reasoning", id, summary: [{ type: "summary_text", text }], encrypted_content: `enc-${id}` }) });

/**
 * Version 2 where Luna answered the first call (a reasoning item, then the tool call), and a turn of another
 * OpenAI model's sits before it: Luna's item is replayed in its place, the other model's is not.
 */
const V2_LUNA = {
  version: 2,
  messages: [
    { role: "system", content: "You are a careful agent." },
    { role: "user", content: "Hello", timestamp: 1 },
    { role: "assistant", api: "offloaded", provider: "openai-compatible", model: "openai/gpt-5.6-terra",
      content: [reasoningBlock("rs_other", "Another model's."), { type: "text", text: "Hi." }], stopReason: "stop", jobId: "mj_0", timestamp: 2 },
    { role: "user", content: "Read https://example.com", timestamp: 3 },
    { role: "assistant", api: "offloaded", provider: "openai-compatible", model: "openai/gpt-5.6-luna",
      content: [reasoningBlock("rs_1", "I should read it."),
        { type: "toolCall", id: "call_1", name: "read", arguments: { url: "https://example.com" } }],
      stopReason: "toolUse", jobId: "mj_1", timestamp: 4 },
    { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "Example Domain" }], isError: false, timestamp: 5 },
  ],
  tools: TOOLS,
};

/** Version 1 with no tool offered (a compaction summary's call): `tools` absent. */
const V1_NO_TOOLS = { systemPrompt: V1.systemPrompt, messages: V1.messages };
/** Version 2 with an empty tool set: `tools: []` is no tools, not an empty list sent. */
const V2_NO_TOOLS = { ...V2, tools: [] };

const job = (context: unknown, operator?: { provider: string; model: string }, options: Record<string, unknown> = {}) => ({
  model: { api: "offloaded", provider: "openai-compatible", id: "deepseek-flash" },
  context,
  options,
  ...(operator ? { operatorModel: operator.model, operatorProvider: operator.provider } : { operatorModel: null, operatorProvider: null }),
});

/** A chat/completions reply carrying text, a reasoning trace, a tool call and DeepSeek's cache counter. */
const REPLY = JSON.stringify({
  choices: [{ finish_reason: "tool_calls", message: { content: "Summarising.", reasoning_content: "Short trace.",
    tool_calls: [{ id: "call_2", type: "function", function: { name: "run_js", arguments: "{\"code\":\"1+1\"}" } }] } }],
  usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 64, completion_tokens_details: { reasoning_tokens: 9 } },
});

/** A Responses API reply carrying the same: a reasoning item (summary and encrypted reasoning), text, a tool call, and usage with its cached and reasoning parts. */
const RESPONSES_REPLY = JSON.stringify({
  id: "resp_2", object: "response", status: "completed",
  output: [
    { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "Short trace." }], encrypted_content: "enc-2" },
    { type: "message", id: "msg_2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Summarising.", annotations: [] }] },
    { type: "function_call", id: "fc_2", call_id: "call_2", name: "run_js", arguments: "{\"code\":\"1+1\"}", status: "completed" },
  ],
  usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 64 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 9 }, total_tokens: 150 },
});

/** Runs the job with `fetch` replaced; returns the one request it made, in the snapshot's form, and the answer. */
async function capture(env: ModelEnv, j: unknown, reply = REPLY): Promise<{ request: string; answer: string }> {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const raw = (init?.headers ?? {}) as Record<string, string>;
    const headers = Object.keys(raw).sort().map((k) => [k, raw[k]]);
    seen.push(JSON.stringify({ url: String(input), method: init?.method, headers, body: init?.body }));
    return new Response(reply, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  let answer;
  try { answer = await callQueuedModel(env, j, "mj_2"); } finally { globalThis.fetch = real; }
  if (seen.length !== 1) throw new Error(`expected one request, saw ${seen.length}`);
  const { timestamp: _t, ...stable } = answer as unknown as Record<string, unknown>;
  return { request: seen[0]!, answer: JSON.stringify(stable) };
}

const CASES: Array<{ name: string; env: ModelEnv; job: unknown; reply?: string; request: string; answer: string }> = [
  { name: "deepseek, version 1 (pi085), the deployment's default model", env: ENV, job: job(V1),
    request: String.raw`{"url":"https://api.deepseek.com/chat/completions","method":"POST","headers":[["authorization","Bearer sk-snapshot-deepseek"],["content-type","application/json"]],"body":"{\"model\":\"deepseek-flash\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"role\":\"assistant\",\"content\":\"Reading.\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"Example Domain\"},{\"role\":\"user\",\"content\":\"And now summarise.\"}],\"max_tokens\":32768,\"temperature\":0,\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"read\",\"description\":\"Read a page\",\"parameters\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}}},{\"type\":\"function\",\"function\":{\"name\":\"run_js\",\"description\":\"Run code\",\"parameters\":{\"type\":\"object\",\"properties\":{\"code\":{\"type\":\"string\"},\"timeout\":{\"type\":\"number\"}}}}}]}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace."},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"deepseek-flash","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
  { name: "deepseek, version 1, a deployment without MODEL_PROVIDERS", env: LEGACY_ENV, job: job(V1),
    request: String.raw`{"url":"https://api.deepseek.com/chat/completions","method":"POST","headers":[["authorization","Bearer sk-snapshot-deepseek"],["content-type","application/json"]],"body":"{\"model\":\"deepseek-flash\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"role\":\"assistant\",\"content\":\"Reading.\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"Example Domain\"},{\"role\":\"user\",\"content\":\"And now summarise.\"}],\"max_tokens\":32768,\"temperature\":0,\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"read\",\"description\":\"Read a page\",\"parameters\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}}},{\"type\":\"function\",\"function\":{\"name\":\"run_js\",\"description\":\"Run code\",\"parameters\":{\"type\":\"object\",\"properties\":{\"code\":{\"type\":\"string\"},\"timeout\":{\"type\":\"number\"}}}}}]}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace."},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"deepseek-flash","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
  { name: "deepseek, version 2 (pd), a bound model", env: ENV, job: job(V2, { provider: "deepseek", model: "deepseek-v4-pro" }),
    request: String.raw`{"url":"https://api.deepseek.com/chat/completions","method":"POST","headers":[["authorization","Bearer sk-snapshot-deepseek"],["content-type","application/json"]],"body":"{\"model\":\"deepseek-v4-pro\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"Example Domain\"},{\"role\":\"system\",\"content\":\"Updated system prompt section \\\"time\\\":\\n\\n<time>2026-10-05</time>\"},{\"role\":\"user\",\"content\":\"summarise\"}],\"max_tokens\":32768,\"temperature\":0,\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"read\",\"description\":\"Read a page\",\"parameters\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}}},{\"type\":\"function\",\"function\":{\"name\":\"run_js\",\"description\":\"Run code\",\"parameters\":{\"type\":\"object\",\"properties\":{\"code\":{\"type\":\"string\"},\"timeout\":{\"type\":\"number\"}}}}}]}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace."},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"deepseek-v4-pro","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
  { name: "cloudflare /compat, deepseek/deepseek-flash (key passed through), version 2", env: ENV,
    job: job(V2, { provider: "cloudflare", model: "deepseek/deepseek-flash" }),
    request: String.raw`{"url":"https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions","method":"POST","headers":[["authorization","Bearer sk-snapshot-deepseek"],["cf-aig-authorization","Bearer snapshot-gateway-token"],["content-type","application/json"]],"body":"{\"model\":\"deepseek/deepseek-flash\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"Example Domain\"},{\"role\":\"system\",\"content\":\"Updated system prompt section \\\"time\\\":\\n\\n<time>2026-10-05</time>\"},{\"role\":\"user\",\"content\":\"summarise\"}],\"max_tokens\":32768,\"temperature\":0,\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"read\",\"description\":\"Read a page\",\"parameters\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}}},{\"type\":\"function\",\"function\":{\"name\":\"run_js\",\"description\":\"Run code\",\"parameters\":{\"type\":\"object\",\"properties\":{\"code\":{\"type\":\"string\"},\"timeout\":{\"type\":\"number\"}}}}}]}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace."},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"deepseek/deepseek-flash","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
  // An OpenAI reasoning model goes to the Responses API at the same provider (src/model/openai-responses.ts): the
  // reasoning on at its default effort, tools beside it, and an earlier reasoning item replayed only when it is
  // the same model's own. The earlier turn in V1 and V2 is DeepSeek's (a trace with no signature): nothing replayed.
  { name: "cloudflare /compat, openai/gpt-5.6-luna (gateway-keyed), version 1, through the Responses API", env: ENV,
    job: job(V1, { provider: "cloudflare", model: "openai/gpt-5.6-luna" }), reply: RESPONSES_REPLY,
    request: String.raw`{"url":"https://gateway.ai.cloudflare.com/v1/acct/gw/compat/responses","method":"POST","headers":[["cf-aig-authorization","Bearer snapshot-gateway-token"],["content-type","application/json"]],"body":"{\"model\":\"openai/gpt-5.6-luna\",\"input\":[{\"role\":\"developer\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"role\":\"assistant\",\"content\":\"Reading.\"},{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"},{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":\"Example Domain\"},{\"role\":\"user\",\"content\":\"And now summarise.\"}],\"max_output_tokens\":32768,\"store\":false,\"reasoning\":{\"effort\":\"medium\",\"summary\":\"auto\"},\"include\":[\"reasoning.encrypted_content\"],\"tools\":[{\"type\":\"function\",\"name\":\"read\",\"description\":\"Read a page\",\"parameters\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]},\"strict\":false},{\"type\":\"function\",\"name\":\"run_js\",\"description\":\"Run code\",\"parameters\":{\"type\":\"object\",\"properties\":{\"code\":{\"type\":\"string\"},\"timeout\":{\"type\":\"number\"}}},\"strict\":false}]}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace.","thinkingSignature":"{\"type\":\"reasoning\",\"id\":\"rs_2\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"Short trace.\"}],\"encrypted_content\":\"enc-2\"}"},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"openai/gpt-5.6-luna","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
  { name: "cloudflare /compat, openai/gpt-5.6-luna (gateway-keyed), version 2, through the Responses API", env: ENV,
    job: job(V2, { provider: "cloudflare", model: "openai/gpt-5.6-luna" }), reply: RESPONSES_REPLY,
    request: String.raw`{"url":"https://gateway.ai.cloudflare.com/v1/acct/gw/compat/responses","method":"POST","headers":[["cf-aig-authorization","Bearer snapshot-gateway-token"],["content-type","application/json"]],"body":"{\"model\":\"openai/gpt-5.6-luna\",\"input\":[{\"role\":\"developer\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"},{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":\"Example Domain\"},{\"role\":\"developer\",\"content\":\"Updated system prompt section \\\"time\\\":\\n\\n<time>2026-10-05</time>\"},{\"role\":\"user\",\"content\":\"summarise\"}],\"max_output_tokens\":32768,\"store\":false,\"reasoning\":{\"effort\":\"medium\",\"summary\":\"auto\"},\"include\":[\"reasoning.encrypted_content\"],\"tools\":[{\"type\":\"function\",\"name\":\"read\",\"description\":\"Read a page\",\"parameters\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]},\"strict\":false},{\"type\":\"function\",\"name\":\"run_js\",\"description\":\"Run code\",\"parameters\":{\"type\":\"object\",\"properties\":{\"code\":{\"type\":\"string\"},\"timeout\":{\"type\":\"number\"}}},\"strict\":false}]}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace.","thinkingSignature":"{\"type\":\"reasoning\",\"id\":\"rs_2\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"Short trace.\"}],\"encrypted_content\":\"enc-2\"}"},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"openai/gpt-5.6-luna","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
  { name: "cloudflare /compat, openai/gpt-5.6-luna, version 2, its own earlier reasoning replayed and another model's not", env: ENV,
    job: job(V2_LUNA, { provider: "cloudflare", model: "openai/gpt-5.6-luna" }), reply: RESPONSES_REPLY,
    request: String.raw`{"url":"https://gateway.ai.cloudflare.com/v1/acct/gw/compat/responses","method":"POST","headers":[["cf-aig-authorization","Bearer snapshot-gateway-token"],["content-type","application/json"]],"body":"{\"model\":\"openai/gpt-5.6-luna\",\"input\":[{\"role\":\"developer\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Hello\"},{\"role\":\"assistant\",\"content\":\"Hi.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"type\":\"reasoning\",\"id\":\"rs_1\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"I should read it.\"}],\"encrypted_content\":\"enc-rs_1\"},{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"},{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":\"Example Domain\"}],\"max_output_tokens\":32768,\"store\":false,\"reasoning\":{\"effort\":\"medium\",\"summary\":\"auto\"},\"include\":[\"reasoning.encrypted_content\"],\"tools\":[{\"type\":\"function\",\"name\":\"read\",\"description\":\"Read a page\",\"parameters\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]},\"strict\":false},{\"type\":\"function\",\"name\":\"run_js\",\"description\":\"Run code\",\"parameters\":{\"type\":\"object\",\"properties\":{\"code\":{\"type\":\"string\"},\"timeout\":{\"type\":\"number\"}}},\"strict\":false}]}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace.","thinkingSignature":"{\"type\":\"reasoning\",\"id\":\"rs_2\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"Short trace.\"}],\"encrypted_content\":\"enc-2\"}"},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"openai/gpt-5.6-luna","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
  // No tool offered: no `tools` key at all, and so no `tool_choice` — at DeepSeek directly and through /compat.
  { name: "deepseek, version 1 with no tools", env: ENV, job: job(V1_NO_TOOLS),
    
    request: String.raw`{"url":"https://api.deepseek.com/chat/completions","method":"POST","headers":[["authorization","Bearer sk-snapshot-deepseek"],["content-type","application/json"]],"body":"{\"model\":\"deepseek-flash\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"role\":\"assistant\",\"content\":\"Reading.\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"Example Domain\"},{\"role\":\"user\",\"content\":\"And now summarise.\"}],\"max_tokens\":32768,\"temperature\":0}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace."},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"deepseek-flash","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
  { name: "cloudflare /compat, deepseek/deepseek-flash, version 2 with an empty tool set", env: ENV,
    job: job(V2_NO_TOOLS, { provider: "cloudflare", model: "deepseek/deepseek-flash" }),
    
    request: String.raw`{"url":"https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions","method":"POST","headers":[["authorization","Bearer sk-snapshot-deepseek"],["cf-aig-authorization","Bearer snapshot-gateway-token"],["content-type","application/json"]],"body":"{\"model\":\"deepseek/deepseek-flash\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"Example Domain\"},{\"role\":\"system\",\"content\":\"Updated system prompt section \\\"time\\\":\\n\\n<time>2026-10-05</time>\"},{\"role\":\"user\",\"content\":\"summarise\"}],\"max_tokens\":32768,\"temperature\":0}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace."},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"deepseek/deepseek-flash","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
  // pi's SimpleStreamOptions may carry a toolChoice into the job's options. The consumer passes tools alone to
  // OpenAiCompatibleModel.complete, so its `tool_choice` branch is not reached from here: nothing is sent for it.
  { name: "cloudflare /compat, deepseek/deepseek-flash, version 2, the job's options asking toolChoice required", env: ENV,
    job: job(V2, { provider: "cloudflare", model: "deepseek/deepseek-flash" }, { toolChoice: "required" }),
    
    request: String.raw`{"url":"https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions","method":"POST","headers":[["authorization","Bearer sk-snapshot-deepseek"],["cf-aig-authorization","Bearer snapshot-gateway-token"],["content-type","application/json"]],"body":"{\"model\":\"deepseek/deepseek-flash\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a careful agent.\"},{\"role\":\"user\",\"content\":\"Read https://example.com\"},{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"Example Domain\"},{\"role\":\"system\",\"content\":\"Updated system prompt section \\\"time\\\":\\n\\n<time>2026-10-05</time>\"},{\"role\":\"user\",\"content\":\"summarise\"}],\"max_tokens\":32768,\"temperature\":0,\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"read\",\"description\":\"Read a page\",\"parameters\":{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}}},{\"type\":\"function\",\"function\":{\"name\":\"run_js\",\"description\":\"Run code\",\"parameters\":{\"type\":\"object\",\"properties\":{\"code\":{\"type\":\"string\"},\"timeout\":{\"type\":\"number\"}}}}}]}"}`,
    answer: String.raw`{"role":"assistant","content":[{"type":"thinking","thinking":"Short trace."},{"type":"text","text":"Summarising."},{"type":"toolCall","id":"call_2","name":"run_js","arguments":{"code":"1+1"}}],"api":"offloaded","provider":"openai-compatible","model":"deepseek/deepseek-flash","usage":{"input":120,"output":30,"cacheRead":64,"cacheWrite":0,"reasoning":9,"totalTokens":150,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","rawStopReason":"tool_calls","jobId":"mj_2"}` },
];

for (const c of CASES) {
  await check(`${c.name}: the request and the answer are the pinned ones`, async () => {
    const got = await capture(c.env, c.job, c.reply);
    const diffs: string[] = [];
    if (got.request !== c.request) diffs.push(`request changed\n    got  ${got.request}\n    want ${c.request}`);
    if (got.answer !== c.answer) diffs.push(`answer changed\n    got  ${got.answer}\n    want ${c.answer}`);
    if (diffs.length) throw new Error(diffs.join("\n  "));
  });
}

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n  ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
