/**
 * The chat/completions body per model family (src/model/chat-request-shape.ts, src/model/openai-compatible.ts):
 * an OpenAI model gets `max_completion_tokens` and, when it reasons, the catalog's "off" level as
 * `reasoning_effort`; every other model, DeepSeek's included, gets the body it always did, byte for byte.
 *
 * The OpenAI rules are mirrored from pi-ai's openai-completions provider, so the last cases run pi's own
 * request builder (`stream` with `onPayload`, which hands over the body before anything is sent) for every
 * model in pi's OpenAI catalog, in both installed pi-ai versions, and compare. A pi upgrade that changes the
 * rule turns them red here rather than reaching a tenant as a 400.
 *
 * Those cases force `api: "openai-completions"` on catalog entries pi itself sends through
 * `openai-responses`: pi never builds a chat/completions body for these models. What they compare is pi's
 * chat/completions rule applied to pi's description of the model, which is the rule this client follows;
 * they say nothing about what pi sends on its own route.
 */
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { chatShapeFor } from "../src/model/chat-request-shape.ts";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { stream as piStream085 } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as piStream1 } from "pi-ai-1/api/openai-completions";
import { OPENAI_MODELS as OPENAI_MODELS_1 } from "pi-ai-1/providers/openai.models";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const TOOLS = [{ name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
const MESSAGES = [{ role: "system" as const, content: "be brief" }, { role: "user" as const, content: "Weather in Oslo?" }];

/** The body `complete` sends for `model`, as text: nothing is sent anywhere. */
async function bodyFor(model: string, opts: Parameters<OpenAiCompatibleModel["complete"]>[1] = {}): Promise<string> {
  const real = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    body = init.body;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }));
  }) as never;
  try { await new OpenAiCompatibleModel({ baseUrl: "https://p.example/v1", apiKey: "k", model }).complete(MESSAGES, opts); }
  finally { globalThis.fetch = real; }
  return body;
}
const fields = (body: string) => { const { messages: _m, tools, ...rest } = JSON.parse(body); return { ...rest, tools: tools?.length ?? 0 }; };

await check("DeepSeek: the body is byte-identical to the one built before per-model shaping, with and without tools and reasoning dials", async () => {
  // Written out as the request builder wrote it before shaping existed (key order included), not derived from it.
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const before = (model: string, extra: Record<string, unknown>, withTools: boolean, toolChoice?: string) => JSON.stringify({
    model, messages: MESSAGES, max_tokens: 32768, temperature: 0, ...extra,
    ...(withTools ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}),
  });
  for (const model of ["deepseek-flash", "deepseek-v4-pro", "deepseek/deepseek-flash"]) {
    must(await bodyFor(model, { tools: TOOLS }) === before(model, {}, true), `${model} with tools: ${await bodyFor(model, { tools: TOOLS })}`);
    must(await bodyFor(model) === before(model, {}, false), `${model} without tools`);
    must(await bodyFor(model, { tools: TOOLS, toolChoice: "required" }) === before(model, {}, true, "required"), `${model} tool_choice`);
    must(await bodyFor(model, { reasoning: "off" }) === before(model, { thinking: { type: "disabled" } }, false), `${model} reasoning off`);
    must(await bodyFor(model, { reasoning: "high" }) === before(model, { reasoning_effort: "high" }, false), `${model} reasoning high`);
  }
});

await check("Anthropic and Google through the gateway: today's body (max_tokens, temperature 0, nothing added)", async () => {
  for (const model of ["anthropic/claude-haiku-4-5", "google-ai-studio/gemini-2.5-flash"]) {
    must(show(fields(await bodyFor(model, { tools: TOOLS }))) === show({ model, max_tokens: 32768, temperature: 0, tools: 1 }), `${model}: ${show(fields(await bodyFor(model, { tools: TOOLS })))}`);
  }
});

await check("OpenAI non-reasoning (gpt-4.1-mini): max_completion_tokens instead of max_tokens, temperature 0, no reasoning_effort", async () => {
  must(show(fields(await bodyFor("openai/gpt-4.1-mini", { tools: TOOLS }))) === show({ model: "openai/gpt-4.1-mini", max_completion_tokens: 32768, temperature: 0, tools: 1 }),
    show(fields(await bodyFor("openai/gpt-4.1-mini", { tools: TOOLS }))));
});

await check("OpenAI reasoning (gpt-5.6-luna), with tools and without: max_completion_tokens, reasoning_effort none, temperature 0", async () => {
  const want = (tools: number) => show({ model: "openai/gpt-5.6-luna", max_completion_tokens: 32768, temperature: 0, reasoning_effort: "none", tools });
  must(show(fields(await bodyFor("openai/gpt-5.6-luna", { tools: TOOLS }))) === want(1), show(fields(await bodyFor("openai/gpt-5.6-luna", { tools: TOOLS }))));
  must(show(fields(await bodyFor("openai/gpt-5.6-luna"))) === want(0), show(fields(await bodyFor("openai/gpt-5.6-luna"))));
});

