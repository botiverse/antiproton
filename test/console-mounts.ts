/**
 * Mounts and kept secrets from the console: `POST /ui/mount/add`, `/ui/mount/refresh`,
 * `/ui/mount/remove`, `/ui/secret`, `/ui/secret/remove`, and `kept` on `GET /ui/plugins`.
 *
 * Two halves. The runtime's rules first, on the real Durable Object store over node:sqlite with a
 * stand-in plugin whose snapshot and `configProblem` the cases control. Then the routes, through
 * the Worker's own `fetch` and `AgentDO` (the `cloudflare:workers` stand-in test/pd-migrate-object.ts
 * uses), with the real `mcp` plugin talking to an in-process server put in place of `globalThis.fetch`,
 * so the sign-in gate, the anonymous refusal, the ownership check and the answers are the shipped ones.
 */
import { register } from "node:module";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { mcpPlugin } from "../src/plugins/mcp.ts";
import { configFromForm } from "../src/runtime/mount-config.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { sessionCookieFor } from "../cf/src/auth.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { AgentRuntime, CONSOLE_MOUNTS_MAX, consoleAdded } = await import("../cf/src/runtime.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

// Every line the code under test prints, so a secret value can be looked for in the logs too.
const logged: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : show(a))).join(" ")); if (level !== "log") real(...args); };
}

const KEK = Buffer.alloc(32, 7).toString("base64");

// ---- the runtime ------------------------------------------------------------

/** A plugin offered to the console, whose server is the case's to decide. */
const REMOTE: Plugin = {
  id: "remote", version: "1.0.0", consoleMount: true, tools: [],
  config: [
    { name: "url", type: "string", required: true, summary: "Where." },
    { name: "headers", type: "string[]", summary: "Sent." },
    { name: "timeoutMs", type: "number", min: 1, max: 60_000, summary: "How long." },
  ],
  configProblem: (c) => (String(c.url).includes("inward") ? "the url points inward" : undefined),
  mountTools: (m) => m.toolSnapshot?.tools ?? [],
  async snapshotTools(ctx) {
    if (String(ctx.publicConfig?.url).includes("down")) throw new Error("the server is down");
    return { tools: [{ name: "ping", summary: "Ping.", parameters: { type: "object" }, sideEffects: "read", idempotency: "none" }] };
  },
  async invoke() { return {}; },
};
/** The same, without the console flag: only the operator may add it. */
const OPERATOR_ONLY: Plugin = { ...REMOTE, id: "operator-only", consoleMount: undefined };

async function runtime(opts: { kek?: boolean } = {}) {
  const host = sqliteHost();
  const rt: any = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    extraPlugins: [REMOTE, OPERATOR_ONLY], ...(opts.kek === false ? {} : { secretKek: KEK }),
  } as any);
  await rt.store.init();
  rt.ready = async () => {};
  await rt.store.createAgent("t", "a");
  return { rt, host };
}
const form = (url: string, extra: Record<string, string> = {}) => ({ url, ...extra });
const noHooks = { list: async () => [] };

await check("configFromForm: lines with blanks dropped, a number via Number(), blank means absent, strings trimmed", () => {
  const fields = REMOTE.config!;
  const r = configFromForm(fields, { url: "  https://x.test/mcp ", headers: "A: 1\n\n  \r\nB: {{k}}  \n", timeoutMs: " 2500 ", alias: "x" });
  must(r.ok && show(r.config) === show({ url: "https://x.test/mcp", headers: ["A: 1", "B: {{k}}"], timeoutMs: 2500 }), show(r));
  const blank = configFromForm(fields, { url: "https://x.test", headers: "\n \n", timeoutMs: "  " });
  must(blank.ok && show(blank.config) === show({ url: "https://x.test" }), `blank fields were kept: ${show(blank)}`);
  const nan = configFromForm(fields, { url: "https://x.test", timeoutMs: "soon" });
  must(!nan.ok && /should be a number/.test(nan.error), `NaN was let through: ${show(nan)}`);
});

