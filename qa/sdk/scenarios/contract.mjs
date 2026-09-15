// Contract scenarios: what the SDK sees on the wire, with or without a model behind the deployment.
// A turn here may end completed or failed (no model key); both are valid endings of the wire contract.
//
// Depends on: openai 7.15.0 — client.beta.agents resources and lib/agents/agent-session-stream.js
//   (sessions.stream). When the SDK changes, re-run and re-check these expectations.

async function agentWithSession({ client, tag, cleanup }, extra = {}) {
  const agent = await client.beta.agents.create({ model: "gpt-6-astra", name: tag, instructions: "Answer in one short sentence.", ...extra });
  cleanup(() => client.beta.agents.delete(agent.id));
  const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: "none" } });
  cleanup(() => client.beta.agents.sessions.delete(session.id));
  return { agent, session };
}

export default [
  {
    name: "agents: create, retrieve, update, list with auto-pagination, delete",
    tier: "contract",
    async run({ client, assert, tag }) {
      const api = client.beta.agents;
      const a = await api.create({ model: "gpt-6-astra", name: tag, instructions: "Write clean code." });
      assert(a.object === "agent" && a.name === tag && a.multi_agent && a.reasoning && a.text && Array.isArray(a.tools), `agent: ${JSON.stringify(a)}`);
      assert((await api.retrieve(a.id)).id === a.id, "retrieve");
      const u = await api.update(a.id, { instructions: "Be brief." });
      assert(u.instructions === "Be brief." && u.name === tag, `update: ${JSON.stringify(u)}`);
      const seen = [];
      for await (const x of api.list({ limit: 1 })) { seen.push(x.id); if (seen.length > 200) break; }
      assert(seen.includes(a.id) && new Set(seen).size === seen.length, `list: ${seen.length} seen, repeats or missing`);
      const d = await api.delete(a.id);
      assert(d.deleted === true && d.object === "agent.deleted", `delete: ${JSON.stringify(d)}`);
      try { await api.retrieve(a.id); } catch (e) { assert(e?.status === 404, `after delete: ${e?.status}`); return `${seen.length} agents paged one at a time`; }
      throw new Error("a deleted agent is still retrievable");
    },
  },
  {
    name: "sessions: create idle, inline agent, metadata update, list by agent, delete",
    tier: "contract",
    async run(ctx) {
      const { client, assert, tag, cleanup } = ctx;
      const { agent, session } = await agentWithSession(ctx);
      assert(session.object === "agent.session" && session.status === "idle" && session.agent?.id === agent.id, `session: ${JSON.stringify(session)}`);
      const inline = await client.beta.agents.sessions.create({ agent: { model: "gpt-6-astra", instructions: "inline" }, environment: { type: "none" } });
      cleanup(() => client.beta.agents.sessions.delete(inline.id));
      assert(inline.agent?.instructions === "inline" && inline.environment?.type === "none", `inline: ${JSON.stringify(inline)}`);
      const u = await client.beta.agents.sessions.update(session.id, { metadata: { run: tag } });
      assert(u.metadata?.run === tag, `metadata: ${JSON.stringify(u.metadata)}`);
      const ids = [];
      for await (const s of client.beta.agents.sessions.list({ agent_id: agent.id })) ids.push(s.id);
      assert(ids.includes(session.id) && !ids.includes(inline.id), `filtered list: ${JSON.stringify(ids)}`);
    },
  },
  {
    name: "refusals and auth: unsupported settings name their parameter; a wrong key is 401",
    tier: "contract",
    async run({ client, OpenAI, assert }) {
      const expect = async (fn, cls, param) => {
        try { await fn(); } catch (e) {
          assert(e instanceof cls, `expected ${cls.name}, got ${e?.constructor?.name}: ${e?.message}`);
          if (param) assert(e?.error?.param === param, `expected param ${param}, got ${JSON.stringify(e?.error)}`);
          return;
        }
        throw new Error(`expected ${cls.name}, but the call succeeded`);
      };
      const a = await client.beta.agents.create({ model: "m", name: "refusals" });
      try {
        await expect(() => client.beta.agents.sessions.create({ agent_id: a.id, environment: { type: "openai_hosted" }, vault_ids: ["v1"] }), OpenAI.BadRequestError, "vault_ids");
        await expect(() => client.beta.agents.create({ model: "m", tools: [{ type: "mcp", server_label: "x", server_url: "https://example.com/mcp" }] }), OpenAI.BadRequestError, "tools[0].type");
        await expect(() => client.beta.agents.sessions.create({ agent_id: a.id, environment: { type: "openai_hosted", packages: { npm: ["zod"] } } }), OpenAI.BadRequestError, "environment.packages");
        const bad = new OpenAI({ apiKey: "ap-" + "x".repeat(43), baseURL: client.baseURL, maxRetries: 0 });
        await expect(() => bad.beta.agents.list(), OpenAI.AuthenticationError);
      } finally { await client.beta.agents.delete(a.id); }
    },
  },
  {
    name: "sessions.stream: subscribes, sends input, ends at the turn's end followed by idle",
    tier: "contract",
    async run(ctx) {
      const { client, assert, TERMINAL } = ctx;
      const { session } = await agentWithSession(ctx);
      const types = [];
      for await (const e of client.beta.agents.sessions.stream(session.id, { input: "Say hello." })) types.push(e.type);
      assert(types.includes("agent.session.turn.created") && types.some((t) => TERMINAL.test(t)) && types.at(-1) === "agent.session.idle", `events: ${types}`);
      return types.join(" > ");
    },
  },
  {
    name: "items and turns: the turn and its user message are listed and retrievable",
    tier: "contract",
    async run(ctx) {
      const { client, assert } = ctx;
      const { session } = await agentWithSession(ctx);
      for await (const _ of client.beta.agents.sessions.stream(session.id, { input: "Say hello." })) { /* run one turn */ }
      const items = [];
      for await (const i of client.beta.agents.sessions.items.list(session.id, { limit: 1, order: "asc" })) items.push(i);
      assert(items[0]?.type === "message" && items[0]?.role === "user", `first item: ${JSON.stringify(items[0])}`);
      const turns = [];
      for await (const t of client.beta.agents.sessions.turns.list(session.id)) turns.push(t);
      assert(turns.length === 1 && ["completed", "failed"].includes(turns[0].status), `turns: ${JSON.stringify(turns)}`);
      const one = await client.beta.agents.sessions.turns.retrieve(turns[0].id, { session_id: session.id });
      assert(one.id === turns[0].id && one.object === "agent.session.turn", `retrieve: ${JSON.stringify(one)}`);
      return `${items.length} items [${items.map((i) => i.type).join(",")}], turn ${one.status}`;
    },
  },
  {
    name: "sessions.create with stream: true streams the first turn",
    tier: "contract",
    async run(ctx) {
      const { client, assert, TERMINAL, tag, cleanup } = ctx;
      const agent = await client.beta.agents.create({ model: "gpt-6-astra", name: tag, instructions: "Answer in one short sentence." });
      cleanup(() => client.beta.agents.delete(agent.id));
      const stream = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: "none" }, input: "Say bye.", stream: true });
      const types = [];
      for await (const e of stream) {
        types.push(e.type);
        if (e.type === "agent.session.idle" && types.some((t) => TERMINAL.test(t))) break;
      }
      assert(types.includes("agent.session.turn.created") && types.at(-1) === "agent.session.idle", `events: ${types}`);
    },
  },
  {
    name: "cancel: a running turn ends cancelled then idle; cancel on an idle session changes nothing",
    tier: "contract",
    async run(ctx) {
      const { client, assert } = ctx;
      const { session } = await agentWithSession(ctx);
      const types = [];
      let sent = false;
      for await (const e of client.beta.agents.sessions.stream(session.id, { input: "Write a long story about the sea." })) {
        types.push(e.type);
        if (e.type === "agent.session.turn.in_progress" && !sent) {
          sent = true;
          await client.beta.agents.sessions.events.create(session.id, { events: [{ type: "agent.session.input.cancel" }] });
        }
      }
      assert(sent && types.includes("agent.session.turn.cancelled") && types.at(-1) === "agent.session.idle", `events: ${types}`);
      await client.beta.agents.sessions.events.create(session.id, { events: [{ type: "agent.session.input.cancel" }] });
      const s = await client.beta.agents.sessions.retrieve(session.id);
      assert(s.status === "idle", `status after idle cancel: ${s.status}`);
    },
  },
  {
    name: "unsupported input events are refused by name",
    tier: "contract",
    async run(ctx) {
      const { client, OpenAI, assert } = ctx;
      const { session } = await agentWithSession(ctx);
      try { await client.beta.agents.sessions.events.create(session.id, { events: [{ type: "agent.session.input.environment_connection" }] }); }
      catch (e) { assert(e instanceof OpenAI.BadRequestError && e.error?.param === "events[0].type", `wrong error: ${e?.constructor?.name} ${JSON.stringify(e?.error)}`); return; }
      throw new Error("an unsupported event type was accepted");
    },
  },
];
