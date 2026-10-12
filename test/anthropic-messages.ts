/**
 * Claude through Anthropic's Messages API (src/model/anthropic-messages.ts), for a provider declared
 * `api: "anthropic-messages"` (src/model/providers.ts): the request `toAnthropicRequest` builds (src/model/pi-bridge.ts)
 * with its cache breakpoints, how an answer and its usage are read, the queue consumer's own call (`callQueuedModel`,
 * cf/src/model-request.ts) with only `fetch` replaced, and the soft-window policy (src/runtime/rebuild.ts) that keeps
 * Claude Haiku 5.5 in its lower price tier.
 */
import { callQueuedModel } from "../cf/src/model-request.ts";
import { ANTHROPIC_VERSION, readMessage } from "../src/model/anthropic-messages.ts";
import { CACHE_BREAKPOINT, EMPTY_INPUT, FAILED_ANSWER, fromResponse, toAnthropicRequest, toRequest } from "../src/model/pi-bridge.ts";
import { overflowKind } from "../src/runtime/overflow-backstop.ts";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { parseProviders, providerRequest, providersFrom } from "../src/model/providers.ts";
import { parseUserModels } from "../src/model/user-models.ts";
import { contextWindowFor } from "../src/model/context-windows.ts";
import {
  DEFAULT_REBUILD_POLICY, DEFAULT_SOFT_WINDOW_POLICY, REFUSED_REBUILD_POLICY, rebuildPolicyOf, softWindowFor, softWindowReached,
} from "../src/runtime/rebuild.ts";
import { readFile } from "node:fs/promises";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { pendingUsage } from "../src/usage/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const HAIKU = "claude-haiku-5-5";
const GW = "https://gateway.ai.cloudflare.com/v1/acct/gw";
const ANTHROPIC = { id: "cloudflare-anthropic", baseUrl: `${GW}/anthropic`, auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, api: "anthropic-messages" };
const ENV = {
  HARNESS_MODEL: "deepseek-flash", DEEPSEEK_API_KEY: "dk", AI_GATEWAY_TOKEN: "gateway-token-value",
  MODEL_PROVIDERS: JSON.stringify([
    { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
    { id: "cloudflare", baseUrl: `${GW}/compat`, auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
    ANTHROPIC,
  ]),
};
const job = (context: unknown) => ({ operatorModel: HAIKU, operatorProvider: "cloudflare-anthropic", model: { api: "offloaded", provider: "p" }, context });
const tool = { name: "kv__get", description: "Read a note.", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } };
const usage0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (model: string, content: unknown[], stopReason = "toolUse") => ({ role: "assistant", content, api: "offloaded", provider: "p", model, usage: usage0, stopReason, timestamp: 2 });
const THINKING = { type: "thinking", thinking: "Read the note first.", signature: "sig-1" };

/** Every block that carries a breakpoint, by where it is. */
function breakpoints(r: ReturnType<typeof toAnthropicRequest>): string[] {
  const out: string[] = [];
  (r.tools ?? []).forEach((t, i) => { if (t.cache_control) out.push(`tools[${i}]`); });
  (r.system ?? []).forEach((b, i) => { if (b.cache_control) out.push(`system[${i}]`); });
  r.messages.forEach((m, i) => m.content.forEach((b, j) => { if (b.cache_control) out.push(`messages[${i}].content[${j}]`); }));
  return out;
}

// ---- configuration --------------------------------------------------------------------------------------------------

await check("a provider may declare the Anthropic protocol; any other value is refused, and the default is OpenAI's", () => {
  const ps = parseProviders(ENV.MODEL_PROVIDERS);
  must(ps.find((p) => p.id === "cloudflare-anthropic")?.api === "anthropic-messages" && ps.find((p) => p.id === "cloudflare")?.api === undefined, show(ps));
  let refused = "";
  try { parseProviders([{ id: "deepseek", baseUrl: "https://api.deepseek.com" }, { ...ANTHROPIC, api: "anthropic" }]); } catch (e) { refused = String(e); }
  must(/api is one of openai, anthropic-messages/.test(refused), refused);
  const p = providersFrom(ENV);
  const r = providerRequest(p, { provider: "cloudflare-anthropic", model: HAIKU });
  // The gateway's token in its own header and no vendor key: the gateway bills the call.
  must(r.api === "anthropic-messages" && r.apiKey === "" && r.headers["cf-aig-authorization"] === "Bearer gateway-token-value", show({ ...r, headers: Object.keys(r.headers) }));
  must(providerRequest(p, { provider: "cloudflare", model: "openai/gpt-5.6-luna" }).api === "openai", "the compat provider is not OpenAI's protocol");
});

await check("both deployments offer Claude Haiku 5.5 on the gateway's Anthropic route, selectable only: the default model stays", async () => {
  for (const [file, gateway] of [["cf/wrangler.jsonc", "antiproton"], ["cf/wrangler.preview.jsonc", "antiproton-preview"]] as const) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const vars = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")).vars;
    const ps = parseProviders(vars.MODEL_PROVIDERS);
    const a = ps.find((p) => p.id === "cloudflare-anthropic");
    must(a && a.api === "anthropic-messages" && (a.modelFormat ?? "model") === "model" && !a.passKeys
      && a.auth?.secret === "AI_GATEWAY_TOKEN" && a.auth.header === "cf-aig-authorization"
      && new RegExp(`^https://gateway\\.ai\\.cloudflare\\.com/v1/[0-9a-f]{32}/${gateway}/anthropic$`).test(a.baseUrl), `${file}: ${show(a)}`);
    const options = parseUserModels(vars.USER_MODELS, { configs: ps, secrets: {} });
    must(show(options.find((o) => o.id === HAIKU)) === show({ id: HAIKU, label: "Claude Haiku 5.5", provider: "cloudflare-anthropic", model: HAIKU }), `${file}: ${show(options)}`);
    must(vars.HARNESS_MODEL === "deepseek-flash", `${file}: the default model moved`);
  }
  must(contextWindowFor(HAIKU) === 1_000_000 && contextWindowFor(`anthropic/${HAIKU}`) === 1_000_000, "Haiku's window");
});

