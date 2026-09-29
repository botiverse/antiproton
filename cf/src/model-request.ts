import { operatorRequest, type OperatorModel } from "../../src/model/operator-request.ts";

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
