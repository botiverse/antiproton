/**
 * The OpenAI-compatible agents API's requests, as pure functions (task #17).
 *
 * The router, the checks and the objects returned are all here, and every
 * effect goes through `deps`: the owner's index and the agent's own object.
 * That keeps what the SDK sees testable without a Worker, and leaves index.ts
 * only the wiring — which is proven with the real SDK against a deployment.
 */
import {
  agentDeleted, cursorPage, metadataOf, openAIError, parseAgentParams, parseEnvironment, sessionDeleted,
  toOpenAIAgent, toOpenAISession, type StoredAgent, type StoredSession,
} from "./shapes.ts";

export type SessionStatus = "idle" | "in_progress" | "requires_action" | "failed";

export interface AgentsApiDeps {
  now(): number;
  mintAgentId(): string;
  mintSessionId(): string;
  index: {
    putAgent(id: string, a: StoredAgent): Promise<void>;
    getAgent(id: string): Promise<StoredAgent | null>;
    listAgents(): Promise<Array<{ id: string; agent: StoredAgent }>>;
    deleteAgent(id: string): Promise<boolean>;
    putSession(s: StoredSession): Promise<void>;
    getSession(id: string): Promise<StoredSession | null>;
    listSessions(agentId?: string | null): Promise<StoredSession[]>;
    deleteSession(id: string): Promise<boolean>;
  };
  agents: {
    /** Create the agent's own object and its persona. Idempotent. */
    adopt(agentId: string, a: StoredAgent): Promise<void>;
    /** Rewrite the persona the harness reads after an update. */
    updatePersona(agentId: string, a: StoredAgent): Promise<void>;
    /** Make the session a conversation the agent's object will run. */
    openSession(agentId: string, sessionId: string): Promise<void>;
    /** Deliver text to the session: starts a turn when idle. */
    postInput(agentId: string, sessionId: string, text: string): Promise<void>;
    status(agentId: string, sessionId: string): Promise<SessionStatus>;
  };
}

