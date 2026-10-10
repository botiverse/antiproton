/**
 * Raft's model routes (`GET /provision/models`, `GET|PUT /provision/agents/{id}/model`) through the Worker's own
 * `fetch`, the real migrations on node:sqlite and the whole `AgentDO` under node (the `cloudflare:workers` stand-in
 * test/eval-seed-object.ts uses), on a production-shaped deployment (no EVAL_SEED_ROUTES). And the harness half of it
 * (#826): a pick or a PATCH of instructions reaches the agent's next turn while its harness is open, on both engines.
 *
 * What the model is sent is read where it leaves: the queue consumer (`callQueuedModel`) with `fetch` replaced, so
 * the model name and the system prompt are the request's own, not a field the harness meant to send.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { d1ModelChoices, d1ModelOverrides, d1ProviderTokens } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import { callQueuedModel } from "../cf/src/model-request.ts";
import { harnessKey } from "../cf/src/runtime.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { setLogSink } = await import("../src/core/log.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const lines: string[] = [];
setLogSink((line) => { lines.push(line); });

const PROVIDERS = [
  { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
  { id: "cloudflare", baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/antiproton/compat", auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
];
const FLASH = { id: "deepseek-flash", label: "DeepSeek Flash", provider: "deepseek", model: "deepseek-flash" };
const PRO = { id: "deepseek-pro", label: "DeepSeek Pro", provider: "deepseek", model: "deepseek-v4-pro" };
const LUNA = { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "cloudflare", model: "openai/gpt-5.6-luna" };
const DK = "dk-secret-value-1234", GT = "gt-secret-value-5678";

const T = "t-raft", A = "raft_01JMODEL", RAFT_ID = "01JMODEL", AUTOMATION = "operator-token";
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** D1 as node:sqlite, with every migration in cf/migrations applied (test/agents-api-model.ts). */
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

const RAFT_CRED = "sk_agent_" + "R".repeat(32);

/**
 * A deployment with two providers and three owner options, a tenant-scoped provider token for T and one for another
 * tenant, and one agent Raft provisioned through `POST /provision/agents` (Raft stood in for, as test/eval-seed-object.ts
 * does). `USER_MODELS` unset gives a deployment that offers nothing.
 */
async function world(opts: { userModels?: unknown[] | null } = {}) {
  const DB = d1();
  const raw = sqliteHost();
  const jobs: string[] = [];
  let alarmAt: number | null = null;
  const ctx = {
    storage: {
      sql: raw.sql, transactionSync: raw.transactionSync,
      getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; },
    },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(),
    id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
  };
  const objects = new Map<string, InstanceType<typeof AgentDO>>();
  const another = (n: string) => {
    const host = sqliteHost();
    const o = new AgentDO({ ...ctx, storage: { ...ctx.storage, sql: host.sql, transactionSync: host.transactionSync }, id: { toString: () => n } } as never, env as never);
    objects.set(n, o);
    return o;
  };
  const userModels = opts.userModels === undefined ? [FLASH, PRO, LUNA] : opts.userModels;
  const env: Record<string, unknown> = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false }) },
    ARTIFACT_BUCKET: "b", CONTROL_DB: DB, HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    MODEL_PROVIDERS: PROVIDERS, DEEPSEEK_API_KEY: DK, AI_GATEWAY_TOKEN: GT, AUTOMATION_TOKEN: AUTOMATION,
    ...(userModels === null ? {} : { USER_MODELS: userModels }),
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? another(n) },
  };
  const D = new AgentDO(ctx as never, env as never);
  objects.set(agentObjectName(T, A), D);
  const token = newProviderToken(), other = newProviderToken();
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(token), label: "raft-test", raftOrigin: "https://raft.example", scope: "tenant", tenantId: T });
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(other), label: "raft-other", raftOrigin: "https://raft.example", scope: "tenant", tenantId: "t-other" });
  const w = { D, rt: D.runtime(), raw, DB, env, jobs, token, other, tokenHash: await hashProviderToken(token), alarmAt: () => alarmAt };
  const posted = await provisionPost(w);
  must(posted.status === 201, `POST /provision/agents: ${posted.status} ${posted.text}`);
  await w.rt.ready();
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

