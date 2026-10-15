/**
 * Changing an existing mount's settings in place (`PATCH /admin/mounts`, runtime `updateMountSettings`), and
 * provisioning's re-adopt keeping them. Through the Worker's own `fetch`, with the agent's object stood in for by a
 * real runtime, gateway and store on one in-memory SQLite, so the mount row, its sealed credential and its plugin
 * database can be read back as rows. Raft is a recording fetch, as in test/provision-runtime.ts.
 */
import { register } from "node:module";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { default: worker } = await import("../cf/src/index.ts");
const { setLogSink } = await import("../src/core/log.ts");
const { AgentRuntime } = await import("../cf/src/runtime.ts");
const { adoptProvisionedAgent, provisionTool, provisionPushStatus, PROVISION_MOUNT_ALIAS } = await import("../cf/src/provision/steps.ts");
const { handleProvision } = await import("../cf/src/provision/handlers.ts");
const { sqliteHost } = await import("../src/store/sqlite-host.ts");
const { operatorModelOf } = await import("../cf/src/model-request.ts");
const { repeatsMount } = await import("../src/runtime/mount-config.ts");
const { raftPlugin } = await import("../src/plugins/raft.ts");
import type { Plugin } from "../src/plugins/types.ts";
import type { ProvisionDeps } from "../cf/src/provision/handlers.ts";
import type { ProvisionedAgent } from "../cf/src/control-plane.ts";

const lines: string[] = [];
setLogSink((l) => lines.push(l));

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const TOKEN = "operator-token-mount-settings";
const ORIGIN = "https://api.raft.build";
const CRED = "sk_agent_" + "R".repeat(32);
const T = "t-raft";

globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = String(init?.method ?? "GET");
  const headers = new Headers(init?.headers ?? {});
  if (headers.get("authorization") !== `Bearer ${CRED}`) return new Response(JSON.stringify({ errorCode: "UNAUTHORIZED" }), { status: 401, headers: { "content-type": "application/json" } });
  if (u === `${ORIGIN}/internal/agent-api` && method === "GET") {
    return new Response(JSON.stringify({ agentId: "ag-1", agentName: "cody", agentDisplayName: "Cody", serverId: "srv-1" }), { headers: { "content-type": "application/json" } });
  }
  if (u === `${ORIGIN}/internal/agent-api/push-webhook`) return new Response(null, { status: 204 });
  return new Response(JSON.stringify({ errorCode: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
}) as any;

/** Answers the settings its call was made with, so "the next call sees the change" is read from a call. */
const ECHO: Plugin = {
  id: "echo", version: "1.0.0",
  config: [
    { name: "target", type: "string", required: true, summary: "Where it points." },
    { name: "mode", type: "string", changeable: true, summary: "How it answers." },
  ],
  tools: [{ name: "show", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke(_tool, _args, ctx) { return { config: ctx.publicConfig }; },
};

async function runtime() {
  const host = sqliteHost();
  const directory = {
    rows: new Map<string, any>(),
    async create(r: any) { this.rows.set(r.hookId, { ...r, createdAt: 1, revokedAt: null }); },
    async lookup(id: string) { return this.rows.get(id) ?? null; },
    async list() { return [...this.rows.values()]; },
    async revoke(id: string) { const r = this.rows.get(id); if (r) r.revokedAt = 2; return r ?? null; },
  };
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    secretKek: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "deepseek-flash",
      MODEL_PROVIDERS: [{ id: "deepseek", baseUrl: "https://model.example/v1", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } }] } as any),
    hooks: { origin: "https://hooks.test", directory },
    extraPlugins: [ECHO],
  } as any);
  await rt.ready();
  return { rt, host };
}

