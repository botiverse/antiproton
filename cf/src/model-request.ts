/**
 * The deployment's model call: where it goes, with which key and headers.
 *
 * `DEEPSEEK_BASE_URL` may be a Cloudflare AI Gateway's OpenAI-compatible endpoint
 * (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat`), and `HARNESS_MODEL` then names
 * the model as `provider/model`. The gateway's own token, when set, goes in `cf-aig-authorization`.
 * DeepSeek's key travels with a DeepSeek model, as it always has; any other provider's key is held by
 * the gateway (stored keys), so none is sent and none lives here.
 */
export function operatorModelRequest(env: { DEEPSEEK_BASE_URL: string; DEEPSEEK_API_KEY: string; HARNESS_MODEL: string; AI_GATEWAY_TOKEN?: string }) {
  const model = env.HARNESS_MODEL;
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : "deepseek";
  const headers: Record<string, string> = {};
  if (env.AI_GATEWAY_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.AI_GATEWAY_TOKEN}`;
  return {
    baseUrl: env.DEEPSEEK_BASE_URL,
    apiKey: provider === "deepseek" ? env.DEEPSEEK_API_KEY : "",
    model,
    headers,
  };
}
