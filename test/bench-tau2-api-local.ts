/**
 * The Agents API τ² runner end to end, against the Worker in this process: `worker.fetch` and `AgentDO` on
 * node:sqlite with every migration (the harness test/agents-api-model.ts uses), the model queue answered by
 * the queue consumer's own provider call (cf/src/model-request.ts `callQueuedModel`) with the provider's HTTP
 * endpoint stubbed, and the runner's task driver (bench/tau2/api-task.ts) given the Worker's `fetch`. No
 * network, no deployment.
 *
 * One task runs to `dbMatch` through every piece the runner uses: the minted key, the agent made with the
 * retail functions, the stream, `requires_action` and the results sent back, the status read, the grade, the
 * transcript and activity through the operator's routes, the ledger and `/admin/models` for the provider, and
 * the deletes. Then the Luna arm reads its provider from the ledger, a ledger that disagrees with the agent
 * stops the run, and the run's key is revoked.
 *
 * Also pinned here, because only this harness sees them: what the provider is handed — the tools byte-equal to
 * the gateway's construction of the mounted `retail` catalogue (limit sentence included), and the system prompt
 * equal to the core prompt and the policy.
 */
import { register } from "node:module";
import { existsSync, mkdtempSync, readdirSync as list, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { BASE_SYSTEM } from "../src/runtime/pi-prompt.ts";
import { qualifyMountedTools } from "../src/runtime/pi-tools.ts";
import { retailPlugin, type RetailDB } from "../bench/tau2/retail.ts";
import { retailFunctions } from "../bench/tau2/api-tools.ts";
import { apiClient } from "../bench/tau2/api-client.ts";
import { RunRefusal, runApiTask, type ApiTaskDeps } from "../bench/tau2/api-task.ts";
import { runApiBench, type ApiRunOptions } from "../bench/tau2/api-run.ts";
import { apiRunRecord } from "../bench/tau2/api-record.ts";
import { deafnessBudget } from "../bench/tau2/deafness.ts";
import { agentObjectName } from "../cf/src/object-name.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { mountedToolEntries, parkedReader, withLimitNote } = await import("../cf/src/runtime.ts");
const { callQueuedModel } = await import("../cf/src/model-request.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

// ---- the deployment, in this process ------------------------------------------

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
    prepare: (q: string) => stmt(q),
    batch: async (s: any[]) => s.map((x) => ({ results: x.q.trim().toUpperCase().startsWith("SELECT") ? db.prepare(x.q).all(...(x.b as any[])) : [], meta: { changes: x.q.trim().toUpperCase().startsWith("SELECT") ? 0 : Number(db.prepare(x.q).run(...(x.b as any[])).changes) } })),
  } as unknown as D1Database;
}

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/acct/antiproton/compat";
const PROVIDERS = [
  { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
  { id: "cloudflare", baseUrl: GATEWAY, auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
];
const USER_MODELS = [
  { id: "deepseek-flash", label: "DeepSeek Flash", provider: "deepseek", model: "deepseek-flash" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "cloudflare", model: "openai/gpt-5.6-luna" },
];
const OPERATOR = "operator-token-for-this-test";
const jobs: Array<{ tenantId: string; agentId: string; jobId: string }> = [];
const objects = new Map<string, { o: any; alarm: { at: number | null }; dispose(): void }>();
const env: Record<string, unknown> = {
  MODEL_QUEUE: { send: async (m: any) => { jobs.push(m); } },
  ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
  ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  MODEL_PROVIDERS: PROVIDERS, USER_MODELS, DEEPSEEK_API_KEY: "dk-test", AI_GATEWAY_TOKEN: "gt-test",
  AUTOMATION_TOKEN: OPERATOR, SECRET_KEK: Buffer.alloc(32, 7).toString("base64"),
  AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n)?.o ?? fresh(n) },
};
function fresh(n: string) {
  const own = sqliteHost();
  const alarm = { at: null as number | null };
  const o = new AgentDO({
    storage: { sql: own.sql, transactionSync: own.transactionSync, getAlarm: async () => alarm.at, setAlarm: async (at: number) => { alarm.at = at; }, deleteAlarm: async () => { alarm.at = null; } },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => n }, getWebSockets: () => [], exports: {},
  } as never, env as never);
  objects.set(n, { o, alarm, dispose: () => own.dispose() });
  return o;
}
const workerFetch = (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env as never) as Promise<Response>;