/** Provisioning's handler over the real steps, wired the way cf/src/index.ts `provisionDeps` wires them. */
function provisionDeps(rt: InstanceType<typeof AgentRuntime>): ProvisionDeps {
  let t = 1_800_000_000_000;
  const rows = new Map<string, ProvisionedAgent>();
  return {
    now: () => (t += 1000),
    registry: {
      async create(r) { rows.set(r.raftAgentId, { ...r, createdAt: t, updatedAt: t, deletedAt: null }); },
      async get(_tenantId, id) { return rows.get(id) ?? null; },
      async getByAgentId(_tenantId, agentId) { return [...rows.values()].find((r) => r.agentId === agentId) ?? null; },
      async update(_tenantId, id, patch) {
        const r = rows.get(id); if (!r) return false;
        rows.set(id, { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: t });
        return true;
      },
    },
    agent: {
      adopt: async (tenantId, agentId, spec) => {
        const r = await adoptProvisionedAgent(rt, tenantId, agentId, { ...spec, avatar: "0badcafe" });
        if (!r.ok && r.refused) return r.refused;
        if (!r.ok) throw new Error(r.error);
      },
      attachCredential: async (tenantId, agentId, credential) => {
        const r = await rt.attachCredential(tenantId, agentId, PROVISION_MOUNT_ALIAS, { token: credential });
        return r.ok ? { ok: true, account: r.account } : { ok: false, error: r.error };
      },
      removeCredential: async (tenantId, agentId) => (await rt.removeCredential(tenantId, agentId, PROVISION_MOUNT_ALIAS)).ok,
      tool: (tenantId, agentId, name) => provisionTool(rt, tenantId, agentId, name),
      pushStatus: (tenantId, agentId) => provisionPushStatus(rt, tenantId, agentId),
    },
  };
}

const WHO = { label: "raft-prod", tenantId: T, raftOrigin: ORIGIN, scope: "tenant" as const };
async function provision(deps: ProvisionDeps, method: string, path: string, payload?: unknown) {
  const r = await handleProvision(method, path, { idempotencyKey: null, raftServerId: null }, payload, WHO, deps);
  must(r, `${method} ${path}: no route`);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, text };
}

/** An agent Raft made: record, raft mount, sealed credential, push on, and a row of the plugin's own state. */
async function raftAgent() {
  const { rt, host } = await runtime();
  const deps = provisionDeps(rt);
  const made = await provision(deps, "POST", "/agents", {
    raftAgentId: "01JAGENT", raftServerId: "srv-1", raftOrigin: ORIGIN, name: "Cody", instructions: "be brief", credential: CRED,
  });
  must(made.status === 201, `POST ${made.status} ${made.text}`);
  const agentId = made.body.providerAgentId as string;
  rt.store.pluginDb.put({ tenantId: T, agentId, alias: PROVISION_MOUNT_ALIAS, plugin: raftPlugin.id }, "probe", "k", { kept: true }, null);
  return { rt, host, deps, agentId };
}

/** Everything of the raft mount except its settings, as rows: the mount row, its sealed credential, its plugin database. */
function identity(host: ReturnType<typeof sqliteHost>, agentId: string) {
  const mount = host.sql.exec("SELECT * FROM mounts WHERE agent_id = ? AND alias = ?", agentId, PROVISION_MOUNT_ALIAS).toArray()[0] as Record<string, unknown>;
  const { public_config: _settings, ...rest } = mount;
  return JSON.stringify({
    mount: rest,
    secrets: host.sql.exec("SELECT * FROM secrets WHERE agent_id = ? ORDER BY name", agentId).toArray(),
    pluginDb: host.sql.exec("SELECT * FROM plugin_db WHERE agent_id = ? ORDER BY store, key", agentId).toArray(),
  });
}
function settingsOf(host: ReturnType<typeof sqliteHost>, agentId: string, alias = PROVISION_MOUNT_ALIAS) {
  const row = host.sql.exec("SELECT public_config FROM mounts WHERE agent_id = ? AND alias = ?", agentId, alias).toArray()[0] as { public_config: string };
  return JSON.parse(row.public_config) as Record<string, unknown>;
}