async function provisionPost(w: Pick<World, "env" | "token">) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    if (String(url) === "https://raft.example/internal/agent-api" && headers.get("authorization") === `Bearer ${RAFT_CRED}`) {
      return Response.json({ agentId: "ag-1", agentName: "cody", agentDisplayName: "Cody", serverId: "srv-1" });
    }
    return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  }) as typeof fetch;
  try {
    const res = await worker.fetch(new Request("https://x/provision/agents", {
      method: "POST", headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" },
      body: JSON.stringify({ raftAgentId: RAFT_ID, raftServerId: "srv-1", raftOrigin: "https://raft.example", name: "n", instructions: "FIRST-PERSONA-7c1", credential: RAFT_CRED }),
    }), w.env as never);
    return { status: res.status, text: await res.text() };
  } finally { globalThis.fetch = real; }
}

/** A provider route, as Raft calls it. `auth` null sends no credential. */
async function call(w: World, method: string, path: string, opts: { body?: unknown; auth?: string | null } = {}) {
  const auth = opts.auth === undefined ? w.token : opts.auth;
  const res = await worker.fetch(new Request(`https://x/provision/${path}`, {
    method, headers: auth === null ? {} : { authorization: `Bearer ${auth}` },
    ...(opts.body === undefined ? {} : { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }),
  }), w.env as never);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}
const putModel = (w: World, model: unknown, auth?: string | null) => call(w, "PUT", `agents/${A}/model`, { body: { model }, auth });

/** Alarm passes until the model has been asked `n` things (test/eval-seed-object.ts). */
async function settle(w: World, n: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && w.jobs.length < n) {
    await w.D.alarm();
    if (w.jobs.length >= n) return;
    const at = w.alarmAt();
    if (at === null || at - Date.now() > 5_000) return;
    await sleep(Math.min(Math.max(0, at - Date.now()), 50));
  }
}
const jobCount = (w: World) => w.jobs.length;
/** Alarm passes until the turn has ended, so the harness is open and idle: the case #826 is about. */
async function idle(w: World) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await (await w.rt.agent(T, A)).running())) return;
    await w.D.alarm();
    await sleep(10);
  }
  throw new Error("the turn did not end");
}

/**
 * Job `i` as it leaves for the provider: taken (the harness's own job, with the binding the queue reads), then sent
 * by the real consumer with `fetch` replaced. Answered, so the turn ends and the harness stays open and idle.
 */