// ---- the provider, stubbed at its HTTP endpoint ---------------------------------

/** What each provider request carried, so a test can read what the model was handed. */
const asked: Array<{ host: string; model: string; system: string; tools: any[] }> = [];
/** A scripted agent: look the order up, cancel it, say so. Keyed on the results since the customer last spoke. */
function agentReply(messages: any[]) {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const results = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
  const call = (name: string, args: object) => ({ content: null, tool_calls: [{ id: `call_${name}_${messages.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  if (results === 0) return call("retail__get_order_details", { order_id: "#W1" });
  if (results === 1) return call("retail__cancel_pending_order", { order_id: "#W1", reason: "no longer needed" });
  return { content: "Your order #W1 is cancelled." };
}
const realFetch = globalThis.fetch;
/** When on, the provider refuses every call, as a gateway does with a wrong or expired token. */
const providerRefuses = { on: false };
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input?.url ?? input);
  if (!/api\.deepseek\.com|gateway\.ai\.cloudflare\.com/.test(url)) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? (await (input as Request).text())));
  asked.push({ host: new URL(url).host, model: body.model, system: String(body.messages?.[0]?.content ?? ""), tools: body.tools ?? [] });
  if (providerRefuses.on) return Response.json({ error: { message: "invalid token", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
  const message: { role: string; content: string | null; tool_calls?: unknown[] } = { role: "assistant", ...agentReply(body.messages) };
  return Response.json({
    id: "x", object: "chat.completion", model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  });
}) as typeof fetch;

/** The queue consumer and the alarms, as the platform runs them: each job answered, each alarm fired when due. */
const lying = { on: false };
let pumping = false;
const pump = setInterval(async () => {
  if (pumping) return;
  pumping = true;
  try {
    while (jobs.length) {
      const m = jobs.shift()!;
      const o = objects.get(agentObjectName(m.tenantId, m.agentId))!.o;
      const taker = crypto.randomUUID();
      const job: any = await o.takeJob(m.tenantId, m.agentId, m.jobId, taker);
      if (!job || job.unknownJob) continue;
      const answer: any = await callQueuedModel(env as never, job, m.jobId);
      // A provider path that reached another model than the binding named, for the refusal below.
      if (lying.on) answer.model = "deepseek-flash";
      await o.deliverAnswer(m.tenantId, m.agentId, m.jobId, answer, 5, taker);
    }
    for (const x of objects.values()) {
      if (x.alarm.at !== null && x.alarm.at <= Date.now()) { x.alarm.at = null; await x.o.alarm(); }
    }
  } catch (e) { console.error("pump:", e); } finally { pumping = false; }
}, 10);

// ---- the task -------------------------------------------------------------------------

const BASE_DB: RetailDB = {
  users: { sofia_1: { user_id: "sofia_1", name: { first_name: "Sofia", last_name: "Rossi" }, address: { zip: "78784" }, email: "sofia@example.com",
    payment_methods: { credit_card_1: { source: "credit_card", id: "credit_card_1" } }, orders: ["#W1"] } },
  orders: { "#W1": { order_id: "#W1", user_id: "sofia_1", address: {}, status: "pending", fulfillments: [],
    items: [{ name: "Lamp", product_id: "p1", item_id: "i1", price: 10, options: {} }],
    payment_history: [{ transaction_type: "payment", amount: 10, payment_method_id: "credit_card_1" }] } },
  products: { p1: { name: "Lamp", product_id: "p1", variants: { i1: { item_id: "i1", options: {}, available: true, price: 10 } } } },
};
const TASK = { id: "fx", user_scenario: { instructions: { reason_for_call: "cancel order #W1" } }, evaluation_criteria: { actions: [
  { name: "get_order_details", arguments: { order_id: "#W1" } },
  { name: "cancel_pending_order", arguments: { order_id: "#W1", reason: "no longer needed" } },
] } };
const POLICY = "# Retail agent policy\n\nOnly cancel pending orders.\n";
/** The customer: asks once, then ends. */
const sim: ApiTaskDeps["sim"] = async (messages) => ({ text: messages.length <= 2 ? "Please cancel my order #W1, I no longer need it." : "Thanks! ###STOP###", finishReason: "stop" });

const client = apiClient({ base: "https://w.test", harnessToken: OPERATOR, fetch: workerFetch });
await client.issueKey("bench", "tau2-api", "tau2-test");
const models = await client.operator("/admin/models");
const said: string[] = [];
/** A second key of the same owner, to see what a run left in the API's index after its own key is revoked. */
const observer = apiClient({ base: "https://w.test", harnessToken: OPERATOR, fetch: workerFetch });
await observer.issueKey("bench", "tau2-api", "observer");
const deps = (model: string): ApiTaskDeps => ({
  client, sim, baseDb: BASE_DB, policy: POLICY, guidelines: "Play the customer.", tools: retailFunctions(), model, models, tenantId: "bench",
  turnTimeoutMs: 30_000, lookEveryMs: 1_000, ledgerWaitMs: 20_000, deafness: deafnessBudget(undefined), say: (l) => said.push(l),
});

let flash: any;
await check("a task over the API runs to dbMatch: the customer's message, two calls run here, the answer, the grade", async () => {
  flash = await runApiTask(TASK, deps("default"));
  must(flash.dbMatch && flash.actionMatch && flash.reward === 1, show(flash));
  must(flash.ended === "stop" && flash.turns === 1 && flash.simCalls === 2, show([flash.ended, flash.turns, flash.simCalls]));
  must(flash.simLast === "Thanks! ###STOP###", show(flash.simLast));
  must(show(flash.performedWrites) === '["cancel_pending_order"]', show(flash.performedWrites));
  must(BASE_DB.orders["#W1"].status === "pending", "the runner wrote the base database");
  must(flash.delivered.push + flash.delivered.poll === 1, show(flash.delivered));
});

await check("its row: usage, calls, byTool and kinds as `/bench/result` counted them, the object's activity, pi085 observed", () => {
  must(show(flash.usage) === show({ prompt: 300, completion: 30, calls: 3 }), show(flash.usage));
  must(show(flash.byTool) === show({ retail__get_order_details: 1, retail__cancel_pending_order: 1 }) && flash.toolErrors === 0, show(flash.byTool));
  // Two placeholders were written off the branch (one per paused call) and are not counted.
  must(show(flash.kinds) === show({ message: 1, "model.response": 3, "tool.result": 2 }), show(flash.kinds));
  must(!said.some((l) => /disagree/.test(l)), `items and entries disagreed: ${said.filter((l) => /disagree/.test(l)).join(" | ")}`);
  must(flash.engine === "pi085" && flash.object === `api:bench/${flash.agentId}` && flash.activity?.activeMs > 0, show([flash.engine, flash.object, flash.activity]));
  must(show(flash.provider) === show({ name: "deepseek-flash", endpoint: "api.deepseek.com" }), show(flash.provider));
});

await check("what the provider was handed: the gateway's own `retail` catalogue, byte for byte with its limit sentence, and nothing else; the system prompt is the core and the policy", () => {
  const mine = asked.filter((a) => a.model === "deepseek-flash");
  must(mine.length === 3 && mine.every((a) => a.host === "api.deepseek.com"), show(asked.map((a) => [a.host, a.model])));
  const record = { tenantId: "bench", agentId: "a", alias: "retail", plugin: "retail", installationId: "i", connectionId: null, toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null };
  // The old path, as cf/src/runtime.ts builds the catalogue: the mount's entries, qualified, then the limit
  // sentence for a catalogue with no reader of parked results (the `/bench` object mounted retail and tools,
  // and neither reads them back).
  const entries = qualifyMountedTools(mountedToolEntries([record] as never, new Map([["retail", retailPlugin(BASE_DB, [])]])) as any);
  must(parkedReader(entries) === null, "the retail mount reads parked results back");
  const gateway = withLimitNote(entries, null)
    .map((t: any) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (const a of mine) must(show(a.tools) === show(gateway), `the provider's tools differ from the mounted catalogue:\n${show(a.tools).slice(0, 300)}\n${show(gateway).slice(0, 300)}`);
  must(show(retailFunctions().map(({ type: _, ...f }) => f)) === show(gateway.map((g: any) => g.function)), "retailFunctions is not the gateway's construction");
  // An empty name adds no "You are <name>." before the policy (bench/tau2/api-task.ts).
  must(mine[0]!.system === `${BASE_SYSTEM}\n\n${POLICY.trim()}`, `the system prompt is not the core and the policy:\n${mine[0]!.system.slice(BASE_SYSTEM.length, BASE_SYSTEM.length + 200)}`);
});

await check("the task's agent and session are deleted from the API's index; the objects keep their transcripts", async () => {
  const a = await workerFetch(`https://w.test/v1/agents/${flash.agentId}`, { headers: { authorization: "Bearer x" } });
  must(a.status === 401, `a made-up key was let in: ${a.status}`);
  let gone = false;
  try { await client.v1("GET", `/agents/${flash.agentId}`); } catch (e) { gone = /404/.test(String(e)); }
  must(gone, "the agent is still in the index");
  const t = await client.operator(`/admin/transcript?tenantId=bench&agentId=${flash.agentId}&taskId=${flash.sessionId}`);
  // The operator's read holds each paused call's placeholder as well as its result: what `kindsOf` leaves out.
  const raw = t.events.filter((e: any) => e.kind === "tool.result");
  must(raw.length === 4 && raw.filter((e: any) => e.payload?.isError).length === 2, show(raw.map((e: any) => [e.sequence, e.payload?.isError])));
});

await check("the Luna arm: made on gpt-5.6-luna, called through the gateway, its provider read from the ledger", async () => {
  const luna = await runApiTask(TASK, deps("gpt-5.6-luna"));
  must(luna.reward === 1 && show(luna.provider) === show({ name: "openai/gpt-5.6-luna", endpoint: "gateway.ai.cloudflare.com" }), show([luna.reward, luna.provider]));
  must(asked.filter((a) => a.model === "openai/gpt-5.6-luna" && a.host === "gateway.ai.cloudflare.com").length === 3, show(asked.map((a) => [a.host, a.model])));
  const record = apiRunRecord({ base: "https://w.test", build: null, driver: null, tenantId: "bench", owner: "tau2-api", modelRequested: "gpt-5.6-luna", simId: "sim.test/fixture",
    sim: {}, tasks: ["fx"], trials: 1, order: "trial-major", startedAt: "", results: [{ ...luna, trial: 1 }] });
  must(record.ok && (record.body as any).model === "openai/gpt-5.6-luna" && (record.body as any).runnerMethod === "agents-api", show(record).slice(0, 300));
  // Rows on two providers make no record.
  must(!apiRunRecord({ base: "", build: null, driver: null, tenantId: "bench", owner: "o", modelRequested: "x", sim: {}, simId: "sim.test/fixture", tasks: [], trials: 1, order: "trial-major",
    startedAt: "", results: [{ ...luna, trial: 1 }, { ...flash, trial: 1 }] }).ok, "a record was built over two providers");
});

await check("a ledger that disagrees with the agent stops the run instead of recording a model it did not run", async () => {
  lying.on = true;
  let refused: unknown = null;
  try { await runApiTask(TASK, deps("gpt-5.6-luna")); } catch (e) { refused = e; } finally { lying.on = false; }
  must(refused instanceof RunRefusal && /gpt-5.6-luna.*deepseek-flash/.test((refused as Error).message), String(refused));
  // The refusal comes after the agent was made: it is deleted all the same.
  must((await observer.v1All("/agents")).length === 0, "the refused task's agent was left in the index");
});

/** A whole run, as bench/tau2/api.ts starts it, into a runs tree of its own. */
async function wholeRun(model: string, extra: Partial<ApiRunOptions> = {}) {
  const tree = mkdtempSync(join(tmpdir(), "bench-tau2-api-run-"));
  const runs = join(tree, "report/runs/");
  const runClient = apiClient({ base: "https://w.test", harnessToken: OPERATOR, fetch: workerFetch });
  const out = await runApiBench({
    client: runClient, sim, simId: "sim.test/fixture", baseDb: BASE_DB, tasks: [TASK], policy: POLICY, guidelines: "Play the customer.", model,
    trials: 1, order: "trial-major", base: "https://w.test", build: async () => null, driver: null, runs,
    onSignal: () => {}, timing: { turnTimeoutMs: 30_000, lookEveryMs: 1_000, ledgerWaitMs: 20_000 }, ...extra,
  });
  const files = existsSync(runs) ? list(runs, { recursive: true }).map(String).filter((f) => f.endsWith(".json")) : [];
  return { out, files, runs, runClient, done: () => rmSync(tree, { recursive: true, force: true }) };
}

await check("a whole run writes one record, runnerMethod agents-api, and exits 0", async () => {
  const r = await wholeRun("default");
  try {
    must(r.out.code === 0 && r.files.length === 1, show({ out: r.out, files: r.files }));
    const rec = JSON.parse(readFileSync(join(r.runs, r.files[0]!), "utf8"));
    must(rec.runnerMethod === "agents-api" && rec.model === "deepseek-flash" && rec.modelRequested === "default" && rec.results[0].reward === 1, show(rec).slice(0, 300));
    must(rec.sim?.id === "sim.test/fixture" && rec.sim.reasoning === "low", show(rec.sim));
    must((await observer.v1All("/agents")).length === 0, "the run left agents in the index");
  } finally { r.done(); }
});

await check("MODEL=no-such-model: the run stops before task 1, writes no record, exits non-zero, and leaves no key or agent", async () => {
  const before = asked.length;
  const r = await wholeRun("no-such-model");
  try {
    must(r.out.code !== 0 && r.out.record === null && /model_not_found/.test(String(r.out.why)), show(r.out));
    // Not even the run's directory: the refusal comes before the run begins (`preflight`), not at task 1.
    must(r.files.length === 0 && !existsSync(r.runs), `the run began: ${show(r.files)} ${existsSync(r.runs)}`);
    must(asked.length === before, "a model was called");
    let revoked = false;
    try { await r.runClient.v1("GET", "/agents"); } catch (e) { revoked = /no API key/.test(String(e)); }
    must(revoked, "the run's key was left live");
    must((await observer.v1All("/agents")).length === 0, "an agent was left in the index");
  } finally { r.done(); }
});

await check("every model call refused at the provider (a bad token): the rows end `model: …`, and the run exits non-zero with no record", async () => {
  const before = asked.length;
  providerRefuses.on = true;
  let r: Awaited<ReturnType<typeof wholeRun>> | null = null;
  try {
    r = await wholeRun("default");
  } finally { providerRefuses.on = false; }
  try {
    // The preflight passed (making an agent calls no model); the provider was asked, and refused.
    must(asked.length > before, "the provider was never called");
    must(r.out.code !== 0 && r.out.record === null && /none has a provider/.test(String(r.out.why)), show(r.out));
    // The run had begun, so its directory exists (with the log that says why, when it is teed); no record in it.
    must(r.files.length === 0, `a record was written: ${show(r.files)}`);
    must((await observer.v1All("/agents")).length === 0, "the run left agents in the index");
  } finally { r.done(); }
});

await check("SIGINT mid-task: the task's agent and session are deleted, the key revoked, and the process ends 130", async () => {
  const handlers = new Map<string, () => void>();
  let exited: number | null = null;
  let entered!: () => void;
  const inTask = new Promise<void>((r) => { entered = r; });
  const tree = mkdtempSync(join(tmpdir(), "bench-tau2-api-int-"));
  const runClient = apiClient({ base: "https://w.test", harnessToken: OPERATOR, fetch: workerFetch });
  try {
    void runApiBench({
      client: runClient, baseDb: BASE_DB, tasks: [TASK], policy: POLICY, guidelines: "g", model: "default", trials: 1, order: "trial-major",
      base: "https://w.test", build: async () => null, driver: null, runs: join(tree, "report/runs/"),
      // The customer never answers: the run is inside its task, with an agent and a session made, when the signal comes.
      sim: () => { entered(); return new Promise(() => {}); }, simId: "sim.test/fixture",
      onSignal: (sig, h) => { handlers.set(sig, h); }, exit: (code) => { exited = code; },
    });
    await inTask;
    must((await observer.v1All("/agents")).length === 1 && (await observer.v1All("/agents/sessions")).length === 1, "the task had no agent or session to clean up");
    must(handlers.has("SIGINT") && handlers.has("SIGTERM"), show([...handlers.keys()]));
    handlers.get("SIGINT")!();
    for (let i = 0; i < 200 && exited === null; i++) await new Promise((r) => setTimeout(r, 25));
    must(exited === 130, `exit ${exited}`);
    must((await observer.v1All("/agents")).length === 0 && (await observer.v1All("/agents/sessions")).length === 0, "the interrupt left an agent or session");
    let revoked = false;
    try { await runClient.v1("GET", "/agents"); } catch (e) { revoked = /no API key/.test(String(e)); }
    must(revoked, "the interrupt left the key live");
  } finally { rmSync(tree, { recursive: true, force: true }); }
});

await check("the run's key is revoked at the end, and then lets nothing in", async () => {
  must(await client.revokeKey(), "the revoke was refused");
  let shut = false;
  try { await client.v1("GET", "/agents"); } catch (e) { shut = /no API key/.test(String(e)); }
  must(shut, "the client still held the key");
  // The route itself: only the operator may revoke, a revoked key reads as revoked once, and an unknown one as nothing.
  const post = (body: unknown, token = OPERATOR) => workerFetch("https://w.test/admin/api-keys", { method: "POST", headers: { "x-harness-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  const issued = await (await post({ tenantId: "bench", ownerAgentId: "tau2-api", label: "t" })).json() as any;
  const use = () => workerFetch("https://w.test/v1/agents", { headers: { authorization: `Bearer ${issued.key}` } });
  must((await use()).status === 200, "a fresh key was refused");
  must((await post({ revoke: issued.key }, "wrong")).status === 401, "a revoke without the operator's token was accepted");
  must(show(await (await post({ revoke: issued.key })).json()) === '{"revoked":true}', "the revoke");
  must((await use()).status === 401, "a revoked key still works");
  must(show(await (await post({ revoke: issued.key })).json()) === '{"revoked":false}', "a second revoke said it revoked something");
  must((await post({ revoke: 7 })).status === 400, "a revoke naming no key was accepted");
});

clearInterval(pump);
globalThis.fetch = realFetch;
for (const x of objects.values()) x.dispose();
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
