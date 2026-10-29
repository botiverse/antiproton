/**
 * What a held call tells the model (#1112), and what the person it is sent to finds.
 *
 * Three halves. The gateway's held result: each sentence of `heldMessage` pinned to the fact it states (who decides,
 * where, no expiry, what happens next, and that a second call is a second approval), with a decider and without.
 * The deployment's wiring: an AgentRuntime with a console origin links the agent's console page. The page itself,
 * through the Worker's own `fetch` and `AgentDO` (the stand-in test/console-mounts.ts uses): the link decides
 * nothing, it asks for a sign-in, a decision without one is refused, and the card's account of the call is the
 * server's, from the row.
 */
import { register } from "node:module";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway, heldMessage } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { bridgeTools, pausedNote, qualifyMountedTools } from "../src/runtime/pi-tools.ts";
import { holdFrom } from "../src/core/execution.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { sessionCookieFor } from "../cf/src/auth.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { AgentRuntime, approvalsUrl } = await import("../cf/src/runtime.ts");
const { approvals } = await import("../cf/src/ui.ts");
const { PROVIDER_HOME } = await import("../cf/src/provision/steps.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(c: unknown, why: string): asserts c { if (!c) throw new Error(why); }

const CTX = { tenantId: "t", agentId: "a", taskId: "k" };
const URL_A = "https://antiproton.ai/ui?view=agents&agentId=a";

const PLUGIN: Plugin = {
  id: "ops", version: "1.0.0",
  tools: [{ name: "deploy", description: "", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" }] as any,
  async invoke() { return { ran: true }; },
};

async function gateway(heldPlace?: (ctx: typeof CTX) => { decider: string | null; url: string | null }) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "ops", plugin: "ops", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: { write: "approval" },
  });
  const gw = new ToolGateway(store, [PLUGIN], new Set(["ops"]), { async resolve() { return null; } }, undefined,
    heldPlace ? { heldPlace } : {});
  return { store, gw };
}
const messageOf = (r: any) => String(r?.error?.message ?? "");

// ---------------------------------------------------------------- the held result

await check("with a decider: the result names them, the page and the operation, and says what happens next", async () => {
  const { gw } = await gateway(() => ({ decider: "artin", url: URL_A }));
  const r: any = await gw.invoke(CTX, "ops.deploy", {});
  must(r.status === "pending" && r.error?.code === "awaiting_approval", `not held: ${JSON.stringify(r)}`);
  const m = messageOf(r);
  must(m.includes(`(operation ${r.operationId})`), `the operation id: ${m}`);
  must(m.includes(`artin decides it on the antiproton console at ${URL_A}.`), `who and where: ${m}`);
  must(m.includes("It does not expire: it waits until someone decides."), `the expiry: ${m}`);
  must(m.includes("you are not told the decision or the result, and your turn does not wait for it"), `what happens next: ${m}`);
  must(m.includes("Antiproton notifies nobody of it: if it matters, send artin that link in a message."), `meanwhile: ${m}`);
  must(m.includes("each call is held as a new, separate approval"), `the second call: ${m}`);
  must(r.decider === "artin" && r.expires === null && r.url === URL_A, `the structured fields: ${JSON.stringify(r)}`);
});

await check("without a decider: it says none is known and who can decide, and to ask a person", async () => {
  const { gw } = await gateway(() => ({ decider: null, url: URL_A }));
  const r: any = await gw.invoke(CTX, "ops.deploy", {});
  const m = messageOf(r);
  must(m.includes(`No decider is known: it is decided on the antiproton console at ${URL_A}, by a person signed in there with access to this agent.`), `no decider: ${m}`);
  must(m.includes("Antiproton notifies nobody of it: if it matters, send a person that link in a message."), `meanwhile: ${m}`);
  must(m.includes("It does not expire"), `the expiry: ${m}`);
  must(r.decider === null && r.expires === null && r.url === URL_A, `the structured fields: ${JSON.stringify(r)}`);
});