async function sent(w: World, i: number) {
  const job = await w.D.takeJob(T, A, w.jobs[i]!) as any;
  const real = globalThis.fetch;
  const out: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    out.push({ url: String(u), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await callQueuedModel(w.env as never, job, w.jobs[i]!); } finally { globalThis.fetch = real; }
  must(out.length === 1, `requests: ${out.length}`);
  await w.D.deliverAnswer(T, A, w.jobs[i]!, { role: "assistant", content: [{ type: "text", text: "ok" }], api: job.model?.api ?? "x",
    provider: job.model?.provider ?? "x", model: String(job.model?.id ?? "x"), usage: USAGE, stopReason: "stop", timestamp: 0 } as never, 5);
  await idle(w);
  const b = out[0]!.body;
  // The Responses API carries the prompt as `instructions`; chat/completions as system messages. Every one of them:
  // pd keeps the conversation's first prompt and sends a changed section as a later system message ("Updated system
  // prompt section"), so its provider's cache of the prefix survives an edit.
  const system = typeof b.instructions === "string" ? b.instructions
    : (b.messages ?? []).filter((m: any) => m.role === "system").map((m: any) => String(m.content)).join("\n---\n");
  const lastSystem = system.split("\n---\n").at(-1)!;
  return { url: out[0]!.url, model: String(b.model), system, lastSystem, harnessModel: String(job.model?.id ?? ""), body: b, job };
}
async function turn(w: World, text: string) {
  const n = jobCount(w);
  await w.rt.postMessage(T, A, text, "prompt");
  await settle(w, n + 1);
  must(jobCount(w) === n + 1, `the turn "${text}" did not reach the model: ${jobCount(w)} jobs`);
  return sent(w, n);
}
async function toPd(w: World) {
  const m = await w.D.migrateEngine(T, A, "migrate", false);
  must(!!m && (m as any).ok, `migrate: ${show(m)}`);
}

// ---- the routes ---------------------------------------------------------------

await check("GET /provision/models lists the offered options as id, label and provider, the default, and no secret or address", async () => {
  const w = await world();
  const r = await call(w, "GET", "models");
  must(r.status === 200, `${r.status} ${r.text}`);
  must(show(r.body.models) === show([FLASH, PRO, LUNA].map((o) => ({ id: o.id, label: o.label, provider: o.provider }))), `models: ${show(r.body.models)}`);
  must(r.body.default === "deepseek-flash" && r.body.defaultLabel === "DeepSeek Flash" && r.body.locked === false, `default: ${r.text}`);
  for (const bad of [DK, GT, "DEEPSEEK_API_KEY", "AI_GATEWAY_TOKEN", "gateway.ai.cloudflare.com", "api.deepseek.com", "baseUrl", "openai/gpt-5.6-luna", "deepseek-v4-pro"]) {
    must(!r.text.includes(bad), `${bad} in ${r.text}`);
  }
  // Without USER_MODELS nothing is offered, and the default still reads.
  const none = await call(await world({ userModels: null }), "GET", "models");
  // No option names the default then, so it reads as `<provider>/<model>`, the Agents API's name for it.
  must(none.status === 200 && show(none.body.models) === "[]" && none.body.default === "deepseek/deepseek-flash", `unset: ${none.text}`);
});

await check("auth and tenant: no token 401, another tenant's token 404 on the agent's model, an unknown agent 404", async () => {
  const w = await world();
  for (const [m, p] of [["GET", "models"], ["GET", `agents/${A}/model`], ["PUT", `agents/${A}/model`]] as const) {
    const r = await call(w, m, p, { auth: null, ...(m === "PUT" ? { body: { model: "deepseek-pro" } } : {}) });
    must(r.status === 401, `${m} ${p} with no token: ${r.status}`);
  }
  for (const [m, body] of [["GET", undefined], ["PUT", { model: "deepseek-pro" }]] as const) {
    const r = await call(w, m, `agents/${A}/model`, { auth: w.other, ...(body ? { body } : {}) });
    must(r.status === 404 && r.body?.error?.code === "not_found", `${m} with another tenant's token: ${r.status} ${r.text}`);
    const nobody = await call(w, m, `agents/raft_nobody/model`, { ...(body ? { body } : {}) });
    must(nobody.status === 404, `${m} an unknown agent: ${nobody.status}`);
  }
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === null, "a refused request stored a pick");
  must((await d1ModelChoices(w.DB).layers("t-other", A)).owner === null, "another tenant's token stored a pick");
});

await check("GET …/model: a new agent follows the default; PUT picks an option, by either address, recorded as the provider token; null resets", async () => {
  const w = await world();
  const fresh = await call(w, "GET", `agents/${A}/model`);
  must(fresh.status === 200 && show(fresh.body) === show({ model: "deepseek-flash", label: "DeepSeek Flash", source: "default", locked: false }), `fresh: ${fresh.text}`);
  const r = await putModel(w, "gpt-5.6-luna");
  must(r.status === 200 && show(r.body) === show({ model: "gpt-5.6-luna", label: "GPT-5.6 Luna", source: "chosen", locked: false }), `put: ${r.status} ${r.text}`);
  const row: any = w.DB.raw.prepare("SELECT * FROM model_choices WHERE tenant_id = ? AND agent_id = ?").get(T, A);
  must(row?.choice_id === "gpt-5.6-luna" && row.set_by === `provider:${w.tokenHash}`, `stored: ${show(row)}`);
  // Bound at once, not at the next input.
  const b = await w.rt.store.getModelBinding(T, A);
  must(b?.model === "openai/gpt-5.6-luna" && b.secretRef === "operator:model:cloudflare", `binding: ${show(b)}`);
  const byRaft = await call(w, "GET", `agents/by-raft-agent/${RAFT_ID}/model`);
  must(byRaft.status === 200 && byRaft.body.model === "gpt-5.6-luna" && byRaft.body.source === "chosen", `by Raft id: ${byRaft.text}`);
  const viaRaft = await call(w, "PUT", `agents/by-raft-agent/${RAFT_ID}/model`, { body: { model: "deepseek-pro" } });
  must(viaRaft.status === 200 && viaRaft.body.model === "deepseek-pro", `PUT by Raft id: ${viaRaft.text}`);
  const reset = await putModel(w, null);
  must(reset.status === 200 && show(reset.body) === show({ model: "deepseek-flash", label: "DeepSeek Flash", source: "default", locked: false }), `null: ${reset.text}`);
  must(!w.DB.raw.prepare("SELECT * FROM model_choices WHERE tenant_id = ? AND agent_id = ?").get(T, A), "null left a row");
  const after = await w.rt.store.getModelBinding(T, A);
  must(after?.model === "deepseek-flash" && after.secretRef === "operator:model", `null did not rebind: ${show(after)}`);
});

