/**
 * Model providers as deployment configuration (src/model/providers.ts): what a MODEL_PROVIDERS declaration
 * may say and what it is refused for, that a new provider is config plus a secret, that a provider's status
 * carries no secret, and that the declarations this repository ships are ones the Worker accepts.
 */
import { readFile } from "node:fs/promises";
import { DEFAULT_PROVIDER, modelProblem, parseProviders, providerRequest, providersFrom, providerStatus } from "../src/model/providers.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const DEEPSEEK = { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } };
const CLOUDFLARE = { id: "cloudflare", baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
  auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } };

function refusal(raw: unknown): string {
  try { parseProviders(raw); return ""; } catch (e) { return String((e as Error).message); }
}

await check("a declaration is refused for duplicate ids, plain http, a secret value where its name belongs, unknown fields, and a missing default", () => {
  for (const [raw, expect, why] of [
    [[DEEPSEEK, { ...CLOUDFLARE, id: "deepseek" }], /declared twice/, "a duplicate id"],
    [[{ ...DEEPSEEK, baseUrl: "http://api.deepseek.com" }], /must be https/, "plain http"],
    [[{ ...DEEPSEEK, baseUrl: "https://user:pw@api.deepseek.com" }], /carries a credential/, "a credential in the URL"],
    [[{ ...DEEPSEEK, auth: { secret: "sk-0123456789abcdef", header: "authorization" } }], /names a Worker secret/, "a key as the secret's name"],
    [[DEEPSEEK, { ...CLOUDFLARE, passKeys: { "deepseek/": "sk-live-abc" } }], /names a Worker secret/, "a key as a pass-through secret's name"],
    [[{ ...DEEPSEEK, auth: { secret: "AKIAIOSFODNN7EXAMPLE", header: "authorization" } }], /names a Worker secret/, "an upper-case credential as the secret's name"],
    [[{ ...DEEPSEEK, auth: { secret: "KEY_20260101", header: "authorization" } }], /names a Worker secret/, "a digit run as the secret's name"],
    [[DEEPSEEK, { ...CLOUDFLARE, passKeys: { "deepseek": "DEEPSEEK_API_KEY" } }], /one vendor and its slash/, "a pass-through prefix without its slash"],
    [[DEEPSEEK, { ...CLOUDFLARE, passKeys: { "openai/o": "DEEPSEEK_API_KEY" } }], /one vendor and its slash/, "a pass-through prefix reaching into the model"],
    [[DEEPSEEK, { ...CLOUDFLARE, passKeys: { "../": "DEEPSEEK_API_KEY" } }], /one vendor and its slash/, "a .. pass-through prefix"],
    [[{ ...DEEPSEEK, apiKey: "sk-0123" }], /unknown field apiKey/, "a key in a field of its own"],
    [[{ ...DEEPSEEK, auth: { secret: "DEEPSEEK_API_KEY", header: "authorization", value: "sk" } }], /auth is \{ secret, header \}/, "a value beside the secret's name"],
    [[{ ...DEEPSEEK, passKeys: { "x/": "X_KEY" } }], /cannot pass vendor keys/, "a pass-through key and the provider's own credential in one header"],
    [[{ ...DEEPSEEK, modelFormat: "vendor:model" }], /modelFormat is one of/, "an unknown model format"],
    [[CLOUDFLARE], /must declare deepseek/, "no default provider"],
    [[], /non-empty array/, "nothing"],
    ["[{", /not JSON/, "text that is not JSON"],
  ] as const) {
    const r = refusal(raw);
    must((expect as RegExp).test(r), `${why}: ${r || "accepted"}`);
  }
  // Text and the parsed form wrangler hands over for an object var are the same declaration.
  must(parseProviders(JSON.stringify([DEEPSEEK, CLOUDFLARE])).length === 2 && parseProviders([DEEPSEEK, CLOUDFLARE]).length === 2, "a valid declaration was refused");
});

await check("a refused declaration leaves no providers and says why, rather than throwing where the object opens", () => {
  const ps = providersFrom({ MODEL_PROVIDERS: "[{", DEEPSEEK_API_KEY: "dk", DEEPSEEK_BASE_URL: "https://api.deepseek.com" });
  must(ps.configs.length === 0 && /not JSON/.test(ps.error ?? ""), JSON.stringify(ps));
  must(/misconfigured: MODEL_PROVIDERS is not JSON/.test(modelProblem(ps, { provider: "deepseek", model: "deepseek-flash" }) ?? ""), "a call under a refused declaration was allowed");
});

