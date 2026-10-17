import { operatorRequest, providerOfRef, type OperatorModel } from "../../src/model/operator-request.ts";
import { DEFAULT_PROVIDER, modelProblem, providersFrom, type ModelChoice, type ModelProviders } from "../../src/model/providers.ts";
import type { UserModel, UserModels } from "../../src/model/user-models.ts";
import { ModelRequestRefused, OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { OpenAiResponsesModel, usesResponses } from "../../src/model/openai-responses.ts";
import { errorMessage, fromResponse, toRequest, toResponsesInput, type AnsweredMessage } from "../../src/model/pi-bridge.ts";
import type { ModelResponse } from "../../src/model/types.ts";
import { acceptsImages } from "../../src/model/context-windows.ts";
import { DEFAULT_IMAGE_WINDOW, hasImageRefs, imageKey, nonVisionImageItems, resolveImagesReported, windowStep, type ImageItem, type ImageLoader, type ImageWindow } from "../../src/model/images.ts";
import type { QueuedModelCall } from "./model-queue.ts";
import { capItems, imageAttemptWriter, providerOutcome, type ImageEvidenceSink } from "./image-evidence.ts";
import { logEvent } from "../../src/core/log.ts";

/**
 * What the operator's model account reads from the environment: the providers (MODEL_PROVIDERS, else
 * DeepSeek from DEEPSEEK_BASE_URL and DEEPSEEK_API_KEY), the secrets they name, and the default model.
 * The secrets are looked up by the names the declaration gives, so the type is open.
 */
export type ModelEnv = {
  DEEPSEEK_BASE_URL?: string; DEEPSEEK_API_KEY?: string; HARNESS_MODEL: string; MODEL_PROVIDERS?: unknown; USER_MODELS?: unknown;
  /**
   * Where the Responses API path puts a tool result's images (`toResponsesInput`, src/model/pi-bridge.ts): `output`
   * (the default, pi's way) or `user`, a user message after the results. Both were answered correctly through the
   * gateway (2026-10-12); this is the switch if one of them stops being accepted.
   */
  RESPONSES_TOOL_IMAGES?: string;
  /** How many images, and how many bytes of them, one request carries, newest first (`ImageWindow`, src/model/images.ts). */
  MODEL_IMAGES_MAX?: string;
  MODEL_IMAGES_MAX_BYTES?: string;
};

/** The image window from the environment: each var a positive whole number, else the default. */
export function imageWindowOf(env: ModelEnv): ImageWindow {
  const n = (v: unknown, d: number) => { const x = Number(v); return Number.isSafeInteger(x) && x > 0 ? x : d; };
  return { maxImages: n(env.MODEL_IMAGES_MAX, DEFAULT_IMAGE_WINDOW.maxImages), maxBytes: n(env.MODEL_IMAGES_MAX_BYTES, DEFAULT_IMAGE_WINDOW.maxBytes) };
}

/**
 * The queue consumer's image loader for one queued call: the bucket read under the queue message's own tenant and
 * agent, with the same key the tool host stored it under (`imageKey`, through `attachViewImage` in
 * src/runtime/tool-view.ts), so a job can only ever reach its own agent's images.
 */
export function imageLoaderFor(
  bucket: { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> },
  owner: { tenantId: string; agentId: string },
): ImageLoader {
  return async (sha) => {
    const o = await bucket.get(imageKey(owner, sha));
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  };
}

/** The deployment's operator model, read from its environment (src/model/operator-request.ts says how it is called). */
export function operatorModelOf(env: ModelEnv): OperatorModel {
  return { model: env.HARNESS_MODEL, providers: providersFrom(env as Record<string, unknown>) };
}

export function operatorModelRequest(env: ModelEnv) {
  return operatorRequest(operatorModelOf(env));
}

/**
 * The choice an agent is bound to, from the admin's most specific one (model_overrides) or none: the deployment's
 * default model when nothing is chosen, and the default provider when the row predates providers (provider null).
 */
export function choiceOf(chosen: { provider: string | null; model: string } | null, defaultModel: string): ModelChoice {
  return { provider: chosen?.provider ?? DEFAULT_PROVIDER, model: chosen?.model ?? defaultModel };
}

/** Where an agent's model came from, as the owner's route says it: an admin's row at any scope, the owner's pick, or neither. */
export type ModelSource = "admin" | "owner" | "default";

/**
 * The provider and model an agent is bound to, from every scope that may decide it (`ModelLayers`,
 * cf/src/control-plane.ts). Most specific wins:
 *
 *   admin's agent row > admin's tenant row > the owner's pick > admin's deployment row > HARNESS_MODEL
 *
 * The owner sits under the admin's agent and tenant rows because those are someone deciding about this
 * agent or its tenant in particular — a cost or a compliance call an owner must not undo — and above the
 * deployment row because that one is the operator moving everyone's default, which a person who picked a
 * model for their own agent did not ask to be moved by. `locked` is "an agent or tenant row applies": the
 * owner's pick, whatever it is, is not what runs, and the route refuses to take a new one (409).
 *
 * An owner's id that is not offered now — removed from USER_MODELS, its provider's secret unset, or the
 * declaration refused — is passed over as if absent, not an error: the agent binds what it would have bound
 * without it, and the row stays, so the pick returns if the option does. Every path that binds asks this
 * (#modelFor in cf/src/index.ts), and the binding it names is checked against the stored one there (planBinding
 * with onlyIfStale) — not on every run: a hook push to a console agent checks nothing. An owner's pick is also
 * bound when it is stored (AgentDO.rebindModel, apiAdopt); an admin's row waits for the next path that checks
 * (README.md, "Model providers").
 */
export function resolveModel(
  layers: { agent: Chosen | null; tenant: Chosen | null; deployment: Chosen | null; owner: string | null },
  userModels: UserModels,
  defaultModel: string,
): { choice: ModelChoice; source: ModelSource; locked: boolean; selected: UserModel | null } {
  const selected = layers.owner === null ? null : userModels.offered.find((o) => o.id === layers.owner) ?? null;
  const admin = layers.agent ?? layers.tenant;
  if (admin) return { choice: choiceOf(admin, defaultModel), source: "admin", locked: true, selected };
  if (selected) return { choice: { provider: selected.provider, model: selected.model }, source: "owner", locked: false, selected };
  if (layers.deployment) return { choice: choiceOf(layers.deployment, defaultModel), source: "admin", locked: false, selected };
  return { choice: choiceOf(null, defaultModel), source: "default", locked: false, selected };
}
type Chosen = { provider: string | null; model: string };

/**
 * The provider and model a subagent runs on when its parent asks for the owner's option `option` (src/runtime/subagents.ts),
 * or why it may not. The same rules as the agent's own pick: an administrator's agent or tenant row decides the agent's
 * model (`resolveModel`'s `locked`), and a subagent may not run on another; where the server's picker switch is enforced
 * and off (`pickerOff`), only the deployment's default may be picked; and only an option the deployment offers now.
 */
export function subagentModelChoice(
  layers: { agent: Chosen | null; tenant: Chosen | null; deployment: Chosen | null; owner: string | null },
  userModels: UserModels, defaultModel: string, option: string, pickerOff: boolean,
): { ok: true; choice: ModelChoice } | { ok: false; error: string } {
  if (resolveModel(layers, userModels, defaultModel).locked) {
    return { ok: false, error: "an administrator has set this agent's model, so a subagent cannot run on another one; leave model out" };
  }
  const o = userModels.offered.find((x) => x.id === option);
  if (!o) {
    const ids = userModels.offered.map((x) => x.id).join(", ");
    return { ok: false, error: `no model option ${JSON.stringify(option.slice(0, 64))}; ${ids ? `the options are ${ids}` : "this deployment offers none, so leave model out"}` };
  }
  const fallback = choiceOf(null, defaultModel);
  if (pickerOff && (o.provider !== fallback.provider || o.model !== fallback.model)) {
    return { ok: false, error: "choosing a model is not enabled for this Raft server, so a subagent runs on the default; leave model out" };
  }
  return { ok: true, choice: { provider: o.provider, model: o.model } };
}

/** Whether an operator binding already names `choice`: the same provider, the same model, and the provider's endpoint as declared now. */
export function bindingIsCurrent(b: { model: string; baseUrl: string; secretRef: string }, choice: ModelChoice, providers: ModelProviders): boolean {
  return providerOfRef(b.secretRef) === choice.provider && b.model === choice.model
    && b.baseUrl === providers.configs.find((p) => p.id === choice.provider)?.baseUrl;
}

/**
 * Whether to (re)write an agent's operator binding for `choice`, shared by every path that binds one (#bindModel in
 * cf/src/index.ts, adoptProvisionedAgent in cf/src/provision/steps.ts) so they cannot disagree.
 *
 * - A binding with the agent's own credential is never touched.
 * - `choice` null is a choice that could not be read: an existing binding stays, since a control plane that did not
 *   answer must not move an agent back to the default; an agent with none gets the default. `undefined` is "no
 *   choice", the default.
 * - `onlyIfStale`: an operator binding that already names the choice stays.
 * - A choice the declaration refuses (its provider since removed, a name in the wrong form) is treated like one that
 *   could not be read, and the reason is returned to be recorded: a page open, a hook delivery or a Raft adopt is no
 *   place to fail on the admin's configuration. An agent with no binding has nothing to keep, and its bind is refused
 *   with the reason.
 */
export function planBinding(
  b: { model: string; baseUrl: string; secretRef: string } | null,
  choice: ModelChoice | null | undefined,
  providers: ModelProviders,
  opts: { onlyIfStale?: boolean } = {},
): { bind: true; choice: ModelChoice | undefined; refused?: string } | { bind: false; refused?: string } {
  if (b && providerOfRef(b.secretRef) === null) return { bind: false };
  if (choice === null) return b ? { bind: false } : { bind: true, choice: undefined };
  if (b && opts.onlyIfStale && choice && bindingIsCurrent(b, choice, providers)) return { bind: false };
  const refused = choice ? modelProblem(providers, choice) ?? undefined : undefined;
  if (refused && b) return { bind: false, refused };
  return { bind: true, choice, ...(refused ? { refused } : {}) };
}

/**
 * The queue consumer's `call` (`modelQueueDeps`, cf/src/index.ts): the provider call for a taken job, its images read
 * from the agent the queue message names — its tenant and agent, never the object id it was addressed to — with the
 * key the tool host stored them under. `evidence`, when given, is where an attempt's image evidence goes for that
 * message (cf/src/image-evidence.ts); it is used only for a job its object marked (`imageEvidence`).
 */
export function queuedCall(env: ModelEnv, bucket: Parameters<typeof imageLoaderFor>[0], evidence?: (m: QueuedModelCall) => ImageEvidenceSink) {
  return (taken: unknown, m: QueuedModelCall) =>
    callQueuedModel(env, taken, m.jobId, imageLoaderFor(bucket, { tenantId: m.tenantId, agentId: m.agentId }), evidence?.(m));
}

/**
 * The queue consumer's provider call for a taken job (`modelQueueDeps`, cf/src/index.ts): the operator's account, with
 * the binding's provider and model when it spends that account (`operatorProvider`, `operatorModel`) and the
 * deployment's otherwise. A job taken before providers existed carries no provider, which is the default one. The answer
 * names the model this call reached, not the one the binding named: that is the model the ledger meters (docs/metering.md).
 *
 * An OpenAI reasoning model (`usesResponses`) is called through the Responses API at the same provider, with its
 * reasoning on and its earlier reasoning replayed (src/model/openai-responses.ts); every other model through
 * chat/completions, whose request — DeepSeek's among them — test/model-request-snapshot.ts pins byte for byte.
 * The job's own options are not forwarded on either path: the reasoning level is each client's default, except where
 * the object marked the job `reasoning: "off"` (an agent's first turn made to run without, src/runtime/prewarm.ts).
 *
 * An image in the conversation is stored as a reference (src/model/images.ts); for a model that can see images
 * (`acceptsImages`) the newest ones, within the image window (`imageWindowOf`), are read through `images` — the
 * agent's own R2 prefix, in the Worker (`imageLoaderFor`) — right before the call, and older ones are sent as a note;
 * for any other model each is sent as the sentence saying it cannot see it, with nothing read.
 *
 * With `evidence`, a job its object marked (`imageEvidence`, set by `AgentRuntime.takeJob` where model-input evidence
 * is on) and a conversation holding an image reference, this attempt is described to it: what became of each
 * reference once the request is built, and how the provider call ended (cf/src/image-evidence.ts). That write runs
 * beside the call and is bounded, and its failure is only logged.
 */
export async function callQueuedModel(env: ModelEnv, job: any, jobId: string, images?: ImageLoader, evidence?: ImageEvidenceSink): Promise<AnsweredMessage> {
  const called = String(job.operatorModel ?? env.HARNESS_MODEL);
  const provider = job.operatorModel ? String(job.operatorProvider ?? DEFAULT_PROVIDER) : DEFAULT_PROVIDER;
  const request = operatorRequest(operatorModelOf(env), { provider, model: called });
  const sees = acceptsImages(called);
  const window = imageWindowOf(env);
  const recording = !!evidence && job?.imageEvidence === true && hasImageRefs(job.context ?? {});
  let context = job.context;
  let report: { items: ImageItem[]; windowStart: number } | null = null;
  if (sees) {
    const r = await resolveImagesReported(job.context, images, window);
    context = r.context;
    report = r;
  } else if (recording) {
    report = nonVisionImageItems(job.context);
  }
  // Told the status of each HTTP answer only when it is recorded, so a call that is not is the call it always was.
  let lastStatus: number | undefined;
  const observe = recording ? { onStatus: (s: number) => { lastStatus = s; } } : {};
  // The one option a job may carry: reasoning off for a first turn its object marked (`AgentRuntime.takeJob`). A job
  // without it is sent exactly the request it always was.
  const reasoning = jobReasoning(job);
  let call: () => Promise<ModelResponse>;
  if (usesResponses(called)) {
    const toolImages = env.RESPONSES_TOOL_IMAGES === "user" ? "user" as const : "output" as const;
    const { input, tools } = toResponsesInput(context, called, { images: sees, toolImages });
    const model = new OpenAiResponsesModel(request);
    call = () => model.complete(input, { ...(tools ? { tools } : {}), ...observe, ...reasoning });
  } else {
    const model = new OpenAiCompatibleModel(request);
    const { messages, tools } = toRequest(context, { images: sees });
    call = () => model.complete(messages, { ...(tools ? { tools } : {}), ...observe, ...reasoning });
  }
  const identity = {
    api: String(job.model?.api ?? "offloaded"),
    provider: String(job.model?.provider ?? "openai-compatible"),
    id: called,
  };
  const attempt = recording && report ? imageAttemptWriter(evidence!, {
    attemptId: crypto.randomUUID(),
    budget: { ...window, step: windowStep(window) },
    windowStart: report.windowStart, model: called, vision: sees,
    ...capItems(report.items),
  }, jobId) : null;
  // The request is built: what it carries is decided, and it has not been sent.
  attempt?.prepared(new Date());
  let res;
  try {
    res = await call();
  } catch (e) {
    await attempt?.ended(providerOutcome(e, lastStatus, new Date()));
    // A refusal of the request itself is this job's answer, not a failure to retry: the queue would send the
    // same request again and be refused again (src/model/openai-compatible.ts, `isPermanentRefusal`). Answered
    // as an error, it fails the turn once. `errorMessage` is the refusal's fixed text, the one string the
    // harness's retry check scans; the provider's status and message go in `providerError`, which the turn's
    // readers show (`failureText`, src/model/pi-bridge.ts). Anything else is thrown, so the queue retries it.
    if (!(e instanceof ModelRequestRefused)) throw e;
    logEvent("model_job.refused", { jobId, provider, model: called, status: e.status });
    return { ...errorMessage(e.message, identity), providerError: e.turnError, jobId };
  }
  await attempt?.ended(providerOutcome(undefined, lastStatus, new Date()));
  return fromResponse(res, identity, jobId);
}

/** `reasoning` as a taken job carries it: only "off" is ever set (`AgentRuntime.takeJob`); anything else is no option. */
function jobReasoning(job: any): { reasoning: "off" } | Record<string, never> {
  return job?.reasoning === "off" ? { reasoning: "off" } : {};
}

const RESPONSES_MIN_OUTPUT_TOKENS = 16;

/** What a prewarm reports back to its object (`AgentRuntime.prewarmDone`). */
export interface PrewarmResult {
  model: string;
  /** `warmed`, or `failed: …` with the reason. */
  outcome: string;
  ms: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number } | null;
}

