/**
 * A second model for an agent's first turn, when the model it is bound to does not answer in time.
 *
 * Why only the first turn: it is the one a person waits on with nothing yet to show for the agent, and the
 * onboarding agent's first answer is what a new user judges the product by. A primary that is down there used to
 * hold the turn for as long as the queue would redeliver: a thrown timeout sends the message back (max_retries 3 in
 * cf/wrangler.jsonc), each delivery waiting out MODEL_CALL_DEADLINE_MS, so a turn could hang for about 40 minutes
 * before failing.
 *
 * What it does, per call and never more: the job of a call in the first turn of an agent made with `firstTurn`
 * (POST /provision/agents, src/runtime/prewarm.ts) whose binding is the operator's DeepSeek model is marked by its
 * object (`AgentRuntime.takeJob`, cf/src/runtime.ts). The queue consumer calls the primary under `primaryS`; on a
 * 5xx or 429 (after the client's own in-call retries, which the same limit bounds), a transport failure, or the
 * limit, it calls the fallback once, for at most `fallbackS` (`callQueuedModel`,
 * cf/src/model-request.ts). A refusal of the request itself (400, 401, 403, 404, 422: `ModelRequestRefused`) is the
 * same request on any model and is never sent to the fallback. The agent's binding, its lock and the owner's picker
 * are untouched: the next call starts at the primary again.
 *
 * When neither answers, the job is answered with a fixed "model busy" error rather than thrown (`MODEL_BUSY_ERROR`),
 * so the queue does not redeliver it, and the agent's object re-dispatches the same turn on its own schedule,
 * `retryAfterS` after each such answer, then gives up (src/runtime/busy-retry.ts). What Raft is shown is the
 * `errorClass` of the failed call's "Bridge fatal" activity event (src/runtime/activity.ts): `model_busy: …` while a
 * retry is scheduled and `model_unavailable: …` once it has given up.
 *
 * Configuration is MODEL_FALLBACK, a JSON object; absent or empty is off:
 *
 *   {"to":"gpt-5.6-luna","scope":"firstTurn","primaryS":60,"fallbackS":50,"retryAfterS":[120,300]}
 *
 * `to` is an id of USER_MODELS (src/model/user-models.ts) that is offered now, so the fallback names a provider and a
 * model the deployment already declares and can call; `fallbackS` (default 50) caps the fallback's own call, and the two
 * together are at most FALLBACK_TOTAL_MAX_S, 110 s. A
 * declaration that is refused is off, and the reason is kept for the admin (`/admin/models`, `modelFallbackError`), as
 * USER_MODELS keeps its own: a wrong value must not stop the Worker opening, and must not half-enable the path. It is
 * deployment configuration and never part of the provision payload, which a re-POST must repeat exactly.
 */
import { isDeepSeekModel } from "./chat-request-shape.ts";
import type { ModelProviders } from "./providers.ts";
import { userModelsFrom } from "./user-models.ts";
import { MODEL_CALL_DEADLINE_MS, ModelCallTimedOut, ModelHttpError, ModelRequestRefused } from "./openai-compatible.ts";

/** The one scope there is. Named in the config so a later scope is a new value, not a changed meaning. */
export type FallbackScope = "firstTurn";

export interface ModelFallback {
  /** The USER_MODELS id named, and the provider and model it stands for. */
  to: string;
  provider: string;
  model: string;
  scope: FallbackScope;
  /** The primary call's whole time, its in-call retries included. */
  primaryMs: number;
  /** The most the fallback call may take. */
  fallbackMs: number;
  /** After the n-th busy answer in a row, the turn is re-dispatched after the n-th of these; past the last, given up. */
  retryAfterMs: number[];
}

/**
 * The most the primary and the fallback may take together, in seconds. Below pi085's REDELIVERY_MS (120 s,
 * src/runtime/pi-agent.ts): a job dispatched longer ago than that with no answer is sent to the queue again
 * (`PiAgent.dispatchPending`), and its take does not refuse a second consumer, so a call still running past it is
 * made a second time, at both providers, and paid twice. Ten seconds are left for the take, the delivery and a
 * pass's lateness. test/model-fallback.ts holds the two numbers together.
 */
export const FALLBACK_TOTAL_MAX_S = 110;
/** The fallback's own limit when the config names none: what is left of FALLBACK_TOTAL_MAX_S after a 60 s primary. */
export const FALLBACK_DEFAULT_S = 50;

const FIELDS = ["to", "scope", "primaryS", "fallbackS", "retryAfterS"];
/** Whole seconds, at least 1, at most the two limits' joint bound. */
const seconds = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= FALLBACK_TOTAL_MAX_S;

/**
 * Check a MODEL_FALLBACK value (JSON text, or the object wrangler hands over) against the deployment's offered owner
 * models, and return it. Throws with the first reason it is refused. Unknown fields are refused, as MODEL_PROVIDERS and
 * USER_MODELS refuse them: a field this does not read is a field someone believed did something.
 */