await check("a new provider is configuration and one secret: OpenRouter is called with its own key and nothing of DeepSeek's or the gateway's", () => {
  const env = {
    MODEL_PROVIDERS: JSON.stringify([DEEPSEEK, CLOUDFLARE,
      { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", auth: { secret: "OPENROUTER_API_KEY", header: "authorization" }, modelFormat: "vendor/model" }]),
    DEEPSEEK_API_KEY: "dk", AI_GATEWAY_TOKEN: "gt", OPENROUTER_API_KEY: "ork",
  };
  const ps = providersFrom(env);
  const r = providerRequest(ps, { provider: "openrouter", model: "openai/gpt-5" });
  must(r.baseUrl === "https://openrouter.ai/api/v1" && r.apiKey === "ork" && r.model === "openai/gpt-5" && Object.keys(r.headers).length === 0, JSON.stringify(r));
  must(modelProblem(ps, { provider: "openrouter", model: "gpt-5" }) !== null, "a bare name was accepted under a vendor/model provider");
  // Without its secret it is declared and unavailable; the others are untouched.
  const { OPENROUTER_API_KEY: _, ...without } = env;
  const st = providerStatus(providersFrom(without));
  must(st.map((p) => `${p.id}:${p.available}`).join() === "deepseek:true,cloudflare:true,openrouter:false", JSON.stringify(st));
});

await check("a pass-through key goes with the model's own vendor segment, exactly and case-sensitively, and with no other", () => {
  const ps = providersFrom({
    MODEL_PROVIDERS: [DEEPSEEK, { ...CLOUDFLARE, passKeys: { "deepseek/": "DEEPSEEK_API_KEY", "openai/": "OPENAI_KEY" } }],
    DEEPSEEK_API_KEY: "dk", AI_GATEWAY_TOKEN: "gt", OPENAI_KEY: "ok",
  });
  const key = (model: string) => providerRequest(ps, { provider: "cloudflare", model }).apiKey;
  must(key("openai/gpt-5") === "ok" && key("deepseek/deepseek-flash") === "dk" && key("anthropic/claude-sonnet-5") === "", "the wrong key travelled");
  for (const model of ["deepseek-evil/x", "DeepSeek/deepseek-flash", "deepseekx/y"]) {
    must(key(model) === "", `DeepSeek's key travelled with ${model}`);
  }
});

await check("a vendor/model name with an empty, . or .. segment, a leading or trailing slash, whitespace or a control character is refused, and nothing is sent", () => {
  const ps = providersFrom({ MODEL_PROVIDERS: [DEEPSEEK, CLOUDFLARE], DEEPSEEK_API_KEY: "dk", AI_GATEWAY_TOKEN: "gt" });
  for (const model of ["deepseek/../openai/x", "deepseek/./x", "openai//gpt-5", "/openai/gpt-5", "openai/gpt-5/", "openai/", "openai/gpt 5", "openai/gpt-5\n", "openai/gpt\u00005", "openai/gpt\t5", "../x"]) {
    must(modelProblem(ps, { provider: "cloudflare", model }) !== null, `${JSON.stringify(model)} was accepted`);
    let sent = true;
    try { providerRequest(ps, { provider: "cloudflare", model }); } catch { sent = false; }
    must(!sent, `${JSON.stringify(model)} built a request`);
  }
  must(modelProblem(ps, { provider: "cloudflare", model: "workers-ai/@cf/meta/llama-3.1-8b" }) === null, "a deeper vendor path was refused");
  must(modelProblem(ps, { provider: "deepseek", model: ".." }) !== null, "a bare .. was accepted");
});

await check("an operator model without providers (built by hand) is refused with a reason, not a TypeError", () => {
  const ps = undefined as never;
  must(/no model providers were given/.test(modelProblem(ps, { provider: "deepseek", model: "m" }) ?? ""), "no reason");
  let msg = "";
  try { providerRequest(ps, { provider: "deepseek", model: "m" }); } catch (e) { msg = String(e); }
  must(/no model providers were given/.test(msg) && !/TypeError/.test(msg), msg);
});

await check("a provider's status names its secrets' absence, never their values", () => {
  const st = providerStatus(providersFrom({ MODEL_PROVIDERS: [DEEPSEEK, CLOUDFLARE], DEEPSEEK_API_KEY: "dk-secret-value" }));
  const text = JSON.stringify(st);
  must(!text.includes("dk-secret-value"), `a secret value is in the status: ${text}`);
  must(st[0]!.available && !st[1]!.available && st[1]!.missing.join() === "AI_GATEWAY_TOKEN" && st[1]!.endpoint === "gateway.ai.cloudflare.com", text);
});

/** A wrangler config's `vars`, with whole-line comments dropped (the files carry no other kind). */
async function varsOf(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(new URL(`../cf/${file}`, import.meta.url), "utf8");
  return JSON.parse(text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")).vars;
}

await check("the preview declaration is accepted, offers cloudflare under vendor/model, and holds no secret; production declares none yet", async () => {
  const preview = await varsOf("wrangler.preview.jsonc");
  const configs = parseProviders(preview.MODEL_PROVIDERS);
  must(configs.map((p) => p.id).join() === `${DEFAULT_PROVIDER},cloudflare`, JSON.stringify(configs));
  const cf = configs.find((p) => p.id === "cloudflare")!;
  must(/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[0-9a-f]{32}\/antiproton-preview\/compat$/.test(cf.baseUrl), cf.baseUrl);
  must(cf.modelFormat === "vendor/model" && cf.auth?.header === "cf-aig-authorization" && JSON.stringify(cf.passKeys) === '{"deepseek/":"DEEPSEEK_API_KEY"}', JSON.stringify(cf));
  // The default stays where the benchmark and /ui/whoami expect it.
  must(configs[0]!.baseUrl === preview.DEEPSEEK_BASE_URL && preview.HARNESS_MODEL === "deepseek-flash", "the preview default moved");
  const production = await varsOf("wrangler.jsonc");
  must(production.MODEL_PROVIDERS === undefined && production.DEEPSEEK_BASE_URL === "https://api.deepseek.com", "production's providers changed in this config");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
