/**
 * Model calls paid with the agent owner's own credential. The operator's account (src/model/providers.ts) is
 * deployment configuration; this is the other case, where the owner pastes a key from their own account with a
 * vendor and the agent's calls are made, and billed, there.
 *
 * Which vendors can be reached this way is code, not configuration: each one is a fixed endpoint, a fixed list of
 * models, and terms of use that decide what we may send (Kimi forbids presenting the caller as another client, so
 * every request names antiproton in its User-Agent). An owner names a provider id and one of its model ids, never
 * a URL, so a pasted key can only ever go to the vendor that issued it.
 *
 * The binding names the provider in its reference (`user:model:<provider>`), as an operator binding does
 * (`operator:model:<id>`, src/model/operator-request.ts). The key itself is sealed in the agent's own object under
 * MODEL_KEY_PREFIX (src/runtime/secrets.ts) and opened only by the queue consumer for the call it makes
 * (`callQueuedModel`, cf/src/model-request.ts). A binding of this kind is never served by the operator's key: when
 * the key is missing, refused or over its rate, the call is answered with why and nothing else is tried.
 *
 * OpenAI's "Sign in with ChatGPT" is meant to land here too: an entry whose key is an OAuth grant rather than a
 * pasted one, resolved at the same point.
 */

import { redacted } from "./openai-compatible.ts";

export interface UserKeyModel { id: string; label: string; contextWindow: number }

export interface UserKeyProvider {
  id: string;
  /** What the owner sees: the vendor's own product name. */
  label: string;
  /** OpenAI-compatible: `<baseUrl>/chat/completions` is called with `authorization: Bearer <key>`. */
  baseUrl: string;
  models: readonly UserKeyModel[];
  /** Where the owner makes the key, said on the form. */
  keyFrom: string;
}

/**
 * Every request on an owner's key says it comes from antiproton. Kimi's terms forbid a third-party client
 * presenting itself as Kimi CLI or another coding agent; an honest name is also what a vendor's support needs
 * to tell our traffic apart.
 */
export const USER_KEY_USER_AGENT = "antiproton/0.1 (+https://antiproton.ai)";

/**
 * Kimi Code: the key an owner creates in the Kimi Code console, at its OpenAI-compatible endpoint. The model ids
 * and windows are pi-ai's `kimi-coding` catalogue (node_modules/@earendil-works/pi-ai/dist/models.generated.js),
 * which reaches the Anthropic-format endpoint at /coding; that the same ids answer at /coding/v1 is the vendor's
 * documentation, not a call made from here.
 */
export const USER_KEY_PROVIDERS: readonly UserKeyProvider[] = [
  {
    id: "kimi-code",
    label: "Kimi Code",
    baseUrl: "https://api.kimi.com/coding/v1",
    keyFrom: "the Kimi Code console (API keys)",
    models: [
      { id: "kimi-for-coding", label: "Kimi for Coding", contextWindow: 262_144 },
      { id: "kimi-for-coding-highspeed", label: "Kimi for Coding HighSpeed", contextWindow: 262_144 },
      { id: "k3", label: "Kimi K3", contextWindow: 1_048_576 },
      { id: "k3-256k", label: "Kimi K3-256K", contextWindow: 262_144 },
    ],
  },
];

/**
 * The vendors this deployment lets an owner run on their own key: the ids named in its `USER_KEY_PROVIDERS` setting,
 * comma-separated, that are also in the catalogue above. Absent or empty is none. A vendor in the catalogue is code
 * that can call it; whether the call can work from where this deployment runs is not, and is learned per deployment:
 * Kimi Code's edge answered a request from a Cloudflare Worker with an HTML 403 block page where the same request
 * from an ordinary server got a JSON 401 (measured on preview, 2026-11-05). So the switch is off unless named, and an
 * id that is not named is not offered, not stored, and not called, even for an agent already bound to it.
 */
export function enabledUserKeyProviders(setting: unknown): readonly UserKeyProvider[] {
  const ids = typeof setting === "string" ? setting.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return USER_KEY_PROVIDERS.filter((p) => ids.includes(p.id));
}

