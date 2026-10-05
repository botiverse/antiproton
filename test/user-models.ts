/**
 * The owner's model pick: USER_MODELS as deployment configuration (src/model/user-models.ts), the order an agent's
 * model is decided in (cf/src/model-request.ts resolveModel), the store (0015_model_choices.sql, cf/src/control-plane.ts
 * d1ModelChoices) and `/ui/agent/model` (cf/src/agent-model.ts).
 *
 * The store is the real migrations on node:sqlite; the routes go through the Worker's own `fetch` and `AgentDO` (the
 * `cloudflare:workers` stand-in test/console-mounts.ts uses), so the sign-in gate, the ownership check, the anonymous
 * refusal and the bind on the agent's next run are the shipped ones.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { parseProviders, providersFrom } from "../src/model/providers.ts";
import { parseUserModels, userModelsFrom } from "../src/model/user-models.ts";
import { resolveModel } from "../cf/src/model-request.ts";
import { d1ModelChoices, d1ModelOverrides } from "../cf/src/control-plane.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { sessionCookieFor, uiAgent } from "../cf/src/auth.ts";

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

const GW = "https://gateway.ai.cloudflare.com/v1/acct/antiproton/compat";
const PROVIDERS = [
  { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
  { id: "cloudflare", baseUrl: GW, auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model", passKeys: { "deepseek/": "DEEPSEEK_API_KEY" } },
];
const FLASH = { id: "deepseek-flash", label: "DeepSeek Flash", provider: "deepseek", model: "deepseek-flash" };
const LUNA = { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "cloudflare", model: "openai/gpt-5.6-luna" };
const DK = "dk-secret-value-1234", GT = "gt-secret-value-5678";
const both = providersFrom({ MODEL_PROVIDERS: PROVIDERS, DEEPSEEK_API_KEY: DK, AI_GATEWAY_TOKEN: GT });

// ---- configuration ----------------------------------------------------------

function refusal(raw: unknown, ps = both): string {
  try { parseUserModels(raw, ps); return ""; } catch (e) { return String((e as Error).message); }
}

await check("config: a declaration is refused for unknown fields, a duplicate id, an undeclared provider, a model its provider does not name that way, and a reserved or malformed id", () => {
  for (const [raw, expect, why] of [
    [[{ ...FLASH, endpoint: "https://x" }], /unknown field endpoint/, "an unknown field"],
    [[{ ...FLASH, apiKey: "sk-1" }], /unknown field apiKey/, "a key in a field of its own"],
    [[FLASH, { ...LUNA, id: "deepseek-flash" }], /declared twice/, "a duplicate id"],
    [[{ ...LUNA, provider: "openrouter" }], /unknown provider openrouter/, "an undeclared provider"],
    [[{ ...LUNA, model: "gpt-5.6-luna" }], /vendor\/model/, "a bare name under a vendor/model provider"],
    [[{ ...FLASH, model: "deepseek/deepseek-flash" }], /bare name/, "a vendor/ name under a bare-name provider"],
    [[{ ...FLASH, id: "default" }], /other than "default"/, "the word that clears a pick"],
    [[{ ...FLASH, id: "Deep Seek" }], /lower-case name/, "a malformed id"],
    [[{ ...FLASH, label: "" }], /label is a name/, "an empty label"],
    [[{ id: "x", label: "X" }], /names a provider/, "no provider or model"],
    [{ id: "x" }, /is an array/, "not an array"],
    ["[{", /not JSON/, "text that is not JSON"],
  ] as const) {
    const r = refusal(raw);
    must((expect as RegExp).test(r), `${why}: ${r || "accepted"}`);
  }
  // A refused MODEL_PROVIDERS refuses every option, with that reason.
  must(/misconfigured/.test(refusal([FLASH], providersFrom({ MODEL_PROVIDERS: "[{" }))), "an option was accepted under refused providers");
  must(parseUserModels(JSON.stringify([FLASH, LUNA]), both).length === 2 && parseUserModels([FLASH, LUNA], both).length === 2, "a valid declaration was refused");
});

await check("config: absent is no options and no error; a refused declaration is no options with the reason; an option whose provider has no secret is not offered", () => {
  must(show(userModelsFrom({}, both)) === '{"offered":[]}', show(userModelsFrom({}, both)));
  must(show(userModelsFrom({ USER_MODELS: "" }, both)) === '{"offered":[]}', "an empty var");
  const bad = userModelsFrom({ USER_MODELS: [{ ...FLASH, x: 1 }] }, both);
  must(bad.offered.length === 0 && /unknown field x/.test(bad.error ?? ""), show(bad));
  const all = userModelsFrom({ USER_MODELS: [FLASH, LUNA] }, both);
  must(show(all.offered.map((o) => o.id)) === show(["deepseek-flash", "gpt-5.6-luna"]) && !all.error, show(all));
  const noGateway = userModelsFrom({ USER_MODELS: [FLASH, LUNA] }, providersFrom({ MODEL_PROVIDERS: PROVIDERS, DEEPSEEK_API_KEY: DK }));
  must(show(noGateway.offered.map((o) => o.id)) === show(["deepseek-flash"]) && !noGateway.error, `with AI_GATEWAY_TOKEN unset: ${show(noGateway)}`);
});

/** A wrangler config's `vars`, with whole-line comments dropped (the files carry no other kind). */
function varsOf(file: string): Record<string, unknown> {
  const text = readFileSync(new URL(`../cf/${file}`, import.meta.url), "utf8");
  return JSON.parse(text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")).vars;
}

await check("config: each deployment offers exactly DeepSeek Flash and GPT-5.6 Luna, accepted against its own providers, and DeepSeek stays the default", () => {
  for (const file of ["wrangler.jsonc", "wrangler.preview.jsonc"]) {
    const vars = varsOf(file);
    const ps = { configs: parseProviders(vars.MODEL_PROVIDERS), secrets: {} };
    must(show(parseUserModels(vars.USER_MODELS, ps)) === show([FLASH, LUNA]), `${file}: ${show(vars.USER_MODELS)}`);
    must(vars.HARNESS_MODEL === "deepseek-flash", `${file}: the default moved`);
  }
});

// ---- the order --------------------------------------------------------------

const UM = userModelsFrom({ USER_MODELS: [FLASH, LUNA] }, both);
const AGENT = { provider: "cloudflare", model: "anthropic/claude-agent" };
const TENANT = { provider: "cloudflare", model: "anthropic/claude-tenant" };
const DEPLOY = { provider: "deepseek", model: "deepseek-v4-pro" };
const none = { agent: null, tenant: null, deployment: null, owner: null };
const pick = (layers: Partial<typeof none> & Record<string, unknown>, um = UM) => {
  const r = resolveModel({ ...none, ...layers } as any, um, "deepseek-flash");
  return `${r.choice.provider}/${r.choice.model} ${r.source}${r.locked ? " locked" : ""}`;
};

await check("order: admin agent > admin tenant > owner > admin deployment > default, each pair", () => {
  for (const [layers, want, pair] of [
    [{ agent: AGENT, tenant: TENANT }, "cloudflare/anthropic/claude-agent admin locked", "agent over tenant"],
    [{ agent: AGENT, owner: LUNA.id }, "cloudflare/anthropic/claude-agent admin locked", "agent over owner"],
    [{ tenant: TENANT, owner: LUNA.id }, "cloudflare/anthropic/claude-tenant admin locked", "tenant over owner"],
    [{ owner: LUNA.id, deployment: DEPLOY }, "cloudflare/openai/gpt-5.6-luna owner", "owner over deployment"],
    [{ tenant: TENANT, deployment: DEPLOY }, "cloudflare/anthropic/claude-tenant admin locked", "tenant over deployment"],
    [{ deployment: DEPLOY }, "deepseek/deepseek-v4-pro admin", "deployment over default"],
    [{ owner: LUNA.id }, "cloudflare/openai/gpt-5.6-luna owner", "owner over default"],
    [{}, "deepseek/deepseek-flash default", "nothing"],
    [{ agent: AGENT, tenant: TENANT, owner: LUNA.id, deployment: DEPLOY }, "cloudflare/anthropic/claude-agent admin locked", "all of them"],
  ] as const) {
    must(pick(layers) === want, `${pair}: ${pick(layers)}, want ${want}`);
  }
});

await check("order: a stored pick that is no longer offered — removed from USER_MODELS, or its provider's secret unset — falls through, not an error", () => {
  const removed = userModelsFrom({ USER_MODELS: [FLASH] }, both);
  must(pick({ owner: LUNA.id, deployment: DEPLOY }, removed) === "deepseek/deepseek-v4-pro admin", `to the deployment's: ${pick({ owner: LUNA.id, deployment: DEPLOY }, removed)}`);
  must(pick({ owner: LUNA.id }, removed) === "deepseek/deepseek-flash default", `to the default: ${pick({ owner: LUNA.id }, removed)}`);
  const unavailable = userModelsFrom({ USER_MODELS: [FLASH, LUNA] }, providersFrom({ MODEL_PROVIDERS: PROVIDERS, DEEPSEEK_API_KEY: DK }));
  must(pick({ owner: LUNA.id }, unavailable) === "deepseek/deepseek-flash default", `provider unavailable: ${pick({ owner: LUNA.id }, unavailable)}`);
  must(pick({ owner: LUNA.id }, { offered: [], error: "refused" }) === "deepseek/deepseek-flash default", "a refused declaration");
  // Control: the same row, offered, is what runs.
  must(pick({ owner: LUNA.id }) === "cloudflare/openai/gpt-5.6-luna owner", "control");
});

// ---- the store --------------------------------------------------------------

/** D1 as node:sqlite, with every migration in cf/migrations applied. Errors are thrown, never read as empty. */
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

await check("store: each scope is read apart in one statement, the owner's pick for that agent only, and a pick is replaced and removed", async () => {
  const db = d1();
  const o = d1ModelOverrides(db), c = d1ModelChoices(db);
  must(show(await c.layers("t", "a")) === show(none), "an empty store");
  await o.put({ tenantId: "", agentId: "", ...DEPLOY, setBy: "adm", setAt: 1 });
  await o.put({ tenantId: "t", agentId: "", ...TENANT, setBy: "adm", setAt: 1 });
  await o.put({ tenantId: "t", agentId: "a", ...AGENT, setBy: "adm", setAt: 1 });
  await o.put({ tenantId: "t2", agentId: "", provider: "deepseek", model: "other-tenant", setBy: "adm", setAt: 1 });
  await c.put({ tenantId: "t", agentId: "a", choiceId: LUNA.id, setBy: "github:1", setAt: 2 });
  await c.put({ tenantId: "t", agentId: "b", choiceId: FLASH.id, setBy: "github:1", setAt: 2 });
  must(show(await c.layers("t", "a")) === show({ agent: AGENT, tenant: TENANT, deployment: DEPLOY, owner: LUNA.id }), show(await c.layers("t", "a")));
  must(show(await c.layers("t2", "a")) === show({ agent: null, tenant: { provider: "deepseek", model: "other-tenant" }, deployment: DEPLOY, owner: null }), `another tenant's agent of the same id: ${show(await c.layers("t2", "a"))}`);
  await c.put({ tenantId: "t", agentId: "a", choiceId: FLASH.id, setBy: "github:2", setAt: 3 });
  const row = db.raw.prepare("SELECT * FROM model_choices WHERE agent_id = 'a'").all();
  must(show(row) === show([{ tenant_id: "t", agent_id: "a", choice_id: FLASH.id, set_by: "github:2", set_at: 3 }]), show(row));
  must(await c.remove("t", "a") && !(await c.remove("t", "a")) && (await c.layers("t", "a")).owner === null && (await c.layers("t", "b")).owner === FLASH.id, "remove");
});

// ---- the routes and the next run --------------------------------------------

const SESSION = "s".repeat(32);
const KEK = Buffer.alloc(32, 7).toString("base64");
const T = "t1", A = "a1", MINE = "a1-second", OTHER_T = "t2", OTHER_A = "a2";
const DB = d1();
const hosts: Array<{ dispose(): void }> = [];
const objects = new Map<string, any>();
const env: Record<string, unknown> = {
  MODEL_QUEUE: { send: async () => {} },
  ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
  ARTIFACT_BUCKET: "b", CONTROL_DB: DB, HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  MODEL_PROVIDERS: PROVIDERS, USER_MODELS: [FLASH, LUNA], DEEPSEEK_API_KEY: DK, AI_GATEWAY_TOKEN: GT,
  AUTOMATION_TOKEN: "operator-token", SESSION_SECRET: SESSION, SECRET_KEK: KEK, UI_ALLOW_ANONYMOUS: "1",
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
const obj = (t: string, a: string) => objects.get(agentObjectName(t, a)) ?? fresh(agentObjectName(t, a));
const cookieOf = async (tenantId: string, agentId: string) =>
  (await sessionCookieFor(SESSION, { email: `${agentId}@x.test`, name: null, username: null, picture: null, source: "github", agentId, tenantId }, `gh-${agentId}`)).split(";")[0]!;
const mine = await cookieOf(T, A);
const theirs = await cookieOf(OTHER_T, OTHER_A);
const responses: string[] = [];
type Who = { cookie?: string } | { token: string } | "anonymous";
function headersFor(who: Who): Record<string, string> {
  if (who === "anonymous") return {};
  if ("token" in who) return { "x-harness-token": who.token };
  return { cookie: who.cookie ?? mine };
}
async function getModel(agentId: string | null, who: Who = {}) {
  const r = await worker.fetch(new Request(`https://console.test/ui/agent/model${agentId ? `?agentId=${agentId}` : ""}`, { headers: headersFor(who) }), env as never);
  const text = await r.text();
  responses.push(text);
  return { status: r.status, text, json: () => JSON.parse(text) };
}
/** A form post as the console's own page sends one: `Sec-Fetch-Site: same-origin`. */
async function postModel(fields: Record<string, string>, who: Who = {}) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...headersFor(who) };
  if (typeof who === "object" && "token" in who) delete headers["sec-fetch-site"];
  const r = await worker.fetch(new Request("https://console.test/ui/agent/model", { method: "POST", headers, body: new URLSearchParams(fields) }), env as never);
  const text = await r.text();
  responses.push(text);
  return { status: r.status, text, json: () => JSON.parse(text) };
}
const overrides = d1ModelOverrides(DB);
/** What the agent's operator binding names now. */
async function bound(t: string, a: string) {
  const b = await obj(t, a).runtime().store.getModelBinding(t, a);
  return b ? `${b.secretRef} ${b.model}` : "none";
}
/** The agent's next run, as the console's page open runs it: the binding is checked and, if stale, bound again. */
const nextRun = (t: string, a: string) => obj(t, a).uiEnsure(t, a, `t_${a}`);