await check("PUT …/model is idempotent: the same pick twice answers the same and leaves one row; null on no pick is 200", async () => {
  const w = await world();
  const one = await putModel(w, "deepseek-pro");
  const two = await putModel(w, "deepseek-pro");
  must(one.status === 200 && two.status === 200 && show(one.body) === show(two.body), `${one.text} / ${two.text}`);
  const n = (w.DB.raw.prepare("SELECT COUNT(*) AS n FROM model_choices").get() as any).n;
  must(n === 1, `rows: ${n}`);
  await putModel(w, null);
  const again = await putModel(w, null);
  must(again.status === 200 && again.body.source === "default", `null twice: ${again.text}`);
});

await check("PUT …/model refuses an unknown id with 422 param model, and a malformed body, storing nothing", async () => {
  const w = await world();
  const before = await w.rt.store.getModelBinding(T, A);
  for (const [body, status, code] of [
    [{ model: "gpt-9" }, 422, "unknown_model"],
    [{ model: "default" }, 422, "unknown_model"],
    [{ model: "cloudflare/openai/gpt-5.6-luna" }, 422, "unknown_model"],
    [{ model: 7 }, 422, "invalid"],
    [{}, 422, "missing"],
    [{ model: "deepseek-pro", extra: 1 }, 400, "unknown_field"],
  ] as const) {
    const r = await call(w, "PUT", `agents/${A}/model`, { body });
    must(r.status === status && r.body?.error?.code === code, `${show(body)}: ${r.status} ${r.text}`);
    if (code !== "unknown_field") must(r.body.error.param === "model", `${show(body)}: param ${r.body.error.param}`);
  }
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === null, "a refusal stored a pick");
  must(show(await w.rt.store.getModelBinding(T, A)) === show(before), "a refusal moved the binding");
  // An offered option is refused once its provider's secret is gone: not offered, so not stored.
  const noGateway = await world();
  delete noGateway.env.AI_GATEWAY_TOKEN;
  const r = await putModel(noGateway, "gpt-5.6-luna");
  must(r.status === 422 && r.body.error.code === "unknown_model", `unavailable option: ${r.status} ${r.text}`);
});

await check("a deleted agent's model is 404 to GET and PUT", async () => {
  const w = await world();
  const del = await call(w, "DELETE", `agents/${A}`);
  must(del.status === 200, `delete: ${del.status} ${del.text}`);
  must((await call(w, "GET", `agents/${A}/model`)).status === 404, "GET a deleted agent");
  const r = await putModel(w, "deepseek-pro");
  must(r.status === 404 && r.body.error.code === "not_found", `PUT a deleted agent: ${r.status} ${r.text}`);
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === null, "stored a pick for a deleted agent");
});

