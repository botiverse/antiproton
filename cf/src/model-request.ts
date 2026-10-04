import { operatorRequest, providerOfRef, type OperatorModel } from "../../src/model/operator-request.ts";
import { DEFAULT_PROVIDER, providersFrom, type ModelChoice, type ModelProviders } from "../../src/model/providers.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { fromResponse, toRequest, type AnsweredMessage } from "../../src/model/pi-bridge.ts";

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
  const res = await model.complete(messages, tools ? { tools } : {});
  const identity = {
    api: String(job.model?.api ?? "offloaded"),
    provider: String(job.model?.provider ?? "openai-compatible"),
    id: called,
  };
  return fromResponse(res, identity, jobId);
}
