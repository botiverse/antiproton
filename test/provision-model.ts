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
import { d1ModelChoices, d1ModelOverrides, d1ProviderTokens, d1TenantModelPicker } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import { callQueuedModel } from "../cf/src/model-request.ts";
import { harnessKey } from "../cf/src/runtime.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker, modelPickerEnforced } = await import("../cf/src/index.ts");
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
 * does). `USER_MODELS` unset gives a deployment that offers nothing. `picker` is T's model-picker switch before the
 * POST: on unless a check says otherwise, since every check before the switch existed is about a tenant that may pick.
 * `enforce` is the deployment's MODEL_PICKER_ENFORCE: "1" unless a check says otherwise, so the switch's checks test
 * it applied; `enforce: false` leaves the variable unset, as production and preview have it.
 */
async function world(opts: { userModels?: unknown[] | null; post?: false | Record<string, unknown>; picker?: boolean; enforce?: boolean } = {}) {
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
    ...(opts.enforce === false ? {} : { MODEL_PICKER_ENFORCE: "1" }),
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? another(n) },
  };
  const D = new AgentDO(ctx as never, env as never);
  objects.set(agentObjectName(T, A), D);
  const token = newProviderToken(), other = newProviderToken(), platform = newProviderToken();
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(token), label: "raft-test", raftOrigin: "https://raft.example", scope: "tenant", tenantId: T });
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(other), label: "raft-other", raftOrigin: "https://raft.example", scope: "tenant", tenantId: "t-other" });
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(platform), label: "raft-platform", raftOrigin: "https://raft.example", scope: "platform" } as never);
  if (opts.picker !== false) await d1TenantModelPicker(DB).set(T, true, "test", 1);
  const w = { D, rt: D.runtime(), raw, DB, env, jobs, token, other, platform, tokenHash: await hashProviderToken(token), alarmAt: () => alarmAt };
  if (opts.post !== false) {
    const posted = await provisionPost(w, opts.post ?? {});
    must(posted.status === 201, `POST /provision/agents: ${posted.status} ${posted.text}`);
  }
  await w.rt.ready();
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

/** `extra` is merged into the body: `model`, or anything else a test adds to an otherwise ordinary create. */
async function provisionPost(w: Pick<World, "env" | "token">, extra: Record<string, unknown> = {}) {
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
      body: JSON.stringify({ raftAgentId: RAFT_ID, raftServerId: "srv-1", raftOrigin: "https://raft.example", name: "n", instructions: "FIRST-PERSONA-7c1", credential: RAFT_CRED, ...extra }),
    }), w.env as never);
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, text, body };
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

// ---- choosing the model at creation (POST /provision/agents `model`) ---------