/** The Worker, with every agent object stood in for by `rt`, recording which object methods were called. */
function env(rt: InstanceType<typeof AgentRuntime>, token: string | undefined = TOKEN) {
  const calls: string[] = [];
  const objectStub = {
    adminMountSettings: async (tenantId: string, agentId: string, alias: string, settings: unknown) => {
      calls.push("object.adminMountSettings");
      return rt.updateMountSettings(tenantId, agentId, alias, settings);
    },
  };
  return { calls, env: { AGENT: { idFromName: (n: string) => n, get: () => objectStub }, ...(token === undefined ? {} : { AUTOMATION_TOKEN: token }) } };
}
async function patch(e: ReturnType<typeof env>, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["x-harness-token"] = token;
  const res = await worker.fetch(new Request("https://x/admin/mounts", { method: "PATCH", headers, body: JSON.stringify(body) }), e.env as never,
    { waitUntil() {}, passThroughOnException() {} } as never);
  const text = await res.text();
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

await check("PATCH /admin/mounts needs the operator's token: unset, missing or wrong is 401 and never reaches the object", async () => {
  const { rt, host, agentId } = await raftAgent();
  const body = { tenantId: T, agentId, alias: "raft", settings: { conversationCards: true } };
  for (const [configured, presented] of [[undefined, null], [undefined, "x"], [TOKEN, null], [TOKEN, ""], [TOKEN, TOKEN + "x"]] as const) {
    const e = env(rt, configured);
    const r = await patch(e, body, presented);
    must(r.status === 401 && e.calls.length === 0, `${configured}/${presented}: ${r.status} ${r.text} ${e.calls}`);
  }
  must(settingsOf(host, agentId).conversationCards === undefined, "a refused call changed the setting");
  host.dispose();
});

await check("conversationCards is set and cleared in place: the answer is the mount's settings, with no secret, and one mount.settings line and trace row each", async () => {
  const { rt, host, agentId } = await raftAgent();
  const before = identity(host, agentId);
  const held = JSON.parse(before);
  must(held.pluginDb.some((r: any) => r.store === "probe") && held.pluginDb.some((r: any) => r.store === "push"), `the fixture has no plugin state to keep: ${before}`);
  must(held.mount.secret_ref === "agent:raft" && held.secrets.some((r: any) => r.name === "raft" && r.ciphertext), `the fixture has no sealed credential: ${before}`);
  lines.length = 0;
  const on = await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { conversationCards: true } });
  must(on.status === 200, `${on.status} ${on.text}`);
  must(JSON.stringify(on.body) === JSON.stringify({ alias: "raft", plugin: "raft", config: { serverUrl: ORIGIN, conversationCards: true }, changed: ["conversationCards"] }), on.text);
  must(!on.text.includes("sk_agent") && !/secret|ciphertext|credential/i.test(on.text), `the answer carries a secret: ${on.text}`);
  must(settingsOf(host, agentId).conversationCards === true, "not stored");
  must(identity(host, agentId) === before, "the credential, installation or plugin state moved");
  const logged = lines.map((l) => JSON.parse(l)).filter((l) => l.evt === "mount.settings");
  must(logged.length === 1 && logged[0].tenantId === T && logged[0].agentId === agentId && logged[0].alias === "raft" && logged[0].keys === "conversationCards",
    `log: ${JSON.stringify(logged)}`);
  must(!lines.some((l) => l.includes("sk_agent")), "a log line carries the credential");
  const off = await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { conversationCards: false } });
  must(off.status === 200 && off.body.config.conversationCards === false && off.body.changed[0] === "conversationCards", off.text);
  must(identity(host, agentId) === before, "the credential, installation or plugin state moved on the way off");
  const rows = host.sql.exec("SELECT kind, status, attrs FROM trace_outbox WHERE kind = 'mount.settings' ORDER BY seq").toArray() as Array<{ status: string; attrs: string }>;
  must(rows.length === 2 && rows.every((r) => r.status === "changed" && JSON.parse(r.attrs).keys[0] === "conversationCards" && JSON.parse(r.attrs).alias === "raft"),
    `trace: ${JSON.stringify(rows)}`);
  // The same value again changes nothing and writes no trace row.
  const again = await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { conversationCards: false } });
  must(again.status === 200 && again.body.changed.length === 0, again.text);
  must(host.sql.exec("SELECT seq FROM trace_outbox WHERE kind = 'mount.settings'").toArray().length === 2, "a no-op wrote a trace row");
  host.dispose();
});

await check("settings merge: a later PATCH of another key keeps the first, and serverUrl is kept throughout", async () => {
  const { rt, host, agentId } = await raftAgent();
  must((await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { conversationCards: true } })).status === 200, "cards");
  const r = await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { timeoutMs: 5000 } });
  must(r.status === 200 && JSON.stringify(r.body.config) === JSON.stringify({ serverUrl: ORIGIN, conversationCards: true, timeoutMs: 5000 }), r.text);
  must(JSON.stringify(settingsOf(host, agentId)) === JSON.stringify(r.body.config), "stored is not what was answered");
  host.dispose();
});

