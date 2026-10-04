/**
 * Model providers: where the operator's account sends a model call, and with which credential. A provider
 * is deployment configuration, not code — one `MODEL_PROVIDERS` var (a JSON array) names each provider's
 * OpenAI-compatible base URL, the Worker secret holding its credential and the header that carries it, and
 * how its models are named. Adding one (OpenRouter, a vendor's own API) is an entry there and a secret,
 * with nothing here changing.
 *
 * A model choice is a pair: a provider and a model under it. The model is the provider's own name for it —
 * `deepseek-flash` at DeepSeek, `openai/gpt-5` at a gateway that routes by vendor — so the same model can
 * be reached through two providers and the name alone does not say which.
 *
 * A deployment without `MODEL_PROVIDERS` has one provider, derived from DEEPSEEK_BASE_URL and
 * DEEPSEEK_API_KEY, exactly as it called before providers existed.
 */

/**
 * The provider every choice stored before providers existed means, and the deployment's default (its
 * HARNESS_MODEL is served there). Those rows were all written when DeepSeek's API was the only place a
 * call could go, so a row with no provider is read as this one rather than as "whichever is listed first".
 */
export const DEFAULT_PROVIDER = "deepseek";

export interface ProviderConfig {
  id: string;
  /** OpenAI-compatible: `<baseUrl>/chat/completions` is called. https only. */
  baseUrl: string;
  /**
   * The provider's own credential: the NAME of a Worker secret, and the header it is sent in as
   * `Bearer <value>`. `authorization` is the usual API key; a gateway may want its own header
   * (`cf-aig-authorization`) and keep the vendors' keys itself. Absent: nothing of the provider's own is sent.
   */
  auth?: { secret: string; header: string };
  /**
   * How a model is named here. `model` (the default): a bare name, no `/`. `vendor/model`: the vendor
   * first, as a gateway that routes by vendor needs (Cloudflare AI Gateway's /compat refuses a bare name).
   */
  modelFormat?: ModelFormat;
  /**
   * A vendor key this deployment holds and passes through for models under one prefix, as `Authorization`:
   * `{ "deepseek/": "DEEPSEEK_API_KEY" }`. A model under no listed prefix is sent with no `Authorization`
   * at all, so a gateway uses the key it stores for that vendor — a key in the request would take
   * precedence over the stored one and reach the other vendor.
   */
  passKeys?: Record<string, string>;
}

export type ModelFormat = "model" | "vendor/model";
const FORMATS: readonly ModelFormat[] = ["model", "vendor/model"];

/** A choice of model: which provider, and the model under it. */
export interface ModelChoice { provider: string; model: string }

/** The providers a deployment declares, with the secret values they reference; or why the declaration was refused. */
export interface ModelProviders {
  configs: ProviderConfig[];
  /** The referenced secrets' values, by name, as the environment holds them. Nothing else from the environment. */
  secrets: Record<string, string | undefined>;
  /** Set when MODEL_PROVIDERS was refused: then there are no providers, and every call says why. */
  error?: string;
}

/** What may be said about a provider to an admin: no secret value, only whether each is set. */
export interface ProviderStatus {
  id: string;
  endpoint: string;
  modelFormat: ModelFormat;
  available: boolean;
  /** Secrets the provider references that the environment does not hold. Names only. */
  missing: string[];
}

// A secret is named the way a Worker binding is. A credential pasted where its name belongs has a shape
// this refuses (lower case, `-`, a prefix like `sk-`), so it is not carried around as a "name".
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const HEADER = /^[a-z][a-z0-9-]{0,63}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,127}$/;

/**
 * Check a MODEL_PROVIDERS value (the JSON text, or the array wrangler hands over when the var is an
 * object) and return its entries. Throws with the first reason it is refused. Unknown fields are
 * refused rather than ignored: a field named `key` or `token` would be a credential in plain config.
 */