/** Nothing of the agent exists: no registry row, no stored pick, no model binding in its object. */
async function nothingMade(w: World, label: string) {
  const row = w.DB.raw.prepare("SELECT * FROM provisioned_agents WHERE tenant_id = ? AND raft_agent_id = ?").get(T, RAFT_ID);
  must(!row, `${label}: a registry row was made: ${show(row)}`);
  must(!w.DB.raw.prepare("SELECT * FROM model_choices WHERE tenant_id = ? AND agent_id = ?").get(T, A), `${label}: a pick was stored`);
  must((await w.rt.store.getModelBinding(T, A)) === null, `${label}: the agent's object was given a binding`);
}

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: POST with model creates the agent on it: GET reads it as chosen, and the first model request goes to it`, async () => {
    lines.length = 0;
    const w = await world({ post: { model: "gpt-5.6-luna" } });
    const g = await call(w, "GET", `agents/${A}/model`);
    must(show(g.body) === show({ model: "gpt-5.6-luna", label: "GPT-5.6 Luna", source: "chosen", locked: false }), `GET after create: ${g.text}`);
    // Stored as a PUT stores it, and logged as a PUT logs it.
    const row: any = w.DB.raw.prepare("SELECT * FROM model_choices WHERE tenant_id = ? AND agent_id = ?").get(T, A);
    must(row?.choice_id === "gpt-5.6-luna" && row.set_by === `provider:${w.tokenHash}`, `stored: ${show(row)}`);
    const ours = lines.map((l) => JSON.parse(l)).filter((l) => l.evt === "provision.model");
    must(ours.length === 1 && ours[0].credentialId === w.tokenHash && ours[0].model === "gpt-5.6-luna" && ours[0].agent === A, `lines: ${show(ours)}`);
    must(!lines.join("\n").includes(w.token), "a log line carries the token");
    // Bound by the create itself, with no PUT and no rebind after it.
    const b = await w.rt.store.getModelBinding(T, A);
    must(b?.model === "openai/gpt-5.6-luna" && b.secretRef === "operator:model:cloudflare", `binding after create: ${show(b)}`);
    if (engine === "pd") await toPd(w);
    const first = await turn(w, "turn one");
    must(first.model === "openai/gpt-5.6-luna" && first.harnessModel === "openai/gpt-5.6-luna" && first.url.startsWith("https://gateway.ai.cloudflare.com"),
      `the first request: ${first.model} ${first.harnessModel} at ${first.url}`);
  });
}

await check("POST with model null is today's create: default, nothing stored, no provision.model line", async () => {
  lines.length = 0;
  const w = await world({ post: { model: null } });
  const g = await call(w, "GET", `agents/${A}/model`);
  must(show(g.body) === show({ model: "deepseek-flash", label: "DeepSeek Flash", source: "default", locked: false }), `null create: ${g.text}`);
  must(!w.DB.raw.prepare("SELECT * FROM model_choices").get(), "null stored a row");
  must(!lines.some((l) => l.includes("provision.model")), "null logged a pick");
});

await check("POST refuses an unknown or unoffered model with 422 unknown_model, and a non-string with 422 invalid, making nothing", async () => {
  for (const [model, code] of [
    ["gpt-9", "unknown_model"], ["default", "unknown_model"], ["cloudflare/openai/gpt-5.6-luna", "unknown_model"],
    [7, "invalid"], [true, "invalid"], [{ id: "gpt-5.6-luna" }, "invalid"], [["gpt-5.6-luna"], "invalid"],
  ] as const) {
    const w = await world({ post: false });
    const r = await provisionPost(w, { model });
    must(r.status === 422 && r.body?.error?.code === code && r.body.error.param === "model", `${show(model)}: ${r.status} ${r.text}`);
    await nothingMade(w, show(model));
  }
  // Offered by USER_MODELS but its provider's secret is unset: not offered, so not taken.
  const noGateway = await world({ post: false });
  delete noGateway.env.AI_GATEWAY_TOKEN;
  const r = await provisionPost(noGateway, { model: "gpt-5.6-luna" });
  must(r.status === 422 && r.body.error.code === "unknown_model", `unavailable option: ${r.status} ${r.text}`);
  await nothingMade(noGateway, "unavailable option");
  // A deployment that offers nothing takes only null.
  const none = await world({ userModels: null, post: false });
  const n = await provisionPost(none, { model: "deepseek-flash" });
  must(n.status === 422 && n.body.error.code === "unknown_model", `nothing offered: ${n.status} ${n.text}`);
  await nothingMade(none, "nothing offered");
});

await check("POST with model under an admin's agent or tenant row is 409 model_locked and makes nothing; without model it still creates", async () => {
  for (const agentId of [A, ""]) {
    const w = await world({ post: false });
    await d1ModelOverrides(w.DB).put({ tenantId: T, agentId, provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 });
    const r = await provisionPost(w, { model: "gpt-5.6-luna" });
    must(r.status === 409 && r.body?.error?.code === "model_locked" && r.body.error.param === "model", `${agentId ? "agent" : "tenant"} row: ${r.status} ${r.text}`);
    await nothingMade(w, `${agentId ? "agent" : "tenant"} row`);
    const plain = await provisionPost(w, {});
    must(plain.status === 201, `a create without model under the lock: ${plain.status} ${plain.text}`);
    must((await call(w, "GET", `agents/${A}/model`)).body.model === "deepseek-pro", "the admin's row does not decide");
  }
  // A deployment row does not lock: the pick is taken and outranks it.
  const w = await world({ post: false });
  await d1ModelOverrides(w.DB).put({ tenantId: "", agentId: "", provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 });
  const r = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(r.status === 201, `deployment row: ${r.status} ${r.text}`);
  must((await call(w, "GET", `agents/${A}/model`)).body.source === "chosen", "the pick under a deployment row");
});

await check("POST replay compares model as part of the request: same answers the same, other or absent is 409; absent and null are one", async () => {
  const w = await world({ post: { model: "gpt-5.6-luna" } });
  const same = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(same.status === 200 && same.body.providerAgentId === A, `same model: ${same.status} ${same.text}`);
  for (const extra of [{ model: "deepseek-pro" }, {}, { model: null }]) {
    const r = await provisionPost(w, extra);
    must(r.status === 409 && r.body.error.code === "idempotency_conflict" && /\(model\)/.test(r.body.error.message), `${show(extra)}: ${r.status} ${r.text}`);
  }
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === "gpt-5.6-luna", "a refused replay moved the pick");
  // Compared with the request, not with what runs: a delayed retry after a PUT answers as the create did and leaves the PUT.
  must((await putModel(w, "deepseek-pro")).status === 200, "PUT");
  const late = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(late.status === 200, `a delayed retry after a PUT: ${late.status} ${late.text}`);
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === "deepseek-pro", "a delayed retry undid the PUT");
  // A replay is compared, not checked as a create: an id nobody offers is simply a different body.
  const unknown = await provisionPost(w, { model: "gpt-9" });
  must(unknown.status === 409 && unknown.body.error.code === "idempotency_conflict", `unknown on replay: ${unknown.status} ${unknown.text}`);
  const badType = await provisionPost(w, { model: 7 });
  must(badType.status === 422 && badType.body.error.code === "invalid", `a non-string on replay: ${badType.status} ${badType.text}`);

  // Created with none: absent and null both answer the same, a model is 409, and a PUT since does not change that.
  const plain = await world();
  for (const extra of [{}, { model: null }]) {
    const r = await provisionPost(plain, extra);
    must(r.status === 200, `no model, replayed with ${show(extra)}: ${r.status} ${r.text}`);
  }
  const named = await provisionPost(plain, { model: "gpt-5.6-luna" });
  must(named.status === 409 && named.body.error.code === "idempotency_conflict", `a model on a create made without one: ${named.status} ${named.text}`);
  must((await d1ModelChoices(plain.DB).layers(T, A)).owner === null, "the refused replay stored a pick");
  must((await putModel(plain, "deepseek-pro")).status === 200, "PUT on the plain agent");
  must((await provisionPost(plain, {})).status === 200, "an absent-model retry after a PUT was refused");
  must((await d1ModelChoices(plain.DB).layers(T, A)).owner === "deepseek-pro", "an absent-model retry undid the PUT");
});

await check("a create refused for its model reserves nothing: the same raftAgentId without model is then a first create (201)", async () => {
  for (const [label, setup, model, status, code] of [
    ["unknown", async (_w: World) => {}, "gpt-9", 422, "unknown_model"],
    ["non-string", async (_w: World) => {}, 7, 422, "invalid"],
    ["locked", async (w: World) => { await d1ModelOverrides(w.DB).put({ tenantId: T, agentId: "", provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 }); }, "gpt-5.6-luna", 409, "model_locked"],
  ] as const) {
    const w = await world({ post: false });
    await setup(w);
    const r = await provisionPost(w, { model });
    must(r.status === status && r.body?.error?.code === code, `${label}: ${r.status} ${r.text}`);
    await nothingMade(w, label);
    const again = await provisionPost(w, {});
    must(again.status === 201, `${label}, then without model: ${again.status} ${again.text}`);
  }
});

/** What a create that named `model` and died between making its row and storing its pick leaves. */
function interrupted(w: World, model: string) {
  w.DB.raw.prepare("UPDATE provisioned_agents SET status = 'provisioning', model = ?, model_pending = 1 WHERE tenant_id = ? AND raft_agent_id = ?").run(model, T, RAFT_ID);
}

await check("POST replay of a create that died before its pick was stored finishes it, and binds it", async () => {
  const w = await world();
  interrupted(w, "gpt-5.6-luna");
  const r = await provisionPost(w, { model: "gpt-5.6-luna" });
  // The create completing: 201, as the first create would have answered.
  must(r.status === 201, `replay: ${r.status} ${r.text}`);
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === "gpt-5.6-luna", "the replay did not store the pick");
  const b = await w.rt.store.getModelBinding(T, A);
  must(b?.model === "openai/gpt-5.6-luna", `the replay did not bind it: ${show(b)}`);
  // Once finished, the same replay of another model is a conflict, not a second finish.
  const again = await provisionPost(w, { model: "deepseek-pro" });
  must(again.status === 409 && again.body.error.code === "idempotency_conflict", `after the finish: ${again.status} ${again.text}`);
});

await check("an identical replay after the option was withdrawn answers 200 with the same agent, not 422", async () => {
  const w = await world({ post: { model: "gpt-5.6-luna" } });
  // The operator withdraws luna: its provider's secret goes, so it is no longer offered.
  delete w.env.AI_GATEWAY_TOKEN;
  must((await call(w, "GET", "models")).body.models.every((o: any) => o.id !== "gpt-5.6-luna"), "luna still offered");
  const r = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(r.status === 200 && r.body.providerAgentId === A && r.body.status === "active", `identical replay: ${r.status} ${r.text}`);
  // And it is still a comparison: no model is another body.
  const none = await provisionPost(w, { model: null });
  must(none.status === 409 && none.body.error.code === "idempotency_conflict", `null after the create: ${none.status} ${none.text}`);
});

await check("an interrupted create is not stuck: under a new lock its same-body replay is 409 model_locked, and one without model finishes it", async () => {
  const w = await world();
  interrupted(w, "gpt-5.6-luna");
  await d1ModelOverrides(w.DB).put({ tenantId: T, agentId: "", provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 });
  const same = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(same.status === 409 && same.body.error.code === "model_locked", `same body under the lock: ${same.status} ${same.text}`);
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === null, "a locked replay stored a pick");
  const none = await provisionPost(w, {});
  must(none.status === 201 && none.body.providerAgentId === A && none.body.status === "active", `without model: ${none.status} ${none.text}`);
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === null, "a replay without model stored a pick");
  const row: any = w.DB.raw.prepare("SELECT model, model_pending FROM provisioned_agents WHERE tenant_id = ? AND raft_agent_id = ?").get(T, RAFT_ID);
  must(row.model === null && row.model_pending === 0, `the row: ${show(row)}`);
  // Settled now: the first body is a different request.
  const late = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(late.status === 409 && late.body.error.code === "idempotency_conflict", `after the finish: ${late.status} ${late.text}`);
});

await check("an interrupted create whose option was withdrawn: the same body is 422, another offered model finishes it on that model", async () => {
  const w = await world();
  interrupted(w, "gpt-5.6-luna");
  delete w.env.AI_GATEWAY_TOKEN;
  const same = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(same.status === 422 && same.body.error.code === "unknown_model", `same body, withdrawn: ${same.status} ${same.text}`);
  const pro = await provisionPost(w, { model: "deepseek-pro" });
  must(pro.status === 201, `another model: ${pro.status} ${pro.text}`);
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === "deepseek-pro", "the new model was not stored");
  must((await w.rt.store.getModelBinding(T, A))?.model === "deepseek-v4-pro", "the new model was not bound");
});

await check("once the create's pick is stored, a replay never writes it again: a PUT null since stays", async () => {
  const w = await world({ post: { model: "gpt-5.6-luna" } });
  // Still provisioning (as after a refused credential), and the owner cleared the pick in between.
  w.DB.raw.prepare("UPDATE provisioned_agents SET status = 'provisioning' WHERE tenant_id = ? AND raft_agent_id = ?").run(T, RAFT_ID);
  must((await putModel(w, null)).status === 200, "PUT null");
  const r = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(r.status === 200, `replay: ${r.status} ${r.text}`);
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === null, "the replay undid the PUT null");
});

await check("a PUT after an interrupted create settles it: the delayed retry of the create is a 200 replay and leaves the PUT", async () => {
  for (const put of [null, "deepseek-pro"] as const) {
    const w = await world();
    interrupted(w, "gpt-5.6-luna");
    must((await putModel(w, put)).status === 200, `PUT ${put}`);
    const row: any = w.DB.raw.prepare("SELECT model_pending FROM provisioned_agents WHERE tenant_id = ? AND raft_agent_id = ?").get(T, RAFT_ID);
    must(row.model_pending === 0, `PUT ${put} left the create unsettled`);
    const r = await provisionPost(w, { model: "gpt-5.6-luna" });
    must(r.status === 200 && r.body.providerAgentId === A, `the delayed retry after PUT ${put}: ${r.status} ${r.text}`);
    must((await d1ModelChoices(w.DB).layers(T, A)).owner === put, `the retry overwrote PUT ${put}: ${(await d1ModelChoices(w.DB).layers(T, A)).owner}`);
    const g = await call(w, "GET", `agents/${A}/model`);
    must(g.body.model === (put ?? "deepseek-flash"), `what runs after PUT ${put}: ${g.text}`);
  }
});

await check("a create that stored its pick and died unsettled, reopened without model under a lock, leaves no pick to run once the lock lifts", async () => {
  const w = await world({ post: { model: "gpt-5.6-luna" } });
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === "gpt-5.6-luna", "the create did not store its pick");
  // The pick was stored and the flag never cleared.
  interrupted(w, "gpt-5.6-luna");
  await d1ModelOverrides(w.DB).put({ tenantId: T, agentId: "", provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 });
  const r = await provisionPost(w, {});
  must(r.status === 201, `reopened without model: ${r.status} ${r.text}`);
  must((await d1ModelChoices(w.DB).layers(T, A)).owner === null, "the first pick is still stored");
  await d1ModelOverrides(w.DB).remove(T, "");
  const g = await call(w, "GET", `agents/${A}/model`);
  must(g.body.model === "deepseek-flash" && g.body.source === "default", `after the lock lifts: ${g.text}`);
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

// ---- the server's model-picker switch (PUT /provision/servers/{raftServerId}/model-picker) ----------------------

const picker = (w: World, tenantId = T) =>
  (w.DB.raw.prepare("SELECT enabled, set_by FROM tenant_model_picker WHERE tenant_id = ?").get(tenantId) as any) ?? null;
const setPicker = (w: World, enabled: unknown, opts: { server?: string; auth?: string | null; body?: unknown } = {}) =>
  call(w, "PUT", `servers/${opts.server ?? "srv-1"}/model-picker`, { body: opts.body ?? { enabled }, auth: opts.auth });
const storedPick = (w: World) => (w.DB.raw.prepare("SELECT choice_id FROM model_choices WHERE tenant_id = ? AND agent_id = ?").get(T, A) as any)?.choice_id ?? null;

await check("model-picker PUT: a body of exactly { enabled: boolean }, the tenant the token gives, server_mismatch for a tenant token's other server; nothing written when refused", async () => {
  const w = await world({ picker: false });
  // A tenant token for the server its agents were made for (srv-1): written, the latest write wins.
  let r = await setPicker(w, true);
  must(r.status === 200 && r.body.raftServerId === "srv-1" && r.body.modelPicker === true && typeof r.body.updatedAt === "string", `on: ${r.status} ${r.text}`);
  must(picker(w)?.enabled === 1 && picker(w)?.set_by === w.tokenHash, `stored: ${show(picker(w))}`);
  r = await setPicker(w, false);
  must(r.status === 200 && r.body.modelPicker === false && picker(w)?.enabled === 0, `off: ${r.status} ${r.text}`);
  // A tenant token naming a server none of its agents were made for: 403, nothing written to its tenant.
  r = await setPicker(w, true, { server: "srv-2" });
  must(r.status === 403 && r.body.error.code === "server_mismatch" && r.body.error.param === "raftServerId", `another server: ${r.status} ${r.text}`);
  must(picker(w)?.enabled === 0, "a server_mismatch wrote");
  // Another tenant's token, which has no agent for srv-1: 403 too, and its own tenant is not written.
  r = await setPicker(w, true, { auth: w.other });
  must(r.status === 403 && r.body.error.code === "server_mismatch" && picker(w, "t-other") === null && picker(w)?.enabled === 0, `other tenant: ${r.status} ${r.text}`);
  // A platform token names the tenant by the path's server, and only that one.
  r = await setPicker(w, true, { server: "srv-9", auth: w.platform });
  must(r.status === 200 && picker(w, "raft_srv-9")?.enabled === 1 && picker(w)?.enabled === 0, `platform: ${r.status} ${r.text}`);
  // No token: 401.
  must((await setPicker(w, true, { auth: null })).status === 401, "no token");
  // Bodies: exactly { enabled: true | false }.
  for (const [bad, param, code] of [[{}, "enabled", "missing"], [{ enabled: "true" }, "enabled", "invalid"], [{ enabled: 1 }, "enabled", "invalid"],
    [{ enabled: null }, "enabled", "invalid"], [{ enabled: true, plan: "pro" }, "plan", "invalid"]] as const) {
    const b = await setPicker(w, undefined, { body: bad });
    must(b.status === 422 && b.body.error.code === code && b.body.error.param === param, `${show(bad)}: ${b.status} ${b.text}`);
  }
  must(picker(w)?.enabled === 0, "a refused body wrote");
  const badId = await setPicker(w, true, { server: "bad id!", auth: w.platform });
  must(badId.status === 422 && badId.body.error.param === "raftServerId", `bad server id: ${badId.status} ${badId.text}`);
});

await check("GET /provision/models says pickerEnabled (false until Raft turns it on) and lists the options either way", async () => {
  const w = await world({ picker: false });
  const off = await call(w, "GET", "models");
  must(off.status === 200 && off.body.pickerEnabled === false && off.body.models.length === 3 && off.body.default === "deepseek-flash", `off: ${off.text}`);
  must((await setPicker(w, true)).status === 200, "on");
  const on = await call(w, "GET", "models");
  must(on.body.pickerEnabled === true && on.body.models.length === 3, `on: ${on.text}`);
});

await check("picker off, create: the default by name is made (no pick stored); another model is 403 model_picker_disabled and makes nothing; on, it is taken", async () => {
  // Hosted agents send the default by name: made, on the default, with no pick stored to outrank an operator's rows.
  lines.length = 0;
  const w = await world({ picker: false, post: { model: "deepseek-flash" } });
  const g = await call(w, "GET", `agents/${A}/model`);
  must(show(g.body) === show({ model: "deepseek-flash", label: "DeepSeek Flash", source: "default", locked: false }), `default create: ${g.text}`);
  must(storedPick(w) === null && !lines.some((l) => l.includes("provision.model\"")), "the default was stored as a pick");
  // Its replay is the same request: 200.
  must((await provisionPost(w, { model: "deepseek-flash" })).status === 200, "replay of the default create");
  for (const model of ["gpt-5.6-luna", "deepseek-pro"]) {
    const x = await world({ picker: false, post: false });
    const r = await provisionPost(x, { model });
    must(r.status === 403 && r.body?.error?.code === "model_picker_disabled" && r.body.error.param === "model", `${model}: ${r.status} ${r.text}`);
    await nothingMade(x, model);
  }
  // Turned on (T's token, once an agent exists for srv-1), the same create is taken.
  const y = await world({ picker: false, post: { raftAgentId: "01JFIRST" } });
  must((await provisionPost(y, { model: "gpt-5.6-luna" })).status === 403, "still off");
  must((await setPicker(y, true)).status === 200, "on through the tenant token");
  const made = await provisionPost(y, { model: "gpt-5.6-luna" });
  must(made.status === 201 && storedPick(y) === "gpt-5.6-luna", `on: ${made.status} ${made.text}`);
  // An id not offered is still 422 unknown_model with the picker off, and modelPicker on the create is refused.
  const z = await world({ picker: false, post: false });
  const unknown = await provisionPost(z, { model: "gpt-9" });
  must(unknown.status === 422 && unknown.body.error.code === "unknown_model", `unknown: ${unknown.status} ${unknown.text}`);
  const flag = await provisionPost(z, { modelPicker: true, model: "gpt-5.6-luna" });
  must(flag.status === 422 && flag.body.error.param === "modelPicker", `modelPicker on POST: ${flag.status} ${flag.text}`);
  await nothingMade(z, "modelPicker on POST");
});

await check("picker off, PUT …/model: another model is 403 and stores nothing; the default and null are taken; on, a pick is taken", async () => {
  const w = await world({ picker: false });
  const before = await w.rt.store.getModelBinding(T, A);
  for (const model of ["gpt-5.6-luna", "deepseek-pro"]) {
    const r = await putModel(w, model);
    must(r.status === 403 && r.body.error.code === "model_picker_disabled" && r.body.error.param === "model", `${model}: ${r.status} ${r.text}`);
  }
  must(storedPick(w) === null && show(await w.rt.store.getModelBinding(T, A)) === show(before), "a refused PUT stored or bound");
  for (const model of ["deepseek-flash", null]) {
    const r = await putModel(w, model);
    must(r.status === 200 && r.body.model === "deepseek-flash" && r.body.source === "default", `${show(model)}: ${r.status} ${r.text}`);
    must(storedPick(w) === null, `${show(model)} stored a pick`);
  }
  must((await setPicker(w, true)).status === 200, "on");
  const on = await putModel(w, "gpt-5.6-luna");
  must(on.status === 200 && on.body.source === "chosen" && storedPick(w) === "gpt-5.6-luna", `on: ${on.status} ${on.text}`);
});

await check("grandfathered: an agent that picked while the picker was on keeps running its model once it is off, may repeat it or return to the default, and may not pick another", async () => {
  const w = await world({ post: { model: "gpt-5.6-luna" } });
  must((await setPicker(w, false)).status === 200, "off");
  // Nothing migrated: the pick reads, binds and runs as before.
  const g = await call(w, "GET", `agents/${A}/model`);
  must(g.body.model === "gpt-5.6-luna" && g.body.source === "chosen", `after off: ${g.text}`);
  const t = await turn(w, "still luna");
  must(t.model === "openai/gpt-5.6-luna" && t.url.startsWith("https://gateway.ai.cloudflare.com"), `the request after off: ${t.model} at ${t.url}`);
  // Another model: refused, the pick stays.
  const other = await putModel(w, "deepseek-pro");
  must(other.status === 403 && other.body.error.code === "model_picker_disabled" && storedPick(w) === "gpt-5.6-luna", `another: ${other.status} ${other.text}`);
  // Its own pick again, and its create's replay: the same request, not a new choice.
  must((await putModel(w, "gpt-5.6-luna")).status === 200 && storedPick(w) === "gpt-5.6-luna", "a repeat of its own pick");
  must((await provisionPost(w, { model: "gpt-5.6-luna" })).status === 200, "the create's replay");
  // Back to the default, which then is all it may have.
  const back = await putModel(w, "deepseek-flash");
  must(back.status === 200 && back.body.source === "default" && storedPick(w) === null, `back to default: ${back.status} ${back.text}`);
  must((await putModel(w, "gpt-5.6-luna")).status === 403, "its old pick again after leaving it");
});

for (const scope of ["tenant", "agent"] as const) {
  await check(`picker off: an operator's ${scope} row set through /admin/models still decides, and the agent runs on it (Luna); Raft's create naming the default is made, not 409`, async () => {
    const w = await world({ picker: false, post: false });
    const admin = await worker.fetch(new Request("https://x/admin/models", {
      method: "PUT", headers: { "x-harness-token": AUTOMATION, "content-type": "application/json" },
      body: JSON.stringify({ scope, tenantId: T, ...(scope === "agent" ? { agentId: A } : {}), provider: "cloudflare", model: "openai/gpt-5.6-luna" }),
    }), w.env as never);
    must(admin.status === 200, `admin PUT: ${admin.status} ${await admin.text()}`);
    // The hosted create sends the default by name: with the picker off that is no pick, so the operator's row is not
    // a lock it runs into.
    const made = await provisionPost(w, { model: "deepseek-flash" });
    must(made.status === 201, `create naming the default: ${made.status} ${made.text}`);
    await w.rt.ready();
    const g = await call(w, "GET", `agents/${A}/model`);
    must(show(g.body) === show({ model: "gpt-5.6-luna", label: "GPT-5.6 Luna", source: "admin", locked: true }), `GET: ${g.text}`);
    must(storedPick(w) === null, "a pick was stored");
    const t = await turn(w, "on the operator's model");
    must(t.model === "openai/gpt-5.6-luna" && t.url.startsWith("https://gateway.ai.cloudflare.com"), `the request: ${t.model} at ${t.url}`);
    // A provider pick is still refused (the operator's row locks first, as with the picker on); the operator can still
    // move the agent.
    const pick = await putModel(w, "deepseek-pro");
    must(pick.status === 409 && pick.body.error.code === "model_locked" && storedPick(w) === null, `a provider pick under the operator's row: ${pick.status} ${pick.text}`);
    const again = await worker.fetch(new Request("https://x/admin/models", {
      method: "PUT", headers: { "x-harness-token": AUTOMATION, "content-type": "application/json" },
      body: JSON.stringify({ scope, tenantId: T, ...(scope === "agent" ? { agentId: A } : {}), provider: "deepseek", model: "deepseek-v4-pro" }),
    }), w.env as never);
    must(again.status === 200, `admin PUT again: ${again.status}`);
    must((await call(w, "GET", `agents/${A}/model`)).body.model === "deepseek-pro", "the operator's second row did not decide");
  });
}

