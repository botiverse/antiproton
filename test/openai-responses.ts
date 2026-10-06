/**
 * An OpenAI reasoning model through the Responses API (src/model/openai-responses.ts): which models go there, the
 * reasoning level each `reasoning` option sends, how an answer is read (tool calls, reasoning items, usage, a cut
 * or failed response), and — on both engines, through the queue consumer's own call (`callQueuedModel`,
 * cf/src/model-request.ts) with only `fetch` replaced — that the reasoning a first call returned reaches the
 * second call of the same turn, in its place before the tool call it led to.
 */
import { callQueuedModel, operatorModelOf } from "../cf/src/model-request.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { readResponse, responsesReasoningFor, usesResponses, RESPONSES_DEFAULT_EFFORT } from "../src/model/openai-responses.ts";
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const LUNA = "openai/gpt-5.6-luna";

await check("which models go to the Responses API: an openai/ reasoning model of pi's catalog, and nothing else", () => {
  must(usesResponses(LUNA) && usesResponses("openai/o3"), "a reasoning model was left on chat/completions");
  for (const m of ["openai/gpt-4.1-mini", "gpt-5.6-luna", "deepseek-flash", "deepseek/deepseek-flash", "openai/gpt-nonexistent"]) {
    must(!usesResponses(m), `${m} was sent to the Responses API`);
  }
});

await check(`the reasoning level: ${RESPONSES_DEFAULT_EFFORT} when none is asked for, the asked level mapped, and off as the catalog's off`, () => {
  must(show(responsesReasoningFor(LUNA)) === show({ field: { effort: "medium", summary: "auto" }, replay: true }), show(responsesReasoningFor(LUNA)));
  must(show(responsesReasoningFor(LUNA, "high")) === show({ field: { effort: "high", summary: "auto" }, replay: true }), show(responsesReasoningFor(LUNA, "high")));
  must(show(responsesReasoningFor(LUNA, "low")) === show({ field: { effort: "low", summary: "auto" }, replay: true }), show(responsesReasoningFor(LUNA, "low")));
  must(show(responsesReasoningFor(LUNA, "off")) === show({ field: { effort: "none" }, replay: false }), show(responsesReasoningFor(LUNA, "off")));
  // o3's catalog entry has no off value: pi sends no reasoning field for it, and neither does this.
  must(show(responsesReasoningFor("openai/o3", "off")) === show({ replay: false }), show(responsesReasoningFor("openai/o3", "off")));
});

await check("an answer is read: text, tool calls by call_id, each encrypted reasoning item kept whole, usage as chat/completions reports it", () => {
  const item = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "a" }, { type: "summary_text", text: "b" }], encrypted_content: "enc" };
  const r = readResponse({ status: "completed", output: [
    item,
    { type: "reasoning", id: "rs_bare", summary: [] },
    { type: "message", content: [{ type: "output_text", text: "x" }, { type: "output_text", text: "y" }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "t", arguments: "{\"k\":1}" },
    { type: "function_call", id: "fc_2", call_id: "call_2", name: "t", arguments: "{oops" },
  ], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 5 } } });
  must(r.text === "xy" && r.reasoning === "a\n\nb", show(r));
  must(show(r.reasoningItems) === show([{ text: "a\n\nb", signature: JSON.stringify(item) }]), `reasoning items ${show(r.reasoningItems)}`);
  must(show(r.toolCalls) === show([{ id: "call_1", name: "t", arguments: { k: 1 } }, { id: "call_2", name: "t", arguments: { __unparsable: "{oops" } }]), show(r.toolCalls));
  must(r.finishReason === "tool_calls" && !r.truncated, show(r));
  must(show(r.usage) === show({ promptTokens: 10, completionTokens: 7, reasoningTokens: 5, cachedPromptTokens: 4 }), show(r.usage));
});

await check("a response cut at its output cap is truncated; one cut for another reason is not; a failed one is thrown, for the queue to retry", () => {
  const cut = readResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
  must(cut.truncated && cut.finishReason === "max_output_tokens", show(cut));
  const filtered = readResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] });
  must(!filtered.truncated && filtered.finishReason === "content_filter", show(filtered));
  let thrown: unknown;
  try { readResponse({ status: "failed", error: { code: "server_error" } }); } catch (e) { thrown = e; }
  must(thrown instanceof Error && /failed/.test(thrown.message), String(thrown));
});

// ---- the agent loop: both engines, the queue consumer's own call ----------------------------------------------

const ENV = {
  HARNESS_MODEL: "deepseek-flash", DEEPSEEK_API_KEY: "dk", AI_GATEWAY_TOKEN: "gt",
  MODEL_PROVIDERS: JSON.stringify([
    { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
    { id: "cloudflare", baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
      auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
  ]),
};

const notes: Plugin = {
  id: "kv", version: "1.0.0",
  tools: [{ name: "get", summary: "Read a note.", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] }, sideEffects: "read", idempotency: "none" }] as never,
  async invoke() { return { value: "the note" }; },
};

