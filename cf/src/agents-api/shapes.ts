/**
 * The OpenAI agents API's objects, as the official SDK reads them (task #17;
 * `openai` 7.15.0, `resources/beta/agents/agents.d.ts`).
 *
 * The goal is that a program written for the SDK works when only the base URL
 * changes, so every object carries every field the SDK's types declare, with
 * the SDK's own defaults. What antiproton does not do is refused with an error
 * shaped like OpenAI's, naming the parameter — never accepted and ignored: a
 * silently dropped setting reads to the caller as a setting that worked.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const seconds = (ms: number) => Math.floor(ms / 1000);

// ---- errors ---------------------------------------------------------------

/** OpenAI's error body: the SDK reads `error.message` and picks the class from the status. */
export function openAIError(
  status: number, message: string,
  opts: { type?: string; param?: string | null; code?: string | null } = {},
): Response {
  const type = opts.type ?? (status === 401 ? "invalid_request_error" : status === 404 ? "invalid_request_error" : status >= 500 ? "server_error" : "invalid_request_error");
  return Response.json(
    { error: { message, type, param: opts.param ?? null, code: opts.code ?? null } },
    { status },
  );
}

export const unsupported = (param: string, what: string) =>
  ({ ok: false as const, status: 400, message: `${param}: ${what} is not supported by this deployment`, param, code: "unsupported_parameter" });

type Invalid = { ok: false; status: number; message: string; param: string; code: string };
const invalid = (param: string, message: string): Invalid => ({ ok: false, status: 400, message, param, code: "invalid_value" });

// ---- agents ---------------------------------------------------------------

export interface FunctionTool { name: string; description: string; parameters: Record<string, Json> }

/** What antiproton keeps for an agent created through this API. */
export interface StoredAgent {
  name: string | null;
  instructions: string | null;
  model: string;
  metadata: Record<string, string>;
  tools: FunctionTool[];
  createdAt: number;
  updatedAt: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function metadataOf(v: unknown): Record<string, string> | Invalid {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) return invalid("metadata", "metadata must be an object of strings");
  const entries = Object.entries(v);
  if (entries.length > 16) return invalid("metadata", "metadata may have at most 16 keys");
  for (const [k, val] of entries) {
    if (typeof val !== "string") return invalid(`metadata.${k}`, "metadata values must be strings");
    if (k.length > 64 || val.length > 512) return invalid(`metadata.${k}`, "metadata keys are at most 64 characters and values at most 512");
  }
  return v as Record<string, string>;
}

function toolsOf(v: unknown): FunctionTool[] | Invalid | ReturnType<typeof unsupported> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return invalid("tools", "tools must be an array");
  const out: FunctionTool[] = [];
  for (const [i, t] of v.entries()) {
    if (!isObj(t)) return invalid(`tools[${i}]`, "each tool must be an object");
    if (t.type !== "function") return unsupported(`tools[${i}].type`, `the tool type ${JSON.stringify(t.type)}`);
    if (typeof t.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) return invalid(`tools[${i}].name`, "a function tool needs a name of letters, digits, _ or -");
    if (t.defer_loading === true) return unsupported(`tools[${i}].defer_loading`, "deferred tool loading");
    out.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      parameters: isObj(t.parameters) ? (t.parameters as Record<string, Json>) : { type: "object", properties: {} },
    });
  }
  return out;
}

/**
 * A create or update body, checked field by field. The settings antiproton has
 * no equivalent for are accepted only at the value that means "off" or
 * "default", so an SDK that sends its defaults still works.
 */
export function parseAgentParams(body: unknown, mode: "create" | "update", prior?: StoredAgent, now = Date.now()):
  { ok: true; value: StoredAgent } | Invalid | ReturnType<typeof unsupported> {
  if (!isObj(body)) return invalid("body", "the request body must be a JSON object");
  const b = body;
  if (mode === "create" && (typeof b.model !== "string" || !b.model)) return invalid("model", "model is required");
  if (b.model !== undefined && typeof b.model !== "string") return invalid("model", "model must be a string");
  for (const f of ["name", "instructions"] as const) {
    if (b[f] !== undefined && b[f] !== null && typeof b[f] !== "string") return invalid(f, `${f} must be a string or null`);
  }
  const ma = b.multi_agent;
  if (ma !== undefined && ma !== null && (!isObj(ma) || ma.enabled !== false)) return unsupported("multi_agent", "running subagents");
  const r = b.reasoning;
  if (r !== undefined && r !== null && (!isObj(r) || (r.effort ?? null) !== null || (r.summary ?? null) !== null)) {
    return unsupported("reasoning", "choosing reasoning effort or summaries");
  }
  if (b.service_tier !== undefined && b.service_tier !== null && b.service_tier !== "auto" && b.service_tier !== "default") {
    return unsupported("service_tier", `the service tier ${JSON.stringify(b.service_tier)}`);
  }
  const t = b.text;
  if (t !== undefined && t !== null) {
    const fmt = isObj(t) ? t.format : undefined;
    if (!isObj(t) || (fmt !== undefined && fmt !== null && (!isObj(fmt) || fmt.type !== "text"))) return unsupported("text.format", "structured output formats");
    if (t.verbosity !== undefined && t.verbosity !== null && t.verbosity !== "medium") return unsupported("text.verbosity", "verbosity other than medium");
  }
  const metadata = b.metadata === undefined && prior ? prior.metadata : metadataOf(b.metadata);
  if ("ok" in (metadata as object)) return metadata as Invalid;
  const tools = b.tools === undefined && prior ? prior.tools : toolsOf(b.tools);
  if (!Array.isArray(tools)) return tools;
  const pick = <K extends "name" | "instructions">(k: K) =>
    (b[k] === undefined ? (prior?.[k] ?? null) : (b[k] as string | null));
  return {
    ok: true,
    value: {
      model: typeof b.model === "string" ? b.model : prior!.model,
      name: pick("name"),
      instructions: pick("instructions"),
      metadata: metadata as Record<string, string>,
      tools,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    },
  };
}