// ---- the request ----------------------------------------------------------------------------------------------------

await check("the request: the prompt as top-level system, calls and results as blocks, four breakpoints at the stable ends", () => {
  const ctx = {
    systemPrompt: "You are helpful.",
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
      assistant(HAIKU, [{ type: "text", text: "on it" }, { type: "toolCall", id: "t1", name: "kv__get", arguments: { key: "a" } }, { type: "toolCall", id: "t2", name: "kv__get", arguments: { key: "b" } }]),
      { role: "toolResult", toolCallId: "t1", toolName: "kv__get", content: [{ type: "text", text: "A" }], isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: "t2", toolName: "kv__get", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 4 },
    ],
    tools: [tool, { ...tool, name: "kv__put" }],
  };
  const r = toAnthropicRequest(ctx as never, HAIKU);
  must(show(r.system) === show([{ type: "text", text: "You are helpful.", cache_control: CACHE_BREAKPOINT }]), show(r.system));
  must(r.messages.length === 3 && r.messages.map((m) => m.role).join() === "user,assistant,user", show(r.messages));
  must(show(r.messages[1]!.content) === show([{ type: "text", text: "on it" }, { type: "tool_use", id: "t1", name: "kv__get", input: { key: "a" } }, { type: "tool_use", id: "t2", name: "kv__get", input: { key: "b" } }]), show(r.messages[1]));
  // Both results in the one message after the calls, the failed one marked.
  must(show(r.messages[2]!.content.map((b) => [b.type, b.tool_use_id, b.content, b.is_error ?? false])) === show([["tool_result", "t1", "A", false], ["tool_result", "t2", "boom", true]]), show(r.messages[2]));
  must(show(r.tools!.map((t) => [t.name, t.input_schema])) === show([["kv__get", tool.parameters], ["kv__put", tool.parameters]]), show(r.tools));
  must(show(breakpoints(r)) === show(["tools[1]", "system[0]", "messages[0].content[0]", "messages[2].content[1]"]), show(breakpoints(r)));
});