/** The first call reasons, then calls the tool; the second answers. Each request's URL and parsed body is kept. */
function provider() {
  const seen: Array<{ url: string; body: any }> = [];
  const RS_1 = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Read the note first." }], encrypted_content: "enc-first-call" };
  const replies = [
    { status: "completed", output: [RS_1, { type: "function_call", id: "fc_1", call_id: "call_1", name: "notes__get", arguments: "{\"key\":\"x\"}" }],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 } } },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "The note says: the note." }] }],
      usage: { input_tokens: 160, input_tokens_details: { cached_tokens: 96 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 } } },
  ];
  const answer = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const reply = replies[seen.length - 1];
    if (!reply) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { seen, fetch: answer, RS_1 };
}

async function lunaTurn(engine: "pi085" | "pd") {
  const host = sqliteHost();
  const real = globalThis.fetch;
  const p = provider();
  globalThis.fetch = p.fetch;
  try {
    if (engine === "pd") {
      const ap = new ApStore(host, prefixedNamespace("ap"));
      ap.ensure();
      ap.setEngineOnce("pd");
    }
    const sent: string[] = [];
    const rt = new AgentRuntime({
      ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
      bucket: {} as never, bucketName: "b", models: { resolve: () => null },
      autoRelease: false, extraPlugins: [notes],
      operatorModel: operatorModelOf(ENV),
      offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
    } as never);
    await rt.ready();
    await rt.store.createAgent("t", "a");
    await rt.store.setPluginChoice("t", "a", "kv", "enable");
    must((await rt.addMount("t", "a", { alias: "notes", plugin: "kv", config: {} })).ok, "the mount was refused");
    await rt.bindOperatorModel("t", "a", { provider: "cloudflare", model: LUNA });
    await rt.postMessage("t", "a", "What does note x say?");
    const answered = new Set<string>();
    for (let guard = 0; ; guard++) {
      must(guard < 300, `${engine}: the turn did not settle after ${p.seen.length} calls`);
      const out = await rt.step("t", "a") as { wakeInMs?: number | null };
      const pending = sent.filter((id) => !answered.has(id));
      for (const id of pending) {
        answered.add(id);
        const job = await rt.takeJob("t", "a", id);
        if (job) await rt.deliverAnswer("t", "a", id, await callQueuedModel(ENV, job, id), undefined);
      }
      if (pending.length) continue;
      if (out?.wakeInMs === null || out?.wakeInMs === undefined) break;
      await sleep(Math.min(out.wakeInMs, 20));
    }
    const usage = pendingUsage(host.sql as never, 0).filter((r) => r.resource === "model.tokens").map((r) => `${r.key}=${r.quantity}`);
    return { seen: p.seen, RS_1: p.RS_1, usage };
  } finally { globalThis.fetch = real; host.dispose(); }
}

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: Luna is called at the provider's /responses with reasoning on and the tools, and its first call's reasoning is replayed in the second, before the tool call it led to`, async () => {
    const { seen, RS_1, usage } = await lunaTurn(engine);
    must(seen.length === 2, `${seen.length} calls: ${show(seen.map((s) => s.url))}`);
    for (const s of seen) {
      must(s.url === "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/responses" && s.body.model === LUNA, `${s.url} ${s.body.model}`);
      must(show(s.body.reasoning) === show({ effort: "medium", summary: "auto" }) && show(s.body.include) === show(["reasoning.encrypted_content"]) && s.body.store === false,
        `reasoning fields: ${show([s.body.reasoning, s.body.include, s.body.store])}`);
      must((s.body.tools ?? []).some((t: any) => t.type === "function" && t.name === "notes__get"), `tools: ${show((s.body.tools ?? []).map((t: any) => t.name))}`);
    }
    must(!seen[0]!.body.input.some((i: any) => i.type === "reasoning"), "the first call replayed reasoning it had not had");
    const second: any[] = seen[1]!.body.input;
    const at = second.findIndex((i) => i.type === "reasoning");
    must(at >= 0, `the second call carried no reasoning: ${show(second.map((i) => i.type ?? i.role))}`);
    must(show(second[at]) === show(RS_1), `the replayed item is not the one returned: ${show(second[at])}`);
    must(second[at + 1]?.type === "function_call" && second[at + 1].call_id === "call_1"
      && second[at + 2]?.type === "function_call_output" && second[at + 2].call_id === "call_1",
      `the reasoning is not followed by its call and the result: ${show(second.slice(at))}`);
    // Metered as a chat/completions call is: the whole prompt in, the reasoning inside the output.
    must(usage.includes(`${LUNA}:input=100`) && usage.includes(`${LUNA}:output=40`) && usage.includes(`${LUNA}:input=160`) && usage.includes(`${LUNA}:output=12`),
      `usage ${show(usage)}`);
  });
}

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