await check("a console add stores the mount marked as console-added, switches the plugin on, and keeps its tools", async () => {
  const { rt } = await runtime();
  must((await rt.store.pluginChoices("t", "a"))["remote"] === undefined, "control: the plugin already had a choice");
  const r = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test/mcp", { headers: "X-Key: {{key}}\n" }));
  must(r.ok && r.added && r.tools?.ok && show(r.tools.tools) === show(["ping"]), `add: ${show(r)}`);
  const m = await rt.store.getMountByAlias("t", "a", "srv");
  must(m && consoleAdded(m) && show(m.publicConfig.headers) === show(["X-Key: {{key}}"]), `mount: ${show(m)}`);
  must(m.toolSnapshot?.tools?.[0]?.name === "ping", "no tool snapshot was kept");
  must((await rt.store.pluginChoices("t", "a"))["remote"] === "enable", "inherit was not turned into enable");
  // The operator's path marks nothing.
  const admin = await rt.addMount("t", "a", { alias: "op", plugin: "remote", config: { url: "https://op.test" } });
  must(admin.ok && !consoleAdded(await rt.store.getMountByAlias("t", "a", "op")), "an operator's mount reads as console-added");
});

await check("a snapshot that fails keeps the mount and says why", async () => {
  const { rt } = await runtime();
  const r = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://down.test/mcp"));
  must(r.ok && r.added && r.tools && !r.tools.ok && /server is down/.test(r.tools.error), `add: ${show(r)}`);
  must(await rt.store.getMountByAlias("t", "a", "srv"), "the mount was not kept");
});

await check("a plugin without consoleMount is refused from the console, before anything is stored", async () => {
  const { rt } = await runtime();
  for (const plugin of ["operator-only", "http", "state"]) {
    const r = await rt.addConsoleMount("t", "a", plugin, "x", form("https://x.test"));
    must(!r.ok && /cannot be added from the console/.test(r.error), `${plugin}: ${show(r)}`);
  }
  must((await rt.store.listMounts("t", "a")).length === 0, "something was mounted");
  must(Object.keys(await rt.store.pluginChoices("t", "a")).length === 0, "a choice was recorded");
  // The flag itself: mcp sets it, and no other installed plugin does.
  must(mcpPlugin.consoleMount === true, "mcp is not offered to the console");
  const flagged = rt.plugins().filter((p: Plugin) => p.consoleMount).map((p: Plugin) => p.id).sort();
  must(show(flagged) === show(["mcp", "remote"]), `offered to the console: ${show(flagged)}`);
});

await check("an explicit disable is refused, not overridden", async () => {
  const { rt } = await runtime();
  await rt.store.setPluginChoice("t", "a", "remote", "disable");
  const r = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test"));
  must(!r.ok && /switched off/.test(r.error), show(r));
  must(!(await rt.store.getMountByAlias("t", "a", "srv")), "mounted anyway");
  must((await rt.store.pluginChoices("t", "a"))["remote"] === "disable", "the owner's disable was changed");
});

await check(`the cap: ${CONSOLE_MOUNTS_MAX} console-added mounts, and operator mounts do not count`, async () => {
  const { rt } = await runtime();
  await rt.addMount("t", "a", { alias: "op", plugin: "remote", config: { url: "https://op.test" } }); // the operator's
  for (let i = 0; i < CONSOLE_MOUNTS_MAX; i++) {
    const r = await rt.addConsoleMount("t", "a", "remote", `s${i}`, form(`https://s${i}.test`));
    must(r.ok && r.added, `mount ${i}: ${show(r)}`);
  }
  const over = await rt.addConsoleMount("t", "a", "remote", "one-more", form("https://more.test"));
  must(!over.ok && /most it may have/.test(over.error), `the ${CONSOLE_MOUNTS_MAX + 1}th: ${show(over)}`);
  must(!(await rt.store.getMountByAlias("t", "a", "one-more")), "the one over the cap was stored");
  must((await rt.removeMount("t", "a", "s0", noHooks)).ok, "remove one");
  const again = await rt.addConsoleMount("t", "a", "remote", "one-more", form("https://more.test"));
  must(again.ok && again.added, `after removing one: ${show(again)}`);
});

await check("configProblem and the declared checks refuse before anything is stored, on every path", async () => {
  const { rt } = await runtime();
  const own = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://inward.test"));
  must(!own.ok && /points inward/.test(own.error), `configProblem, console: ${show(own)}`);
  const missing = await rt.addConsoleMount("t", "a", "remote", "srv", {});
  must(!missing.ok && /needs "url"/.test(missing.error), `required: ${show(missing)}`);
  const big = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://x.test", { timeoutMs: "999999" }));
  must(!big.ok && /between/.test(big.error), `bounds: ${show(big)}`);
  must(Object.keys(await rt.store.pluginChoices("t", "a")).length === 0, "a refused add switched the plugin on");
  // The operator's route and provisioning hear the same refusal.
  await rt.store.setPluginChoice("t", "a", "remote", "enable");
  const admin = await rt.addMount("t", "a", { alias: "srv", plugin: "remote", config: { url: "https://inward.test" } });
  must(!admin.ok && /points inward/.test(admin.error), `configProblem, /admin/mounts: ${show(admin)}`);
  let thrown = "";
  try { await rt.provision("t", "a", [{ alias: "srv", plugin: "remote", config: { url: "https://inward.test" } }], { chosen: true }); }
  catch (e) { thrown = String((e as Error).message); }
  must(/points inward/.test(thrown), `configProblem, provisioning: ${thrown || "accepted"}`);
  must((await rt.store.listMounts("t", "a")).length === 0, "a refused mount was stored");
});