export function parseModelFallback(raw: unknown, offered: ReadonlyArray<{ id: string; provider: string; model: string }>): ModelFallback {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { throw new Error("MODEL_FALLBACK is not JSON"); }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("MODEL_FALLBACK is an object { to, scope, primaryS, fallbackS?, retryAfterS }");
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !FIELDS.includes(k));
  if (extra) throw new Error(`MODEL_FALLBACK has an unknown field ${extra}`);
  if (o.scope !== "firstTurn") throw new Error('MODEL_FALLBACK.scope is "firstTurn", the only scope there is');
  if (typeof o.to !== "string" || !o.to) throw new Error("MODEL_FALLBACK.to is the id of a USER_MODELS option");
  const option = offered.find((m) => m.id === o.to);
  if (!option) throw new Error(`MODEL_FALLBACK.to ${o.to} is not a USER_MODELS option offered now (declared, with its provider's secret set)`);
  // The primary is a DeepSeek model (the scope's binding); a fallback that is one too would fail with it.
  if (isDeepSeekModel(option.model)) throw new Error(`MODEL_FALLBACK.to ${o.to} is a DeepSeek model, the primary it is meant to stand in for`);
  if (!seconds(o.primaryS)) throw new Error(`MODEL_FALLBACK.primaryS is whole seconds from 1 to ${FALLBACK_TOTAL_MAX_S}`);
  if (o.fallbackS !== undefined && !seconds(o.fallbackS)) throw new Error(`MODEL_FALLBACK.fallbackS is whole seconds from 1 to ${FALLBACK_TOTAL_MAX_S}`);
  const fallbackS = (o.fallbackS as number | undefined) ?? FALLBACK_DEFAULT_S;
  // Both calls run in one queue invocation, and must end before the job is sent again (FALLBACK_TOTAL_MAX_S) and
  // inside the call's own deadline.
  const total = (o.primaryS as number) + fallbackS;
  if (total > FALLBACK_TOTAL_MAX_S || total * 1000 > MODEL_CALL_DEADLINE_MS) {
    throw new Error(`MODEL_FALLBACK.primaryS and fallbackS (default ${FALLBACK_DEFAULT_S}) add up to ${total} s, more than ${FALLBACK_TOTAL_MAX_S} s: past it the job is sent to the queue again while it is still being called`);
  }
  if (!Array.isArray(o.retryAfterS) || o.retryAfterS.length > 10 || !o.retryAfterS.every((s) => Number.isSafeInteger(s) && s >= 1 && s <= 86_400)) {
    throw new Error("MODEL_FALLBACK.retryAfterS is a list of at most 10 delays, whole seconds from 1 to 86400");
  }
  return {
    to: option.id, provider: option.provider, model: option.model, scope: "firstTurn",
    primaryMs: (o.primaryS as number) * 1000, fallbackMs: fallbackS * 1000,
    retryAfterMs: (o.retryAfterS as number[]).map((s) => s * 1000),
  };
}