await check("each request's second-to-last breakpoint is the previous request's last: a turn's prefix is read back exactly", () => {
  const first = [{ role: "user", content: "question", timestamp: 1 }];
  const second = [...first, assistant(HAIKU, [{ type: "toolCall", id: "t1", name: "kv__get", arguments: {} }]),
    { role: "toolResult", toolCallId: "t1", toolName: "kv__get", content: [{ type: "text", text: "A" }], isError: false, timestamp: 3 }];
  const a = toAnthropicRequest({ systemPrompt: "S", messages: first } as never, HAIKU);
  const b = toAnthropicRequest({ systemPrompt: "S", messages: second } as never, HAIKU);
  const last = (r: typeof a, from: number) => { for (let i = r.messages.length - 1 - from; i >= 0; i--) if (r.messages[i]!.role === "user") return i; return -1; };
  const prevLast = last(a, 0), nowSecond = b.messages.findIndex((m, i) => m.role === "user" && i < last(b, 0));
  must(prevLast === nowSecond && show(a.messages.slice(0, prevLast + 1)) === show(b.messages.slice(0, nowSecond + 1)), `${show(a.messages)} / ${show(b.messages)}`);
  must(breakpoints(b).length === 3 && breakpoints(b).includes(breakpoints(a).at(-1)!), `no tools: three breakpoints, the previous last among them: ${show(breakpoints(a))} / ${show(breakpoints(b))}`);
});

await check("version 2: the prompt from the first message, a later system message as a framed text block before the next answer, the system never moved", () => {
  const v2 = {
    version: 2,
    messages: [
      { role: "system", content: "PROMPT" },
      { role: "user", content: "hello", timestamp: 1 },
      assistant(HAIKU, [{ type: "toolCall", id: "t1", name: "kv__get", arguments: {} }]),
      { role: "toolResult", toolCallId: "t1", toolName: "kv__get", content: [{ type: "text", text: "A" }], isError: false, timestamp: 3 },
      { role: "system", content: "UPDATE" },
      assistant(HAIKU, [{ type: "text", text: "done" }], "stop"),
      { role: "user", content: "next", timestamp: 5 },
      { role: "system", content: "LATER" },
    ],
  };
  const r = toAnthropicRequest(v2 as never, HAIKU);
  must(show(r.system) === show([{ type: "text", text: "PROMPT", cache_control: CACHE_BREAKPOINT }]), show(r.system));
  // The update follows the result in its message (results must open it), and the last one closes the request.
  must(show(r.messages[2]!.content.map((b) => b.type)) === show(["tool_result", "text"]) && r.messages[2]!.content[1]!.text === "<system-update>\nUPDATE\n</system-update>", show(r.messages[2]));
  must(show(r.messages[4]!.content.map((b) => b.text)) === show(["next", "<system-update>\nLATER\n</system-update>"]), show(r.messages[4]));
  let thrown = "";
  try { toAnthropicRequest({ messages: [{ role: "user", content: "x" }, { role: "system", content: "y" }] } as never, HAIKU); } catch (e) { thrown = String(e); }
  must(/version 1 model job carries a system message/.test(thrown), thrown);
});

