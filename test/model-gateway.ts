/**
 * The deployment's model call per provider (src/model/providers.ts, cf/src/model-request.ts): DeepSeek
 * direct with its key; Cloudflare AI Gateway with its token in its own header, DeepSeek's key only with a
 * deepseek/ model and no key for a vendor the gateway holds one for; a binding or a take from before
 * providers read as DeepSeek's; and a `vendor/model` name sized by the model's own window.
 */
import { bindingIsCurrent, callQueuedModel, choiceOf, operatorModelOf, operatorModelRequest } from "../cf/src/model-request.ts";
import { isOperatorModelRef } from "../cf/src/runtime.ts";
import { providerStatus } from "../src/model/providers.ts";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { contextWindowFor } from "../src/model/context-windows.ts";
import { ModelResolver } from "../src/runtime/model-resolver.ts";
import { operatorRefFor, operatorRequest, providerOfRef } from "../src/model/operator-request.ts";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { pendingUsage } from "../src/usage/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const GW = "https://gateway.ai.cloudflare.com/v1/acct/antiproton/compat";
// The shape cf/wrangler.preview.jsonc declares: DeepSeek direct, and Cloudflare AI Gateway holding the other vendors' keys.
const PROVIDERS = [
  { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
  { id: "cloudflare", baseUrl: GW, auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" },
    modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
];
const ENV = { DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk", HARNESS_MODEL: "deepseek-flash",
  MODEL_PROVIDERS: JSON.stringify(PROVIDERS), AI_GATEWAY_TOKEN: "gt" };

/** Every request fetch sees: its URL, headers and the model it names. */
function recording() {
  const seen: Array<{ url: string; headers: Record<string, string>; model: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()), model: JSON.parse(init.body).model });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } });
  }) as any;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

await check("each provider's request: its own URL and credential header; DeepSeek's key only directly or for a deepseek/ model", () => {
  const op = operatorModelOf(ENV);
  const direct = operatorRequest(op);
  must(direct.baseUrl === "https://api.deepseek.com" && direct.model === "deepseek-flash" && direct.apiKey === "dk" && Object.keys(direct.headers).length === 0, JSON.stringify(direct));
  const viaGw = operatorRequest(op, { provider: "cloudflare", model: "deepseek/deepseek-flash" });
  must(viaGw.baseUrl === GW && viaGw.apiKey === "dk" && viaGw.headers["cf-aig-authorization"] === "Bearer gt" && Object.keys(viaGw.headers).length === 1, JSON.stringify(viaGw));
  for (const model of ["anthropic/claude-sonnet-5", "openai/gpt-5"]) {
    const other = operatorRequest(op, { provider: "cloudflare", model });
    must(other.baseUrl === GW && other.apiKey === "" && other.model === model && other.headers["cf-aig-authorization"] === "Bearer gt",
      `DeepSeek's key was sent for another vendor: ${JSON.stringify(other)}`);
  }
});