export function parseProviders(raw: unknown): ProviderConfig[] {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { throw new Error("MODEL_PROVIDERS is not JSON"); }
  }
  if (!Array.isArray(v) || v.length === 0) throw new Error("MODEL_PROVIDERS is a non-empty array of providers");
  const seen = new Set<string>();
  const out: ProviderConfig[] = [];
  for (const [i, e] of v.entries()) {
    const at = `MODEL_PROVIDERS[${i}]`;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`${at} is not an object`);
    const o = e as Record<string, unknown>;
    const extra = Object.keys(o).find((k) => !["id", "baseUrl", "auth", "modelFormat", "passKeys"].includes(k));
    if (extra) throw new Error(`${at} has an unknown field ${extra}`);
    if (typeof o.id !== "string" || !PROVIDER_ID.test(o.id)) throw new Error(`${at}.id is a lower-case name`);
    if (seen.has(o.id)) throw new Error(`${at}.id ${o.id} is declared twice`);
    seen.add(o.id);
    const p: ProviderConfig = { id: o.id, baseUrl: httpsUrl(o.baseUrl, `${o.id}.baseUrl`) };
    if (o.auth !== undefined) {
      const a = o.auth as Record<string, unknown>;
      if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some((k) => k !== "secret" && k !== "header")) {
        throw new Error(`${o.id}.auth is { secret, header }`);
      }
      p.auth = { secret: secretName(a.secret, `${o.id}.auth.secret`), header: headerName(a.header, `${o.id}.auth.header`) };
    }
    if (o.modelFormat !== undefined) {
      if (!FORMATS.includes(o.modelFormat as ModelFormat)) throw new Error(`${o.id}.modelFormat is one of ${FORMATS.join(", ")}`);
      p.modelFormat = o.modelFormat as ModelFormat;
    }
    if (o.passKeys !== undefined) {
      const k = o.passKeys as Record<string, unknown>;
      if (!k || typeof k !== "object" || Array.isArray(k)) throw new Error(`${o.id}.passKeys maps a model prefix to a secret name`);
      // Both would be the `Authorization` header: the provider's own credential and a passed-through
      // vendor key cannot share it.
      if (p.auth?.header === "authorization") throw new Error(`${o.id} sends its own credential as authorization, so it cannot pass vendor keys there`);
      p.passKeys = {};
      for (const [prefix, name] of Object.entries(k)) {
        if (!prefix) throw new Error(`${o.id}.passKeys has an empty prefix`);
        p.passKeys[prefix] = secretName(name, `${o.id}.passKeys[${prefix}]`);
      }
    }
    out.push(p);
  }
  // Stored choices with no provider, and HARNESS_MODEL, are served there.
  if (!seen.has(DEFAULT_PROVIDER)) throw new Error(`MODEL_PROVIDERS must declare ${DEFAULT_PROVIDER}, the deployment's default provider`);
  return out;
}

/**
 * The deployment's providers, from its environment. MODEL_PROVIDERS when set; else the one provider a
 * deployment had before them, DeepSeek at DEEPSEEK_BASE_URL with DEEPSEEK_API_KEY. A refused declaration
 * is returned as `error`, not thrown: the object holding it still opens, and each call says what is wrong.
 */
export function providersFrom(env: Record<string, unknown>): ModelProviders {
  let configs: ProviderConfig[];
  try {
    configs = env.MODEL_PROVIDERS === undefined || env.MODEL_PROVIDERS === ""
      ? [{ id: DEFAULT_PROVIDER, baseUrl: String(env.DEEPSEEK_BASE_URL ?? ""), auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } }]
      : parseProviders(env.MODEL_PROVIDERS);
  } catch (e) {
    return { configs: [], secrets: {}, error: String((e as Error)?.message ?? e) };
  }
  const secrets: Record<string, string | undefined> = {};
  for (const name of configs.flatMap(secretsOf)) {
    const value = env[name];
    secrets[name] = typeof value === "string" && value ? value : undefined;
  }
  return { configs, secrets };
}