await check("thinking: this model's own blocks go back whole, in place; another model's, or one without its block, are dropped", () => {
  const ctx = {
    systemPrompt: "S",
    messages: [
      { role: "user", content: "q", timestamp: 1 },
      assistant(HAIKU, [{ type: "thinking", thinking: "Read the note first.", thinkingSignature: JSON.stringify(THINKING) }, { type: "toolCall", id: "t1", name: "kv__get", arguments: {} }]),
      { role: "toolResult", toolCallId: "t1", toolName: "kv__get", content: [{ type: "text", text: "A" }], isError: false, timestamp: 3 },
      assistant("deepseek-flash", [{ type: "thinking", thinking: "x", thinkingSignature: JSON.stringify({ type: "thinking", thinking: "x", signature: "other" }) }, { type: "text", text: "other model" }], "stop"),
      assistant(HAIKU, [{ type: "thinking", thinking: "a trace with no block" }, { type: "text", text: "own" }], "stop"),
    ],
  };
  const r = toAnthropicRequest(ctx as never, HAIKU);
  must(show(r.messages[1]!.content[0]) === show(THINKING), show(r.messages[1]));
  must(show(r.messages[3]!.content) === show([{ type: "text", text: "other model" }]) && show(r.messages[4]!.content) === show([{ type: "text", text: "own" }]), show(r.messages.slice(3)));
});

// ---- the answer -----------------------------------------------------------------------------------------------------