await check("remove deletes the mount, its tool snapshot, its databases and a left-over credential row", async () => {
  const { rt, host } = await runtime();
  await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test"));
  must((await rt.store.getMountByAlias("t", "a", "srv"))?.toolSnapshot, "control: no snapshot to remove");
  host.sql.exec("INSERT INTO plugin_db(tenant_id, agent_id, alias, plugin, store, key, value, idx, updated_at) VALUES ('t','a','srv','remote','s','k','\"v\"',NULL,0)");
  host.sql.exec("INSERT INTO plugin_db(tenant_id, agent_id, alias, plugin, store, key, value, idx, updated_at) VALUES ('t','a','other','remote','s','k','\"v\"',NULL,0)");
  await rt.store.putSecret("t", "a", "srv", { ciphertext: "c", iv: "i" });
  const r = await rt.removeMount("t", "a", "srv", noHooks);
  must(r.ok, `remove: ${show(r)}`);
  must(!(await rt.store.getMountByAlias("t", "a", "srv")), "the mount is still there");
  const rows = host.sql.exec("SELECT alias FROM plugin_db").toArray().map((x: any) => x.alias);
  must(show(rows) === show(["other"]), `plugin databases after: ${show(rows)}`);
  must(!(await rt.store.getSecret("t", "a", "srv")), "the credential row named after the alias survived");
  // A mount added again under the alias inherits no tool list from the one removed.
  const back = await rt.addConsoleMount("t", "a", "remote", "srv", form("https://down.test"));
  must(back.ok && !(await rt.store.getMountByAlias("t", "a", "srv"))?.toolSnapshot, "the new mount carries the old snapshot");
  const gone = await rt.removeMount("t", "a", "nope", noHooks);
  must(!gone.ok && !gone.conflict && /no mount named/.test(gone.error), `unknown alias: ${show(gone)}`);
});

await check("both stores' removeMount delete the row, its databases and the named credential row, and nothing of another mount", async () => {
  const { DurableObjectStore } = await import("../src/store/durable-object.ts");
  const { SqliteStore } = await import("../src/store/sqlite.ts");
  const host = sqliteHost();
  const doStore = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  const lite = new SqliteStore(":memory:");
  for (const [name, store] of [["durable-object", doStore], ["sqlite", lite]] as const) {
    await store.init();
    for (const alias of ["srv", "other"]) {
      await store.addMount({ tenantId: "t", agentId: "a", alias, plugin: "remote", installationId: `console:${alias}`, connectionId: null,
        toolVersion: "1.0.0", publicConfig: { url: "https://x.test" }, secretRef: null, policy: null });
      store.pluginDb.ensure().put({ tenantId: "t", agentId: "a", alias, plugin: "remote" }, "s", "k", "v", null);
      await store.putSecret("t", "a", alias, { ciphertext: "c", iv: "i" });
    }
    must(await store.removeMount("t", "a", "srv", "srv"), `${name}: removeMount answered false`);
    must(!(await store.getMountByAlias("t", "a", "srv")) && await store.getMountByAlias("t", "a", "other"), `${name}: the wrong rows went`);
    const dbs = store.pluginDb.summary("t", "a").map((r: any) => r.alias);
    must(show(dbs) === show(["other"]), `${name}: plugin databases after: ${show(dbs)}`);
    must(!(await store.getSecret("t", "a", "srv")) && await store.getSecret("t", "a", "other"), `${name}: credential rows after`);
    must(!(await store.removeMount("t", "a", "srv", null)), `${name}: a second remove answered true`);
  }
});

