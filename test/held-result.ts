/**
 * What a held call tells the model (#1112), and what the person it is sent to finds.
 *
 * Three halves. The gateway's held result: each sentence of `heldMessage` pinned to the fact it states (who decides,
 * where, no expiry, what happens next, and that an identical call while one is pending is merged into it), with a
 * decider, without one, and where nobody can decide. The deployment's wiring: an AgentRuntime with a console origin
 * links the agent's console page for a console or API agent's first conversation, and says nobody can decide for a
 * Raft-made agent or a call held in another conversation. The page itself,
 * through the Worker's own `fetch` and `AgentDO` (the stand-in test/console-mounts.ts uses): the link decides
 * nothing, it asks for a sign-in, a decision without one is refused, and the card's account of the call is the
 * server's, from the row.
 */
import { register } from "node:module";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway, heldMessage, type HeldPlace } from "../src/runtime/gateway.ts";
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
const { AgentRuntime, approvalsUrl, heldPlaceFor } = await import("../cf/src/runtime.ts");
const { approvals } = await import("../cf/src/ui.ts");
const { PROVIDER_HOME, PROVISIONED_BY } = await import("../cf/src/provision/steps.ts");

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

async function gateway(heldPlace?: (ctx: typeof CTX) => HeldPlace) {
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
const AGAIN = "Calling this tool again with the same arguments while it waits returns this same pending approval; it does not create another.";
const MERGED_ONLY = (id: string) => `An identical call is already waiting for approval (operation ${id}); this call was not added as a second one.`;
const MERGED = (id: string) => MERGED_ONLY(id) + " If you need it done twice, call again after that one is decided.";
const NOBODY = "Nobody you can reach can approve it on the antiproton console today: ";
const NOBODY_REST = "The operator can still approve it, from the provider's home or by its operation id; if it is approved, it runs on its own " +
  "exactly as written, and you are not told the decision or the result. It does not expire. Antiproton notifies nobody of it. " +
  "Tell your owner once that this action is blocked, then plan as if it will not run. " +
  "Retrying will not make it happen sooner: calling again with the same arguments returns this same pending approval.";
const NOBODY_RAFT = NOBODY + "this agent was made through Raft, and the console accepts no Raft sign-in, so its owner cannot open it. " + NOBODY_REST;

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
  must(m.endsWith(AGAIN), `the second call: ${m}`);
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
  must(r.decider === null && r.expires === null && r.url === null, `the structured fields: ${JSON.stringify(r)}`);
});

await check("a place that throws still holds the call, and the text names neither decider nor link", async () => {
  const { gw, store } = await gateway(() => { throw new Error("no"); });
  const r: any = await gw.invoke(CTX, "ops.deploy", {});
  must(r.status === "pending" && messageOf(r).includes("No decider is known"), `${JSON.stringify(r)}`);
  must((await store.listApprovals("t", "pending")).length === 1, "the hold was not recorded");
});

await check("nobody can decide: the text says so, with no link, no expiry, nobody notified, tell the owner and do not retry", async () => {
  const { gw } = await gateway(() => heldPlaceFor("raft", "main", URL_A));
  const r: any = await gw.invoke(CTX, "ops.deploy", {});
  const m = messageOf(r);
  must(r.status === "pending", `not held: ${JSON.stringify(r)}`);
  must(m === `This call is held for approval (operation ${r.operationId}). ${NOBODY_RAFT}`, `the text: ${m}`);
  must(!m.includes("http") && !m.includes("decided on"), `a link or a place: ${m}`);
  must(r.decider === null && r.expires === null && r.url === null, `the structured fields: ${JSON.stringify(r)}`);
});

await check("an identical call while the first is pending: the same operation, one approval, and the result says it was merged", async () => {
  const { gw, store } = await gateway(() => ({ decider: null, url: URL_A }));
  const one: any = await gw.invoke(CTX, "ops.deploy", { v: 1, w: [1, { b: 2, a: 1 }] });
  // The same arguments with keys in another order: canonical JSON makes them the same call.
  const two: any = await gw.invoke(CTX, "ops.deploy", { w: [1, { a: 1, b: 2 }], v: 1 });
  const pending = await store.listApprovals("t", "pending");
  must(pending.length === 1 && two.status === "pending" && one.operationId === two.operationId, `${pending.length} pending: ${one.operationId} ${two.operationId}`);
  must(messageOf(two).startsWith(MERGED(one.operationId) + " No decider is known"), `the merged call's text: ${messageOf(two)}`);
  must(!messageOf(one).includes("An identical call"), `the first call's text: ${messageOf(one)}`);
});

