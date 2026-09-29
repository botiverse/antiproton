/**
 * The operator's model call: where it goes, with which key and headers — one answer for every path
 * that spends the operator's account (the queued call in cf/src/index.ts, and `ModelResolver` for a
 * binding on the operator's reference).
 *
 * `baseUrl` may be a Cloudflare AI Gateway's OpenAI-compatible endpoint
 * (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat`), and the model is then named
 * `provider/model`. The gateway's own token, when set, goes in `cf-aig-authorization`. DeepSeek's key
 * travels only with a DeepSeek model, as it always has; any other provider's key is held by the gateway
 * (its stored keys), so none is sent — a key in the request would take precedence over the stored one
 * and reach the other provider.
 */
export interface OperatorModel {
  baseUrl: string;
  /** DeepSeek's key: sent only for a DeepSeek model. */
  apiKey: string;
  /** The deployment's default model. */
  model: string;
  /** Cloudflare AI Gateway token (AI Gateway: Run). */
  gatewayToken?: string;
}

export function operatorRequest(op: OperatorModel, model: string = op.model):
  { baseUrl: string; apiKey: string; model: string; headers: Record<string, string> } {
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : "deepseek";
  const headers: Record<string, string> = {};
  if (op.gatewayToken) headers["cf-aig-authorization"] = `Bearer ${op.gatewayToken}`;
  return { baseUrl: op.baseUrl, apiKey: provider === "deepseek" ? op.apiKey : "", model, headers };
}