await check("serverUrl, an undeclared key and an empty change are 400; the mount's settings, credential and plugin state are byte-identical after", async () => {
  const { rt, host, agentId } = await raftAgent();
  must((await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { conversationCards: true } })).status === 200, "cards");
  const before = identity(host, agentId);
  const settingsBefore = JSON.stringify(settingsOf(host, agentId));
  lines.length = 0;
  const cases: Array<[unknown, RegExp]> = [
    [{ serverUrl: "https://evil.example" }, /"serverUrl" cannot be changed on an existing raft mount \(only timeoutMs, conversationCards can\)/],
    [{ serverUrl: ORIGIN }, /"serverUrl" cannot be changed/],
    [{ conversationCards: true, serverUrl: "https://evil.example" }, /"serverUrl" cannot be changed/],
    [{ conversation_cards: true }, /raft has no setting "conversation_cards"/],
    [{}, /settings is an object/],
    [undefined, /settings is an object/],
    [[true], /settings is an object/],
  ];
  for (const [settings, why] of cases) {
    const r = await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings });
    must(r.status === 400 && why.test(r.body?.error ?? ""), `${JSON.stringify(settings)}: ${r.status} ${r.text}`);
  }
  must(identity(host, agentId) === before, "a refused change moved the credential, installation or plugin state");
  must(JSON.stringify(settingsOf(host, agentId)) === settingsBefore, "a refused change moved the settings");
  must(!lines.some((l) => l.includes("mount.settings")), `a refused change was logged as made: ${lines}`);
  host.dispose();
});

await check("each value must be of its declared type: conversationCards a boolean, timeoutMs a number in its range", async () => {
  const { rt, host, agentId } = await raftAgent();
  for (const v of ["true", 1, 0, null, {}, ["true"]]) {
    const r = await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { conversationCards: v } });
    must(r.status === 400 && /"conversationCards" must be a boolean/.test(r.body.error), `${JSON.stringify(v)}: ${r.status} ${r.text}`);
  }
  for (const v of ["5000", true]) {
    const r = await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { timeoutMs: v } });
    must(r.status === 400 && /"timeoutMs" must be a number/.test(r.body.error), `${JSON.stringify(v)}: ${r.status} ${r.text}`);
  }
  must(settingsOf(host, agentId).conversationCards === undefined && settingsOf(host, agentId).timeoutMs === undefined, "a refused value was stored");
  host.dispose();
});

await check("an unknown agent or alias is 404, and a malformed agent id is 400 before the object", async () => {
  const { rt, host, agentId } = await raftAgent();
  const noAgent = await patch(env(rt), { tenantId: T, agentId: "raft_NOBODY", alias: "raft", settings: { conversationCards: true } });
  must(noAgent.status === 404 && /no agent raft_NOBODY/.test(noAgent.body.error), noAgent.text);
  const noAlias = await patch(env(rt), { tenantId: T, agentId, alias: "raft2", settings: { conversationCards: true } });
  must(noAlias.status === 404 && /no mount named raft2/.test(noAlias.body.error), noAlias.text);
  const e = env(rt);
  const noName = await patch(e, { tenantId: T, agentId, settings: { conversationCards: true } });
  must(noName.status === 400 && e.calls.length === 0, noName.text);
  const bad = await patch(e, { tenantId: "", agentId, alias: "raft", settings: { conversationCards: true } });
  must(bad.status === 400 && e.calls.length === 0, bad.text);
  host.dispose();
});