await check("remove is refused while a credential, a live hook or a held call is on the mount, and for an operator-only plugin", async () => {
  const { rt } = await runtime();
  await rt.addConsoleMount("t", "a", "remote", "srv", form("https://srv.test"));
  await rt.store.setMountSecretRef("t", "a", "srv", "agent:srv");
  const cred = await rt.removeMount("t", "a", "srv", noHooks);
  must(!cred.ok && cred.conflict && /account attached/.test(cred.error), `credential: ${show(cred)}`);
  await rt.store.setMountSecretRef("t", "a", "srv", null);
  const live = { list: async () => [{ hookId: "h", tenantId: "t", agentId: "a", alias: "srv", createdAt: 0, revokedAt: null }] };
  const hook = await rt.removeMount("t", "a", "srv", live);
  must(!hook.ok && hook.conflict && /live inbound hook/.test(hook.error), `hook: ${show(hook)}`);
  const revoked = { list: async () => [{ hookId: "h", tenantId: "t", agentId: "a", alias: "srv", createdAt: 0, revokedAt: 1 }] };
  const broken = { list: async () => { throw new Error("D1 is away"); } };
  const unread = await rt.removeMount("t", "a", "srv", broken);
  must(!unread.ok && unread.conflict && /could not check/.test(unread.error), `an unreadable index: ${show(unread)}`);
  await rt.store.requireApproval({ tenantId: "t", operationId: "op1", agentId: "a", taskId: "main", mountAlias: "srv", tool: "ping", request: {} });
  const held = await rt.removeMount("t", "a", "srv", revoked);
  must(!held.ok && held.conflict && /waiting for a decision/.test(held.error), `held: ${show(held)}`);
  must(await rt.store.getMountByAlias("t", "a", "srv"), "a refused remove deleted the mount");
  await rt.store.decideApproval("t", "op1", "denied", "me");
  must((await rt.removeMount("t", "a", "srv", revoked)).ok, "with the hook revoked and the call decided, the remove is refused");
  await rt.addMount("t", "a", { alias: "op", plugin: "operator-only", config: { url: "https://op.test" } });
  await rt.store.setPluginChoice("t", "a", "operator-only", "enable");
  await rt.addMount("t", "a", { alias: "op", plugin: "operator-only", config: { url: "https://op.test" } });
  const op = await rt.removeMount("t", "a", "op", noHooks);
  must(!op.ok && op.conflict && /cannot be removed from the console/.test(op.error), `operator-only: ${show(op)}`);
});

await check("kept secrets: the agent's own rows and rules, readable by secret_list, sealed, never returned", async () => {
  const { rt, host } = await runtime();
  const value = "sk-live-0123456789abcdef";
  must(show(await rt.putKeptSecret("t", "a", "key", value)) === show({ ok: true }), "put");
  const state = rt.plugins().find((p: Plugin) => p.id === "state");
  const listed: any = await state.invoke("secret_list", {}, { caller: { tenantId: "t", agentId: "a", taskId: "main" }, publicConfig: {} });
  must(listed.secrets.length === 1 && listed.secrets[0].name === "key", `secret_list: ${show(listed)}`);
  must(show(await rt.keptSecrets("t", "a")) === show(listed.secrets), "the console's list is not secret_list's");
  const got: any = await state.invoke("secret_get", { name: "key" }, { caller: { tenantId: "t", agentId: "a", taskId: "main" }, publicConfig: {} });
  must(got.value === value, "the agent cannot read back what the owner kept");
  const raw = show(host.sql.exec("SELECT * FROM secrets").toArray());
  must(raw.includes("kept:key") && !raw.includes(value), "the row is not a sealed kept: row");
  for (const [name, v, why] of [["bad name", value, /name must be/], ["key", "", /non-empty/], ["key", "x".repeat(8_001), /longer than 8000/]] as const) {
    const r = await rt.putKeptSecret("t", "a", name, v);
    must(!r.ok && why.test(r.error) && !r.error.includes(value), `${name}/${v.length}: ${show(r)}`);
  }
  must(show(await rt.removeKeptSecret("t", "a", "key")) === show({ ok: true, removed: true }), "remove");
  must((await rt.keptSecrets("t", "a")).length === 0, "still listed");
  const { rt: bare } = await runtime({ kek: false });
  const nokek = await bare.putKeptSecret("t", "a", "key", value);
  must(!nokek.ok && /SECRET_KEK/.test(nokek.error), `without a KEK: ${show(nokek)}`);
});

// ---- the routes -------------------------------------------------------------

const SESSION = "s".repeat(32);
const T = "t1", A = "a1", OTHER_T = "t2", OTHER_A = "a2";
const VALUE = "sk-console-secret-9f8e7d6c5b4a";

