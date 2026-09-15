// Model scenarios: what a caller gets from a real model through the SDK. They need the deployment to
// reach a model (qa/sdk/run.sh puts the DeepSeek key on preview for the run and removes it after).
//
// Depends on: openai 7.15.0 — lib/agents/agent-session-stream.js (sessions.stream, toolHandlers) and
//   resources/beta/agents/sessions/{items,turns}. When the SDK changes, re-run and re-check these.

async function agentWithSession({ client, tag, cleanup }, agentParams = {}) {
  const agent = await client.beta.agents.create({ model: "gpt-6-astra", name: tag, ...agentParams });
  cleanup(() => client.beta.agents.delete(agent.id));
  const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: "none" } });
  cleanup(() => client.beta.agents.sessions.delete(session.id));
  return { agent, session };
}

async function runTurn(client, sessionId, params) {
  const events = [];
  for await (const e of client.beta.agents.sessions.stream(sessionId, params)) events.push(e);
  const text = events.filter((e) => e.type === "agent.session.turn.output_text.done").map((e) => e.text).join("\n");
  const ended = events.find((e) => /^agent\.session\.turn\.(completed|failed|cancelled)$/.test(e.type));
  return { events, types: events.map((e) => e.type), text, ended };
}

export default [
  {
    name: "a real answer: the turn completes with text, usage and a final_answer item",
    tier: "model",
    async run(ctx) {
      const { client, assert } = ctx;
      const { session } = await agentWithSession(ctx, { instructions: "Answer with just the number, nothing else." });
      const t = await runTurn(client, session.id, { input: "What is 17 + 25?" });
      assert(t.ended?.type === "agent.session.turn.completed", `turn ended ${t.ended?.type}: ${t.ended?.turn?.error?.message ?? t.types}`);
      assert(/\b42\b/.test(t.text), `answer text: ${JSON.stringify(t.text)}`);
      const turn = await client.beta.agents.sessions.turns.retrieve(t.ended.turn_id, { session_id: session.id });
      assert(turn.status === "completed" && turn.usage && turn.usage.input_tokens > 0 && turn.usage.output_tokens > 0, `turn: ${JSON.stringify(turn)}`);
      const items = [];
      for await (const i of client.beta.agents.sessions.items.list(session.id, { order: "asc" })) items.push(i);
      assert(items.some((i) => i.type === "message" && i.role === "assistant" && i.phase === "final_answer"), `items: ${items.map((i) => `${i.type}:${i.role ?? ""}:${i.phase ?? ""}`)}`);
      return `answer ${JSON.stringify(t.text)} · ${turn.usage.input_tokens}+${turn.usage.output_tokens} tokens`;
    },
  },
  {
    name: "a follow-up turn keeps the conversation's context",
    tier: "model",
    async run(ctx) {
      const { client, assert } = ctx;
      const { session } = await agentWithSession(ctx, { instructions: "Answer in as few words as possible." });
      const first = await runTurn(client, session.id, { input: "Remember this code word: heliotrope. Reply only OK." });
      assert(first.ended?.type === "agent.session.turn.completed", `first turn ${first.ended?.type}`);
      const second = await runTurn(client, session.id, { input: "What was the code word? Reply with the word only." });
      assert(second.ended?.type === "agent.session.turn.completed", `second turn ${second.ended?.type}`);
      assert(/heliotrope/i.test(second.text), `second answer: ${JSON.stringify(second.text)}`);
      const turns = [];
      for await (const x of client.beta.agents.sessions.turns.list(session.id, { order: "asc" })) turns.push(x.status);
      assert(turns.join() === "completed,completed", `turns: ${turns}`);
      return `second answer ${JSON.stringify(second.text)}`;
    },
  },
  {
    name: "a function the caller runs: the SDK's toolHandlers answers it and the model uses the result",
    tier: "model",
    async run(ctx) {
      const { client, assert } = ctx;
      const { session } = await agentWithSession(ctx, {
        instructions: "For weather questions always call get_weather, then answer in one sentence using its result.",
        tools: [{
          type: "function", name: "get_weather", description: "Current weather for a city.",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
        }],
      });
      const calls = [];
      const t = await runTurn(client, session.id, {
        input: "What's the weather in Oslo right now?",
        toolHandlers: {
          get_weather: async (args) => { calls.push(args); return { city: args.city, forecast: "light rain", temperature_c: 13 }; },
        },
      });
      assert(calls.length >= 1 && /oslo/i.test(String(calls[0]?.city)), `handler calls: ${JSON.stringify(calls)}`);
      assert(t.types.includes("agent.session.requires_action"), `no requires_action: ${t.types}`);
      assert(t.ended?.type === "agent.session.turn.completed", `turn ended ${t.ended?.type}: ${t.ended?.turn?.error?.message ?? ""}`);
      assert(/13|rain/i.test(t.text), `the answer does not use the function's result: ${JSON.stringify(t.text)}`);
      const items = [];
      for await (const i of client.beta.agents.sessions.items.list(session.id, { order: "asc" })) items.push(i);
      const out = items.find((i) => i.type === "function_call_output");
      assert(items.some((i) => i.type === "function_call" && i.name === "get_weather" && i.status === "completed"), `items: ${items.map((i) => `${i.type}:${i.status ?? ""}`)}`);
      assert(out && String(out.output).includes("light rain") && !String(out.output).includes("waiting for the caller"), `output item: ${JSON.stringify(out)}`);
      return `handler got ${JSON.stringify(calls[0])} · answer ${JSON.stringify(t.text)}`;
    },
  },
  {
    name: "cancelling a real turn mid-answer, then the next turn still answers",
    tier: "model",
    async run(ctx) {
      const { client, assert } = ctx;
      const { session } = await agentWithSession(ctx, { instructions: "Be helpful." });
      const types = [];
      let sent = false;
      for await (const e of client.beta.agents.sessions.stream(session.id, { input: "Write a 2000-word story about a lighthouse keeper." })) {
        types.push(e.type);
        if (e.type === "agent.session.turn.in_progress" && !sent) {
          sent = true;
          await client.beta.agents.sessions.events.create(session.id, { events: [{ type: "agent.session.input.cancel" }] });
        }
      }
      assert(types.includes("agent.session.turn.cancelled") && types.at(-1) === "agent.session.idle", `events: ${types}`);
      const next = await runTurn(client, session.id, { input: "Reply with just the word OK." });
      assert(next.ended?.type === "agent.session.turn.completed" && /ok/i.test(next.text), `next turn: ${next.ended?.type} ${JSON.stringify(next.text)}`);
      return `cancelled, then ${JSON.stringify(next.text)}`;
    },
  },
];