function secretsOf(p: ProviderConfig): string[] {
  return [...(p.auth ? [p.auth.secret] : []), ...Object.values(p.passKeys ?? {})];
}

export function providerStatus(ps: ModelProviders): ProviderStatus[] {
  return ps.configs.map((p) => {
    const missing = secretsOf(p).filter((n) => !ps.secrets[n]);
    return { id: p.id, endpoint: hostOf(p.baseUrl), modelFormat: p.modelFormat ?? "model", available: missing.length === 0, missing };
  });
}

/**
 * Why `model` is not a model this provider can be asked for, or null when it is. Shared by the admin's
 * write and the call itself, so a name refused at one is refused at the other.
 */
export function modelProblem(ps: ModelProviders, choice: ModelChoice): string | null {
  if (ps.error) return `the deployment's providers are misconfigured: ${ps.error}`;
  const p = ps.configs.find((c) => c.id === choice.provider);
  if (!p) return `unknown provider ${choice.provider}; this deployment has ${ps.configs.map((c) => c.id).join(", ")}`;
  if (!MODEL.test(choice.model)) return `${JSON.stringify(choice.model)} is not a model name`;
  const slash = choice.model.indexOf("/");
  if ((p.modelFormat ?? "model") === "vendor/model") {
    if (slash <= 0 || slash === choice.model.length - 1) return `a ${p.id} model is named vendor/model, like openai/gpt-5`;
  } else if (slash !== -1) {
    return `a ${p.id} model is a bare name, with no vendor/ prefix`;
  }
  return null;
}

/** The provider `choice` names, once the choice is one it can be asked for; throws why not. A missing secret is not checked here: it is the call's to refuse. */
export function providerFor(ps: ModelProviders, choice: ModelChoice): ProviderConfig {
  const problem = modelProblem(ps, choice);
  if (problem) throw new Error(problem);
  return ps.configs.find((c) => c.id === choice.provider)!;
}

/** The request a call to `choice` makes: its URL, the key sent as `Authorization` ("" sends none), and any other header. */
export function providerRequest(ps: ModelProviders, choice: ModelChoice):
  { baseUrl: string; apiKey: string; model: string; headers: Record<string, string> } {
  const p = providerFor(ps, choice);
  const missing = secretsOf(p).filter((n) => !ps.secrets[n]);
  if (missing.length) throw new Error(`provider ${p.id} is not available: ${missing.join(", ")} not set`);
  const headers: Record<string, string> = {};
  let apiKey = "";
  if (p.auth) {
    const value = ps.secrets[p.auth.secret]!;
    if (p.auth.header === "authorization") apiKey = value;
    else headers[p.auth.header] = `Bearer ${value}`;
  }
  // The longest matching prefix, so `openai/` and `openai/o` can name different keys.
  const prefix = Object.keys(p.passKeys ?? {}).filter((k) => choice.model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (prefix !== undefined) apiKey = ps.secrets[p.passKeys![prefix]!]!;
  return { baseUrl: p.baseUrl, apiKey, model: choice.model, headers };
}

function httpsUrl(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} is a URL`);
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`${what} is not a URL`); }
  // A credential goes wherever this points, so never in the clear.
  if (u.protocol !== "https:") throw new Error(`${what} must be https`);
  if (u.username || u.password) throw new Error(`${what} carries a credential; name a secret in auth instead`);
  return v.replace(/\/+$/, "");
}

function secretName(v: unknown, what: string): string {
  if (typeof v !== "string" || !SECRET_NAME.test(v)) throw new Error(`${what} names a Worker secret (like DEEPSEEK_API_KEY), never its value`);
  return v;
}

function headerName(v: unknown, what: string): string {
  if (typeof v !== "string" || !HEADER.test(v)) throw new Error(`${what} is a lower-case header name`);
  return v;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}