await check("a PATCH of the agent's name, and separately of its instructions, succeeds and keeps conversationCards true", async () => {
  const { rt, host, deps, agentId } = await raftAgent();
  must((await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { conversationCards: true } })).status === 200, "cards");
  const before = identity(host, agentId);
  const named = await provision(deps, "PATCH", `/agents/${agentId}`, { name: "Cody 2" });
  must(named.status === 200 && named.body.name === "Cody 2", `name: ${named.status} ${named.text}`);
  must(settingsOf(host, agentId).conversationCards === true, `after the name: ${JSON.stringify(settingsOf(host, agentId))}`);
  const told = await provision(deps, "PATCH", `/agents/${agentId}`, { instructions: "be thorough" });
  must(told.status === 200 && told.body.instructions === "be thorough", `instructions: ${told.status} ${told.text}`);
  must(settingsOf(host, agentId).conversationCards === true, `after the instructions: ${JSON.stringify(settingsOf(host, agentId))}`);
  const record = (await rt.store.loadAgent(T, agentId))?.config as any;
  must(record.name === "Cody 2" && record.description === "be thorough", JSON.stringify(record));
  must(identity(host, agentId) === before, "a re-adopt moved the credential, installation or plugin state");
  host.dispose();
});

await check("re-adopt at another origin is still a different mount, and leaves the stored one as it was", async () => {
  const { rt, host, agentId } = await raftAgent();
  must((await patch(env(rt), { tenantId: T, agentId, alias: "raft", settings: { conversationCards: true } })).status === 200, "cards");
  const before = identity(host, agentId);
  const r = await adoptProvisionedAgent(rt, T, agentId, { name: "Cody", instructions: "be brief", raftOrigin: "https://other.raft.example", avatar: "0badcafe" });
  must(!r.ok && /already a different mount/.test(r.error), JSON.stringify(r));
  must(JSON.stringify(settingsOf(host, agentId)) === JSON.stringify({ serverUrl: ORIGIN, conversationCards: true }), JSON.stringify(settingsOf(host, agentId)));
  must(identity(host, agentId) === before, "the refused adopt moved the mount");
  host.dispose();
});

await check("repeatsMount: a stored changeable setting the add does not name is a repeat; one it names differently, or an unmarked extra, is not", async () => {
  const stored = { serverUrl: ORIGIN, conversationCards: true };
  must(repeatsMount(raftPlugin, stored, { serverUrl: ORIGIN }), "serverUrl alone");
  must(repeatsMount(raftPlugin, stored, { serverUrl: ORIGIN, conversationCards: true }), "the same, named");
  must(!repeatsMount(raftPlugin, stored, { serverUrl: ORIGIN, conversationCards: false }), "named differently");
  must(!repeatsMount(raftPlugin, stored, { serverUrl: "https://other.example" }), "another origin");
  must(!repeatsMount(raftPlugin, { serverUrl: ORIGIN }, { serverUrl: ORIGIN, conversationCards: true }), "asks for a setting not stored");
  must(!repeatsMount(ECHO, { target: "a", extra: "x" }, { target: "a" }), "an unmarked stored setting");
  must(!repeatsMount(undefined, stored, { serverUrl: ORIGIN }), "no plugin: nothing is changeable");
});

await check("the next call runs with the changed settings: the gateway hands the plugin the row read for that call", async () => {
  const { rt, host } = await runtime();
  await rt.store.createAgent(T, "u-echo", {});
  await rt.store.setPluginChoice(T, "u-echo", "echo", "enable");
  const added = await rt.addMount(T, "u-echo", { alias: "echo1", plugin: "echo", config: { target: "a", mode: "plain" } });
  must(added.ok && added.added, JSON.stringify(added));
  const call = async () => {
    const r = await rt.gateway().invoke({ tenantId: T, agentId: "u-echo", taskId: "task-echo" } as any, "echo1.show", {});
    must(r.status === "succeeded", JSON.stringify(r));
    return (r as any).result.config;
  };
  must((await call()).mode === "plain", "first call");
  const changed = await rt.updateMountSettings(T, "u-echo", "echo1", { mode: "loud" });
  must(changed.ok, JSON.stringify(changed));
  must((await call()).mode === "loud", "the next call did not see the change");
  const refused = await rt.updateMountSettings(T, "u-echo", "echo1", { target: "b" });
  must(!refused.ok && refused.status === 400 && /only mode can/.test(refused.error), JSON.stringify(refused));
  // Adding it again as first written is a repeat: the changed setting is kept.
  const readd = await rt.addMount(T, "u-echo", { alias: "echo1", plugin: "echo", config: { target: "a" } });
  must(readd.ok && readd.added === false && settingsOf(host, "u-echo", "echo1").mode === "loud", `${JSON.stringify(readd)} ${JSON.stringify(settingsOf(host, "u-echo", "echo1"))}`);
  host.dispose();
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