/** The deployment's fallback: null when MODEL_FALLBACK is absent or empty, or refused (then `error` says why). */
export function modelFallbackFrom(env: Record<string, unknown>, providers: ModelProviders): { config: ModelFallback | null; error?: string } {
  const raw = env.MODEL_FALLBACK;
  if (raw === undefined || raw === null || raw === "") return { config: null };
  try {
    return { config: parseModelFallback(raw, userModelsFrom(env, providers).offered) };
  } catch (e) {
    return { config: null, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * What a taken job carries when its call may fall back (`AgentRuntime.takeJob`): where to, and the two time limits.
 * The consumer obeys the mark and decides nothing else, so which calls fall back is said in one place.
 */
export interface JobFallback { provider: string; model: string; primaryMs: number; fallbackMs: number }

/** The mark as a taken job carries it, or null: a job without a well-formed one is called as it always was. */
export function jobFallback(job: unknown): JobFallback | null {
  const f = (job as { fallback?: Record<string, unknown> } | null)?.fallback;
  if (!f || typeof f !== "object") return null;
  const { provider, model, primaryMs, fallbackMs } = f;
  return typeof provider === "string" && typeof model === "string" && Number.isSafeInteger(primaryMs) && (primaryMs as number) > 0
    && Number.isSafeInteger(fallbackMs) && (fallbackMs as number) > 0
    ? { provider, model, primaryMs: primaryMs as number, fallbackMs: fallbackMs as number } : null;
}

/** Whether a binding's model is in the scope's primary: the operator's DeepSeek model. */
export const fallbackPrimary = (model: string) => isDeepSeekModel(model);

/**
 * How the primary attempt ended, when that ending sends the call to the fallback: an HTTP status class the provider
 * answered with past its retries (`http_5xx`, `http_429`), the time limit (`timeout`), or no HTTP answer at all
 * (`network`: the provider could not be reached, the same "not now" as a 5xx). Null for every other ending — a
 * refusal of the request itself above all — which is answered as it is today.
 */
export function primaryOutcomeOf(e: unknown): string | null {
  if (e instanceof ModelRequestRefused) return null;
  if (e instanceof ModelCallTimedOut) return "timeout";
  if (e instanceof ModelHttpError) return e.status === 429 ? "http_429" : e.status >= 500 ? "http_5xx" : null;
  // A fetch that never got an answer: a TypeError in Workers and node alike.
  if (e instanceof TypeError) return "network";
  return null;
}

/** How a fallback attempt ended, for the trace and the log; never sent to the model. */
export function fallbackOutcomeOf(e: unknown): string {
  if (e instanceof ModelRequestRefused) return `refused_${e.status}`;
  return primaryOutcomeOf(e) ?? "error";
}

/**
 * The `errorMessage` of a call neither model answered. Fixed text, for the reason SPEND_LIMIT_ERROR is
 * (src/model/pi-bridge.ts): pi decides whether to retry a failed turn by scanning this string
 * (`isRetryableAssistantError`, @earendil-works/pi-ai dist/utils/retry.js) and the overflow backstop reads it too.
 * It matches none of their patterns (test/model-fallback.ts runs pi-ai's own function on it), so the turn ends here
 * once and the retry is ours, on our schedule — pi's would come back within seconds, at a provider that has just
 * failed two calls for a minute or more. Words such as "busy" are safe; "unavailable" next to "service", any status
 * number, "timeout" and "overloaded" are not.
 */
export const MODEL_BUSY_ERROR = "model busy: no answer from the primary or the fallback model; see the turn's error";

/** The `errorClass` prefixes Raft matches, a closed set: a retry is scheduled, or the retries are over. */
export const MODEL_BUSY_CLASS = "model_busy";
export const MODEL_UNAVAILABLE_CLASS = "model_unavailable";

/** The answer is a busy one (`MODEL_BUSY_ERROR`), whatever its sentence says. */
export function isModelBusy(m: { stopReason?: unknown; errorMessage?: unknown } | null | undefined): boolean {
  return m?.stopReason === "error" && m.errorMessage === MODEL_BUSY_ERROR;
}

/**
 * The sentence a busy answer carries (`providerError`) once its object has decided what happens next
 * (src/runtime/busy-retry.ts), for the trace and Raft; undefined for any other answer. Only the two prefixes count.
 */
export function busySentence(m: { stopReason?: unknown; errorMessage?: unknown; providerError?: unknown } | null | undefined): string | undefined {
  if (!isModelBusy(m) || typeof m!.providerError !== "string") return undefined;
  const s = m!.providerError;
  return s.startsWith(`${MODEL_BUSY_CLASS}: `) || s.startsWith(`${MODEL_UNAVAILABLE_CLASS}: `) ? s : undefined;
}

/** "2 min", or seconds below a minute. */
const span = (ms: number) => ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : ms >= 60_000 ? `${Math.round(ms / 6_000) / 10} min` : `${Math.round(ms / 1000)} s`;

/** The sentence while a re-dispatch is scheduled `inMs` from now. */
export const busyRetrying = (inMs: number) => `${MODEL_BUSY_CLASS}: primary and fallback model both unavailable; retrying in ${span(inMs)}`;
/** The sentence once the retries are over: `attempts` busy answers in a row. */
export const busyGivenUp = (attempts: number) =>
  `${MODEL_UNAVAILABLE_CLASS}: primary and fallback model unavailable on ${attempts} attempt${attempts === 1 ? "" : "s"}; giving up`;
/** The sentence the consumer delivers, before the object has decided (and what a busy answer says if it never does). */
export const BUSY_UNDECIDED = `${MODEL_BUSY_CLASS}: primary and fallback model both unavailable`;

/**
 * What a model call's trace row says about a fallback (src/trace/seams.ts `modelCallRow`), carried on the answer
 * because that row is written from the answer alone. `primaryMs` is on every call that was marked, answered by the
 * primary or not, so the first turn's latency is recorded whichever way it went.
 */
export interface FallbackFacts {
  /** The primary's model, when another model was called after it. */
  fallbackFrom?: string;
  /** How the primary ended (`primaryOutcomeOf`), when it did not answer; `ok` when it did. */
  primaryOutcome: string;
  primaryMs: number;
  /** How the fallback ended, when it was called and did not answer. */
  fallbackOutcome?: string;
}

/** The facts an answer carries, read by shape: absent, or anything malformed, is none. */
export function fallbackFacts(m: unknown): FallbackFacts | undefined {
  const f = (m as { fallback?: Record<string, unknown> } | null)?.fallback;
  if (!f || typeof f !== "object" || typeof f.primaryOutcome !== "string" || typeof f.primaryMs !== "number") return undefined;
  return {
    ...(typeof f.fallbackFrom === "string" ? { fallbackFrom: f.fallbackFrom } : {}),
    primaryOutcome: f.primaryOutcome, primaryMs: f.primaryMs,
    ...(typeof f.fallbackOutcome === "string" ? { fallbackOutcome: f.fallbackOutcome } : {}),
  };
}