await check("an answer is read: text, tool calls, each thinking block kept whole, and usage as the whole prompt with reads and writes inside it", () => {
  const redacted = { type: "redacted_thinking", data: "opaque" };
  const r = readMessage({ content: [THINKING, redacted, { type: "text", text: "x" }, { type: "tool_use", id: "toolu_1", name: "kv__get", input: { key: "a" } }],
    stop_reason: "tool_use", usage: { input_tokens: 9, cache_creation_input_tokens: 78, cache_read_input_tokens: 6816, output_tokens: 20 } });
  must(r.text === "x" && r.finishReason === "tool_calls" && !r.truncated && r.reasoning === "Read the note first.", show(r));
  must(show(r.toolCalls) === show([{ id: "toolu_1", name: "kv__get", arguments: { key: "a" } }]), show(r.toolCalls));
  must(show(r.reasoningItems) === show([{ text: "Read the note first.", signature: JSON.stringify(THINKING) }, { text: "", signature: JSON.stringify(redacted) }]), show(r.reasoningItems));
  must(show(r.usage) === show({ promptTokens: 6903, completionTokens: 20, reasoningTokens: 0, cachedPromptTokens: 6816, cacheWriteTokens: 78 }), show(r.usage));
  const cut = readMessage({ content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens", usage: {} });
  must(cut.truncated && cut.finishReason === "max_tokens", show(cut));
  // The ledger's counters (pi-ai's usage): input the whole prompt, the cache reads and writes inside it.
  const u = fromResponse(r, { api: "offloaded", provider: "p", id: HAIKU }).usage;
  must(u.input === 6903 && u.cacheRead === 6816 && u.cacheWrite === 78 && u.output === 20 && u.totalTokens === 6923, show(u));
});

// ---- verbatim replay, failed stops, empty inputs, results after text -----------------------------------------------

/** An answer's blocks read, written to the transcript, and sent back: what the next request carries for that turn. */
function replayed(content: unknown[], stop = "tool_use") {
  const res = readMessage({ content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
  const answer = fromResponse(res, { api: "offloaded", provider: "p", id: HAIKU }, "mj_r");
  const results = (content as any[]).filter((b) => b.type === "tool_use")
    .map((b, i) => ({ role: "toolResult", toolCallId: b.id, toolName: b.name, content: [{ type: "text", text: `r${i}` }], isError: false, timestamp: 3 }));
  const r = toAnthropicRequest({ systemPrompt: "S", messages: [{ role: "user", content: "go", timestamp: 1 }, answer, ...results] } as never, HAIKU);
  return { answer, sent: r.messages[1]! };
}

await check("an interleaved answer [thinking, tool_use, thinking, tool_use] goes back byte for byte, in its order", () => {
  const content = [
    { type: "thinking", thinking: "First the note.", signature: "sig-a" },
    { type: "tool_use", id: "toolu_1", name: "kv__get", input: { key: "a", nested: { z: 1, a: [2, 1] } }, caller: { type: "direct" } },
    { type: "thinking", thinking: "Then the other.", signature: "sig-b" },
    { type: "tool_use", id: "toolu_2", name: "kv__get", input: { key: "b" } },
  ];
  const { answer, sent } = replayed(content);
  must(answer.content.map((c: any) => c.type).join() === "thinking,toolCall,thinking,toolCall", show(answer.content));
  must(sent.role === "assistant" && JSON.stringify(sent.content) === JSON.stringify(content), `sent ${show(sent.content)}`);
});

await check("an answer [text, thinking, text] goes back byte for byte: the two texts are not joined, the thinking not moved", () => {
  const content = [
    { type: "text", text: "Looking.", citations: null },
    { type: "thinking", thinking: "", signature: "sig-c" },
    { type: "text", text: " Done." },
  ];
  const { answer, sent } = replayed(content, "end_turn");
  must(answer.stopReason === "stop" && answer.content.map((c: any) => c.type).join() === "text,thinking,text", show(answer.content));
  must(JSON.stringify(sent.content) === JSON.stringify(content), `sent ${show(sent.content)}`);
});

await check("a refusal or a window stop with nothing in it is a failed turn naming the stop; with content a window stop is a cut answer", () => {
  const identity = { api: "offloaded", provider: "p", id: HAIKU };
  const refusal = fromResponse(readMessage({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, usage: {} }), identity, "mj_f");
  must(refusal.stopReason === "error" && refusal.errorMessage === FAILED_ANSWER && /refusal/.test(String(refusal.providerError)) && /cyber/.test(String(refusal.providerError)), show(refusal));
  must(!isRetryableAssistantError(refusal as never), "pi would send the refused call again");
  const window = fromResponse(readMessage({ content: [{ type: "thinking", thinking: "", signature: "s" }], stop_reason: "model_context_window_exceeded", usage: {} }), identity, "mj_w");
  must(window.stopReason === "error" && /model_context_window_exceeded/.test(String(window.providerError)), show(window));
  // The overflow backstop rebuilds for it, as for a provider's refusal of an oversized request.
  must(overflowKind(window) === "history", `not an overflow: ${overflowKind(window)}`);
  const cut = readMessage({ content: [{ type: "text", text: "partial" }], stop_reason: "model_context_window_exceeded", usage: {} });
  must(cut.truncated && !cut.failure && fromResponse(cut, identity).stopReason === "length", show(cut));
});

await check("an input with no text (an image alone, or whitespace) is sent as a placeholder: the request never ends on an answer or empty", () => {
  const ctx = { systemPrompt: "S", messages: [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(HAIKU, [{ type: "text", text: "hello" }], "stop"),
    { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 3 },
  ] };
  const r = toAnthropicRequest(ctx as never, HAIKU);
  must(r.messages.at(-1)!.role === "user" && r.messages.at(-1)!.content[0]!.text === EMPTY_INPUT, show(r.messages.at(-1)));
  const blank = toAnthropicRequest({ systemPrompt: "S", messages: [{ role: "user", content: "   ", timestamp: 1 }] } as never, HAIKU);
  must(blank.messages.length === 1 && blank.messages[0]!.content[0]!.text === EMPTY_INPUT, show(blank.messages));
});

await check("a tool result after an input in the same user turn is one message, the results first", () => {
  const ctx = { systemPrompt: "S", messages: [
    { role: "user", content: "start", timestamp: 1 },
    assistant(HAIKU, [{ type: "toolCall", id: "t1", name: "kv__get", arguments: {} }]),
    { role: "user", content: "also this", timestamp: 3 },
    { role: "toolResult", toolCallId: "t1", toolName: "kv__get", content: [{ type: "text", text: "A" }], isError: false, timestamp: 4 },
  ] };
  const r = toAnthropicRequest(ctx as never, HAIKU);
  must(r.messages.length === 3 && show(r.messages[2]!.content.map((b) => b.type === "tool_result" ? `result:${b.tool_use_id}` : `text:${b.text}`)) === show(["result:t1", "text:also this"]), show(r.messages));
});

// ---- the queue consumer's call ---------------------------------------------------------------------------------------

function provider(replies: Array<{ status?: number; body: unknown }>) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
    const r = replies[seen.length - 1] ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}
async function withFetch<T>(f: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

await check("the queue consumer calls <baseUrl>/v1/messages with the gateway token alone; its thinking comes back on the next call of the turn", async () => {
  const p = provider([
    { body: { content: [THINKING, { type: "tool_use", id: "toolu_1", name: "kv__get", input: { key: "x" } }], stop_reason: "tool_use",
      usage: { input_tokens: 5, cache_creation_input_tokens: 6000, cache_read_input_tokens: 0, output_tokens: 40 } } },
    { body: { content: [{ type: "text", text: "The note says hi." }], stop_reason: "end_turn",
      usage: { input_tokens: 4, cache_creation_input_tokens: 70, cache_read_input_tokens: 6000, output_tokens: 9 } } },
  ]);
  const messages: any[] = [{ role: "user", content: "read note x", timestamp: 1 }];
  const first = await withFetch(p.fetch, () => callQueuedModel(ENV, job({ systemPrompt: "S", messages, tools: [tool] }), "mj_1"));
  must(first.stopReason === "toolUse" && first.model === HAIKU && first.jobId === "mj_1", show(first));
  must(first.usage.input === 6005 && first.usage.cacheWrite === 6000 && first.usage.cacheRead === 0, show(first.usage));
  const call = first.content.find((c: any) => c.type === "toolCall") as any;
  messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "hi" }], isError: false, timestamp: 3 });
  const second = await withFetch(p.fetch, () => callQueuedModel(ENV, job({ systemPrompt: "S", messages, tools: [tool] }), "mj_2"));
  must(second.stopReason === "stop" && second.usage.cacheRead === 6000 && second.usage.input === 6074, show(second));

  const [a, b] = p.seen;
  must(a!.url === `${GW}/anthropic/v1/messages` && b!.url === a!.url, a!.url);
  must(a!.headers["cf-aig-authorization"] === "Bearer gateway-token-value" && a!.headers["anthropic-version"] === ANTHROPIC_VERSION
    && !("authorization" in a!.headers) && !("x-api-key" in a!.headers), `headers: ${show(Object.keys(a!.headers))}`);
  must(a!.body.model === HAIKU && a!.body.max_tokens === 32768 && !("temperature" in a!.body) && !("thinking" in a!.body) && !("stream" in a!.body), show(a!.body));
  must(show(b!.body.messages[1].content) === show([THINKING, { type: "tool_use", id: "toolu_1", name: "kv__get", input: { key: "x" } }]), show(b!.body.messages[1]));
  must(show(b!.body.messages.slice(0, 1)) === show(a!.body.messages.slice(0, 1).map((m: any) => m)), "the first message moved between calls");
});