await check("picker off: the id the routes report as the default is taken as no pick even when an operator's row makes it another model; the 403 names the accepted ids", async () => {
  // An operator's deployment row moves everyone's default to Luna: GET /models reports it, and echoing it back is taken.
  const w = await world({ picker: false, post: false });
  await d1ModelOverrides(w.DB).put({ tenantId: "", agentId: "", provider: "cloudflare", model: "openai/gpt-5.6-luna", setBy: "adm", setAt: 1 });
  const list = await call(w, "GET", "models");
  must(list.body.default === "gpt-5.6-luna" && list.body.pickerEnabled === false, `list: ${list.text}`);
  const made = await provisionPost(w, { model: list.body.default });
  must(made.status === 201 && storedPick(w) === null, `create echoing default: ${made.status} ${made.text}`);
  await w.rt.ready();
  must((await call(w, "GET", `agents/${A}/model`)).body.model === "gpt-5.6-luna", "not on the operator's default");
  for (const model of ["gpt-5.6-luna", "deepseek-flash"]) {
    const r = await putModel(w, model);
    must(r.status === 200 && r.body.model === "gpt-5.6-luna" && r.body.source === "admin" && storedPick(w) === null, `PUT ${model}: ${r.status} ${r.text}`);
  }
  const no = await putModel(w, "deepseek-pro");
  must(no.status === 403 && no.body.error.code === "model_picker_disabled" && no.body.error.message.includes('"deepseek-flash"') && no.body.error.message.includes('"gpt-5.6-luna"'),
    `refusal names the accepted ids: ${no.text}`);
  // An operator's tenant row: the create echoing its model is made, not 409 model_locked.
  const t = await world({ picker: false, post: false });
  await d1ModelOverrides(t.DB).put({ tenantId: T, agentId: "", provider: "cloudflare", model: "openai/gpt-5.6-luna", setBy: "adm", setAt: 1 });
  const echoed = await provisionPost(t, { model: (await call(t, "GET", "models")).body.default });
  must(echoed.status === 201 && storedPick(t) === null, `tenant row, create echoing default: ${echoed.status} ${echoed.text}`);
});

