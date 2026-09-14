/**
 * The agents API's requests as the OpenAI SDK makes them (task #17): paths,
 * status codes, objects, and what is refused — against in-memory deps.
 */
import { handleAgentsApi, inputText, type AgentsApiDeps } from "../cf/src/agents-api/handlers.ts";
import type { StoredAgent, StoredSession } from "../cf/src/agents-api/shapes.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

function fakeDeps() {
  let t = 1_800_000_000_000, n = 0;
  const agents = new Map<string, StoredAgent>(), sessions = new Map<string, StoredSession>();
  const log = { adopted: [] as string[], persona: [] as Array<{ id: string; instructions: string | null }>, opened: [] as string[], inputs: [] as Array<{ session: string; text: string }> };
  const deps: AgentsApiDeps = {
    now: () => (t += 1000),
    mintAgentId: () => `agent_${++n}`,
    mintSessionId: () => `sess_${++n}`,
    index: {
      putAgent: async (id, a) => { agents.set(id, a); },
      getAgent: async (id) => agents.get(id) ?? null,
      listAgents: async () => [...agents.entries()].map(([id, agent]) => ({ id, agent })),
      deleteAgent: async (id) => agents.delete(id),
      putSession: async (s) => { sessions.set(s.id, s); },
      getSession: async (id) => sessions.get(id) ?? null,
      listSessions: async (agentId) => [...sessions.values()].filter((s) => !agentId || s.agentId === agentId),
      deleteSession: async (id) => sessions.delete(id),
    },
    agents: {
      adopt: async (id) => { log.adopted.push(id); },
      updatePersona: async (id, a) => { log.persona.push({ id, instructions: a.instructions }); },
      openSession: async (_a, s) => { log.opened.push(s); },
      postInput: async (_a, s, text) => { log.inputs.push({ session: s, text }); },
      status: async () => "idle",
      transcript: async () => ({ entries: [], running: false }),
    },
  };
  return { deps, log, agents, sessions };
}
const call = async (deps: AgentsApiDeps, method: string, path: string, body?: unknown, qs = "") => {
  const r = await handleAgentsApi(method, path, new URLSearchParams(qs), body, deps);
  if (!r) return { status: 0, body: null as any };
  return { status: r.status, body: await r.json() as any };
};

await check("agents: create, retrieve, list, update reaching the persona, delete making it unreachable", async () => {
  const { deps, log } = fakeDeps();
  const c = await call(deps, "POST", "/agents", { model: "gpt-6-astra", name: "coder", instructions: "Write clean code." });
  assert(c.status === 200 && c.body.object === "agent" && c.body.id === "agent_1", `create: ${JSON.stringify(c)}`);
  assert(log.adopted.join() === "agent_1", "the agent's own object was not created");
  assert((await call(deps, "GET", "/agents/agent_1")).body.name === "coder", "retrieve");
  const list = await call(deps, "GET", "/agents", undefined, "order=asc");
  assert(list.body.object === "list" && list.body.data.length === 1 && list.body.has_more === false, `list: ${JSON.stringify(list.body)}`);
  const u = await call(deps, "POST", "/agents/agent_1", { instructions: "Be brief." });
  assert(u.status === 200 && u.body.instructions === "Be brief." && u.body.name === "coder", `update: ${JSON.stringify(u.body)}`);
  assert(log.persona.at(-1)?.instructions === "Be brief.", "an update did not reach the persona the harness reads");
  const d = await call(deps, "DELETE", "/agents/agent_1");
  assert(d.body.object === "agent.deleted" && d.body.deleted === true, `delete: ${JSON.stringify(d.body)}`);
  const gone = await call(deps, "GET", "/agents/agent_1");
  assert(gone.status === 404 && gone.body.error?.code === "not_found", `a deleted agent is still reachable: ${JSON.stringify(gone)}`);
});