/** The agent settings as the SDK's `AgentSession.Agent` declares them (no timestamps, no metadata). */
export function agentSettings(id: string, a: StoredAgent) {
  return {
    id,
    instructions: a.instructions,
    model: a.model,
    multi_agent: { enabled: false, max_concurrent_subagents: null },
    name: a.name,
    reasoning: { effort: null, summary: null },
    service_tier: "auto" as const,
    text: { format: { type: "text" as const }, verbosity: "medium" as const },
    tools: a.tools.map((t) => ({ defer_loading: false, description: t.description, name: t.name, parameters: t.parameters, type: "function" as const })),
  };
}

/** `Agent`: every field the SDK declares. */
export function toOpenAIAgent(id: string, a: StoredAgent) {
  return {
    ...agentSettings(id, a),
    created_at: seconds(a.createdAt),
    metadata: a.metadata,
    object: "agent" as const,
    updated_at: seconds(a.updatedAt),
  };
}

export const agentDeleted = (id: string) => ({ id, deleted: true, object: "agent.deleted" as const });
export const sessionDeleted = (id: string) => ({ id, deleted: true, object: "agent.session.deleted" as const });

// ---- environments ---------------------------------------------------------

/**
 * Which environment a session gets. `openai_hosted` with nothing configured is
 * antiproton's container (the sandbox mount); `none` is no container. Anything
 * that configures the environment — files, packages, network, setup commands,
 * templates — is a capability of OpenAI's hosting that antiproton does not
 * have, so it is refused by name.
 */
export function parseEnvironment(v: unknown): { ok: true; kind: "none" | "container" } | Invalid | ReturnType<typeof unsupported> {
  if (!isObj(v)) return invalid("environment", "environment is required: {\"type\": \"openai_hosted\"} or {\"type\": \"none\"}");
  if (v.type === "none") return { ok: true, kind: "none" };
  if (v.type === "self_hosted") return unsupported("environment.type", "a self-hosted environment");
  if (v.type !== "openai_hosted") return invalid("environment.type", `unknown environment type ${JSON.stringify(v.type)}`);
  for (const k of ["capability_directories", "env", "environment_template_id", "files", "network", "packages", "plugins", "setup_commands", "skills"]) {
    const val = v[k];
    const empty = val === undefined || val === null || (Array.isArray(val) && val.length === 0) || (isObj(val) && Object.keys(val).length === 0);
    if (!empty) return unsupported(`environment.${k}`, "configuring the hosted environment");
  }
  return { ok: true, kind: "container" };
}

export function toOpenAIEnvironment(kind: "none" | "container", sessionId: string) {
  if (kind === "none") return { type: "none" as const };
  return {
    id: `env_${sessionId.replace(/^sess_/, "")}`,
    capability_directories: [],
    files: [],
    network: { access: "enabled" as const, allowed_domains: [] },
    packages: { npm: [], python: [], system: [] },
    plugins: [],
    skills: [],
    type: "openai_hosted" as const,
  };
}

// ---- sessions -------------------------------------------------------------

export interface StoredSession {
  id: string;
  agentId: string;
  environment: "none" | "container";
  metadata: Record<string, string>;
  createdAt: number;
  lastActiveAt: number;
}

export function toOpenAISession(
  s: StoredSession, agent: StoredAgent,
  live: { status: "idle" | "in_progress" | "requires_action" | "failed"; error?: string | null } = { status: "idle" },
) {
  return {
    id: s.id,
    agent: agentSettings(s.agentId, agent),
    created_at: seconds(s.createdAt),
    environment: toOpenAIEnvironment(s.environment, s.id),
    error: live.error ?? null,
    last_active_at: seconds(s.lastActiveAt),
    metadata: s.metadata,
    object: "agent.session" as const,
    required_actions: [],
    status: live.status,
    usage: null,
    vault_ids: [],
  };
}

// ---- pages ----------------------------------------------------------------

/**
 * A `CursorPage` the SDK can walk: it asks for the next page with `after` set
 * to the last item's id and stops when `has_more` is false. An `after` that
 * names nothing in the list is an error rather than a silent restart, which
 * would loop an iterator forever.
 */
export function cursorPage<T extends { id: string }>(
  items: T[], q: { after?: string | null; limit?: string | number | null; order?: string | null },
): { ok: true; page: { object: "list"; data: T[]; first_id: string | null; last_id: string | null; has_more: boolean } } | Invalid {
  const limitRaw = q.limit === undefined || q.limit === null || q.limit === "" ? 20 : Number(q.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) return invalid("limit", "limit must be an integer from 1 to 100");
  if (q.order && q.order !== "asc" && q.order !== "desc") return invalid("order", "order must be asc or desc");
  const ordered = q.order === "asc" ? items : [...items].reverse();
  let start = 0;
  if (q.after) {
    const i = ordered.findIndex((x) => x.id === q.after);
    if (i < 0) return invalid("after", `no item with id ${JSON.stringify(q.after)} in this list`);
    start = i + 1;
  }
  const data = ordered.slice(start, start + limitRaw);
  return {
    ok: true,
    page: {
      object: "list", data,
      first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null,
      has_more: start + limitRaw < ordered.length,
    },
  };
}