await check("picker off: an agent that chose the default's id by name keeps that choice when it PUTs it again (not reset to none under an operator's deployment row)", async () => {
  const w = await world({ post: { model: "deepseek-flash" } });
  must(storedPick(w) === "deepseek-flash", "the create's pick of the default was not stored with the picker on");
  await d1ModelOverrides(w.DB).put({ tenantId: "", agentId: "", provider: "cloudflare", model: "openai/gpt-5.6-luna", setBy: "adm", setAt: 1 });
  must((await setPicker(w, false)).status === 200, "off");
  const g = await call(w, "GET", `agents/${A}/model`);
  must(g.body.model === "deepseek-flash" && g.body.source === "chosen", `before: ${g.text}`);
  const before = await w.rt.store.getModelBinding(T, A);
  const r = await putModel(w, "deepseek-flash");
  must(r.status === 200 && r.body.model === "deepseek-flash" && r.body.source === "chosen" && storedPick(w) === "deepseek-flash", `repeat: ${r.status} ${r.text}`);
  must(show(await w.rt.store.getModelBinding(T, A)) === show(before), `the binding moved: ${show(await w.rt.store.getModelBinding(T, A))}`);
  const t = await turn(w, "still flash");
  must(t.model === "deepseek-flash", `the request after the repeat: ${t.model}`);
});