await check("sessions: create with agent_id and text input, retrieve, list by agent, update metadata, delete", async () => {
  const { deps, log } = fakeDeps();
  await call(deps, "POST", "/agents", { model: "m" });
  const s = await call(deps, "POST", "/agents/sessions", { agent_id: "agent_1", environment: { type: "openai_hosted" }, input: "Create tree.py", metadata: { job: "1" } });
  assert(s.status === 200 && s.body.object === "agent.session" && s.body.agent.id === "agent_1", `create: ${JSON.stringify(s)}`);
  assert(s.body.environment.type === "openai_hosted" && s.body.metadata.job === "1", `fields: ${JSON.stringify(s.body)}`);
  assert(log.opened.join() === s.body.id && log.inputs[0]?.text === "Create tree.py" && log.inputs[0]?.session === s.body.id, `session not opened or input not delivered: ${JSON.stringify(log)}`);
  assert((await call(deps, "GET", `/agents/sessions/${s.body.id}`)).body.id === s.body.id, "retrieve");
  const listed = await call(deps, "GET", "/agents/sessions", undefined, "agent_id=agent_1");
  assert(listed.body.data.length === 1 && listed.body.data[0].id === s.body.id, `list: ${JSON.stringify(listed.body)}`);
  const up = await call(deps, "POST", `/agents/sessions/${s.body.id}`, { metadata: { job: "2" } });
  assert(up.body.metadata.job === "2", `update: ${JSON.stringify(up.body)}`);
  const bad = await call(deps, "POST", `/agents/sessions/${s.body.id}`, { environment: { type: "none" } });
  assert(bad.status === 400 && bad.body.error.param === "environment", `a non-metadata update was accepted: ${JSON.stringify(bad)}`);
  const del = await call(deps, "DELETE", `/agents/sessions/${s.body.id}`);
  assert(del.body.object === "agent.session.deleted", `delete: ${JSON.stringify(del.body)}`);
  assert((await call(deps, "GET", `/agents/sessions/${s.body.id}`)).status === 404, "a deleted session is still reachable");
});

await check("a session with an inline agent creates that agent; the sessions path is never read as an agent id", async () => {
  const { deps, log, agents } = fakeDeps();
  const s = await call(deps, "POST", "/agents/sessions", { agent: { model: "gpt-6-astra", instructions: "Run it." }, environment: { type: "none" } });
  assert(s.status === 200 && agents.size === 1 && log.adopted.length === 1, `inline agent: ${JSON.stringify(s)}`);
  assert(s.body.environment.type === "none" && s.body.agent.instructions === "Run it.", `fields: ${JSON.stringify(s.body)}`);
  const list = await call(deps, "GET", "/agents/sessions");
  assert(list.status === 200 && list.body.object === "list", `GET /agents/sessions was routed as an agent: ${JSON.stringify(list)}`);
});

await check("what is not supported yet is refused by name, and unknown or not-owned paths are distinguished", async () => {
  const { deps } = fakeDeps();
  await call(deps, "POST", "/agents", { model: "m" });
  const cases: Array<[unknown, string]> = [
    [{ agent_id: "agent_1", environment: { type: "openai_hosted" }, stream: true }, "stream"],
    [{ agent_id: "agent_1", environment: { type: "openai_hosted" }, vault_ids: ["v1"] }, "vault_ids"],
    [{ agent_id: "agent_1", environment: { type: "openai_hosted", packages: { npm: ["zod"] } } }, "environment.packages"],
    [{ agent_id: "agent_1", environment: { type: "openai_hosted" }, input: [{ role: "user", content: [{ type: "input_image", image_url: "x" }] }] }, "input[0].content[0].type"],
    [{ agent_id: "agent_1" }, "environment"],
    [{ environment: { type: "none" } }, "agent"],
  ];
  for (const [body, param] of cases) {
    const r = await call(deps, "POST", "/agents/sessions", body);
    assert(r.status === 400 && r.body.error?.param === param, `${param} not refused: ${JSON.stringify(r)}`);
  }
  const missing = await call(deps, "POST", "/agents/sessions", { agent_id: "nope", environment: { type: "none" } });
  assert(missing.status === 404, `a session for a missing agent: ${JSON.stringify(missing)}`);
  const events = await call(deps, "GET", "/agents/sessions/sess_x/events");
  assert(events.status === 404 && /not supported by this deployment yet|No session/.test(events.body.error.message), `events path: ${JSON.stringify(events)}`);
  assert((await handleAgentsApi("GET", "/responses", new URLSearchParams(), undefined, deps)) === null, "a path this API does not own was claimed");
});

await check("input text: strings and input_text parts joined; other parts refused by position", async () => {
  const t: any = inputText([{ role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] }, { role: "user", content: "c" }]);
  assert(t.ok && t.text === "a\n\nb\n\nc", `joined: ${JSON.stringify(t)}`);
  assert((inputText(undefined) as any).text === null, "absent input is not empty");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