/** An MCP server in the place of `fetch`, recording the headers it was sent. */
const seenHeaders: Array<Record<string, string>> = [];
let serverDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
  if (serverDown) throw new Error("connect ECONNREFUSED");
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  if (String(init.method ?? "GET") !== "POST") return new Response(null, { status: 405 });
  const msg = JSON.parse(String(init.body));
  seenHeaders.push(headers);
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  if (msg.method === "initialize") return json({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
  if (msg.method === "tools/list") return json({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

let liveHooks: Array<Record<string, unknown>> = [];
const d1 = () => {
  const stmt = (sql: string) => {
    const s: any = {
      bind: () => s, first: async () => null, run: async () => ({ meta: { changes: 1 } }),
      all: async () => ({ results: sql.includes("inbound_hooks") ? liveHooks : [] }),
    };
    return s;
  };
  return { prepare: (sql: string) => stmt(sql), batch: async (s: unknown[]) => s.map(() => ({ results: [], meta: { changes: 1 } })) };
};
const hosts: Array<{ dispose(): void }> = [];
const objects = new Map<string, any>();
const env: Record<string, unknown> = {
  MODEL_QUEUE: { send: async () => {} },
  ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
  ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "m1", DEEPSEEK_BASE_URL: "https://model.example/v1",
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
const cookieOf = async (tenantId: string, agentId: string) =>
  (await sessionCookieFor(SESSION, { email: `${agentId}@x.test`, name: null, username: null, picture: null, source: "github", agentId, tenantId }, `gh-${agentId}`)).split(";")[0]!;
const mine = await cookieOf(T, A);
const theirs = await cookieOf(OTHER_T, OTHER_A);
const responses: string[] = [];
async function post(path: string, fields: Record<string, string>, opts: { cookie?: string | null; json?: boolean } = {}) {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? mine;
  if (opts.json) headers.accept = "application/json";
  const r = await worker.fetch(new Request(`https://console.test${path}`, { method: "POST", headers, body }), env as never);
  const text = await r.text();
  responses.push(text);
  return { status: r.status, text, json: () => JSON.parse(text) };
}
async function get(path: string, cookie = mine) {
  const r = await worker.fetch(new Request(`https://console.test${path}`, { headers: { cookie } }), env as never);
  const text = await r.text();
  responses.push(text);
  return { status: r.status, text };
}
const home = () => objects.get(agentObjectName(T, A)) ?? fresh(agentObjectName(T, A));
const MCP_URL = "https://mcp.example.test/mcp";

const panel = (t: string) => t.includes("<h3>this agent's mounts</h3>");

await check("route: add, through the sign-in gate, answers the plugins panel and the result", async () => {
  const r = await post("/ui/mount/add", { plugin: "mcp", alias: "plain", url: MCP_URL, headers: "\n\n", timeoutMs: "" }, { json: true });
  must(r.status === 200, `status ${r.status}: ${r.text}`);
  const j = r.json();
  must(j.ok && j.added && j.tools?.ok && show(j.tools.tools) === show(["echo"]), `result: ${show(j)}`);
  must(panel(j.html) && j.html.includes("plain__echo"), `html: ${String(j.html).slice(0, 200)}`);
  const m = await home().runtime().store.getMountByAlias(T, A, "plain");
  must(m && consoleAdded(m) && show(m.publicConfig) === show({ url: MCP_URL }), `stored: ${show(m)}`);
  const d = await home().uiPlugins(T, A);
  const row = d.mounts.find((x: any) => x.alias === "plain");
  must(row?.fromConsole === true && row.snapshotError === null && d.consoleMountsMax === 8, `payload: ${show(row)}`);
  must(d.installed.find((p: any) => p.id === "mcp")?.addable === true && d.installed.filter((p: any) => p.addable).length === 1, "addable is not exactly mcp");
  // htmx's answer is the panel itself.
  const plain = await post("/ui/mount/add", { plugin: "mcp", alias: "plain", url: MCP_URL });
  must(plain.status === 200 && panel(plain.text) && !plain.text.trimStart().startsWith("{"), `html: ${plain.status} ${plain.text.slice(0, 80)}`);
});

await check("route: add refusals are 400 with the reason, and store nothing", async () => {
  for (const [fields, why] of [
    [{ plugin: "http", alias: "web9", url: MCP_URL }, /cannot be added from the console/],
    [{ plugin: "mcp", alias: "Bad Alias", url: MCP_URL }, /an alias is/],
    [{ plugin: "mcp", alias: "nourl" }, /needs "url"/],
    [{ plugin: "mcp", alias: "keyed", url: MCP_URL, headers: "Authorization: Bearer abc123" }, /headers/],
    [{ plugin: "mcp", alias: "slow", url: MCP_URL, timeoutMs: "later" }, /should be a number/],
  ] as const) {
    const r = await post("/ui/mount/add", fields, { json: true });
    must(r.status === 400 && why.test(r.json().error), `${show(fields)}: ${r.status} ${r.text}`);
    must(!(await home().runtime().store.getMountByAlias(T, A, fields.alias)), `${fields.alias} was stored`);
  }
  const text = await post("/ui/mount/add", { plugin: "http", alias: "web9", url: MCP_URL });
  must(text.status === 400 && /cannot be added/.test(text.text), `plain refusal: ${text.text}`);
});

await check("route: an inward server url is refused by /ui/mount/add and by /admin/mounts alike (mcp's configProblem), before anything is stored", async () => {
  const INWARD = "https://169.254.169.254.nip.io/mcp";
  const before = seenHeaders.length;
  const ui = await post("/ui/mount/add", { plugin: "mcp", alias: "meta", url: INWARD }, { json: true });
  must(ui.status === 400 && /public host/.test(ui.json().error), `console: ${ui.status} ${ui.text}`);
  const admin = await worker.fetch(new Request("https://console.test/admin/mounts", {
    method: "POST", headers: { "x-harness-token": "operator-token", "content-type": "application/json" },
    body: JSON.stringify({ tenantId: T, agentId: A, alias: "meta", plugin: "mcp", config: { url: INWARD } }),
  }), env as never);
  const body = await admin.json() as { error?: string };
  must(admin.status === 400 && /public host/.test(body.error ?? ""), `admin: ${admin.status} ${show(body)}`);
  must(!(await home().runtime().store.getMountByAlias(T, A, "meta")), "the inward mount was stored");
  must(seenHeaders.length === before, "the inward server was asked for its tools");
});

await check("route: a snapshot failure is 200 with the mount, and the error is kept on it", async () => {
  // The slot names a secret not kept yet, so the listing fails before anything is sent.
  const r = await post("/ui/mount/add", { plugin: "mcp", alias: "docs", url: MCP_URL, headers: "X-Api-Key: {{docs-key}}\n" }, { json: true });
  const j = r.json();
  must(r.status === 200 && j.ok && j.added && j.tools && !j.tools.ok && /no secret named docs-key/.test(j.tools.error), `${r.status} ${r.text}`);
  must(await home().runtime().store.getMountByAlias(T, A, "docs"), "the mount was not kept");
  serverDown = true;
  try {
    const down = await post("/ui/mount/add", { plugin: "mcp", alias: "flaky", url: MCP_URL }, { json: true });
    must(down.status === 200 && !down.json().tools.ok, `server down: ${down.status} ${down.text}`);
  } finally { serverDown = false; }
  const d = await home().uiPlugins(T, A);
  const row = (a: string) => d.mounts.find((x: any) => x.alias === a);
  must(/no secret named docs-key/.test(row("docs")?.snapshotError ?? ""), `docs: ${show(row("docs"))}`);
  must(/could not list flaky/.test(row("flaky")?.snapshotError ?? ""), `flaky: ${show(row("flaky"))}`);
  must(row("docs").fromConsole === true, "not marked as added from the console");
});

await check("route: a kept secret fills the header slot on refresh, which clears the kept error", async () => {
  const before = seenHeaders.length;
  const put = await post("/ui/secret", { name: "docs-key", value: VALUE }, { json: true });
  must(put.status === 200 && put.json().ok && panel(put.json().html) && show(put.json().secrets.map((s: any) => s.name)) === show(["docs-key"]), `${put.status} ${put.text}`);
  const r = await post("/ui/mount/refresh", { alias: "docs" }, { json: true });
  const j = r.json();
  must(r.status === 200 && j.ok && j.changed === true && show(j.tools) === show(["echo"]) && Array.isArray(j.skipped) && typeof j.toolsTakenAt === "number", `refresh: ${r.status} ${r.text}`);
  must(seenHeaders.slice(before).some((h) => h["x-api-key"] === VALUE), "the slot was not filled from the kept secret");
  const d = await home().uiPlugins(T, A);
  must(d.mounts.find((x: any) => x.alias === "docs")?.snapshotError === null, "a successful refresh left the error");
  must(show(d.kept.map((k: any) => k.name)) === show(["docs-key"]) && typeof d.kept[0].storedAt === "string" && typeof d.kept[0].lastReadAt === "string", `kept: ${show(d.kept)}`);
  must((await get("/ui/plugins")).status === 200, "GET /ui/plugins");
  const badName = await post("/ui/secret", { name: "no spaces", value: VALUE }, { json: true });
  must(badName.status === 400 && /name must be/.test(badName.json().error), `bad name: ${badName.text}`);
  const failed = await post("/ui/mount/refresh", { alias: "nope" }, { json: true });
  must(failed.status === 200 && !failed.json().ok && /no mount named/.test(failed.json().error), `refresh of nothing: ${failed.text}`);
  const noAlias = await post("/ui/mount/refresh", {}, { json: true });
  must(noAlias.status === 400, `refresh without an alias: ${noAlias.status}`);
});

await check("route: an operator's mount, added through /admin/mounts, is neither refreshed nor removed from the console", async () => {
  const admin = (token: string) => worker.fetch(new Request("https://console.test/admin/mounts", {
    method: "POST", headers: { "x-harness-token": token, "content-type": "application/json" },
    body: JSON.stringify({ tenantId: T, agentId: A, alias: "opmcp", plugin: "mcp", config: { url: MCP_URL } }),
  }), env as never);
  must((await admin("operator-tokeN")).status === 401 && (await admin("")).status === 401, "a wrong token was let in");
  const added = await admin("operator-token");
  must(added.status === 200 && (await added.json() as any).added === true, `admin add: ${added.status}`);
  must(!(await home().uiPlugins(T, A)).mounts.find((x: any) => x.alias === "opmcp").fromConsole, "the operator's mount reads as console-added");
  const refresh = await post("/ui/mount/refresh", { alias: "opmcp" }, { json: true });
  must(refresh.status === 200 && !refresh.json().ok && /not added from the console/.test(refresh.json().error), `refresh: ${refresh.text}`);
  const remove = await post("/ui/mount/remove", { alias: "opmcp" }, { json: true });
  must(remove.status === 409 && /only the operator/.test(remove.json().error), `remove: ${remove.status} ${remove.text}`);
  must(await home().runtime().store.getMountByAlias(T, A, "opmcp"), "the operator's mount was removed");
});

await check("route: remove answers 409 with the reason while a hook or a credential is on it, then removes and leaves no snapshot", async () => {
  liveHooks = [{ hook_id: "h1", tenant_id: T, agent_id: A, alias: "docs", created_at: 1, revoked_at: null }];
  try {
    const held = await post("/ui/mount/remove", { alias: "docs" }, { json: true });
    must(held.status === 409 && /live inbound hook/.test(held.json().error), `with a hook: ${held.status} ${held.text}`);
  } finally { liveHooks = []; }
  const store = home().runtime().store;
  await store.setMountSecretRef(T, A, "docs", "agent:docs");
  const cred = await post("/ui/mount/remove", { alias: "docs" });
  must(cred.status === 409 && /account attached/.test(cred.text), `with a credential: ${cred.status} ${cred.text}`);
  await store.setMountSecretRef(T, A, "docs", null);
  must((await store.getMountByAlias(T, A, "docs"))?.toolSnapshot, "control: no snapshot before the remove");
  const r = await post("/ui/mount/remove", { alias: "docs" }, { json: true });
  must(r.status === 200 && r.json().removed === true && panel(r.json().html), `remove: ${r.status} ${r.text}`);
  must(!(await store.getMountByAlias(T, A, "docs")), "the mount is still stored");
  const raw = home().ctx.storage.sql;
  const left = raw.exec("SELECT alias, tool_snapshot FROM mounts WHERE alias = 'docs'").toArray();
  must(left.length === 0, `a row for docs survived: ${show(left)}`);
  must(!(await home().uiPlugins(T, A)).mounts.some((m: any) => m.alias === "docs"), "the console still lists it");
  // The flaky mount's kept error goes with it.
  must((await post("/ui/mount/remove", { alias: "flaky" })).status === 200, "remove flaky");
  must(raw.exec("SELECT alias FROM mount_snapshot_errors WHERE alias = 'flaky'").toArray().length === 0, "the snapshot error outlived its mount");
  const missing = await post("/ui/mount/remove", { alias: "ghost" }, { json: true });
  must(missing.status === 400, `an unknown alias: ${missing.status}`);
});

await check("route: secret/remove deletes the kept row; without SECRET_KEK a put is 400", async () => {
  const r = await post("/ui/secret/remove", { name: "docs-key" }, { json: true });
  must(r.status === 200 && r.json().removed === true && r.json().secrets.length === 0, `${r.status} ${r.text}`);
  const kek = env.SECRET_KEK;
  delete env.SECRET_KEK;
  try {
    const nokek = await post("/ui/secret", { name: "k", value: VALUE }, { json: true, cookie: await cookieOf("t3", "a3") });
    must(nokek.status === 400 && /SECRET_KEK/.test(nokek.json().error), `${nokek.status} ${nokek.text}`);
  } finally { env.SECRET_KEK = kek; }
});

await check("route: another tenant's agentId is 404 on every new write, and nothing is written there", async () => {
  // The other tenant's agent exists and has a mount of its own.
  await post("/ui/mount/add", { plugin: "mcp", alias: "theirs", url: MCP_URL }, { cookie: theirs });
  const before = await objects.get(agentObjectName(OTHER_T, OTHER_A)).runtime().store.listMounts(OTHER_T, OTHER_A);
  must(before.some((m: any) => m.alias === "theirs"), "control: the other tenant's mount was not made");
  for (const [path, fields] of [
    ["/ui/mount/add", { plugin: "mcp", alias: "intruder", url: MCP_URL }],
    ["/ui/mount/refresh", { alias: "theirs" }],
    ["/ui/mount/remove", { alias: "theirs" }],
    ["/ui/secret", { name: "planted", value: VALUE }],
    ["/ui/secret/remove", { name: "planted" }],
    ["/ui/plugin/choice", { plugin: "mcp", choice: "disable" }],
  ] as const) {
    const r = await post(path, { ...fields, agentId: OTHER_A }, { json: true });
    must(r.status === 404, `${path} with another tenant's agentId: ${r.status} ${r.text}`);
  }
  const store = objects.get(agentObjectName(OTHER_T, OTHER_A)).runtime().store;
  must(show((await store.listMounts(OTHER_T, OTHER_A)).map((m: any) => m.alias)) === show(before.map((m: any) => m.alias)), "the other agent's mounts changed");
  must((await store.listSecretNames(OTHER_T, OTHER_A, "kept:")).length === 0, "a secret was planted");
  must((await store.pluginChoices(OTHER_T, OTHER_A))["mcp"] !== "disable", "the other agent's plugin was switched off");
});

await check("route: an anonymous viewer is refused every new write and /ui/plugin/choice, and changes nothing", async () => {
  const store = home().runtime().store;
  const choicesBefore = show(await store.pluginChoices(T, A));
  const mountsBefore = (await store.listMounts(T, A)).length;
  for (const [path, fields] of [
    ["/ui/mount/add", { plugin: "mcp", alias: "anon", url: MCP_URL }],
    ["/ui/mount/refresh", { alias: "flaky" }],
    ["/ui/mount/remove", { alias: "flaky" }],
    ["/ui/secret", { name: "anon", value: VALUE }],
    ["/ui/secret/remove", { name: "anon" }],
    ["/ui/plugin/choice", { plugin: "mcp", choice: "disable" }],
  ] as const) {
    const r = await post(path, fields, { cookie: null });
    must(r.status === 403 && /read-only/.test(r.text), `${path} anonymously: ${r.status} ${r.text}`);
  }
  // Anonymous reaches the gate at all: a read is still answered.
  must((await get("/ui/plugins", "")).status === 200, "control: the anonymous viewer cannot read either, so the 403s prove nothing");
  must(show(await store.pluginChoices(T, A)) === choicesBefore, "a plugin choice changed");
  must((await store.listMounts(T, A)).length === mountsBefore, "the mounts changed");
});

await check("route: the owner's own /ui/plugin/choice still works", async () => {
  const r = await post("/ui/plugin/choice", { plugin: "mcp", choice: "disable" });
  must(r.status === 200, `${r.status} ${r.text}`);
  must((await home().runtime().store.pluginChoices(T, A))["mcp"] === "disable", "the choice was not recorded");
  const refused = await post("/ui/mount/add", { plugin: "mcp", alias: "after-off", url: MCP_URL }, { json: true });
  must(refused.status === 400 && /switched off/.test(refused.json().error), `adding after a disable: ${refused.text}`);
});

await check("no secret value appears in any response or log line", async () => {
  must(responses.length > 20, `control: only ${responses.length} responses were recorded`);
  const leaks = responses.filter((t) => t.includes(VALUE));
  must(leaks.length === 0, `${leaks.length} response(s) carried the value: ${leaks[0]?.slice(0, 200)}`);
  const logLeaks = logged.filter((l) => l.includes(VALUE));
  must(logLeaks.length === 0, `${logLeaks.length} log line(s) carried the value`);
});

globalThis.fetch = realFetch;
for (const h of hosts) h.dispose();

// One write, and the exit only once it has drained: a failure that quotes a whole panel is tens of KB,
// and `process.exit` on a pipe drops what is still queued — the summary line first.
const lines = [`\n  Console mounts and kept secrets\n  ${"─".repeat(56)}`];
for (const r of results) {
  lines.push(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${String(r.error).slice(0, 1_500)}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
lines.push(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.stdout.write(lines.join("\n") + "\n", () => process.exit(pass === results.length ? 0 : 1));
