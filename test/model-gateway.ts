/**
 * The deployment's model call through Cloudflare AI Gateway (cf/src/model-request.ts): the gateway's
 * token in its own header, DeepSeek's key only with a DeepSeek model, no key for a provider the
 * gateway holds one for, and a `provider/model` name sized by the model's own window.
 */
import { callQueuedModel, operatorModelRequest } from "../cf/src/model-request.ts";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { contextWindowFor } from "../src/model/context-windows.ts";
import { ModelResolver } from "../src/runtime/model-resolver.ts";
import { operatorRequest } from "../src/model/operator-request.ts";
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

await check("DeepSeek's key goes only with a DeepSeek model; the gateway token goes in its own header", () => {
  const direct = operatorModelRequest({ DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk", HARNESS_MODEL: "deepseek-flash" });
  must(direct.apiKey === "dk" && Object.keys(direct.headers).length === 0, JSON.stringify(direct));
  const viaGw = operatorModelRequest({ DEEPSEEK_BASE_URL: GW, DEEPSEEK_API_KEY: "dk", HARNESS_MODEL: "deepseek/deepseek-flash", AI_GATEWAY_TOKEN: "gt" });
  must(viaGw.apiKey === "dk" && viaGw.headers["cf-aig-authorization"] === "Bearer gt", JSON.stringify(viaGw));
  const other = operatorModelRequest({ DEEPSEEK_BASE_URL: GW, DEEPSEEK_API_KEY: "dk", HARNESS_MODEL: "anthropic/claude-sonnet-5", AI_GATEWAY_TOKEN: "gt" });
  must(other.apiKey === "" && other.model === "anthropic/claude-sonnet-5", `DeepSeek's key was sent for another provider: ${JSON.stringify(other)}`);
});

await check("the client sends the extra headers, and no authorization when it has no key", async () => {
  const seen: Array<Record<string, string>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init?: any) => {
    seen.push(Object.fromEntries(new Headers(init?.headers ?? {}).entries()));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { headers: { "content-type": "application/json" } });
  }) as any;
  try {
    await new OpenAiCompatibleModel({ baseUrl: GW, apiKey: "", model: "anthropic/claude-sonnet-5", headers: { "cf-aig-authorization": "Bearer gt" } }).complete([{ role: "user", content: "hi" }]);
    await new OpenAiCompatibleModel({ baseUrl: GW, apiKey: "dk", model: "deepseek/deepseek-flash" }).complete([{ role: "user", content: "hi" }]);
  } finally { globalThis.fetch = real; }
  must(seen[0]!["cf-aig-authorization"] === "Bearer gt" && !("authorization" in seen[0]!), JSON.stringify(seen[0]));
  must(seen[1]!.authorization === "Bearer dk", JSON.stringify(seen[1]));
});

await check("an agent bound to the operator's model is called the same way: no DeepSeek key to another provider, the gateway token sent", async () => {
  const op = { baseUrl: GW, apiKey: "dk", model: "deepseek/deepseek-flash", gatewayToken: "gt" };
  const store: any = { getModelBinding: async () => ({ provider: "openai-compatible", baseUrl: GW, model: "anthropic/claude-sonnet-5", secretRef: "operator:model" }) };
  const secrets: any = { resolve: async () => { throw new Error("the operator's binding was resolved as a plain key"); } };
  const resolver = new ModelResolver(store, secrets, { ref: "operator:model", request: (b) => operatorRequest({ ...op, baseUrl: b.baseUrl }, b.model) });
  const seen: Array<Record<string, string>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init?: any) => {
    seen.push({ ...Object.fromEntries(new Headers(init?.headers ?? {}).entries()), model: JSON.parse(init.body).model });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { headers: { "content-type": "application/json" } });
  }) as any;
  try { await (await resolver.resolve({ tenantId: "t", agentId: "a" })).complete([{ role: "user", content: "hi" }]); }
  finally { globalThis.fetch = real; }
  must(seen[0]?.model === "anthropic/claude-sonnet-5" && !("authorization" in seen[0]!) && seen[0]!["cf-aig-authorization"] === "Bearer gt", JSON.stringify(seen));
});

await check("the queue consumer's answer names the model it called, which the ledger meters: the deployment's for a binding that spends no operator credential, the binding's when it does", async () => {
  const env = { DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk", HARNESS_MODEL: "deepseek-flash" };
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init?: any) => {
    sent.push(JSON.parse(init.body).model);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } });
  }) as any;
  const job = (operatorModel: string | null) => ({
    model: { api: "offloaded", provider: "queue", id: "bound-model" }, operatorModel,
    context: { systemPrompt: "be brief", messages: [{ role: "user", content: "hi", timestamp: 0 }] },
  });
  let own, operator;
  try {
    own = await callQueuedModel(env, job(null), "mj_1");
    operator = await callQueuedModel(env, job("deepseek-pro"), "mj_2");
  } finally { globalThis.fetch = real; }
  must(sent[0] === "deepseek-flash" && own.model === "deepseek-flash", `own credential: called ${sent[0]}, answer names ${own.model}`);
  must(sent[1] === "deepseek-pro" && operator.model === "deepseek-pro", `operator binding: called ${sent[1]}, answer names ${operator.model}`);
  must(own.provider === "queue" && own.jobId === "mj_1" && own.usage.input === 5, `the rest of the answer: ${JSON.stringify(own)}`);
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