await check("precedence: an admin's agent row wins, reads as source admin and locked, and refuses a PUT; a deployment row sits under the pick", async () => {
  const w = await world();
  must((await putModel(w, "gpt-5.6-luna")).status === 200, "pick");
  await d1ModelOverrides(w.DB).put({ tenantId: T, agentId: A, provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 });
  const g = await call(w, "GET", `agents/${A}/model`);
  must(show(g.body) === show({ model: "deepseek-pro", label: "DeepSeek Pro", source: "admin", locked: true }), `agent row: ${g.text}`);
  const r = await putModel(w, "deepseek-flash");
  must(r.status === 409 && r.body.error.code === "model_locked" && r.body.error.param === "model", `locked PUT: ${r.status} ${r.text}`);
  must((await putModel(w, null)).status === 409, "a reset under the lock was taken");
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === "gpt-5.6-luna", "the pick under the lock was lost or changed");
  // A tenant row locks too, and shows in the list.
  await d1ModelOverrides(w.DB).remove(T, A);
  await d1ModelOverrides(w.DB).put({ tenantId: T, agentId: "", provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 });
  must((await call(w, "GET", `agents/${A}/model`)).body.locked === true, "a tenant row did not lock");
  const list = await call(w, "GET", "models");
  must(list.body.default === "deepseek-pro" && list.body.locked === true, `models under a tenant row: ${list.text}`);
  await d1ModelOverrides(w.DB).remove(T, "");
  // The deployment row is the operator moving everyone's default: below the pick, above HARNESS_MODEL.
  await d1ModelOverrides(w.DB).put({ tenantId: "", agentId: "", provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 });
  const picked = await call(w, "GET", `agents/${A}/model`);
  must(show(picked.body) === show({ model: "gpt-5.6-luna", label: "GPT-5.6 Luna", source: "chosen", locked: false }), `deployment row under a pick: ${picked.text}`);
  must((await putModel(w, null)).body.source === "admin", "the deployment row did not read as admin once the pick was cleared");
  const dl = await call(w, "GET", "models");
  must(dl.body.default === "deepseek-pro" && dl.body.locked === false, `models under a deployment row: ${dl.text}`);
});

await check("the console's picker reads a pick made through Raft, and Raft reads one made in the console (one row)", async () => {
  const w = await world();
  must((await putModel(w, "deepseek-pro")).status === 200, "pick");
  const { agentModel } = await import("../cf/src/agent-model.ts");
  const { userModelsFrom } = await import("../src/model/user-models.ts");
  const { providersFrom } = await import("../src/model/providers.ts");
  const deps = { choices: d1ModelChoices(w.DB), userModels: userModelsFrom(w.env, providersFrom(w.env)), defaultModel: "deepseek-flash", now: () => 2 };
  const console1 = await (await agentModel("GET", null, { tenantId: T, agentId: A, actor: "owner" }, deps)).json() as any;
  must(console1.selected === "deepseek-pro" && console1.effective.source === "owner", `console: ${show(console1)}`);
  const form = new FormData(); form.set("choice", "gpt-5.6-luna");
  must((await agentModel("POST", form, { tenantId: T, agentId: A, actor: "owner" }, deps)).ok, "console pick");
  must((await call(w, "GET", `agents/${A}/model`)).body.model === "gpt-5.6-luna", "Raft does not see the console's pick");
});

await check("the route leaves one log line naming the token by its hash, never the token", async () => {
  const w = await world();
  lines.length = 0;
  await putModel(w, "deepseek-pro");
  const ours = lines.map((l) => JSON.parse(l)).filter((l) => l.evt === "provision.model");
  must(ours.length === 1 && ours[0].credentialId === w.tokenHash && ours[0].model === "deepseek-pro" && ours[0].agent === A, `lines: ${show(ours)}`);
  must(!lines.join("\n").includes(w.token), "a log line carries the token");
});