// A second agent of the owner's, in their directory, the way `/ui/agent` records one.
await obj(T, A).uiRecordAgent(T, A, { agentId: MINE, name: "second", description: "", avatar: "", createdAt: 1 });

await check("route: GET answers the exact shape — the default, both options, nothing selected, unlocked", async () => {
  const r = await getModel(A);
  must(r.status === 200, `${r.status} ${r.text}`);
  must(r.text === show({
    effective: { label: "DeepSeek Flash", provider: "deepseek", model: "deepseek-flash", source: "default" },
    options: [{ id: "deepseek-flash", label: "DeepSeek Flash" }, { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
    selected: null, locked: false,
  }), r.text);
});

await check("route: POST a pick answers the new state and stores it with who set it; `default` clears it; the agent's model moves on its next run, not before", async () => {
  await nextRun(T, A);
  must(await bound(T, A) === "operator:model deepseek-flash", `before: ${await bound(T, A)}`);
  const r = await postModel({ agentId: A, choice: LUNA.id });
  must(r.status === 200 && show(r.json()) === show({
    effective: { label: "GPT-5.6 Luna", provider: "cloudflare", model: "openai/gpt-5.6-luna", source: "owner" },
    options: [{ id: "deepseek-flash", label: "DeepSeek Flash" }, { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
    selected: "gpt-5.6-luna", locked: false,
  }), `${r.status} ${r.text}`);
  const row: any = DB.raw.prepare("SELECT * FROM model_choices WHERE tenant_id = ? AND agent_id = ?").get(T, A);
  must(row?.choice_id === LUNA.id && row.set_by === `gh-${A}`, show(row));
  must(await bound(T, A) === "operator:model deepseek-flash", `the binding moved before a run: ${await bound(T, A)}`);
  await nextRun(T, A);
  must(await bound(T, A) === "operator:model:cloudflare openai/gpt-5.6-luna", `the next run did not rebind: ${await bound(T, A)}`);
  // An owner picking the default's own option: the label is the option's, the source the owner's.
  const flash = await postModel({ agentId: A, choice: FLASH.id });
  must(flash.json().effective.source === "owner" && flash.json().selected === FLASH.id, flash.text);
  await nextRun(T, A);
  must(await bound(T, A) === "operator:model deepseek-flash", `back: ${await bound(T, A)}`);
  await postModel({ agentId: A, choice: LUNA.id });
  const cleared = await postModel({ agentId: A, choice: "default" });
  must(cleared.status === 200 && cleared.json().selected === null && cleared.json().effective.source === "default", cleared.text);
  must(!DB.raw.prepare("SELECT 1 FROM model_choices WHERE agent_id = ?").get(A), "the row is still there");
  // Clearing what is not set is still the answer, not an error.
  must((await postModel({ agentId: A, choice: "default" })).status === 200, "a second clear");
});

await check("route: an admin's agent or tenant row locks the pick — 409 with the reason, nothing stored — and outranks a pick already made, on the next run", async () => {
  await postModel({ agentId: MINE, choice: LUNA.id });
  await nextRun(T, MINE);
  must(await bound(T, MINE) === "operator:model:cloudflare openai/gpt-5.6-luna", `the pick: ${await bound(T, MINE)}`);
  await overrides.put({ tenantId: T, agentId: "", provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 });
  const g = (await getModel(MINE)).json();
  must(g.locked === true && g.effective.source === "admin" && g.effective.label === "deepseek-v4-pro" && g.selected === LUNA.id, show(g));
  for (const choice of [FLASH.id, "default", "no-such-option"]) {
    const r = await postModel({ agentId: MINE, choice });
    must(r.status === 409 && r.json().error.code === "locked" && /administrator/.test(r.json().error.message), `${choice}: ${r.status} ${r.text}`);
  }
  must((DB.raw.prepare("SELECT choice_id FROM model_choices WHERE agent_id = ?").get(MINE) as any)?.choice_id === LUNA.id, "a locked post changed the row");
  await nextRun(T, MINE);
  must(await bound(T, MINE) === "operator:model deepseek-v4-pro", `the tenant row did not win on the next run: ${await bound(T, MINE)}`);
  await overrides.remove(T, "");
  await overrides.put({ tenantId: T, agentId: MINE, provider: "cloudflare", model: "openai/gpt-5", setBy: "adm", setAt: 1 });
  must((await postModel({ agentId: MINE, choice: FLASH.id })).status === 409, "an agent row did not lock");
  must((await getModel(A)).json().locked === false, "the agent row locked another agent");
  await overrides.remove(T, MINE);
  // Unlocked, the stored pick is what runs again.
  await nextRun(T, MINE);
  must(await bound(T, MINE) === "operator:model:cloudflare openai/gpt-5.6-luna", `the pick did not return: ${await bound(T, MINE)}`);
  // A deployment row does not lock, and the owner's pick outranks it.
  await overrides.put({ tenantId: "", agentId: "", provider: "deepseek", model: "deepseek-v4-pro", setBy: "adm", setAt: 1 });
  const d = (await getModel(MINE)).json();
  must(d.locked === false && d.effective.source === "owner", show(d));
  must((await getModel(A)).json().effective.source === "admin", "the deployment row is not what an agent without a pick runs");
  await overrides.remove("", "");
});

await check("route: an id that is not offered is 422 and stores nothing; a missing choice is 422", async () => {
  for (const choice of ["no-such-option", "openai/gpt-5.6-luna", "cloudflare"]) {
    const r = await postModel({ agentId: A, choice });
    must(r.status === 422 && r.json().error.code === "unknown_choice", `${choice}: ${r.status} ${r.text}`);
  }
  must((await postModel({ agentId: A })).status === 422, "no choice");
  must(!DB.raw.prepare("SELECT 1 FROM model_choices WHERE agent_id = ?").get(A), "an unknown id was stored");
  // An option the declaration lists but whose provider has no secret is not offered, so not accepted.
  const saved = env.AI_GATEWAY_TOKEN;
  delete env.AI_GATEWAY_TOKEN;
  try {
    const r = await postModel({ agentId: A, choice: LUNA.id });
    must(r.status === 422, `an unavailable option was accepted: ${r.status} ${r.text}`);
    must(show((await getModel(A)).json().options) === show([{ id: FLASH.id, label: FLASH.label }]), "an unavailable option was listed");
  } finally { env.AI_GATEWAY_TOKEN = saved; }
});

await check("route: a stored pick whose option was removed reads as no pick and runs the default, and returns when the option does", async () => {
  await postModel({ agentId: A, choice: LUNA.id });
  env.USER_MODELS = [FLASH];
  try {
    const g = (await getModel(A)).json();
    must(g.selected === null && g.effective.source === "default" && show(g.options) === show([{ id: FLASH.id, label: FLASH.label }]), show(g));
    await nextRun(T, A);
    must(await bound(T, A) === "operator:model deepseek-flash", `a removed option is still bound: ${await bound(T, A)}`);
  } finally { env.USER_MODELS = [FLASH, LUNA]; }
  must((await getModel(A)).json().selected === LUNA.id, "the pick did not return with its option");
  await postModel({ agentId: A, choice: "default" });
});

await check("route: absent USER_MODELS is no options, and only `default` is accepted", async () => {
  const saved = env.USER_MODELS;
  delete env.USER_MODELS;
  try {
    const g = (await getModel(A)).json();
    must(show(g.options) === "[]" && g.selected === null && g.effective.label === "deepseek-flash" && g.effective.source === "default", show(g));
    must((await postModel({ agentId: A, choice: FLASH.id })).status === 422 && (await postModel({ agentId: A, choice: "default" })).status === 200, "the feature is not off");
  } finally { env.USER_MODELS = saved; }
});

await check("route: only the owner — another person is told 404 for read and write alike; anonymous may read but not write; the operator's token reaches its own agent", async () => {
  const read = await getModel(A, { cookie: theirs });
  must(read.status === 404 && /no such agent/.test(read.text), `read: ${read.status} ${read.text}`);
  const write = await postModel({ agentId: A, choice: LUNA.id }, { cookie: theirs });
  must(write.status === 404, `write: ${write.status} ${write.text}`);
  must(!DB.raw.prepare("SELECT 1 FROM model_choices WHERE agent_id = ?").get(A), "another person's write was stored");
  // Control: the same requests as the owner are answered.
  must((await getModel(A)).status === 200 && (await getModel(MINE)).status === 200, "control: the owner was refused");
  const anonRead = await getModel(null, "anonymous");
  must(anonRead.status === 200 && anonRead.json().options.length === 2, `anonymous read: ${anonRead.status} ${anonRead.text}`);
  const anonWrite = await postModel({ choice: LUNA.id }, "anonymous");
  must(anonWrite.status === 403 && /read-only/.test(anonWrite.text), `anonymous write: ${anonWrite.status} ${anonWrite.text}`);
  // Another origin's page posting with the owner's cookie (forgedWrite).
  const cross = await worker.fetch(new Request("https://console.test/ui/agent/model", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-site", cookie: mine }, body: new URLSearchParams({ agentId: A, choice: LUNA.id }) }), env as never);
  must(cross.status === 403, `a same-site post: ${cross.status}`);
  const op = await postModel({ choice: LUNA.id }, { token: "operator-token" });
  must(op.status === 200 && op.json().selected === LUNA.id, `automation: ${op.status} ${op.text}`);
  must((DB.raw.prepare("SELECT agent_id FROM model_choices WHERE tenant_id = 'demo'").get() as any)?.agent_id === uiAgent("automation"), "the operator's pick is not on its own agent");
  must((await getModel(A, { token: "operator-token" })).status === 404, "the operator's token reached a person's agent through the console");
  must((await worker.fetch(new Request("https://console.test/ui/agent/model", { method: "PUT", headers: { cookie: mine, "sec-fetch-site": "same-origin" } }), env as never)).status === 405, "PUT");
});

await check("admin: a refused USER_MODELS is said on /admin/models, and a valid one is not called refused", async () => {
  const admin = async () => (await (await worker.fetch(new Request("https://console.test/admin/models", { headers: { "x-harness-token": "operator-token" } }), env as never)).json()) as any;
  must(!("userModelsError" in await admin()), "a valid declaration was reported refused");
  const saved = env.USER_MODELS;
  env.USER_MODELS = [{ ...LUNA, provider: "openrouter" }];
  try {
    must(/unknown provider openrouter/.test((await admin()).userModelsError ?? ""), "the refusal was not said");
  } finally { env.USER_MODELS = saved; }
});

await check("route: no answer carries an endpoint, a gateway, a secret's name or value, or an option's provider mapping beyond the effective model", async () => {
  must(responses.length >= 20, `only ${responses.length} answers were looked at`);
  for (const text of responses) {
    for (const bad of [DK, GT, "DEEPSEEK_API_KEY", "AI_GATEWAY_TOKEN", "gateway.ai.cloudflare.com", "api.deepseek.com", "https://", "baseUrl", "endpoint", "secret"]) {
      must(!text.includes(bad), `${bad} in ${text.slice(0, 200)}`);
    }
  }
  const g = (await getModel(A)).json();
  must(show(Object.keys(g)) === show(["effective", "options", "selected", "locked"]) && g.options.every((o: any) => show(Object.keys(o)) === show(["id", "label"])), show(g));
});

for (const h of hosts) h.dispose();
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