await check("a deployment without MODEL_PROVIDERS has DeepSeek alone, at DEEPSEEK_BASE_URL, as before; no cloudflare provider exists", () => {
  const legacy = { DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk", HARNESS_MODEL: "deepseek-flash", AI_GATEWAY_TOKEN: "gt" };
  const r = operatorModelRequest(legacy);
  must(r.baseUrl === "https://api.deepseek.com" && r.apiKey === "dk" && r.model === "deepseek-flash" && Object.keys(r.headers).length === 0, JSON.stringify(r));
  const op = operatorModelOf(legacy);
  must(JSON.stringify(op.providers.configs.map((p) => p.id)) === '["deepseek"]', JSON.stringify(op.providers.configs));
  let refused = "";
  try { operatorRequest(op, { provider: "cloudflare", model: "openai/gpt-5" }); } catch (e) { refused = String((e as Error).message); }
  must(/unknown provider cloudflare/.test(refused), `a provider the deployment does not declare was called: ${refused || "no refusal"}`);
});

await check("a declared provider whose secret is not set is unavailable, and its call is refused before anything is sent", async () => {
  const { AI_GATEWAY_TOKEN: _, ...env } = ENV;
  const op = operatorModelOf(env);
  const st = providerStatus(op.providers);
  must(st.find((p) => p.id === "cloudflare")?.available === false && st.find((p) => p.id === "cloudflare")?.missing.join() === "AI_GATEWAY_TOKEN"
    && st.find((p) => p.id === "deepseek")?.available === true, JSON.stringify(st));
  const rec = recording();
  let refused = "";
  try { await callQueuedModel(env, job("openai/gpt-5", "cloudflare"), "mj_x"); } catch (e) { refused = String((e as Error).message); }
  finally { rec.restore(); }
  must(/cloudflare is not available: AI_GATEWAY_TOKEN/.test(refused) && rec.seen.length === 0, `${refused} / sent ${rec.seen.length}`);
});

await check("the client sends the extra headers, and no authorization when it has no key", async () => {
  const rec = recording();
  try {
    await new OpenAiCompatibleModel({ baseUrl: GW, apiKey: "", model: "anthropic/claude-sonnet-5", headers: { "cf-aig-authorization": "Bearer gt" } }).complete([{ role: "user", content: "hi" }]);
    await new OpenAiCompatibleModel({ baseUrl: GW, apiKey: "dk", model: "deepseek/deepseek-flash" }).complete([{ role: "user", content: "hi" }]);
  } finally { rec.restore(); }
  const seen = rec.seen.map((x) => x.headers);
  must(seen[0]!["cf-aig-authorization"] === "Bearer gt" && !("authorization" in seen[0]!), JSON.stringify(seen[0]));
  must(seen[1]!.authorization === "Bearer dk", JSON.stringify(seen[1]));
});

/** A resolver over one stored binding, wired the way cf/src/runtime.ts wires it. */
function resolverFor(binding: { model: string; baseUrl: string; secretRef: string }, env: Record<string, unknown> = ENV) {
  const op = operatorModelOf(env as any);
  const store: any = { getModelBinding: async () => ({ provider: "openai-compatible", ...binding }) };
  const secrets: any = { resolve: async () => { throw new Error("the operator's binding was resolved as a plain key"); } };
  return new ModelResolver(store, secrets, { owns: isOperatorModelRef, request: (b) => operatorRequest(op, { provider: providerOfRef(b.secretRef)!, model: b.model }) });
}

await check("an agent bound to openai/ under cloudflare is called at the gateway with its token and no DeepSeek key, end to end", async () => {
  const rec = recording();
  try { await (await resolverFor({ model: "openai/gpt-5", baseUrl: GW, secretRef: "operator:model:cloudflare" }).resolve({ tenantId: "t", agentId: "a" })).complete([{ role: "user", content: "hi" }]); }
  finally { rec.restore(); }
  const s = rec.seen[0];
  must(s?.url === `${GW}/chat/completions` && s.model === "openai/gpt-5" && !("authorization" in s.headers) && s.headers["cf-aig-authorization"] === "Bearer gt"
    && !JSON.stringify(s.headers).includes("dk"), JSON.stringify(rec.seen));
});

await check("a binding written before providers (operator:model, no provider) is DeepSeek's, called exactly as before, even with a gateway declared", async () => {
  must(providerOfRef("operator:model") === "deepseek" && operatorRefFor("deepseek") === "operator:model", "the bare reference is not the default provider's");
  const rec = recording();
  try { await (await resolverFor({ model: "deepseek-flash", baseUrl: "https://api.deepseek.com", secretRef: "operator:model" }).resolve({ tenantId: "t", agentId: "a" })).complete([{ role: "user", content: "hi" }]); }
  finally { rec.restore(); }
  const s = rec.seen[0];
  must(s?.url === "https://api.deepseek.com/chat/completions" && s.model === "deepseek-flash" && s.headers.authorization === "Bearer dk" && !("cf-aig-authorization" in s.headers), JSON.stringify(rec.seen));
});

function job(operatorModel: string | null, operatorProvider?: string | null) {
  return {
    model: { api: "offloaded", provider: "queue", id: "bound-model" }, operatorModel,
    ...(operatorProvider === undefined ? {} : { operatorProvider }),
    context: { systemPrompt: "be brief", messages: [{ role: "user", content: "hi", timestamp: 0 }] },
  };
}

await check("the queue consumer's answer names the model it called, which the ledger meters: the deployment's for a binding that spends no operator credential, the binding's when it does", async () => {
  const env = { DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk", HARNESS_MODEL: "deepseek-flash" };
  const rec = recording();
  let own, operator;
  try {
    own = await callQueuedModel(env, job(null), "mj_1");
    operator = await callQueuedModel(env, job("deepseek-pro"), "mj_2");
  } finally { rec.restore(); }
  const sent = rec.seen.map((x) => x.model);
  must(sent[0] === "deepseek-flash" && own.model === "deepseek-flash", `own credential: called ${sent[0]}, answer names ${own.model}`);
  must(sent[1] === "deepseek-pro" && operator.model === "deepseek-pro", `operator binding: called ${sent[1]}, answer names ${operator.model}`);
  must(own.provider === "queue" && own.jobId === "mj_1" && own.usage.input === 5, `the rest of the answer: ${JSON.stringify(own)}`);
});

await check("the queue consumer calls the provider the take names, and a take from before providers is DeepSeek's", async () => {
  const rec = recording();
  try {
    await callQueuedModel(ENV, job("openai/gpt-5", "cloudflare"), "mj_1");
    await callQueuedModel(ENV, job("deepseek-flash"), "mj_2");
    await callQueuedModel(ENV, job(null, null), "mj_3");
  } finally { rec.restore(); }
  const [gw, legacy, dflt] = rec.seen;
  must(gw?.url === `${GW}/chat/completions` && gw.model === "openai/gpt-5" && !("authorization" in gw.headers) && gw.headers["cf-aig-authorization"] === "Bearer gt", JSON.stringify(gw));
  must(legacy?.url === "https://api.deepseek.com/chat/completions" && legacy.headers.authorization === "Bearer dk", JSON.stringify(legacy));
  must(dflt?.url === "https://api.deepseek.com/chat/completions" && dflt.model === "deepseek-flash", JSON.stringify(dflt));
});

await check("a stored choice with no provider is the default provider's, and no choice is the deployment's default model", () => {
  must(JSON.stringify(choiceOf(null, "deepseek-flash")) === '{"provider":"deepseek","model":"deepseek-flash"}', "no choice");
  must(JSON.stringify(choiceOf({ provider: null, model: "deepseek-v4-pro" }, "deepseek-flash")) === '{"provider":"deepseek","model":"deepseek-v4-pro"}', "a row from before providers");
  must(JSON.stringify(choiceOf({ provider: "cloudflare", model: "openai/gpt-5" }, "deepseek-flash")) === '{"provider":"cloudflare","model":"openai/gpt-5"}', "a choice with its provider");
});

await check("an existing agent's binding is current exactly when provider, model and the provider's endpoint all match; a legacy binding needs no rebind", () => {
  const ps = operatorModelOf(ENV).providers;
  const legacy = { model: "deepseek-flash", baseUrl: "https://api.deepseek.com", secretRef: "operator:model" };
  must(bindingIsCurrent(legacy, choiceOf(null, "deepseek-flash"), ps), "an agent bound before providers would be rebound on its next run");
  must(!bindingIsCurrent(legacy, { provider: "cloudflare", model: "deepseek/deepseek-flash" }, ps), "a move to another provider was not seen");
  must(!bindingIsCurrent({ ...legacy, secretRef: "operator:model:cloudflare" }, { provider: "deepseek", model: "deepseek-flash" }, ps), "a move back to the default provider was not seen");
  must(!bindingIsCurrent({ ...legacy, baseUrl: "https://old.example" }, { provider: "deepseek", model: "deepseek-flash" }, ps), "an endpoint change was not seen");
  must(bindingIsCurrent({ model: "openai/gpt-5", baseUrl: GW, secretRef: "operator:model:cloudflare" }, { provider: "cloudflare", model: "openai/gpt-5" }, ps), "a current gateway binding was found stale");
});

await check("pi085 meters a queued answer under the model the consumer called, not the model its job asked for, when the two differ", async () => {
  // A binding that spends no operator credential (a legacy one, or one changed or unbound while the call was queued):
  // the job asks for `m1`, the take carries no operatorModel, and the consumer calls the deployment's `h9`.
  const host = sqliteHost();
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { headers: { "content-type": "application/json" } })) as any;
  try {
    const agent = await PiAgent.open({
      host: host as never, sessionId: "s", systemPrompt: "be brief", model: { provider: "queue", id: "m1", contextWindow: 100_000 }, tools: [],
      toolHost: { async invoke() { throw new Error("no tool is offered"); } } as never,
      usageOwner: { tenantId: "t", agentId: "a" }, dispatch: async () => {},
    });
    await agent.say("hi");
    let out = await agent.step();
    for (let guard = 0; out.wakeInMs !== null || out.open > 0; guard++) {
      must(guard < 50, `the turn did not end: ${JSON.stringify(out)}`);
      const open = host.sql.exec("SELECT id FROM pi_model_jobs WHERE answer IS NULL").toArray()[0];
      if (open) {
        const id = String(open.id);
        const job = agent.takeJob(id) as { model: { id: string } };
        must(job.model.id === "m1", `control: the job asks for ${job.model.id}`);
        agent.deliver(id, await callQueuedModel({ DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk", HARNESS_MODEL: "h9" }, { ...job, operatorModel: null }, id));
      }
      out = await agent.step();
    }
    await agent.close();
    const keys = pendingUsage(host.sql as never, 0).filter((r) => r.resource === "model.tokens").map((r) => `${r.key}=${r.quantity}`);
    must(JSON.stringify(keys) === JSON.stringify(["h9:input=5", "h9:output=2"]), `pi085 metered ${JSON.stringify(keys)}`);
  } finally { globalThis.fetch = real; host.dispose(); }
});

await check("a `provider/model` name is sized by the model's own window", () => {
  must(contextWindowFor("deepseek/deepseek-flash") === contextWindowFor("deepseek-flash") && contextWindowFor("deepseek-flash") === 1_000_000, "prefix");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
