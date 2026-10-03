import { operatorRequest, type OperatorModel } from "../../src/model/operator-request.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { fromResponse, toRequest, type AnsweredMessage } from "../../src/model/pi-bridge.ts";

/** The deployment's operator model, read from its environment (src/model/operator-request.ts says how it is called). */
export function operatorModelOf(env: { DEEPSEEK_BASE_URL: string; DEEPSEEK_API_KEY: string; HARNESS_MODEL: string; AI_GATEWAY_TOKEN?: string }): OperatorModel {
  return {
    baseUrl: env.DEEPSEEK_BASE_URL, apiKey: env.DEEPSEEK_API_KEY, model: env.HARNESS_MODEL,
    ...(env.AI_GATEWAY_TOKEN ? { gatewayToken: env.AI_GATEWAY_TOKEN } : {}),
  };
}

export function operatorModelRequest(env: Parameters<typeof operatorModelOf>[0]) {
  return operatorRequest(operatorModelOf(env));
}

/**
 * The queue consumer's provider call for a taken job (`modelQueueDeps`, cf/src/index.ts): the operator's account, with
 * the binding's model when it spends that account (`operatorModel`) and the deployment's otherwise. The answer names
 * the model this call reached, not the one the binding named: that is the model the ledger meters (docs/metering.md).
 */
export async function callQueuedModel(env: Parameters<typeof operatorModelOf>[0], job: any, jobId: string): Promise<AnsweredMessage> {
  const called = String(job.operatorModel ?? env.HARNESS_MODEL);
  const model = new OpenAiCompatibleModel(operatorRequest(operatorModelOf(env), called));
  const { messages, tools } = toRequest(job.context);
  const res = await model.complete(messages, tools ? { tools } : {});
  const identity = {
    api: String(job.model?.api ?? "offloaded"),
    provider: String(job.model?.provider ?? "openai-compatible"),
    id: called,
  };
  return fromResponse(res, identity, jobId);
}