await check("without a console origin or a place at all: the panel is named, the operation id is what to send", async () => {
  const { gw } = await gateway();
  const r: any = await gw.invoke(CTX, "ops.deploy", {});
  const m = messageOf(r);
  must(m.includes("No decider is known: it is decided on this agent's approvals panel on the antiproton console, by a person signed in there with access to this agent."), `where: ${m}`);
  must(m.includes("send a person the operation id in a message."), `meanwhile: ${m}`);
  must(r.decider === null && r.expires === null && !("url" in r), `the structured fields: ${JSON.stringify(r)}`);
});

await check("a place that throws still holds the call, and the text names neither decider nor link", async () => {
  const { gw, store } = await gateway(() => { throw new Error("no"); });
  const r: any = await gw.invoke(CTX, "ops.deploy", {});
  must(r.status === "pending" && messageOf(r).includes("No decider is known"), `${JSON.stringify(r)}`);
  must((await store.listApprovals("t", "pending")).length === 1, "the hold was not recorded");
});

await check("the second-card claim: calling the same tool again records a second approval", async () => {
  const { gw, store } = await gateway(() => ({ decider: null, url: URL_A }));
  const one: any = await gw.invoke(CTX, "ops.deploy", { v: 1 });
  const two: any = await gw.invoke(CTX, "ops.deploy", { v: 1 });
  const pending = await store.listApprovals("t", "pending");
  must(pending.length === 2 && one.operationId !== two.operationId, `${pending.length} pending: ${one.operationId} ${two.operationId}`);
});

await check("the no-expiry claim: the approval row has no deadline, and deciding it later still runs it", async () => {
  const { gw, store } = await gateway(() => ({ decider: null, url: URL_A }));
  const r: any = await gw.invoke(CTX, "ops.deploy", {});
  const [row] = await store.listApprovals("t", "pending");
  must(row && !Object.keys(row).some((k) => /expir|deadline|until/i.test(k)), `the row: ${JSON.stringify(row)}`);
  const ok = await gw.applyApproval("t", r.operationId, "approved", "someone");
  must(ok.ok && ok.executed, `the decision did not run it: ${JSON.stringify(ok)}`);
});

await check("a direct model call reads the whole held text", async () => {
  const { gw } = await gateway(() => ({ decider: null, url: URL_A }));
  const host = { async invoke(call: any) { return gw.invoke(CTX, call.tool, call.args, call.opts ?? {}); } };
  const tools = qualifyMountedTools([{ name: "deploy", address: "ops.deploy", description: "", parameters: { type: "object" }, sideEffects: "write" } as any]);
  const [deploy] = bridgeTools(tools, host as any);
  const said = await (deploy as any).execute("d1", {}).then(() => "", (e: Error) => e.message);
  must(/^ops__deploy: This call is held for approval \(operation op_[0-9a-f]+\)\. No decider is known/.test(said), `the model read: ${said}`);
  must(said.includes(URL_A), `no link: ${said}`);
});

await check("a program's hold carries the same text as data.approval, and the note points at it", () => {
  const p = holdFrom("ops__deploy", { operationId: "op_1", error: { code: "awaiting_approval", message: heldMessage("op_1", { decider: null, url: URL_A }) } });
  must((p.data as any).approval === heldMessage("op_1", { decider: null, url: URL_A }), `data: ${JSON.stringify(p.data)}`);
  must(/data\.approval says who decides it/.test(pausedNote(p, [])), `note: ${pausedNote(p, [])}`);
});

// ---------------------------------------------------------------- the deployment's wiring

await check("approvalsUrl: the agent's console page, ids only, and none without an origin", () => {
  must(approvalsUrl("https://antiproton.ai", "a") === URL_A, `${approvalsUrl("https://antiproton.ai", "a")}`);
  must(approvalsUrl(undefined, "a") === null, "a link without an origin");
  const u = new URL(approvalsUrl("https://antiproton.ai", "a b&c")!);
  must([...u.searchParams.keys()].join(",") === "view,agentId" && u.searchParams.get("agentId") === "a b&c", `params: ${u.search}`);
});

