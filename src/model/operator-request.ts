import { DEFAULT_PROVIDER, providerRequest, type ModelChoice, type ModelProviders } from "./providers.ts";

/**
 * The operator's model call: where it goes, with which key and headers. Every model call an agent makes
 * is a queued job, called by the queue consumer (`callQueuedModel`, cf/src/model-request.ts) with the
 * provider and model the agent's binding names. The runtime builds no `ModelResolver`: since pi's loop
 * (2df66b3) nothing in it calls a model directly, and a resolver it built was never read. Which provider serves
 * which model, and what each one is sent, is the deployment's declaration (src/model/providers.ts).
 */
export interface OperatorModel {
  /** The deployment's default model, under DEFAULT_PROVIDER. */
  model: string;
  providers: ModelProviders;
}

/** The call for `choice`; the deployment's default when none is given, and DEFAULT_PROVIDER when a choice names no provider. */
export function operatorRequest(op: OperatorModel, choice?: Partial<ModelChoice> | null):
  { baseUrl: string; apiKey: string; model: string; headers: Record<string, string> } {
  return providerRequest(op.providers, { provider: choice?.provider || DEFAULT_PROVIDER, model: choice?.model || op.model });
}

/**
 * A binding on the operator's account names the provider in its credential reference, since that is what
 * the reference is: whose key. The bare reference is the default provider, which is every binding written
 * before providers existed, and is still what a default-provider binding is written as — so those rows
 * read exactly as they did. Another provider's is `operator:model:<id>`.
 */
export const OPERATOR_MODEL_REF = "operator:model";

export function operatorRefFor(provider: string): string {
  return provider === DEFAULT_PROVIDER ? OPERATOR_MODEL_REF : `${OPERATOR_MODEL_REF}:${provider}`;
}

/** The provider an operator binding's reference names, or null when the reference is not the operator's model account. */
export function providerOfRef(ref: string): string | null {
  if (ref === OPERATOR_MODEL_REF) return DEFAULT_PROVIDER;
  return ref.startsWith(`${OPERATOR_MODEL_REF}:`) ? ref.slice(OPERATOR_MODEL_REF.length + 1) || null : null;
}