type Refusal = { ok: false; status: number; message: string; param: string; code: string };
const refuse = (r: Refusal) => openAIError(r.status, r.message, { param: r.param, code: r.code });
const notFound = (what: string, id: string) => openAIError(404, `No ${what} found with id '${id}'.`, { code: "not_found" });
const ok = (v: unknown) => Response.json(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Text from `input`: a string, or messages whose content is input_text parts. Anything else is refused by name. */
export function inputText(input: unknown): { ok: true; text: string | null } | Refusal {
  if (input === undefined || input === null) return { ok: true, text: null };
  if (typeof input === "string") return { ok: true, text: input };
  if (!Array.isArray(input)) return { ok: false, status: 400, message: "input must be a string or an array of messages", param: "input", code: "invalid_value" };
  const parts: string[] = [];
  for (const [i, m] of input.entries()) {
    if (!isObj(m)) return { ok: false, status: 400, message: "each input item must be a message", param: `input[${i}]`, code: "invalid_value" };
    const content = m.content;
    if (typeof content === "string") { parts.push(content); continue; }
    if (!Array.isArray(content)) return { ok: false, status: 400, message: "message content must be a string or parts", param: `input[${i}].content`, code: "invalid_value" };
    for (const [j, c] of content.entries()) {
      if (isObj(c) && c.type === "input_text" && typeof c.text === "string") { parts.push(c.text); continue; }
      return { ok: false, status: 400, message: `input[${i}].content[${j}]: the part type ${JSON.stringify(isObj(c) ? c.type : c)} is not supported by this deployment`, param: `input[${i}].content[${j}].type`, code: "unsupported_parameter" };
    }
  }
  return { ok: true, text: parts.join("\n\n") };
}

async function sessionObject(deps: AgentsApiDeps, s: StoredSession) {
  const agent = await deps.index.getAgent(s.agentId);
  if (!agent) return null;
  return toOpenAISession(s, agent, { status: await deps.agents.status(s.agentId, s.id) });
}

/**
 * One request under `/v1`. `path` is what follows `/v1` (e.g. `/agents/sessions/sess_1`).
 * Returns null for a path this API does not own, so the caller can fall through.
 */
export async function handleAgentsApi(
  method: string, path: string, query: URLSearchParams, body: unknown, deps: AgentsApiDeps,
): Promise<Response | null> {
  const seg = path.split("/").filter(Boolean);
  if (seg[0] !== "agents") return null;
  const q = { after: query.get("after"), limit: query.get("limit"), order: query.get("order") };

  // /agents/sessions... first: a session route must never be read as an agent id.
  if (seg[1] === "sessions") {
    if (seg.length === 2 && method === "POST") {
      if (!isObj(body)) return openAIError(400, "the request body must be a JSON object", { param: "body", code: "invalid_value" });
      if (body.stream === true) return openAIError(400, "stream: streaming session events is not supported by this deployment yet", { param: "stream", code: "unsupported_parameter" });
      if (Array.isArray(body.vault_ids) && body.vault_ids.length) return openAIError(400, "vault_ids: vaults are not supported by this deployment", { param: "vault_ids", code: "unsupported_parameter" });
      const env = parseEnvironment(body.environment);
      if (!env.ok) return refuse(env);
      const metadata = metadataOf(body.metadata);
      if ("ok" in (metadata as object)) return refuse(metadata as unknown as Refusal);
      const text = inputText(body.input);
      if (!text.ok) return refuse(text);
      let agentId: string;
      if (typeof body.agent_id === "string" && body.agent_id) {
        if (body.agent !== undefined && body.agent !== null) return openAIError(400, "give agent_id or agent, not both", { param: "agent", code: "invalid_value" });
        if (!(await deps.index.getAgent(body.agent_id))) return notFound("agent", body.agent_id);
        agentId = body.agent_id;
      } else {
        if (!isObj(body.agent)) return openAIError(400, "agent_id or agent is required", { param: "agent", code: "invalid_value" });
        const parsed = parseAgentParams(body.agent, "create", undefined, deps.now());
        if (!parsed.ok) return refuse(parsed);
        agentId = deps.mintAgentId();
        await deps.agents.adopt(agentId, parsed.value);
        await deps.index.putAgent(agentId, parsed.value);
      }
      const now = deps.now();
      const session: StoredSession = {
        id: deps.mintSessionId(), agentId, environment: env.kind,
        metadata: metadata as Record<string, string>, createdAt: now, lastActiveAt: now,
      };
      await deps.agents.openSession(agentId, session.id);
      await deps.index.putSession(session);
      if (text.text) await deps.agents.postInput(agentId, session.id, text.text);
      return ok(await sessionObject(deps, session));
    }
    if (seg.length === 2 && method === "GET") {
      const agentFilter = query.get("agent_id");
      const page = cursorPage(await deps.index.listSessions(agentFilter), q);
      if (!page.ok) return refuse(page);
      const data = [];
      for (const s of page.page.data) { const o = await sessionObject(deps, s); if (o) data.push(o); }
      return ok({ ...page.page, data });
    }
    if (seg.length === 3) {
      const id = seg[2]!;
      const s = await deps.index.getSession(id);
      if (!s) return notFound("session", id);
      if (method === "GET") return ok(await sessionObject(deps, s));
      if (method === "DELETE") { await deps.index.deleteSession(id); return ok(sessionDeleted(id)); }
      if (method === "POST") {
        if (!isObj(body)) return openAIError(400, "the request body must be a JSON object", { param: "body", code: "invalid_value" });
        const unknown = Object.keys(body).find((k) => k !== "metadata");
        if (unknown) return openAIError(400, `${unknown}: a session update can change only metadata`, { param: unknown, code: "unsupported_parameter" });
        const metadata = body.metadata === undefined ? s.metadata : metadataOf(body.metadata);
        if ("ok" in (metadata as object)) return refuse(metadata as unknown as Refusal);
        const updated = { ...s, metadata: metadata as Record<string, string> };
        await deps.index.putSession(updated);
        return ok(await sessionObject(deps, updated));
      }
    }
    return openAIError(404, `${method} /v1/${seg.join("/")} is not supported by this deployment yet`, { code: "not_found" });
  }

  if (seg.length === 1 && method === "POST") {
    const parsed = parseAgentParams(body, "create", undefined, deps.now());
    if (!parsed.ok) return refuse(parsed);
    const id = deps.mintAgentId();
    await deps.agents.adopt(id, parsed.value);
    await deps.index.putAgent(id, parsed.value);
    return ok(toOpenAIAgent(id, parsed.value));
  }
  if (seg.length === 1 && method === "GET") {
    const page = cursorPage((await deps.index.listAgents()).map((x) => ({ ...toOpenAIAgent(x.id, x.agent) })), q);
    return page.ok ? ok(page.page) : refuse(page);
  }
  if (seg.length === 2 && seg[1] !== "environments") {
    const id = seg[1]!;
    const a = await deps.index.getAgent(id);
    if (!a) return notFound("agent", id);
    if (method === "GET") return ok(toOpenAIAgent(id, a));
    if (method === "DELETE") { await deps.index.deleteAgent(id); return ok(agentDeleted(id)); }
    if (method === "POST") {
      const parsed = parseAgentParams(body, "update", a, deps.now());
      if (!parsed.ok) return refuse(parsed);
      await deps.index.putAgent(id, parsed.value);
      await deps.agents.updatePersona(id, parsed.value);
      return ok(toOpenAIAgent(id, parsed.value));
    }
  }
  return openAIError(404, `${method} /v1/${seg.join("/")} is not supported by this deployment yet`, { code: "not_found" });
}