await check("a refusal through the gateway is the turn's error, with the hint that an unknown model also answers 401", async () => {
  const p = provider([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "x-api-key header is required" } } }]);
  const a = await withFetch(p.fetch, () => callQueuedModel(ENV, job({ systemPrompt: "S", messages: [{ role: "user", content: "hi", timestamp: 1 }] }), "mj_3"));
  must(p.seen.length === 1 && a.stopReason === "error", `sent ${p.seen.length} times: ${show(a)}`);
  must(/HTTP 401/.test(a.providerError ?? "") && /x-api-key header is required/.test(a.providerError ?? "") && /check the model name/.test(a.providerError ?? ""), String(a.providerError));
  must(!(a.providerError ?? "").includes("gateway-token-value"), "the token reached the turn");
});

await check("the same model through the OpenAI-compatible provider is the chat request it always was", async () => {
  const p = provider([{ body: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } } }]);
  const ctx = { systemPrompt: "S", messages: [{ role: "user", content: "hi", timestamp: 1 }] };
  await withFetch(p.fetch, () => callQueuedModel(ENV, { ...job(ctx), operatorModel: `anthropic/${HAIKU}`, operatorProvider: "cloudflare" }, "mj_4"));
  must(p.seen[0]!.url === `${GW}/compat/chat/completions` && show(p.seen[0]!.body.messages) === show(toRequest(ctx as never).messages)
    && !JSON.stringify(p.seen[0]!.body).includes("cache_control"), show(p.seen[0]));
});

