/**
 * The Agents API's `model` field (cf/src/agents-api/model.ts): the owner's pick, the same one the console's picker
 * makes, checked against what the deployment offers and outranked by an admin's agent or tenant row.
 *
 * The first half drives the handlers with the real resolver over an in-memory store; the second goes through the
 * Worker's own `fetch` with an API key, the real migrations on node:sqlite and `AgentDO` (the `cloudflare:workers`
 * stand-in test/user-models.ts uses), so the agent's operator binding after its first input is the shipped one.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { providersFrom } from "../src/model/providers.ts";
import { userModelsFrom } from "../src/model/user-models.ts";
import { handleAgentsApi, type AgentsApiDeps } from "../cf/src/agents-api/handlers.ts";
import type { StoredAgent, StoredSession } from "../cf/src/agents-api/shapes.ts";
import type { ModelLayers } from "../cf/src/control-plane.ts";
import { d1ApiKeys, d1ModelChoices, d1ModelOverrides } from "../cf/src/control-plane.ts";
import { hashApiKey, newApiKey } from "../cf/src/agents-api/keys.ts";
import { agentObjectName } from "../cf/src/object-name.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const PROVIDERS = [
  { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
  { id: "cloudflare", baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/antiproton/compat", auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
];
const FLASH = { id: "deepseek-flash", label: "DeepSeek Flash", provider: "deepseek", model: "deepseek-flash" };
const LUNA = { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "cloudflare", model: "openai/gpt-5.6-luna" };
const DK = "dk-secret-value-1234", GT = "gt-secret-value-5678";
const UM = userModelsFrom({ USER_MODELS: [FLASH, LUNA] }, providersFrom({ MODEL_PROVIDERS: PROVIDERS, DEEPSEEK_API_KEY: DK, AI_GATEWAY_TOKEN: GT }));
const ADMIN = { provider: "deepseek", model: "deepseek-v4-pro" };

// ---- the handlers, over an in-memory store ----------------------------------

function fake() {
  let t = 1_800_000_000_000, n = 0;
  const agents = new Map<string, StoredAgent>(), sessions = new Map<string, StoredSession>();
  const picks = new Map<string, string>();
  const admin = { agent: new Map<string, { provider: string; model: string }>(), tenant: null as { provider: string; model: string } | null, deployment: null as { provider: string; model: string } | null };
  let failPut = false;
  const adopted: string[] = [];
  const deps: AgentsApiDeps = {
    now: () => (t += 1000),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    streamMaxMs: 60_000,
    mintAgentId: () => `agent_${++n}`,
    mintSessionId: () => `sess_${++n}`,
    index: {
      putAgent: async (id, a) => { if (failPut) throw new Error("index down"); agents.set(id, a); },
      getAgent: async (id) => agents.get(id) ?? null,
      listAgents: async () => [...agents.entries()].map(([id, agent]) => ({ id, agent })),
      deleteAgent: async (id) => agents.delete(id),
      putSession: async (s) => { sessions.set(s.id, s); },
      getSession: async (id) => sessions.get(id) ?? null,
      listSessions: async (agentId) => [...sessions.values()].filter((s) => !agentId || s.agentId === agentId),
      deleteSession: async (id) => sessions.delete(id),
    },
    agents: {
      adopt: async (id) => { adopted.push(id); },
      openSession: async () => {},
      postInput: async () => {},
      status: async () => ({ status: "idle" as const, pending: [] }),
      toolResults: async () => ({ unknown: [] }),
      cancel: async () => {},
      transcript: async () => ({ entries: [], running: false, pending: [] }),
    },
    models: {
      userModels: UM, defaultModel: "deepseek-flash",
      layers: async (id): Promise<ModelLayers> => ({ agent: admin.agent.get(id) ?? null, tenant: admin.tenant, deployment: admin.deployment, owner: picks.get(id) ?? null }),
      put: async (id, choice) => { picks.set(id, choice); },
      remove: async (id) => { picks.delete(id); },
    },
  };
  return { deps, agents, sessions, picks, admin, adopted, failPut: (v: boolean) => { failPut = v; } };
}
const call = async (deps: AgentsApiDeps, method: string, path: string, body?: unknown, qs = "") => {
  const r = (await handleAgentsApi(method, path, new URLSearchParams(qs), body, deps))!;
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as any };
};

await check("create: an option's id or its provider/model is stored as the owner's pick by id, and the agent reads back as that id", async () => {
  const f = fake();
  const a = await call(f.deps, "POST", "/agents", { model: "gpt-5.6-luna", name: "a" });
  must(a.status === 200 && a.body.model === "gpt-5.6-luna", `${a.status} ${show(a.body)}`);
  must(f.picks.get(a.body.id) === LUNA.id, `the pick was not stored: ${show([...f.picks])}`);
  const b = await call(f.deps, "POST", "/agents", { model: "cloudflare/openai/gpt-5.6-luna", name: "b" });
  must(b.status === 200 && b.body.model === "gpt-5.6-luna" && f.picks.get(b.body.id) === LUNA.id, `provider/model: ${show(b.body)} ${show([...f.picks])}`);
  must((await call(f.deps, "GET", `/agents/${b.body.id}`)).body.model === "gpt-5.6-luna", "retrieve");
});

await check("create: `default` stores no pick and reads back as what runs — the default's option id", async () => {
  const f = fake();
  const a = await call(f.deps, "POST", "/agents", { model: "default" });
  must(a.status === 200 && a.body.model === "deepseek-flash" && f.picks.size === 0, `${show(a.body)} ${show([...f.picks])}`);
});

await check("an unknown model is 400 in OpenAI's error shape naming `model`, and nothing is made — create, inline session agent, update", async () => {
  const f = fake();
  for (const model of ["gpt-6-astra", "openai/gpt-5.6-luna", "deepseek/deepseek-v4-pro", "Default"]) {
    const r = await call(f.deps, "POST", "/agents", { model });
    must(r.status === 400 && show(Object.keys(r.body.error)) === show(["message", "type", "param", "code"]), `${model}: ${r.status} ${show(r.body)}`);
    must(r.body.error.type === "invalid_request_error" && r.body.error.param === "model" && r.body.error.code === "model_not_found", `${model}: ${show(r.body)}`);
    must(/"default", "deepseek-flash", "gpt-5.6-luna"/.test(r.body.error.message), `the refusal does not say what may be sent: ${r.body.error.message}`);
  }
  const s = await call(f.deps, "POST", "/agents/sessions", { agent: { model: "gpt-6-astra" }, environment: { type: "none" }, input: "hi" });
  must(s.status === 400 && s.body.error.param === "agent.model" && s.body.error.code === "model_not_found", `inline: ${s.status} ${show(s.body)}`);
  must(f.agents.size === 0 && f.sessions.size === 0 && f.picks.size === 0 && f.adopted.length === 0, `a refused create left something: ${f.agents.size} ${f.sessions.size} ${f.picks.size}`);
  const ok = await call(f.deps, "POST", "/agents", { model: "gpt-5.6-luna" });
  const u = await call(f.deps, "POST", `/agents/${ok.body.id}`, { model: "nope", instructions: "changed" });
  must(u.status === 400 && u.body.error.code === "model_not_found", `update: ${show(u.body)}`);
  must(f.agents.get(ok.body.id)!.instructions === null && f.picks.get(ok.body.id) === LUNA.id, "a refused update changed the agent or its pick");
});

await check("update: `model` moves the pick, `default` clears it, and an update without `model` leaves it alone", async () => {
  const f = fake();
  const a = await call(f.deps, "POST", "/agents", { model: "default" });
  const id = a.body.id;
  must((await call(f.deps, "POST", `/agents/${id}`, { model: "gpt-5.6-luna" })).body.model === "gpt-5.6-luna" && f.picks.get(id) === LUNA.id, "to luna");
  must((await call(f.deps, "POST", `/agents/${id}`, { instructions: "x" })).body.model === "gpt-5.6-luna" && f.picks.get(id) === LUNA.id, "an update without model moved the pick");
  must((await call(f.deps, "POST", `/agents/${id}`, { model: "default" })).body.model === "deepseek-flash" && !f.picks.has(id), "default did not clear");
  // A pick made elsewhere (the console's picker) is what the API reads back, list and session included.
  f.picks.set(id, LUNA.id);
  must((await call(f.deps, "GET", `/agents/${id}`)).body.model === "gpt-5.6-luna", "retrieve after a console pick");
  must((await call(f.deps, "GET", "/agents")).body.data[0].model === "gpt-5.6-luna", "list after a console pick");
  const s = await call(f.deps, "POST", "/agents/sessions", { agent_id: id, environment: { type: "none" } });
  must(s.body.agent.model === "gpt-5.6-luna", `session.agent.model: ${show(s.body.agent)}`);
});

await check("an admin's row: the agent reads as the admin's model; another option or `default` is 409 `model_locked` and stores nothing; the name read back is accepted and changes nothing", async () => {
  const f = fake();
  const a = await call(f.deps, "POST", "/agents", { model: "gpt-5.6-luna" });
  const id = a.body.id;
  f.admin.agent.set(id, ADMIN);
  must((await call(f.deps, "GET", `/agents/${id}`)).body.model === "deepseek/deepseek-v4-pro", "an admin-set agent does not read as the admin's model");
  const r = await call(f.deps, "POST", `/agents/${id}`, { model: "deepseek-flash" });
  must(r.status === 409 && r.body.error.code === "model_locked" && r.body.error.param === "model" && /deepseek\/deepseek-v4-pro/.test(r.body.error.message), `${r.status} ${show(r.body)}`);
  must(f.picks.get(id) === LUNA.id, "a locked update changed the pick");
  // Echoing the object read back is neither refused nor a change: the owner's pick survives the lock.
  const echo = await call(f.deps, "POST", `/agents/${id}`, { model: "deepseek/deepseek-v4-pro" });
  must(echo.status === 200 && echo.body.model === "deepseek/deepseek-v4-pro", `echo: ${echo.status} ${show(echo.body)}`);
  must(f.picks.get(id) === LUNA.id, "echoing the admin's model cleared the owner's pick");
  // `default` under the lock is refused too, as the console's picker refuses clearing: it would not change what runs.
  const def = await call(f.deps, "POST", `/agents/${id}`, { model: "default", instructions: "changed" });
  must(def.status === 409 && def.body.error.code === "model_locked", `default under a lock: ${def.status} ${show(def.body)}`);
  must(f.picks.get(id) === LUNA.id && f.agents.get(id)!.instructions === null, "a refused `default` under a lock changed the pick or the agent");
  // The admin's name is accepted only while it is what runs: with the row gone it is an unknown model.
  f.admin.agent.delete(id);
  must((await call(f.deps, "POST", `/agents/${id}`, { model: "deepseek/deepseek-v4-pro" })).status === 400, "a stale echo was accepted");
  // A tenant row decides a new agent too: create with an option is refused, with `default` it is made.
  f.admin.tenant = ADMIN;
  const c = await call(f.deps, "POST", "/agents", { model: "gpt-5.6-luna" });
  must(c.status === 409 && c.body.error.code === "model_locked" && f.agents.size === 1, `create under a tenant row: ${c.status} ${show(c.body)}`);
  const d = await call(f.deps, "POST", "/agents", { model: "default" });
  must(d.status === 409 && d.body.error.code === "model_locked" && f.agents.size === 1, `default under a tenant row: ${d.status} ${show(d.body)}`);
  const e = await call(f.deps, "POST", "/agents", { model: "deepseek/deepseek-v4-pro" });
  must(e.status === 200 && e.body.model === "deepseek/deepseek-v4-pro" && !f.picks.has(e.body.id), `the admin's name under a tenant row: ${show(e.body)} ${show([...f.picks])}`);
});

await check("echoing the default's option id stores no pick: the agent still follows the deployment, not pinned above its row", async () => {
  const f = fake();
  const a = await call(f.deps, "POST", "/agents", { model: "default" });
  const id = a.body.id;
  must(a.body.model === "deepseek-flash", `read back: ${show(a.body)}`);
  const u = await call(f.deps, "POST", `/agents/${id}`, { ...a.body, instructions: "edited" });
  must(u.status === 200 && u.body.model === "deepseek-flash" && u.body.instructions === "edited", `echo: ${u.status} ${show(u.body)}`);
  must(!f.picks.has(id), `echoing the read-back name stored a pick: ${show([...f.picks])}`);
  // An admin's deployment row now applies to the agent; a pick would have outranked it.
  f.admin.deployment = { provider: LUNA.provider, model: LUNA.model };
  must((await call(f.deps, "GET", `/agents/${id}`)).body.model === "gpt-5.6-luna", "the agent does not follow the deployment row");
  // Created with the read-back name, too: nothing is pinned.
  f.admin.deployment = null;
  const c = await call(f.deps, "POST", "/agents", { model: "deepseek-flash" });
  must(c.status === 200 && !f.picks.has(c.body.id), `create with the read-back name stored a pick: ${show([...f.picks])}`);
});

await check("an admin's row on an option: echoing that option's id keeps the owner's pick", async () => {
  const f = fake();
  const a = await call(f.deps, "POST", "/agents", { model: "gpt-5.6-luna" });
  const id = a.body.id;
  // The owner pins the default's option in the console's picker, then an admin moves the agent to Luna.
  f.picks.set(id, FLASH.id);
  f.admin.agent.set(id, { provider: LUNA.provider, model: LUNA.model });
  const read = await call(f.deps, "GET", `/agents/${id}`);
  must(read.body.model === "gpt-5.6-luna", `read back under the admin's row: ${show(read.body)}`);
  const echo = await call(f.deps, "POST", `/agents/${id}`, { model: "gpt-5.6-luna" });
  must(echo.status === 200 && echo.body.model === "gpt-5.6-luna", `echo: ${echo.status} ${show(echo.body)}`);
  must(f.picks.get(id) === FLASH.id, `echoing the admin's option overwrote the owner's pick: ${show([...f.picks])}`);
  // The owner's pick comes back when the row goes.
  f.admin.agent.delete(id);
  must((await call(f.deps, "GET", `/agents/${id}`)).body.model === "deepseek-flash", "the owner's pick did not return");
});

await check("an agent created before `model` was the pick: sending back its old string changes nothing; another unknown string is 400", async () => {
  const f = fake();
  const legacy: StoredAgent = { name: "old", instructions: null, model: "gpt-6-astra", metadata: {}, tools: [], createdAt: 1, updatedAt: 1 };
  f.agents.set("agent_old", legacy);
  must((await call(f.deps, "GET", "/agents/agent_old")).body.model === "deepseek-flash", "a legacy agent does not read as what runs");
  const u = await call(f.deps, "POST", "/agents/agent_old", { model: "gpt-6-astra", instructions: "edited" });
  must(u.status === 200 && u.body.model === "deepseek-flash" && u.body.instructions === "edited", `legacy echo: ${u.status} ${show(u.body)}`);
  must(!f.picks.has("agent_old") && f.agents.get("agent_old")!.model === "gpt-6-astra", `legacy echo stored a pick or lost the record: ${show([...f.picks])} ${f.agents.get("agent_old")!.model}`);
  // Twice: the record still holds it.
  must((await call(f.deps, "POST", "/agents/agent_old", { model: "gpt-6-astra" })).status === 200, "a second legacy echo");
  const bad = await call(f.deps, "POST", "/agents/agent_old", { model: "gpt-7" });
  must(bad.status === 400 && bad.body.error.code === "model_not_found", `another unknown string: ${bad.status} ${show(bad.body)}`);
});

await check("delete removes the agent's pick; a create whose index row fails leaves no pick", async () => {
  const f = fake();
  const a = await call(f.deps, "POST", "/agents", { model: "gpt-5.6-luna" });
  must(f.picks.has(a.body.id), "no pick to delete");
  must((await call(f.deps, "DELETE", `/agents/${a.body.id}`)).status === 200 && !f.picks.has(a.body.id), `the pick outlived its agent: ${show([...f.picks])}`);
  f.failPut(true);
  let threw = false;
  try { await call(f.deps, "POST", "/agents", { model: "gpt-5.6-luna" }); } catch { threw = true; }
  must(threw && f.picks.size === 0, `a create that failed at its index row left a pick: ${threw} ${show([...f.picks])}`);
  threw = false;
  try { await call(f.deps, "POST", "/agents/sessions", { agent: { model: "gpt-5.6-luna" }, environment: { type: "none" } }); } catch { threw = true; }
  must(threw && f.picks.size === 0, `an inline create that failed at its index row left a pick: ${threw} ${show([...f.picks])}`);
});

// ---- through the Worker, to the binding --------------------------------------

/** D1 as node:sqlite, with every migration in cf/migrations applied. */
function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    q, b,
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.prepare(q).get(...(b as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...(b as any[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  return {
    raw: db,
    prepare: (q: string) => stmt(q),
    batch: async (s: any[]) => s.map((x) => ({ results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } })),
  } as unknown as D1Database & { raw: DatabaseSync };
}

const T = "t1", OWNER = "owner1";
const DB = d1();
const hosts: Array<{ dispose(): void }> = [];
const objects = new Map<string, any>();
const env: Record<string, unknown> = {
  MODEL_QUEUE: { send: async () => {} },
  ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
  ARTIFACT_BUCKET: "b", CONTROL_DB: DB, HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  MODEL_PROVIDERS: PROVIDERS, USER_MODELS: [FLASH, LUNA], DEEPSEEK_API_KEY: DK, AI_GATEWAY_TOKEN: GT,
  SECRET_KEK: Buffer.alloc(32, 7).toString("base64"),
  AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? fresh(n) },
};
function fresh(n: string) {
  const own = sqliteHost();
  hosts.push(own);
  let alarmAt: number | null = null;
  const o = new AgentDO({
    storage: { sql: own.sql, transactionSync: own.transactionSync, getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => n }, getWebSockets: () => [], exports: {},
  } as never, env as never);
  objects.set(n, o);
  return o;
}
const KEY = newApiKey();
await d1ApiKeys(DB).issue({ hash: await hashApiKey(KEY), tenantId: T, ownerAgentId: OWNER, label: "test" });
async function v1(method: string, path: string, body?: unknown) {
  const r = await worker.fetch(new Request(`https://api.test/v1${path}`, {
    method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env as never);
  const text = await r.text();
  return { status: r.status, text, body: (text ? JSON.parse(text) : null) as any };
}
async function bound(agentId: string) {
  const o = objects.get(agentObjectName(T, agentId));
  const b = o ? await o.runtime().store.getModelBinding(T, agentId) : null;
  return b ? `${b.secretRef} ${b.model}` : "none";
}

await check("worker: an agent created with `gpt-5.6-luna` runs its first input on GPT-5.6 Luna; one created with `default` on DeepSeek", async () => {
  const luna = await v1("POST", "/agents", { model: "gpt-5.6-luna", name: "luna" });
  must(luna.status === 200 && luna.body.model === "gpt-5.6-luna", `${luna.status} ${luna.text}`);
  const row: any = DB.raw.prepare("SELECT * FROM model_choices WHERE tenant_id = ? AND agent_id = ?").get(T, luna.body.id);
  must(row?.choice_id === LUNA.id && row.set_by === `api:${OWNER}`, `stored: ${show(row)}`);
  const s = await v1("POST", "/agents/sessions", { agent_id: luna.body.id, environment: { type: "none" }, input: "hello" });
  must(s.status === 200 && s.body.agent.model === "gpt-5.6-luna", `${s.status} ${s.text}`);
  must(await bound(luna.body.id) === "operator:model:cloudflare openai/gpt-5.6-luna", `bound: ${await bound(luna.body.id)}`);

  const flash = await v1("POST", "/agents/sessions", { agent: { model: "default" }, environment: { type: "none" }, input: "hello" });
  must(flash.status === 200 && flash.body.agent.model === "deepseek-flash", `${flash.status} ${flash.text}`);
  must(await bound(flash.body.agent.id) === "operator:model deepseek-flash", `bound: ${await bound(flash.body.agent.id)}`);
});

await check("worker: an update moves the binding when it is made, before any input; an admin's agent row then wins, reads back, and refuses another pick", async () => {
  const a = await v1("POST", "/agents", { model: "default" });
  const id = a.body.id;
  const s = await v1("POST", "/agents/sessions", { agent_id: id, environment: { type: "none" }, input: "one" });
  must(await bound(id) === "operator:model deepseek-flash", `first: ${await bound(id)}`);
  must((await v1("POST", `/agents/${id}`, { model: "gpt-5.6-luna" })).body.model === "gpt-5.6-luna", "update");
  // Bound by the update itself (AgentDO.apiAdopt), so the agent's next model call runs on the pick whatever starts it.
  must(await bound(id) === "operator:model:cloudflare openai/gpt-5.6-luna", `the update did not rebind: ${await bound(id)}`);
  must((await v1("POST", `/agents/${id}`, { model: "default" })).body.model === "deepseek-flash" && await bound(id) === "operator:model deepseek-flash",
    `clearing the pick did not rebind: ${await bound(id)}`);
  must((await v1("POST", `/agents/${id}`, { model: "gpt-5.6-luna" })).status === 200, "back to luna");
  await v1("POST", `/agents/sessions/${s.body.id}/events`, { events: [{ type: "agent.session.input.message", input: "two" }] });
  must(await bound(id) === "operator:model:cloudflare openai/gpt-5.6-luna", `after the next input: ${await bound(id)}`);
  await d1ModelOverrides(DB).put({ tenantId: T, agentId: id, ...ADMIN, setBy: "adm", setAt: 1 });
  must((await v1("GET", `/agents/${id}`)).body.model === "deepseek/deepseek-v4-pro", "an admin-set agent reads as its pick");
  const locked = await v1("POST", `/agents/${id}`, { model: "deepseek-flash" });
  must(locked.status === 409 && locked.body.error.code === "model_locked", `${locked.status} ${locked.text}`);
  await v1("POST", `/agents/sessions/${s.body.id}/events`, { events: [{ type: "agent.session.input.message", input: "three" }] });
  must(await bound(id) === "operator:model deepseek-v4-pro", `the admin's row did not win: ${await bound(id)}`);
  must((await d1ModelChoices(DB).layers(T, id)).owner === LUNA.id, "the owner's pick was lost under the lock");
});

await check("worker: no answer names an endpoint, a gateway or a secret", async () => {
  const all = [await v1("GET", "/agents"), await v1("POST", "/agents", { model: "nope" }), await v1("POST", "/agents", { model: "gpt-5.6-luna" })];
  for (const r of all) for (const bad of [DK, GT, "DEEPSEEK_API_KEY", "AI_GATEWAY_TOKEN", "gateway.ai.cloudflare.com", "api.deepseek.com"]) {
    must(!r.text.includes(bad), `${bad} in ${r.text.slice(0, 200)}`);
  }
});

for (const h of hosts) h.dispose();
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