await check("two identical calls at once (pi runs a turn's calls with Promise.all): one approval, one operation id, one merged", async () => {
  const { gw, store } = await gateway(() => ({ decider: null, url: URL_A }));
  const [one, two]: any[] = await Promise.all([gw.invoke(CTX, "ops.deploy", { v: 1 }), gw.invoke(CTX, "ops.deploy", { v: 1 })]);
  const pending = await store.listApprovals("t", "pending");
  must(pending.length === 1 && one.status === "pending" && two.status === "pending" && one.operationId === two.operationId
    && pending[0]!.operationId === one.operationId, `${pending.length} pending: ${one.operationId} ${two.operationId}`);
  const merged = [one, two].filter((r) => messageOf(r).startsWith(MERGED(one.operationId)));
  must(merged.length === 1, `${merged.length} results say merged: ${messageOf(one)} | ${messageOf(two)}`);
});

await check("an identical call after the first is decided: a new approval, since the same call twice can be meant", async () => {
  for (const decision of ["approved", "denied"] as const) {
    const { gw, store } = await gateway(() => ({ decider: null, url: URL_A }));
    const one: any = await gw.invoke(CTX, "ops.deploy", { v: 1 });
    must((await gw.applyApproval("t", one.operationId, decision, "someone")).ok, "not decided");
    const two: any = await gw.invoke(CTX, "ops.deploy", { v: 1 });
    const pending = await store.listApprovals("t", "pending");
    must(two.status === "pending" && two.operationId !== one.operationId && pending.length === 1 && pending[0]!.operationId === two.operationId,
      `${decision}: ${one.operationId} ${two.operationId}, ${pending.length} pending`);
    must(!messageOf(two).includes("An identical call"), `${decision}: said merged: ${messageOf(two)}`);
  }
});

await check("a call with different arguments while one is pending: a separate approval", async () => {
  const { gw, store } = await gateway(() => ({ decider: null, url: URL_A }));
  const one: any = await gw.invoke(CTX, "ops.deploy", { v: 1 });
  const two: any = await gw.invoke(CTX, "ops.deploy", { v: 2 });
  const pending = await store.listApprovals("t", "pending");
  must(pending.length === 2 && one.operationId !== two.operationId && !messageOf(two).includes("An identical call"),
    `${pending.length} pending: ${one.operationId} ${two.operationId}`);
});

await check("an agent-confirmed hold and a program's hold are merged the same way", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "ops", plugin: "ops", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: { write: "allow" },
  });
  const gw = new ToolGateway(store, [PLUGIN], new Set(["ops"]), { async resolve() { return null; } });
  const one: any = await gw.invoke(CTX, "ops.deploy", { v: 1 }, { confirm: true } as any);
  const ended: Array<{ id: string; status: string; result: unknown }> = [];
  const complete = store.completeOperation.bind(store);
  store.completeOperation = async (t: string, id: string, status: any, ref: any, result?: any, facts?: any) => {
    ended.push({ id, status, result });
    return complete(t, id, status, ref, result, facts);
  };
  const two: any = await gw.invoke(CTX, "ops.deploy", { v: 1 }, { confirm: true, fromProgram: true } as any);
  must(one.status === "pending" && two.operationId === one.operationId && (await store.listApprovals("t", "pending")).length === 1,
    `${JSON.stringify(one)} ${JSON.stringify(two)}`);
  must(holdFrom("ops__deploy", two).data && (holdFrom("ops__deploy", two).data as any).approval.startsWith(MERGED(one.operationId)), "the program's data.approval");
  // The merged attempt's own operation is ended, not left pending for ever.
  must(ended.length === 1 && ended[0]!.id !== one.operationId && ended[0]!.status === "cancelled"
    && (ended[0]!.result as any)?.mergedInto === one.operationId, `the merged attempt's operation: ${JSON.stringify(ended)}`);
});