export function userKeyProviderEnabled(setting: unknown, id: string): boolean {
  return enabledUserKeyProviders(setting).some((p) => p.id === id);
}

/** Why a key for `provider` cannot be stored or used on this deployment, said to the owner. */
export function userKeyOffProblem(provider: string): string {
  return `own keys for ${userKeyProvider(provider)?.label ?? provider} are switched off on this deployment`;
}

export const USER_MODEL_REF = "user:model";

export function userRefFor(provider: string): string { return `${USER_MODEL_REF}:${provider}`; }

/** The provider a user-key binding's reference names, or null when the reference is not one. */
export function userProviderOfRef(ref: string | null | undefined): string | null {
  if (typeof ref !== "string" || !ref.startsWith(`${USER_MODEL_REF}:`)) return null;
  const id = ref.slice(USER_MODEL_REF.length + 1);
  return USER_KEY_PROVIDERS.some((p) => p.id === id) ? id : null;
}

export function userKeyProvider(id: string): UserKeyProvider | null {
  return USER_KEY_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** The name the key is sealed under in the agent's object, after MODEL_KEY_PREFIX. One key per provider. */
export function modelKeyName(provider: string): string { return provider; }

/** Why `provider`/`model` cannot be bound with an owner's key, or null. */
export function userChoiceProblem(provider: string, model: string): string | null {
  const p = userKeyProvider(provider);
  if (!p) return `no provider ${JSON.stringify(provider.slice(0, 64))} takes your own key; the providers are ${USER_KEY_PROVIDERS.map((x) => x.id).join(", ")}`;
  if (!p.models.some((m) => m.id === model)) return `${p.label} has no model ${JSON.stringify(model.slice(0, 64))}; its models are ${p.models.map((m) => m.id).join(", ")}`;
  return null;
}

/** Longest key accepted. Kimi's are far shorter; this bounds what is sealed, not what a vendor issues. */
export const USER_KEY_MAX_CHARS = 512;

/** Why `key` is not a key, or null. Never repeats the value. */
export function userKeyProblem(key: unknown): string | null {
  if (typeof key !== "string" || !key.trim()) return "paste the API key";
  if (key.length > USER_KEY_MAX_CHARS) return `that is longer than ${USER_KEY_MAX_CHARS} characters, so it is not an API key`;
  // A header value: a newline or a space inside would be refused by fetch, or worse, split the header.
  if (/[\s\u0000-\u001f\u007f]/.test(key.trim())) return "an API key has no spaces or line breaks in it; paste the key alone";
  return null;
}

/** The request a call on the owner's key makes: the provider's own endpoint, the key as `authorization`, and our User-Agent. */
export function userKeyRequest(provider: string, model: string, key: string):
  { baseUrl: string; apiKey: string; model: string; headers: Record<string, string> } {
  const problem = userChoiceProblem(provider, model);
  if (problem) throw new Error(problem);
  return { baseUrl: userKeyProvider(provider)!.baseUrl, apiKey: key, model, headers: { "user-agent": USER_KEY_USER_AGENT } };
}

/** The window of a model reached with an owner's key, or undefined for any other. */
export function userKeyContextWindow(model: string): number | undefined {
  for (const p of USER_KEY_PROVIDERS) {
    const m = p.models.find((x) => x.id === model);
    if (m) return m.contextWindow;
  }
  return undefined;
}

/**
 * How many provider attempts one agent may make on its owner's key in a minute. An attempt is each time the queue
 * consumer opens the key: a call, and each queue retry of it after a 5xx, a timeout or a network error, counts again
 * (a 429 ends the turn rather than going back to the queue). Counting attempts, not jobs, is deliberate: it is what
 * the vendor sees, and a run of retries is what this exists to bound. The vendor bills the tokens, but each attempt
 * still runs our queue and our object. Counted in the agent's object, where the key is opened, so it is exact
 * without a shared counter.
 */
export const USER_KEY_CALLS_PER_MINUTE = 60;

/**
 * The fixed texts a user-key answer fails with (`errorMessage`). Both engines' harnesses scan that string to decide
 * whether to retry a failed turn (pi-ai `isRetryableAssistantError`), so none of these holds a pattern it retries on
 * ("429", "rate limit", "timeout", "refused" after "connection"): the turn ends once. What happened and what to do
 * is in `providerError`, which no retry check reads.
 */
export const USER_KEY_ERRORS = {
  refused: "your own model key was not accepted; see the turn's error",
  missing: "no own model key is stored for this agent; see the turn's error",
  limited: "your own model account is over its plan's limit (out of budget); see the turn's error",
  paced: "too many attempts on your own model key this minute (out of budget); see the turn's error",
  off: "own model keys for this provider are switched off on this deployment; see the turn's error",
  edge: "the provider's edge turned the request away before it reached your key; see the turn's error",
} as const;

/** The owner-facing sentence for each failure, carried in `providerError`. */
export function userKeyTurnError(kind: keyof typeof USER_KEY_ERRORS, provider: string, status?: number): string {
  const label = userKeyProvider(provider)?.label ?? provider;
  switch (kind) {
    case "refused":
      return `${label} refused your API key${status ? ` (HTTP ${status})` : ""}. It may have been revoked or expired: create a new key in ${userKeyProvider(provider)?.keyFrom ?? "the provider's console"} and reconnect it on this agent's model card. Until then this agent makes no model calls; nothing falls back to another account.`;
    case "missing":
      return `This agent is set to run on your own ${label} key, and none is stored, or it was refused before. Reconnect it on this agent's model card, or switch the agent back to the deployment's model.`;
    case "limited":
      return `${label} says your account is over its rate or plan limit${status ? ` (HTTP ${status})` : ""}. Wait for it to reset, or raise the plan with ${label}; this agent does not fall back to another account.`;
    case "paced":
      return `This agent made more than ${USER_KEY_CALLS_PER_MINUTE} attempts at model calls on your ${label} key in the last minute (retries of a failed call count too), the most it may. Send the next message in a minute.`;
    case "off":
      return `Own keys for ${label} are switched off on this deployment, so this agent made no model call. Nothing fell back to another account. Remove your key on this agent's model card to run it on the deployment's model.`;
    case "edge":
      return `${label}'s network edge refused this request${status ? ` (HTTP ${status}, not a JSON answer)` : " (not a JSON answer)"}: this is not about your key, which is kept and tried again on the next message. Nothing fell back to another account.`;
  }
}

/**
 * The response headers that tell a block by something in front of the vendor (a CDN or WAF page) from the vendor's
 * own answer. Only these are ever logged: never a request header, and never the rest of the response's.
 */
const EDGE_HEADERS = ["server", "cf-ray", "cf-mitigated", "x-amz-cf-id", "via"] as const;
/** How much of a failed answer's body is logged: enough to tell `<!DOCTYPE html>`, `error code:` and `{` apart. */
const BODY_HEAD_CHARS = 40;

/**
 * The `model_key.http` log line for one non-2xx answer on an owner's key: status, content type, body length and its
 * first characters, EDGE_HEADERS, and whether an edge's error-code marker opens the body. The body head and every
 * header value are redacted of `secrets` (the key and the request's headers) and of anything shaped like a key
 * before they are cut, so a vendor that echoes the key back does not put it in the log.
 */
export function userKeyHttpLine(a: { status: number; headers: Headers; body: string }, secrets: string[]): Record<string, unknown> {
  const clean = (v: string, n: number) => redacted(v, secrets).replace(/\s+/g, " ").trim().slice(0, n);
  const headers: Record<string, string> = {};
  for (const h of EDGE_HEADERS) {
    const v = a.headers.get(h);
    if (v !== null) headers[h] = clean(v, 120);
  }
  return {
    status: a.status,
    contentType: clean(a.headers.get("content-type") ?? "", 120) || null,
    bodyBytes: new TextEncoder().encode(a.body).length,
    bodyHead: clean(a.body, BODY_HEAD_CHARS),
    edgeErrorCode: /cf-error-code|error code:/i.test(a.body.slice(0, 200)),
    headers,
  };
}