// ---- the next turn, with the harness open (#826) ------------------------------

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: a PUT while the harness is open moves the agent's next model request to the new model, and null moves it back`, async () => {
    const w = await world();
    if (engine === "pd") await toPd(w);
    const first = await turn(w, "turn one");
    must(first.model === "deepseek-flash" && first.harnessModel === "deepseek-flash" && first.url.startsWith("https://api.deepseek.com"), `first: ${first.model} ${first.harnessModel} ${first.url}`);
    must(!(await (await w.rt.agent(T, A)).running()), "the turn did not end");
    must((await putModel(w, "gpt-5.6-luna")).status === 200, "pick");
    const second = await turn(w, "turn two");
    must(second.model === "openai/gpt-5.6-luna" && second.url.startsWith("https://gateway.ai.cloudflare.com"), `the request after the pick: ${second.model} at ${second.url}`);
    // The harness's own model, which the transcript records and the context window is taken from: rebuilt, not the old one.
    must(second.harnessModel === "openai/gpt-5.6-luna", `the open harness kept its model: ${second.harnessModel}`);
    must((await putModel(w, null)).status === 200, "reset");
    const third = await turn(w, "turn three");
    must(third.model === "deepseek-flash" && third.harnessModel === "deepseek-flash", `after null: ${third.model} ${third.harnessModel}`);
  });

  await check(`${engine}: PATCH of instructions while the harness is open reaches the next turn's system prompt (#826)`, async () => {
    const w = await world();
    if (engine === "pd") await toPd(w);
    const first = await turn(w, "turn one");
    must(first.system.includes("FIRST-PERSONA-7c1"), `the first prompt lacks the persona: ${first.system.slice(0, 200)}`);
    const p = await call(w, "PATCH", `agents/${A}`, { body: { instructions: "SECOND-PERSONA-9d4" } });
    must(p.status === 200, `patch: ${p.status} ${p.text}`);
    const second = await turn(w, "turn two");
    // pi085 rebuilds its prompt whole; pd sends the changed section as the newest system message. Either way the
    // newest system text the model reads is the new persona's, and the old one is not in it.
    must(second.lastSystem.includes("SECOND-PERSONA-9d4") && !second.lastSystem.includes("FIRST-PERSONA-7c1"),
      `the next prompt: ${show(second.body.messages?.filter((m: any) => m.role === "system").map((m: any) => String(m.content).slice(0, 120)))}`);
    if (engine === "pi085") must(!second.system.includes("FIRST-PERSONA-7c1"), "pi085 still sends the old persona");
    const n = await call(w, "PATCH", `agents/${A}`, { body: { name: "Renamed-Agent-5e2" } });
    must(n.status === 200, `rename: ${n.text}`);
    const third = await turn(w, "turn three");
    must(third.lastSystem.includes("Renamed-Agent-5e2"), `a rename did not reach the prompt: ${third.system.slice(0, 300)}`);
  });

  await check(`${engine}: an agent that never uses the routes keeps its harness across turns, and its request is what it was`, async () => {
    const w = await world();
    if (engine === "pd") await toPd(w);
    const before = await w.rt.agent(T, A);
    const first = await turn(w, "same words");
    must(await w.rt.agent(T, A) === before, "an unchanged agent's harness was rebuilt");
    // The reads change nothing either: a GET of the list and of the agent's model, then the same words again.
    await call(w, "GET", "models");
    await call(w, "GET", `agents/${A}/model`);
    must(await w.rt.agent(T, A) === before, "a GET rebuilt the harness");
    must((await d1ModelChoices(w.DB).layers(T, A)).owner === null, "a GET stored a pick");
    const second = await turn(w, "same words");
    must(first.model === "deepseek-flash" && second.model === first.model && second.system === first.system, "the request moved");
    must(show(second.body.tools) === show(first.body.tools), "the tool list moved");
  });
}

await check("harnessKey: moves with the persona and the binding, and only with them", () => {
  const b = { provider: "openai-compatible", model: "deepseek-flash", baseUrl: "https://api.deepseek.com", secretRef: "operator:model" };
  const k = harnessKey("cat", { name: "n", description: "d" }, b);
  must(harnessKey("cat", { name: "n", description: "d" }, { ...b }) === k, "an equal input moved the key");
  must(harnessKey("cat", { name: "n", description: "d2" }, b) !== k, "instructions");
  must(harnessKey("cat", { name: "n2", description: "d" }, b) !== k, "name");
  must(harnessKey("cat", { name: "n", description: "d" }, { ...b, model: "x" }) !== k, "model");
  must(harnessKey("cat", { name: "n", description: "d" }, { ...b, secretRef: "operator:model:cloudflare" }) !== k, "provider");
  must(harnessKey("cat2", { name: "n", description: "d" }, b) !== k, "catalogue");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
