/**
 * The objects the OpenAI SDK reads, and what antiproton refuses rather than
 * ignores (task #17). Field lists are the SDK's own (`openai` 7.15.0).
 */
import {
  agentDeleted, cursorPage, openAIError, parseAgentParams, parseEnvironment, toOpenAIAgent, toOpenAISession,
} from "../cf/src/agents-api/shapes.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const now = 1_800_000_000_000;
const keys = (o: object) => Object.keys(o).sort().join(",");

await check("an error is OpenAI's body: the SDK finds error.message and the status picks its class", async () => {
  const r = openAIError(400, "tools[0].type: the tool type \"mcp\" is not supported", { param: "tools[0].type", code: "unsupported_parameter" });
  assert(r.status === 400, `status ${r.status}`);
  const b = await r.json() as any;
  assert(keys(b) === "error" && keys(b.error) === "code,message,param,type", `body keys: ${JSON.stringify(b)}`);
  assert(b.error.param === "tools[0].type" && b.error.code === "unsupported_parameter", `fields: ${JSON.stringify(b.error)}`);
});

await check("an agent carries every field the SDK's Agent declares, with its defaults", async () => {
  const p = parseAgentParams({ model: "gpt-6-astra", name: "coder", instructions: "Write clean code." }, "create", undefined, now);
  assert(p.ok, `valid create refused: ${JSON.stringify(p)}`);
  const a = toOpenAIAgent("agent_1", (p as any).value);
  assert(keys(a) === "created_at,id,instructions,metadata,model,multi_agent,name,object,reasoning,service_tier,text,tools,updated_at", `agent keys: ${keys(a)}`);
  assert(a.object === "agent" && a.model === "gpt-6-astra" && a.created_at === 1_800_000_000, `values: ${JSON.stringify(a)}`);
  assert(a.multi_agent.enabled === false && a.text.format.type === "text" && a.service_tier === "auto", `defaults: ${JSON.stringify(a)}`);
  assert(keys(agentDeleted("agent_1")) === "deleted,id,object", "AgentDeleted fields");
});

await check("what antiproton does not do is refused by name, and its off/default value is still accepted", async () => {
  const refused: Array<[unknown, string]> = [
    [{ model: "m", multi_agent: { enabled: true } }, "multi_agent"],
    [{ model: "m", reasoning: { effort: "high" } }, "reasoning"],
    [{ model: "m", service_tier: "priority" }, "service_tier"],
    [{ model: "m", text: { format: { type: "json_schema", schema: {} } } }, "text.format"],
    [{ model: "m", tools: [{ type: "mcp", server_label: "x" }] }, "tools[0].type"],
    [{ model: "m", tools: [{ type: "web_search" }] }, "tools[0].type"],
  ];
  for (const [body, param] of refused) {
    const r: any = parseAgentParams(body, "create", undefined, now);
    assert(!r.ok && r.param === param && r.status === 400 && r.code === "unsupported_parameter", `${param} was not refused: ${JSON.stringify(r)}`);
  }
  const defaults: any = parseAgentParams({ model: "m", multi_agent: { enabled: false }, reasoning: { effort: null, summary: null }, service_tier: "auto", text: { format: { type: "text" }, verbosity: "medium" } }, "create", undefined, now);
  assert(defaults.ok, `the SDK's own defaults were refused: ${JSON.stringify(defaults)}`);
  const missing: any = parseAgentParams({ name: "x" }, "create", undefined, now);
  assert(!missing.ok && missing.param === "model", "a create without model was accepted");
});

await check("an update changes only what it names", async () => {
  const created: any = parseAgentParams({ model: "m", name: "a", instructions: "i", metadata: { team: "x" } }, "create", undefined, now);
  const updated: any = parseAgentParams({ instructions: "new" }, "update", created.value, now + 5_000);
  assert(updated.ok && updated.value.name === "a" && updated.value.instructions === "new" && updated.value.metadata.team === "x", `update: ${JSON.stringify(updated)}`);
  assert(updated.value.createdAt === now && updated.value.updatedAt === now + 5_000, "timestamps not kept/advanced");
});

await check("an environment: hosted with nothing configured is our container, none is none, configuring it is refused", async () => {
  assert((parseEnvironment({ type: "openai_hosted" }) as any).kind === "container", "bare openai_hosted not accepted");
  assert((parseEnvironment({ type: "openai_hosted", files: [], packages: {} }) as any).kind === "container", "empty extras refused");
  assert((parseEnvironment({ type: "none" }) as any).kind === "none", "none not accepted");
  const pk: any = parseEnvironment({ type: "openai_hosted", packages: { python: ["numpy"] } });
  assert(!pk.ok && pk.param === "environment.packages", `packages not refused: ${JSON.stringify(pk)}`);
  const sh: any = parseEnvironment({ type: "self_hosted" });
  assert(!sh.ok && sh.param === "environment.type", "self_hosted not refused");
  assert(!(parseEnvironment(undefined) as any).ok, "a missing environment was accepted");
});

await check("a session carries every field the SDK's AgentSession declares", async () => {
  const agent: any = parseAgentParams({ model: "m" }, "create", undefined, now);
  const s = toOpenAISession({ id: "sess_1", agentId: "agent_1", environment: "container", metadata: {}, createdAt: now, lastActiveAt: now }, agent.value);
  assert(keys(s) === "agent,created_at,environment,error,id,last_active_at,metadata,object,required_actions,status,usage,vault_ids", `session keys: ${keys(s)}`);
  assert(s.object === "agent.session" && s.status === "idle" && (s.environment as any).type === "openai_hosted", `values: ${JSON.stringify(s)}`);
  assert(keys(s.agent) === "id,instructions,model,multi_agent,name,reasoning,service_tier,text,tools", `session.agent keys: ${keys(s.agent)}`);
});

await check("a cursor page the SDK can walk to the end, and cannot loop on", async () => {
  const items = Array.from({ length: 45 }, (_, i) => ({ id: `x${i}` }));
  const seen: string[] = []; let after: string | undefined; let pages = 0;
  for (;;) {
    const r: any = cursorPage(items, { after, limit: 20, order: "asc" });
    assert(r.ok, `page refused: ${JSON.stringify(r)}`);
    seen.push(...r.page.data.map((d: any) => d.id)); pages++;
    if (!r.page.has_more) break;
    after = r.page.data[r.page.data.length - 1].id;
    assert(pages < 10, "the pages never end");
  }
  assert(pages === 3 && seen.length === 45 && new Set(seen).size === 45 && seen[0] === "x0" && seen[44] === "x44", `walked ${pages} pages, ${seen.length} items`);
  // The boundary the loose rule gets wrong: a list that is an exact multiple of the page size must say it ended
  // on its last full page, not send the SDK after one more (45 items could not tell `<` from `<=`).
  const exact = Array.from({ length: 40 }, (_, i) => ({ id: `y${i}` }));
  const p1: any = cursorPage(exact, { limit: 20, order: "asc" });
  const p2: any = cursorPage(exact, { after: "y19", limit: 20, order: "asc" });
  assert(p1.page.has_more === true && p2.page.data.length === 20, `exact-multiple pages: ${JSON.stringify([p1.page.has_more, p2.page.data.length])}`);
  assert(p2.page.has_more === false, "the last full page of an exact multiple still claims there is more");
  const desc: any = cursorPage(items, { limit: 2 });
  assert(desc.page.data[0].id === "x44", "default order is not newest first");
  assert(!(cursorPage(items, { after: "nope" }) as any).ok, "an unknown after restarted the list");
  assert(!(cursorPage(items, { limit: 500 }) as any).ok, "limit above 100 accepted");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
