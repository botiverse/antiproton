import { operatorRequest, providerOfRef, type OperatorModel } from "../../src/model/operator-request.ts";
import { DEFAULT_PROVIDER, modelProblem, providersFrom, type ModelChoice, type ModelProviders } from "../../src/model/providers.ts";
import { ModelRequestRefused, OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { errorMessage, fromResponse, toRequest, type AnsweredMessage } from "../../src/model/pi-bridge.ts";
import { logEvent } from "../../src/core/log.ts";

/**
 * What the operator's model account reads from the environment: the providers (MODEL_PROVIDERS, else
 * DeepSeek from DEEPSEEK_BASE_URL and DEEPSEEK_API_KEY), the secrets they name, and the default model.
 * The secrets are looked up by the names the declaration gives, so the type is open.
 */
export type ModelEnv = { DEEPSEEK_BASE_URL?: string; DEEPSEEK_API_KEY?: string; HARNESS_MODEL: string; MODEL_PROVIDERS?: unknown };

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
 * The queue consumer's provider call for a taken job (`modelQueueDeps`, cf/src/index.ts): the operator's account, with
 * the binding's provider and model when it spends that account (`operatorProvider`, `operatorModel`) and the
 * deployment's otherwise. A job taken before providers existed carries no provider, which is the default one. The answer
 * names the model this call reached, not the one the binding named: that is the model the ledger meters (docs/metering.md).
 */
export async function callQueuedModel(env: ModelEnv, job: any, jobId: string): Promise<AnsweredMessage> {
  const called = String(job.operatorModel ?? env.HARNESS_MODEL);
  const provider = job.operatorModel ? String(job.operatorProvider ?? DEFAULT_PROVIDER) : DEFAULT_PROVIDER;
  const model = new OpenAiCompatibleModel(operatorRequest(operatorModelOf(env), { provider, model: called }));
  const { messages, tools } = toRequest(job.context);
  const identity = {
    api: String(job.model?.api ?? "offloaded"),
    provider: String(job.model?.provider ?? "openai-compatible"),
    id: called,
  };
  let res;
  try {
    res = await model.complete(messages, tools ? { tools } : {});
  } catch (e) {
    // A refusal of the request itself is this job's answer, not a failure to retry: the queue would send the
    // same request again and be refused again (src/model/openai-compatible.ts, `isPermanentRefusal`). Answered
    // as an error, it fails the turn once, with the provider's status and message as the turn's error on both
    // engines, which read a failed turn's error from the answer's `errorMessage`. Anything else is thrown, so
    // the queue retries it as before.
    if (!(e instanceof ModelRequestRefused)) throw e;
    logEvent("model_job.refused", { jobId, provider, model: called, status: e.status });
    return { ...errorMessage(e.message, identity), jobId };
  }
  return fromResponse(res, identity, jobId);
}