/**
 * A prompt-cache prewarm (src/runtime/prewarm.ts), the queue consumer's half: the first turn's prefix sent the way
 * `callQueuedModel` would send that turn — the same provider and model, the same serializer, the same reasoning — with
 * nothing to generate: through the Responses API the developer message and tools with `prewarm`, through
 * chat/completions the system prompt, one user message and the tools with a one-token cap. Never thrown: a failure is
 * its outcome, so the queue does not send it again.
 */
export async function callPrewarm(env: ModelEnv, job: any): Promise<PrewarmResult> {
  const called = String(job?.operatorModel ?? env.HARNESS_MODEL);
  const provider = job?.operatorModel ? String(job.operatorProvider ?? DEFAULT_PROVIDER) : DEFAULT_PROVIDER;
  const t0 = Date.now();
  try {
    const request = operatorRequest(operatorModelOf(env), { provider, model: called });
    const reasoning = jobReasoning(job);
    let res: ModelResponse;
    if (usesResponses(called)) {
      const { input, tools } = toResponsesInput({ ...job.context, messages: [] }, called, {});
      // 16 is the least `max_output_tokens` the Responses API takes (15 was refused with a 400 through the gateway,
      // 2026-10-14); a prewarm generates nothing, and this bounds it if it ever did.
      res = await new OpenAiResponsesModel(request).complete(input, { ...(tools ? { tools } : {}), ...reasoning, prewarm: true, maxTokens: RESPONSES_MIN_OUTPUT_TOKENS });
    } else {
      const { messages, tools } = toRequest(job.context, {});
      res = await new OpenAiCompatibleModel(request).complete(messages, { ...(tools ? { tools } : {}), ...reasoning, maxTokens: 1 });
    }
    const u = fromResponse(res, { api: "offloaded", provider: "openai-compatible", id: called }).usage;
    return { model: called, outcome: "warmed", ms: Date.now() - t0,
      usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, ...(u.reasoning ? { reasoning: u.reasoning } : {}) } };
  } catch (e) {
    return { model: called, outcome: `failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`, ms: Date.now() - t0, usage: null };
  }
}