await check("picker off: a create interrupted while it was on finishes on its replay with the model it asked for; another model is still 403", async () => {
  const w = await world();
  interrupted(w, "gpt-5.6-luna");
  must((await setPicker(w, false)).status === 200, "off");
  const other = await provisionPost(w, { model: "deepseek-pro" });
  must(other.status === 403 && other.body.error.code === "model_picker_disabled", `another model on the reopen: ${other.status} ${other.text}`);
  const r = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(r.status === 201 && storedPick(w) === "gpt-5.6-luna", `replay: ${r.status} ${r.text}`);
  must((await w.rt.store.getModelBinding(T, A))?.model === "openai/gpt-5.6-luna", "the replay did not bind it");
});

// ---- the switch not enforced (MODEL_PICKER_ENFORCE unset, as deployed until Raft sets every server's switch) -------

await check("MODEL_PICKER_ENFORCE: only exactly \"1\" enforces; no wrangler config sets it", () => {
  for (const [v, on] of [["1", true], [undefined, false], ["", false], ["0", false], ["true", false], [" 1", false], ["1 ", false]] as const) {
    must(modelPickerEnforced({ MODEL_PICKER_ENFORCE: v }) === on, `${show(v)} read as ${!on ? "on" : "off"}`);
  }
  // Comment lines dropped (test/eval-seed.ts `varsOf` reads the configs the same way); the name anywhere else is set.
  for (const file of ["wrangler.jsonc", "wrangler.preview.jsonc"]) {
    const code = readFileSync(new URL(`../cf/${file}`, import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    must(!code.includes("MODEL_PICKER_ENFORCE"), `cf/${file} sets MODEL_PICKER_ENFORCE: Raft does not set every server's switch yet`);
  }
});

await check("not enforced: with the switch stored off, POST and PUT …/model take every offered pick as before the switch (stored, bound, run); unknown is still 422", async () => {
  // A create naming another model: made on it and stored as the pick, exactly as with the picker on.
  // The switch stored off before the create (a tenant token may set it only once an agent exists for the server).
  const w = await world({ enforce: false, picker: false, post: false });
  await d1TenantModelPicker(w.DB).set(T, false, "test", 1);
  must(picker(w)?.enabled === 0, "switch not stored off");
  const made = await provisionPost(w, { model: "gpt-5.6-luna" });
  must(made.status === 201 && storedPick(w) === "gpt-5.6-luna", `create on luna: ${made.status} ${made.text}`);
  await w.rt.ready();
  must((await w.rt.store.getModelBinding(T, A))?.model === "openai/gpt-5.6-luna", "the create did not bind luna");
  // Stored off again through the route, then PUT another model: taken and stored.
  const pro = await putModel(w, "deepseek-pro");
  must(pro.status === 200 && pro.body.source === "chosen" && pro.body.model === "deepseek-pro" && storedPick(w) === "deepseek-pro", `PUT pro: ${pro.status} ${pro.text}`);
  // PUT the default by name: stored as a pick of it, as before the switch (not turned into "no pick").
  const flash = await putModel(w, "deepseek-flash");
  must(flash.status === 200 && flash.body.source === "chosen" && storedPick(w) === "deepseek-flash", `PUT flash: ${flash.status} ${flash.text}`);
  const t = await turn(w, "on flash, chosen");
  must(t.model === "deepseek-flash", `the request: ${t.model}`);
  must((await putModel(w, null)).status === 200 && storedPick(w) === null, "null");
  must((await putModel(w, "gpt-9")).status === 422, "unknown on PUT");
  // A create naming the default by name stores it as a pick, as before the switch.
  const d = await world({ enforce: false, picker: false, post: { model: "deepseek-flash" } });
  must(storedPick(d) === "deepseek-flash", `default create: ${storedPick(d)}`);
  const unknown = await provisionPost(await world({ enforce: false, picker: false, post: false }), { model: "gpt-9" });
  must(unknown.status === 422 && unknown.body.error.code === "unknown_model", `unknown: ${unknown.status} ${unknown.text}`);
});

await check("not enforced: an operator's tenant row still locks a provider pick with 409 model_locked, the default by name included, as before the switch", async () => {
  const w = await world({ enforce: false, picker: false, post: false });
  await d1ModelOverrides(w.DB).put({ tenantId: T, agentId: "", provider: "cloudflare", model: "openai/gpt-5.6-luna", setBy: "adm", setAt: 1 });
  const r = await provisionPost(w, { model: "deepseek-flash" });
  must(r.status === 409 && r.body.error.code === "model_locked", `create naming the default under a tenant row: ${r.status} ${r.text}`);
  await nothingMade(w, "locked create");
});

await check("not enforced: the switch PUT still validates, stores and answers, and GET /provision/models reports it as stored", async () => {
  const w = await world({ enforce: false, picker: false });
  const off = await call(w, "GET", "models");
  must(off.body.pickerEnabled === false && off.body.models.length === 3, `before: ${off.text}`);
  let r = await setPicker(w, true);
  must(r.status === 200 && r.body.modelPicker === true && picker(w)?.enabled === 1 && picker(w)?.set_by === w.tokenHash, `on: ${r.status} ${r.text}`);
  must((await call(w, "GET", "models")).body.pickerEnabled === true, "GET after on");
  r = await setPicker(w, false);
  must(r.status === 200 && r.body.modelPicker === false && picker(w)?.enabled === 0, `off: ${r.status} ${r.text}`);
  must((await call(w, "GET", "models")).body.pickerEnabled === false, "GET after off");
  const bad = await setPicker(w, undefined, { body: { enabled: "yes" } });
  must(bad.status === 422 && bad.body.error.param === "enabled" && picker(w)?.enabled === 0, `bad body: ${bad.status} ${bad.text}`);
  must((await setPicker(w, true, { server: "srv-2" })).status === 403, "server_mismatch");
});

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