await check("an AgentRuntime with a console origin links the agent's page in the held result, and names no decider", async () => {
  const host = sqliteHost();
  const rt: any = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    extraPlugins: [PLUGIN], consoleOrigin: "https://antiproton.ai",
  } as any);
  await rt.store.init();
  rt.ready = async () => {};
  await rt.store.createAgent("t", "a");
  await rt.store.addMount({
    tenantId: "t", agentId: "a", alias: "ops", plugin: "ops", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: { write: "approval" },
  });
  // An extra plugin is not seeded, so it is off until chosen (`pluginEnabled`).
  await rt.store.setPluginChoice("t", "a", "ops", "enable");
  const r: any = await rt.gateway().invoke(CTX, "ops.deploy", {});
  must(r.status === "pending", `not held: ${JSON.stringify(r)}`);
  must(r.url === URL_A && r.decider === null && messageOf(r).includes(URL_A), `${JSON.stringify(r)}`);
  host.dispose();
});

// ---------------------------------------------------------------- the page the link opens

const SESSION = "s".repeat(48);
const KEK = Buffer.alloc(32, 7).toString("base64");
const T = "tenant-held", A = "u-owner", OTHER = "u-stranger";
const d1 = () => {
  const stmt = (_sql: string): any => {
    const s: any = { bind: () => s, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 1 } }), raw: async () => [] };
    return s;
  };
  return { prepare: (sql: string) => stmt(sql), batch: async (s: unknown[]) => s.map(() => ({ results: [], meta: { changes: 1 } })) };
};
const objects = new Map<string, any>();
const hosts: Array<{ dispose(): void }> = [];
// No UI_ALLOW_ANONYMOUS: the deployment's own setting (cf/wrangler.jsonc sets none).
const env: Record<string, unknown> = {
  MODEL_QUEUE: { send: async () => {} },
  ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
  ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "m1", DEEPSEEK_BASE_URL: "https://model.example/v1",
  AUTOMATION_TOKEN: "operator-token", SESSION_SECRET: SESSION, SECRET_KEK: KEK, DEEPSEEK_API_KEY: "k",
  UI_ORIGIN: "https://console.test",
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
const cookieOf = async (agentId: string) =>
  (await sessionCookieFor(SESSION, { email: `${agentId}@x.test`, name: null, username: null, picture: null, source: "github", agentId, tenantId: T }, `gh-${agentId}`)).split(";")[0]!;
const fetchAs = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://console.test${path}`, init), env as never);
const decideForm = (operationId: string) => new URLSearchParams({ operationId, decision: "approved" });

/** A held call on the owner's own agent, recorded as the gateway records one; its operation id. */
async function heldOnOwnersAgent(): Promise<{ operationId: string; store: any }> {
  const mine = await cookieOf(A);
  const page = await fetchAs(`/ui?view=agents&agentId=${A}`, { headers: { cookie: mine, accept: "text/html" } });
  must(page.status === 200, `control: the owner cannot open their own page (${page.status}), so a refusal below proves nothing`);
  const store = objects.get(agentObjectName(T, A)).runtime().store;
  const operationId = `op_held_${Math.random().toString(16).slice(2, 10)}`;
  await store.requireApproval({ tenantId: T, operationId, agentId: A, taskId: "main", mountAlias: "stamp", tool: "stamp_login", request: { tool: "stamp.stamp_login", args: {}, heldBy: "policy" } });
  return { operationId, store };
}

await check("the link without a sign-in: the page sends the browser to /login, and a fragment request gets 401", async () => {
  await heldOnOwnersAgent();
  const page = await fetchAs(`/ui?view=agents&agentId=${A}`, { headers: { accept: "text/html" } });
  must(page.status === 302 && page.headers.get("location") === "/login", `page: ${page.status} ${page.headers.get("location")}`);
  const panel = await fetchAs(`/ui/approvals?agentId=${A}`);
  must(panel.status === 401 && !(await panel.text()).includes("stamp_login"), `panel: ${panel.status}`);
});

await check("nothing in the link approves: a decision without a sign-in is refused and the call stays pending", async () => {
  const { operationId, store } = await heldOnOwnersAgent();
  const r = await fetchAs(`/ui/decide?agentId=${A}&operationId=${operationId}&decision=approved`, {
    method: "POST", body: decideForm(operationId), headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
  });
  must(r.status === 401, `decide without a session: ${r.status}`);
  must((await store.getApproval(T, operationId))?.state === "pending", "it was decided");
});

await check("a signed-in viewer whose agent it is not gets 404, and cannot decide it", async () => {
  const { operationId, store } = await heldOnOwnersAgent();
  const theirs = await cookieOf(OTHER);
  const page = await fetchAs(`/ui/approvals?agentId=${A}`, { headers: { cookie: theirs } });
  must(page.status === 404, `another viewer's panel: ${page.status}`);
  const r = await fetchAs("/ui/decide", {
    method: "POST", body: new URLSearchParams({ operationId, decision: "approved", agentId: A }),
    headers: { cookie: theirs, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
  });
  must(r.status === 404 && (await store.getApproval(T, operationId))?.state === "pending", `another viewer's decision: ${r.status}`);
});

await check("the signed-in owner's panel describes the call from its row: agent, tool, operation, what approving does", async () => {
  const { operationId } = await heldOnOwnersAgent();
  const r = await fetchAs(`/ui/approvals?agentId=${A}`, { headers: { cookie: await cookieOf(A) } });
  const html = await r.text();
  must(r.status === 200, `owner's panel: ${r.status}`);
  must(html.includes(`Agent <code>${A}</code> asked to run <code>stamp.stamp_login</code> (operation <code>${operationId}</code>).`), `who and what: ${html.slice(0, 600)}`);
  must(html.includes("Approving runs this one call, exactly as shown, with the agent's <code>stamp</code> mount; denying runs nothing."), "what approving does");
});

await check("the gap: a Raft-made agent is listed under the provider's home, so its owner's own sign-in cannot open its panel", async () => {
  // What provisioning does (cf/src/index.ts `agent.adopt`): the agent is recorded under PROVIDER_HOME, nobody's sign-in.
  const RAFT_AGENT = "raft-made";
  const store = (objects.get(agentObjectName(T, RAFT_AGENT)) ?? fresh(agentObjectName(T, RAFT_AGENT)));
  await store.uiAdoptAgent(T, RAFT_AGENT, { name: "Eleanor", description: "", avatar: "" });
  const providerHome = objects.get(agentObjectName(T, PROVIDER_HOME)) ?? fresh(agentObjectName(T, PROVIDER_HOME));
  await providerHome.uiRecordAgent(T, PROVIDER_HOME, { agentId: RAFT_AGENT, name: "Eleanor", description: "", avatar: "", createdAt: 1 });
  const owner = await fetchAs(`/ui/approvals?agentId=${RAFT_AGENT}`, { headers: { cookie: await cookieOf(A) } });
  must(owner.status === 404, `a person's own GitHub sign-in opened a Raft-made agent's panel: ${owner.status}`);
  const provider = await fetchAs(`/ui/approvals?agentId=${RAFT_AGENT}`, { headers: { cookie: await cookieOf(PROVIDER_HOME) } });
  must(provider.status === 200, `control: the provider home's session cannot open it either (${provider.status}), so the 404 proves nothing`);
});

await check("the gap: the page's panel lists only the first conversation's held calls", async () => {
  const { operationId, store } = await heldOnOwnersAgent();
  const other = `op_other_${Math.random().toString(16).slice(2, 10)}`;
  await store.createTask(T, A, "t_second", {});
  await store.requireApproval({ tenantId: T, operationId: other, agentId: A, taskId: "t_second", mountAlias: "stamp", tool: "stamp_login", request: { args: {} } });
  // What the page polls (cf/src/ui.ts `page`: /ui/chat?held=1, no taskId), and so what the link shows.
  const html = await (await fetchAs("/ui/chat?held=1", { headers: { cookie: await cookieOf(A) } })).text();
  must(html.includes(operationId), "control: the first conversation's held call is not on the page either");
  must(!html.includes(other), "a held call in a second conversation shows on the page the link opens");
});

await check("the card's account is escaped: a tool name cannot write markup into the panel", () => {
  const html = approvals([{ tenantId: "t", operationId: "op<x>", agentId: "a", taskId: "main", mountAlias: "m", tool: "<b>t</b>",
    request: { args: {} }, state: "pending", approver: null, decidedAt: null, createdAt: 0 }]);
  must(!html.includes("<b>t</b>") && html.includes("&lt;b&gt;t&lt;/b&gt;") && html.includes("op&lt;x&gt;"), html);
});

for (const h of hosts) h.dispose();
for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
