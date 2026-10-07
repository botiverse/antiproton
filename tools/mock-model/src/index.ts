/**
 * A stand-in model provider for load tests: an OpenAI-compatible chat/completions endpoint that answers
 * from a script, after a chosen delay, without calling anything. A preview deployment pointed at it can run
 * many agents at once and pay nothing for their model calls, so what a load test measures is the platform
 * (the queue, the objects, D1) rather than a provider's latency or bill.
 *
 * It speaks the subset our client sends and reads (src/model/openai-compatible.ts): a non-streamed POST to
 * `<baseUrl>/chat/completions`, answered with `choices[0].message` (content, tool_calls), `finish_reason` and
 * `usage`. Everything it does is decided by the request, so the same request always gets the same answer.
 *
 * The model name is the only dial an agent's binding can turn (an owner picks an option id; an admin row names
 * a model), so behaviour is spelled in it: `mock` followed by any of these `-` tokens, in any order —
 *
 *   tool     when tools are offered and the current user turn has no tool result yet, call one read-only
 *            tool — the agent's `mounts`, else `jobs` with action "list", which every agent is offered —
 *            then answer in text. A request offering neither gets text.
 *   inbox    the same, calling Raft's `receive_events` first when offered: exercises the Raft path on every
 *            turn. It acknowledges the previous batch, so it is not read-only, and is only called when asked.
 *   d<ms>    answer after <ms> milliseconds instead of DEFAULT_DELAY_MS, up to MAX_DELAY_MS.
 *
 * so `mock`, `mock-tool`, `mock-d5000`, `mock-inbox-d250`. Any other token is refused with 404, the way a
 * provider refuses a model it does not have, so a misspelt name fails the turn rather than running a default.
 * An `x-mock-delay-ms` request header overrides the delay, for probing by hand.
 *
 * Auth: when the Worker holds MOCK_MODEL_KEY, a request must carry `authorization: Bearer <it>`; without the
 * secret every request is accepted. The endpoint costs nothing to call but is public on workers.dev, and the key
 * keeps it from being someone else's free load generator.
 */

export const DEFAULT_DELAY_MS = 1000;
/** Bounded well under the client's 10-minute deadline (MODEL_CALL_DEADLINE_MS), so a delay is never a timeout. */
export const MAX_DELAY_MS = 120_000;

/** Tools the scripted call may pick, by unqualified name, in order of preference, with arguments their schemas accept. */
const READ_ONLY = [["mounts", "{}"], ["jobs", '{"action":"list"}']] as const;
const TOOL_PREFERENCE = { tool: READ_ONLY, inbox: [["receive_events", "{}"], ...READ_ONLY] } as const;

export interface MockBehaviour { delayMs: number; toolMode: "none" | "tool" | "inbox" }

/** What a model name asks for, or why it is not a mock model. */
export function behaviourOf(model: unknown): MockBehaviour | { error: string } {
  if (typeof model !== "string" || !/^mock(-[a-z0-9]+)*$/.test(model)) {
    return { error: `${JSON.stringify(model)} is not a mock model; use mock, mock-tool, mock-inbox, optionally with -d<ms>` };
  }
  const b: MockBehaviour = { delayMs: DEFAULT_DELAY_MS, toolMode: "none" };
  for (const token of model.split("-").slice(1)) {
    const d = /^d([0-9]{1,6})$/.exec(token);
    if (d) b.delayMs = Math.min(Number(d[1]), MAX_DELAY_MS);
    else if (token === "tool" || token === "inbox") b.toolMode = token;
    else return { error: `${JSON.stringify(model)}: unknown token ${token}` };
  }
  return b;
}

/** A delay given in the header, bounded the same way; undefined when absent or not a number of milliseconds. */
export function headerDelay(v: string | null): number | undefined {
  if (v === null || !/^[0-9]{1,6}$/.test(v.trim())) return undefined;
  return Math.min(Number(v.trim()), MAX_DELAY_MS);
}

/** The tokens a text would cost, at the usual ~4 characters a token: realistic enough for a ledger to meter. */
const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

/**
 * The scripted answer to one request body, as an OpenAI chat.completion. Pure: no clock, no randomness, so a
 * test can compare it byte for byte (`created` is the caller's).
 */
export function mockCompletion(body: any, b: MockBehaviour, created = 0): Record<string, unknown> {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const tools: any[] = Array.isArray(body?.tools) ? body.tools : [];
  const lastUser = messages.map((m) => m?.role).lastIndexOf("user");
  const answeredThisTurn = messages.slice(lastUser + 1).some((m) => m?.role === "tool");
  const userTurns = messages.filter((m) => m?.role === "user").length;

  let tool: string | undefined, args = "{}";
  if (b.toolMode !== "none" && !answeredThisTurn && body?.tool_choice !== "none") {
    const names: string[] = tools.map((t) => t?.function?.name).filter((n) => typeof n === "string");
    for (const [want, a] of TOOL_PREFERENCE[b.toolMode]) {
      tool = names.find((n) => n === want || n.endsWith(`__${want}`));
      if (tool) { args = a; break; }
    }
  }

  const prompt = tokens(JSON.stringify(messages)) + (tools.length ? tokens(JSON.stringify(tools)) : 0);
  const message: Record<string, unknown> = tool
    ? { role: "assistant", content: null, tool_calls: [{ id: `call_mock_${messages.length}`, type: "function", function: { name: tool, arguments: args } }] }
    : { role: "assistant", content: `Mock reply to turn ${userTurns}${answeredThisTurn ? ", after the tool result" : ""}. Nothing further to do.` };
  const completion = tool ? tokens(tool + args) + 8 : tokens(String(message.content));
  return {
    id: `chatcmpl-mock-${messages.length}-${userTurns}`,
    object: "chat.completion",
    created,
    model: String(body?.model ?? "mock"),
    choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

export interface MockEnv { MOCK_MODEL_KEY?: string }

const json = (status: number, v: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const refuse = (status: number, message: string, code: string) =>
  json(status, { error: { message, type: "invalid_request_error", code } });

/** Equal strings, compared in time that depends only on their lengths. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `sleep` is a parameter so a test can answer without waiting. */
export async function handle(req: Request, env: MockEnv, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json(200, { ok: true, service: "antiproton-mock-model", endpoint: "POST /v1/chat/completions", models: "mock[-tool|-inbox][-d<ms>]" });
  }
  // `<baseUrl>/chat/completions` with or without the conventional /v1.
  if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") return refuse(404, `no route ${url.pathname}`, "not_found");
  if (req.method !== "POST") return refuse(405, "POST only", "method_not_allowed");
  if (env.MOCK_MODEL_KEY && !sameSecret(req.headers.get("authorization") ?? "", `Bearer ${env.MOCK_MODEL_KEY}`)) {
    return refuse(401, "missing or wrong bearer key", "invalid_api_key");
  }
  let body: any;
  try { body = await req.json(); } catch { return refuse(400, "body is not JSON", "invalid_json"); }
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return refuse(400, "messages is required", "invalid_request");
  if (body.stream === true) return refuse(400, "streaming is not supported by the mock", "stream_unsupported");
  const b = behaviourOf(body.model);
  if ("error" in b) return refuse(404, b.error, "model_not_found");
  const delayMs = headerDelay(req.headers.get("x-mock-delay-ms")) ?? b.delayMs;
  if (delayMs > 0) await sleep(delayMs);
  return json(200, mockCompletion(body, b, Math.floor(Date.now() / 1000)), { "x-mock-delay-ms": String(delayMs) });
}

export default {
  fetch(req: Request, env: MockEnv): Promise<Response> {
    return handle(req, env);
  },
};
