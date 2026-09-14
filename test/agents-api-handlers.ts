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
  const log = { cancelled: [] as string[], adopted: [] as string[], persona: [] as Array<{ id: string; instructions: string | null }>, opened: [] as string[], inputs: [] as Array<{ session: string; text: string }> };
  const deps: AgentsApiDeps = {
    now: () => (t += 1000),
    // A macrotask, so input posted by another request lands between two reads of the stream.
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    streamMaxMs: 60_000,
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
      cancel: async (_a, s) => { log.cancelled.push(s); },
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

/** The event types in an SSE body, keepalives skipped. */
const frames = (text: string) => text.split("\n\n").filter((f) => f.startsWith("event: ")).map((f) => JSON.parse(f.split("\n")[1]!.slice("data: ".length)));

await check("events: GET streams from now on; POST input starts a turn it reports through idle; create with stream does both", async () => {
  const { deps, log } = fakeDeps();
  let entries: unknown[] = [
    { type: "message", seq: 1, timestamp: 1_000, message: { role: "user", content: "old" } },
    { type: "message", seq: 2, timestamp: 2_000, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old answer" }] } },
  ];
  deps.agents.transcript = async () => ({ entries, running: false });
  deps.agents.postInput = async (_a, s, text) => {
    log.inputs.push({ session: s, text });
    const seq = entries.length;
    entries = [...entries,
      { type: "message", seq: seq + 1, timestamp: 3_000, message: { role: "user", content: text } },
      { type: "message", seq: seq + 2, timestamp: 4_000, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `re: ${text}` }] } }];
  };
  await call(deps, "POST", "/agents", { model: "m", name: "a" });
  const sess = (await call(deps, "POST", "/agents/sessions", { agent_id: "agent_1", environment: { type: "none" } })).body;

  const stream = (await handleAgentsApi("GET", `/agents/sessions/${sess.id}/events`, new URLSearchParams(), undefined, deps))!;
  assert(stream.status === 200 && /^text\/event-stream/.test(stream.headers.get("content-type") ?? ""), `stream: ${stream.status} ${stream.headers.get("content-type")}`);
  const posted = (await handleAgentsApi("POST", `/agents/sessions/${sess.id}/events`, new URLSearchParams(),
    { events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] }] }, deps))!;
  assert(posted.status === 204 && log.inputs.at(-1)?.text === "hello", `post: ${posted.status} ${JSON.stringify(log.inputs)}`);
  const got = frames(await stream.text());
  const types = got.map((e) => e.type);
  assert(!got.some((e) => JSON.stringify(e).includes("old answer")), "history was replayed");
  assert(types.includes("agent.session.turn.created") && types.includes("agent.session.turn.completed") && types.at(-1) === "agent.session.idle",
    `types: ${types}`);
  assert(got.find((e) => e.type === "agent.session.turn.output_text.done")?.text === "re: hello", "the answer text");

  const refused = (await handleAgentsApi("POST", `/agents/sessions/${sess.id}/events`, new URLSearchParams(),
    { events: [{ type: "agent.session.input.message", input: "a" }, { type: "agent.session.input.tool_result", turn_id: "t", call_id: "c", success: true }] }, deps))!;
  const body = await refused.json() as any;
  assert(refused.status === 400 && body.error.param === "events[1].type" && log.inputs.length === 1, `a refused batch: ${refused.status} ${JSON.stringify(body)} inputs ${log.inputs.length}`);

  const order: string[] = [];
  deps.agents.cancel = async () => { order.push("cancel"); };
  const prior = deps.agents.postInput;
  deps.agents.postInput = async (a, s2, text) => { order.push(`message:${text}`); await prior(a, s2, text); };
  const both = (await handleAgentsApi("POST", `/agents/sessions/${sess.id}/events`, new URLSearchParams(),
    { events: [{ type: "agent.session.input.cancel" }, { type: "agent.session.input.message", input: "instead" }] }, deps))!;
  assert(both.status === 204 && order.join() === "cancel,message:instead", `cancel then message: ${both.status} ${order}`);
  deps.agents.postInput = prior;

  const created = (await handleAgentsApi("POST", "/agents/sessions", new URLSearchParams(),
    { agent_id: "agent_1", environment: { type: "none" }, input: "again", stream: true }, deps))!;
  assert(/^text\/event-stream/.test(created.headers.get("content-type") ?? ""), "create with stream did not stream");
  const createdTypes = frames(await created.text()).map((e) => e.type);
  assert(log.inputs.at(-1)?.text === "again" && createdTypes.includes("agent.session.turn.completed") && createdTypes.at(-1) === "agent.session.idle",
    `create stream: ${createdTypes}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