await check("a secret-shaped argument is in neither the held text nor a program's data.approval", async () => {
  const { gw } = await gateway(() => ({ decider: null, url: URL_A }));
  const token = "ghp_" + "A1b2C3d4E5".repeat(4).slice(0, 36);
  const r: any = await gw.invoke(CTX, "ops.deploy", { token });
  must(r.status === "pending", `not held: ${JSON.stringify(r)}`);
  const data = holdFrom("ops__deploy", r).data as any;
  must(typeof data.approval === "string" && data.approval.length > 0, `control: no data.approval, so its absence proves nothing: ${JSON.stringify(data)}`);
  must(!messageOf(r).includes(token) && !messageOf(r).includes("ghp_"), `in the message: ${messageOf(r)}`);
  must(!data.approval.includes(token) && !data.approval.includes("ghp_") && !JSON.stringify(data).includes("ghp_"), `in data: ${JSON.stringify(data)}`);
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

await check("heldPlaceFor: a console or API agent's first conversation has the page; a Raft agent or another conversation has nobody", () => {
  for (const kind of ["console", "api"] as const) {
    const p = heldPlaceFor(kind, "main", URL_A);
    must("url" in p && p.url === URL_A && p.decider === null, `${kind}: ${JSON.stringify(p)}`);
    const other = heldPlaceFor(kind, "sess_1", URL_A);
    must("nobody" in other && /only its first conversation's held calls/.test(other.nobody), `${kind} in another conversation: ${JSON.stringify(other)}`);
  }
  for (const task of ["main", "sess_1"]) {
    const p = heldPlaceFor("raft", task, URL_A);
    must("nobody" in p && /made through Raft/.test(p.nobody), `raft in ${task}: ${JSON.stringify(p)}`);
  }
});

/** An AgentRuntime with a console origin and an `ops` mount that holds writes, for an agent made with this config. */
async function runtimeFor(config: Record<string, unknown>) {
  const host = sqliteHost();
  const rt: any = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    extraPlugins: [PLUGIN], consoleOrigin: "https://antiproton.ai",
  } as any);
  await rt.store.init();
  rt.ready = async () => {};
  await rt.store.createAgent("t", "a", config);
  await rt.store.addMount({
    tenantId: "t", agentId: "a", alias: "ops", plugin: "ops", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: { write: "approval" },
  });
  // An extra plugin is not seeded, so it is off until chosen (`pluginEnabled`).
  await rt.store.setPluginChoice("t", "a", "ops", "enable");
  return { rt, host };
}
const MAIN = { tenantId: "t", agentId: "a", taskId: "main" };

await check("an AgentRuntime, console agent: the held result links the agent's page and names no decider", async () => {
  const { rt, host } = await runtimeFor({});
  const r: any = await rt.gateway().invoke(MAIN, "ops.deploy", {});
  must(r.status === "pending", `not held: ${JSON.stringify(r)}`);
  must(r.url === URL_A && r.decider === null && messageOf(r).includes(URL_A), `${JSON.stringify(r)}`);
  host.dispose();
});

await check("an AgentRuntime, API agent: its first conversation links the page; a session's call says nobody can decide", async () => {
  const { rt, host } = await runtimeFor({ openai: { name: "api" } });
  const r: any = await rt.gateway().invoke(MAIN, "ops.deploy", {});
  must(r.url === URL_A && messageOf(r).includes(URL_A), `first conversation: ${JSON.stringify(r)}`);
  // Other arguments: the same ones would be merged into the first conversation's call, and told its place.
  const s: any = await rt.gateway().invoke({ ...MAIN, taskId: "sess_1" }, "ops.deploy", { v: 1 });
  must(s.status === "pending" && s.url === null && messageOf(s).includes(NOBODY)
    && !messageOf(s).includes("http"), `a session: ${JSON.stringify(s)}`);
  host.dispose();
});

await check("two identical calls at once through the Durable Object store: one approval, one operation id, one merged", async () => {
  const { rt, host } = await runtimeFor({});
  const [one, two]: any[] = await Promise.all([rt.gateway().invoke(MAIN, "ops.deploy", { v: 1 }), rt.gateway().invoke(MAIN, "ops.deploy", { v: 1 })]);
  const pending = await rt.store.listApprovals("t", "pending");
  must(pending.length === 1 && one.operationId === two.operationId, `${pending.length} pending: ${one.operationId} ${two.operationId}`);
  must([one, two].filter((r) => messageOf(r).startsWith(MERGED(one.operationId))).length === 1, `${messageOf(one)} | ${messageOf(two)}`);
  host.dispose();
});

await check("a call held in a child conversation, then made again from main: merged, and told the held row's place, nobody", async () => {
  const { rt, host } = await runtimeFor({});
  const child: any = await rt.gateway().invoke({ ...MAIN, taskId: "t_child" }, "ops.deploy", { v: 1 });
  must(child.status === "pending" && child.url === null && messageOf(child).includes(NOBODY), `the child's: ${JSON.stringify(child)}`);
  const r: any = await rt.gateway().invoke(MAIN, "ops.deploy", { v: 1 });
  must(r.operationId === child.operationId && r.url === null && !messageOf(r).includes("http"), `main's: ${JSON.stringify(r)}`);
  must(messageOf(r) === `${MERGED_ONLY(child.operationId)} ${NOBODY}` +
    `the console's page for this agent shows only its first conversation's held calls, and this call was held in another one. ${NOBODY_REST}`,
    `main's text: ${messageOf(r)}`);
  // Control: main's own call with other arguments still gets the page.
  const own: any = await rt.gateway().invoke(MAIN, "ops.deploy", { v: 2 });
  must(own.url === URL_A && messageOf(own).includes(URL_A), `main's own: ${JSON.stringify(own)}`);
  host.dispose();
});

await check("an AgentRuntime, Raft-made agent: nobody can decide, no link, tell the owner, do not retry", async () => {
  const { rt, host } = await runtimeFor({ provisionedBy: PROVISIONED_BY });
  const r: any = await rt.gateway().invoke(MAIN, "ops.deploy", {});
  must(r.status === "pending" && r.url === null && r.decider === null && r.expires === null, `${JSON.stringify(r)}`);
  must(messageOf(r) === `This call is held for approval (operation ${r.operationId}). ${NOBODY_RAFT}`, `the text: ${messageOf(r)}`);
  host.dispose();
});

await check("current behaviour, until Raft approvals deliver decisions: after a decision the agent receives nothing", async () => {
  // What `heldMessage` tells the agent ("you are not told the decision or the result"). The Raft approvals work
  // (docs/raft-approvals.md) is meant to change this; this case is then the one to rewrite.
  const { rt, host } = await runtimeFor({});
  const conversationRows = () => (host.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pi_%entries'").toArray() as any[])
    .reduce((n, t) => n + Number((host.sql.exec(`SELECT COUNT(*) AS c FROM ${t.name}`).toArray()[0] as any).c), 0);
  const inConversation = (needle: string) => (host.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pi_%entries'").toArray() as any[])
    .some((t) => (host.sql.exec(`SELECT * FROM ${t.name}`).toArray() as any[]).some((row) => JSON.stringify(row).includes(needle)));
  const before = conversationRows();
  const approved: any = await rt.gateway().invoke(MAIN, "ops.deploy", { marker: "approved-marker" });
  const denied: any = await rt.gateway().invoke(MAIN, "ops.deploy", { marker: "denied-marker" });
  const ran = await rt.gateway().applyApproval("t", approved.operationId, "approved", "someone");
  must(ran.ok && ran.executed && (ran.result as any)?.status === "succeeded", `control: the approved call did not run: ${JSON.stringify(ran)}`);
  must((await rt.gateway().applyApproval("t", denied.operationId, "denied", "someone")).ok, "control: not denied");
  must(conversationRows() === before, `the conversation changed: ${before} -> ${conversationRows()} rows`);
  for (const needle of [approved.operationId, denied.operationId, "approved-marker"]) must(!inConversation(needle), `${needle} reached the conversation`);
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

await check("why a Raft-made agent is told nobody can decide: it is listed under the provider's home, so its owner's own sign-in cannot open its panel", async () => {
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

await check("/ui/approvals lists every held call of the agent, a second conversation's too; the page's panel still the first's", async () => {
  const { operationId, store } = await heldOnOwnersAgent();
  const other = `op_other_${Math.random().toString(16).slice(2, 10)}`;
  await store.createTask(T, A, "t_second", {});
  await store.requireApproval({ tenantId: T, operationId: other, agentId: A, taskId: "t_second", mountAlias: "stamp", tool: "stamp_login", request: { args: {} } });
  const cookie = await cookieOf(A);
  const all = await fetchAs(`/ui/approvals?agentId=${A}`, { headers: { cookie } });
  const html = await all.text();
  must(all.status === 200 && html.includes(operationId) && html.includes(other), `/ui/approvals: ${all.status}, first ${html.includes(operationId)}, second ${html.includes(other)}`);
  // Naming a conversation still narrows it to that one.
  const named = await (await fetchAs(`/ui/approvals?agentId=${A}&taskId=t_second`, { headers: { cookie } })).text();
  must(named.includes(other) && !named.includes(operationId), "a named conversation is not narrowed to");
  // What the page polls (cf/src/ui.ts `page`: /ui/chat?held=1, no taskId) is unchanged: the first conversation's only.
  const page = await (await fetchAs("/ui/chat?held=1", { headers: { cookie } })).text();
  must(page.includes(operationId) && !page.includes(other), "the page's panel changed");
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