// ---- through the agent: both engines -------------------------------------------------------------------------------

const notes: Plugin = {
  id: "kv", version: "1.0.0",
  tools: [{ name: "get", summary: "Read a note.", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] }, sideEffects: "read", idempotency: "none" }] as never,
  async invoke() { return { value: "the note" }; },
};
const INTERLEAVED = [
  { type: "thinking", thinking: "Read x.", signature: "sig-1" },
  { type: "tool_use", id: "toolu_1", name: "notes__get", input: { key: "x" } },
  { type: "thinking", thinking: "And y.", signature: "sig-2" },
  { type: "tool_use", id: "toolu_2", name: "notes__get", input: { key: "y" } },
];

/** One Haiku turn on `engine`: an interleaved answer of two calls, then a reply. The requests sent and the usage metered. */
async function haikuTurn(engine: "pi085" | "pd") {
  const host = sqliteHost();
  const p = provider([
    { body: { content: INTERLEAVED, stop_reason: "tool_use", usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 30 } } },
    // Over 100,000 prompt tokens: metered at the long tier.
    { body: { content: [{ type: "text", text: "Both say: the note." }], stop_reason: "end_turn", usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_000, output_tokens: 8 } } },
  ]);
  try {
    return await withFetch(p.fetch, async () => {
      if (engine === "pd") { const ap = new ApStore(host, prefixedNamespace("ap")); ap.ensure(); ap.setEngineOnce("pd"); }
      const sent: string[] = [];
      const rt = new AgentRuntime({
        ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
        bucket: {} as never, bucketName: "b", models: { resolve: () => null },
        autoRelease: false, extraPlugins: [notes], operatorModel: operatorModelOf(ENV),
        offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
      } as never);
      await rt.ready();
      await rt.store.createAgent("t", "a");
      await rt.store.setPluginChoice("t", "a", "kv", "enable");
      must((await rt.addMount("t", "a", { alias: "notes", plugin: "kv", config: {} })).ok, "the mount was refused");
      await rt.bindOperatorModel("t", "a", { provider: "cloudflare-anthropic", model: HAIKU });
      await rt.postMessage("t", "a", "What do notes x and y say?");
      const answered = new Set<string>();
      for (let guard = 0; ; guard++) {
        must(guard < 300, `${engine}: the turn did not settle after ${p.seen.length} calls`);
        const out = await rt.step("t", "a") as { wakeInMs?: number | null };
        const pending = sent.filter((id) => !answered.has(id));
        for (const id of pending) {
          answered.add(id);
          const taken = await rt.takeJob("t", "a", id);
          if (taken) await rt.deliverAnswer("t", "a", id, await callQueuedModel(ENV, taken, id), undefined);
        }
        if (pending.length) continue;
        if (out?.wakeInMs === null || out?.wakeInMs === undefined) break;
        await new Promise((r) => setTimeout(r, Math.min(out.wakeInMs!, 20)));
      }
      const usage = pendingUsage(host.sql as never, 0).filter((r) => r.resource === "model.tokens").map((r) => `${r.key}=${r.quantity}`);
      return { seen: p.seen, usage };
    });
  } finally { host.dispose(); }
}

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: an interleaved answer reaches the next request byte for byte through the transcript; a call over 100,000 is metered at the long tier`, async () => {
    const { seen, usage } = await haikuTurn(engine);
    must(seen.length === 2, `${seen.length} calls`);
    const turn = seen[1]!.body.messages.find((m: any) => m.role === "assistant");
    must(JSON.stringify(turn?.content) === JSON.stringify(INTERLEAVED), `the turn sent back: ${show(turn?.content)}`);
    must(usage.includes(`${HAIKU}:input=10`) && usage.includes(`${HAIKU}:output=30`)
      && usage.includes(`${HAIKU}:long:input=100001`) && usage.includes(`${HAIKU}:long:cache_read=100000`) && usage.includes(`${HAIKU}:long:output=8`), `usage ${show(usage)}`);
  });
}

// ---- the soft window's policy ---------------------------------------------------------------------------------------

await check("the soft window: Haiku's 100,000 by default, held at 90,000, matched by contained name; no other model has one", () => {
  must(show(softWindowFor(DEFAULT_REBUILD_POLICY, HAIKU)) === show({ entry: `byModel:${HAIKU}`, tokens: 100_000, thresholdTokens: 90_000 }), show(softWindowFor(DEFAULT_REBUILD_POLICY, HAIKU)));
  must(softWindowFor(DEFAULT_REBUILD_POLICY, `anthropic/${HAIKU}`)?.thresholdTokens === 90_000, "the compat name has none");
  for (const m of ["deepseek-flash", "openai/gpt-5.6-luna", "claude-sonnet-5-5"]) must(softWindowFor(DEFAULT_REBUILD_POLICY, m) === null, `${m} has a soft window`);
  must(softWindowFor(null, HAIKU) === null && softWindowFor(REFUSED_REBUILD_POLICY, HAIKU) === null, "an off or refused policy acts");
  must(softWindowFor({ ...DEFAULT_REBUILD_POLICY, softWindow: undefined }, HAIKU)?.tokens === DEFAULT_SOFT_WINDOW_POLICY.byModel[HAIKU], "absent is not the default");
});

await check("REBUILD_POLICY's softWindow is laid over the default: off, one model off, a share, a model added; a bad one is refused", () => {
  must(softWindowFor(rebuildPolicyOf('{"softWindow": false}'), HAIKU) === null, "false did not turn it off");
  must(softWindowFor(rebuildPolicyOf(`{"softWindow": {"byModel": {"${HAIKU}": null}}}`), HAIKU) === null, "null did not turn Haiku off");
  const p = rebuildPolicyOf('{"softWindow": {"share": 0.5, "byModel": {"deepseek": 200000}}}');
  must(softWindowFor(p, HAIKU)?.thresholdTokens === 50_000 && softWindowFor(p, "deepseek-flash")?.thresholdTokens === 100_000, show(p?.softWindow));
  must(softWindowFor(rebuildPolicyOf('{"idle": false}'), HAIKU)?.tokens === 100_000, "another section's change dropped the soft window");
  for (const bad of ['{"softWindow": {"share": 2}}', '{"softWindow": {"byModel": {"x": -1}}}', '{"softWindow": {"byModel": []}}', '{"softWindow": 3}']) {
    must(rebuildPolicyOf(bad) === REFUSED_REBUILD_POLICY, `accepted: ${bad}`);
  }
});

await check("held back only when the last answered call reached the threshold and the conversation started under it", () => {
  const w = { entry: "e", tokens: 100_000, thresholdTokens: 90_000 };
  must(!softWindowReached([], w) && !softWindowReached([89_999], w) && !softWindowReached([30_000, 89_999], w), "under it");
  must(softWindowReached([30_000, 90_000], w) && softWindowReached([30_000, 120_000], w), "at or over it");
  must(!softWindowReached([90_000], w) && !softWindowReached([95_000, 99_000], w), "a conversation that started over it");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
