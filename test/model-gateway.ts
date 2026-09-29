/**
 * The deployment's model call through Cloudflare AI Gateway (cf/src/model-request.ts): the gateway's
 * token in its own header, DeepSeek's key only with a DeepSeek model, no key for a provider the
 * gateway holds one for, and a `provider/model` name sized by the model's own window.
 */
import { operatorModelRequest } from "../cf/src/model-request.ts";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { contextWindowFor } from "../src/model/context-windows.ts";

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

await check("a `provider/model` name is sized by the model's own window", () => {
  must(contextWindowFor("deepseek/deepseek-flash") === contextWindowFor("deepseek-flash") && contextWindowFor("deepseek-flash") === 1_000_000, "prefix");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