await check("OpenAI reasoning with no off level (o3) and reasoning asked for (luna, high): no temperature, the level as given", async () => {
  must(show(fields(await bodyFor("openai/o3", { tools: TOOLS }))) === show({ model: "openai/o3", max_completion_tokens: 32768, tools: 1 }), show(fields(await bodyFor("openai/o3", { tools: TOOLS }))));
  must(show(fields(await bodyFor("openai/gpt-5.6-luna", { reasoning: "high" }))) === show({ model: "openai/gpt-5.6-luna", max_completion_tokens: 32768, reasoning_effort: "high", tools: 0 }),
    show(fields(await bodyFor("openai/gpt-5.6-luna", { reasoning: "high" }))));
});

await check("the decision is the model's name: a bare name is never shaped, an unlisted openai/ model is shaped as non-reasoning", () => {
  must(chatShapeFor("gpt-5.6-luna") === null && chatShapeFor("deepseek-flash") === null && chatShapeFor("openrouter/openai") === null, "a name without the openai/ vendor was shaped");
  must(show(chatShapeFor("openai/gpt-9-unlisted")) === show({ tokensField: "max_completion_tokens", temperature: true }), show(chatShapeFor("openai/gpt-9-unlisted")));
  must(chatShapeFor("openai/constructor")?.reasoningEffort === undefined, "an Object.prototype name read as a catalog entry");
});

/** The body pi's openai-completions provider would send for `entry` at OpenAI's own chat/completions endpoint. */
type PiStream = (model: never, context: never, options: never) => { result(): Promise<unknown> };
async function piBody(stream: PiStream, entry: Record<string, unknown>, reasoningEffort?: string): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | undefined;
  const model = { ...entry, api: "openai-completions" };
  const s = stream(model as never, {
    systemPrompt: "be brief",
    messages: [{ role: "user", content: "Weather in Oslo?", timestamp: 0 }],
    tools: TOOLS,
  } as never, {
    apiKey: "k", maxTokens: 32768, temperature: 0, ...(reasoningEffort ? { reasoningEffort } : {}),
    onPayload: (p: unknown) => { payload = p as Record<string, unknown>; throw new Error("captured"); },
    fetch: (async () => { throw new Error("pi tried to send the request"); }) as never,
  } as never);
  await s.result();
  if (!payload) throw new Error(`pi built no payload for ${String(entry.id)}`);
  return payload;
}

const PI: Array<[string, PiStream, unknown]> = [["0.85.1", piStream085 as PiStream, OPENAI_MODELS], ["1.0.0", piStream1 as PiStream, OPENAI_MODELS_1]];
for (const [version, stream, catalog] of PI) {
  await check(`pi-ai ${version}: for every model in pi's OpenAI catalog, the output cap's field and reasoning_effort are the ones pi sends`, async () => {
    const entries = Object.values(catalog as Record<string, Record<string, unknown>>);
    must(entries.length > 10 && entries.some((e) => e.id === "gpt-5.6-luna") && entries.some((e) => e.id === "gpt-4.1-mini"), `catalog ${entries.map((e) => e.id)}`);
    const parted: string[] = [];
    for (const entry of entries) {
      for (const asked of [undefined, "high"] as const) {
        const pi = await piBody(stream, entry, asked);
        const ours = fields(await bodyFor(`openai/${String(entry.id)}`, { tools: TOOLS, ...(asked ? { reasoning: asked } : {}) }));
        const piField = "max_completion_tokens" in pi ? "max_completion_tokens" : "max_tokens" in pi ? "max_tokens" : "none";
        const ourField = "max_completion_tokens" in ours ? "max_completion_tokens" : "max_tokens" in ours ? "max_tokens" : "none";
        if (piField !== ourField || pi.reasoning_effort !== ours.reasoning_effort) {
          parted.push(`${String(entry.id)}${asked ? ` (${asked})` : ""}: pi ${piField}/${String(pi.reasoning_effort)}, ours ${ourField}/${String(ours.reasoning_effort)}`);
        }
      }
    }
    must(parted.length === 0, parted.join("; "));
  });
}

await check("pi-ai 0.85.1: DeepSeek's own endpoint gets max_tokens from pi too, the field the unchanged body sends", async () => {
  const pi = await piBody(piStream085 as PiStream, { id: "deepseek-flash", provider: "deepseek", baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"], cost: {}, contextWindow: 1, maxTokens: 1 });
  must("max_tokens" in pi && !("max_completion_tokens" in pi), show(Object.keys(pi)));
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
