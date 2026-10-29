/**
 * Approvals for Raft-hosted agents (docs/raft-approvals.md): the provider routes (`GET …/approvals`, `POST …/decide`,
 * `GET /provision/approvals`) through the Worker's own `fetch`, the real migrations on node:sqlite and the whole
 * `AgentDO` under node (the `cloudflare:workers` stand-in test/provision-model.ts uses); the expiry sweep, the notice the
 * agent is woken with, read where it leaves for the model; the signed hint; the migration of an older `approvals`
 * table on both stores; and the console's own decide route, which still works.
 *
 * The held call is real: the provisioned agent's `state` mount with `put` held by its policy, called through the
 * gateway, so what is approved runs exactly as the gateway runs it.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { d1ProviderTokens } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import { sessionCookieFor } from "../cf/src/auth.ts";
import { PROVIDER_HOME } from "../cf/src/provision/steps.ts";
import { verifyHint, SIGNATURE_HEADER, TIMESTAMP_HEADER, hintTarget, publishBackoffMs } from "../cf/src/approvals.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { DEFAULT_APPROVAL_TTL_MS } from "../src/store/approvals-schema.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { callQueuedModel } = await import("../cf/src/model-request.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const T = "t-raft", RAFT_ID = "01JAPPROVE", A = "raft_01JAPPROVE", AUTOMATION = "operator-token";
const ORIGIN = "https://raft.example";
const RAFT_CRED = "sk_agent_" + "R".repeat(32);
/** A credential-shaped value the agent put in its arguments: the card must never show it. */
const LEAKED = "sk_agent_" + "L".repeat(32);
const SESSION = "s".repeat(32);
const HINT_SECRET = "hint-secret-" + "h".repeat(32);
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** D1 as node:sqlite, with every migration in cf/migrations applied (test/provision-model.ts). */
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

/** Every request the code under test sent anywhere but the model, answered as Raft would; hints answered by `hintStatus`. */
let outbound: Array<{ url: string; headers: Headers; body: string }> = [];
let hintStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url);
  const headers = new Headers(init?.headers ?? {});
  const body = typeof init?.body === "string" ? init.body : "";
  outbound.push({ url: u, headers, body });
  if (u === `${ORIGIN}/internal/agent-api` && headers.get("authorization") === `Bearer ${RAFT_CRED}`) {
    return Response.json({ agentId: "ag-1", agentName: "cody", agentDisplayName: "Cody", serverId: "srv-1" });
  }
  if (u.startsWith(`${ORIGIN}/hooks/antiproton/approvals`)) return new Response("{}", { status: hintStatus });
  return Response.json({}, { status: 200 });
}) as typeof fetch;
const hints = () => outbound.filter((o) => o.url.startsWith(`${ORIGIN}/hooks/antiproton/approvals`));

async function world(opts: { hints?: boolean; keepTrace?: boolean } = {}) {
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
  const env: Record<string, unknown> = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    // `keepTrace`: the trace export fails, so its rows stay in the outbox where a case can count them.
    ARTIFACTS: { put: async () => { if (opts.keepTrace) throw new Error("R2 is away"); return {}; }, get: async () => null, head: async () => null, list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false }) },
    ARTIFACT_BUCKET: "b", CONTROL_DB: DB, HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_API_KEY: "dk-test-key", AUTOMATION_TOKEN: AUTOMATION, SESSION_SECRET: SESSION,
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    ...(opts.hints ? { RAFT_APPROVAL_CALLBACK_PATH: "/hooks/antiproton/approvals", RAFT_APPROVAL_CALLBACK_SECRET: HINT_SECRET } : {}),
    AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? another(n) },
  };
  const D = new AgentDO(ctx as never, env as never);
  objects.set(agentObjectName(T, A), D);
  const token = newProviderToken(), other = newProviderToken(), platform = newProviderToken(), elsewhere = newProviderToken();
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(token), label: "raft-test", raftOrigin: ORIGIN, scope: "tenant", tenantId: T });
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(other), label: "raft-other", raftOrigin: ORIGIN, scope: "tenant", tenantId: "t-other" });
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(platform), label: "raft-platform", raftOrigin: ORIGIN, scope: "platform" } as never);
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(elsewhere), label: "raft-elsewhere", raftOrigin: "https://other-raft.example", scope: "platform" } as never);
  const w = { D, rt: D.runtime() as any, raw, DB, env, jobs, token, other, platform, elsewhere, alarmAt: () => alarmAt, objects };
  const res = await worker.fetch(new Request("https://x/provision/agents", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raftAgentId: RAFT_ID, raftServerId: "srv-1", raftOrigin: ORIGIN, name: "n", instructions: "persona", credential: RAFT_CRED }),
  }), env as never);
  must(res.status === 201, `POST /provision/agents: ${res.status} ${await res.text()}`);
  await w.rt.ready();
  must(await w.rt.store.updateMountPolicy(T, A, "state", { tools: { put: "approval" } }), "the state mount's policy was not set");
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

/** Another agent Raft made in the same tenant, with its own held `state.put`. */
async function secondAgent(w: World) {
  const res = await worker.fetch(new Request("https://x/provision/agents", {
    method: "POST", headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" },
    body: JSON.stringify({ raftAgentId: "01JSECOND", raftServerId: "srv-1", raftOrigin: ORIGIN, name: "m", instructions: "p", credential: RAFT_CRED }),
  }), w.env as never);
  must(res.status === 201, `second agent: ${res.status} ${await res.text()}`);
  const B = "raft_01JSECOND";
  const rt: any = (w.objects.get(agentObjectName(T, B)) as any).runtime();
  await rt.ready();
  must(await rt.store.updateMountPolicy(T, B, "state", { tools: { put: "approval" } }), "policy");
  const r = await rt.gateway().invoke({ tenantId: T, agentId: B, taskId: "main" }, "state.put", { key: "b", value: "b" });
  must(r.status === "pending", show(r));
  return { B, op: r.operationId as string };
}

/** A held call: `state.put` through the gateway, as the model's call would go. */
async function hold(w: World, value = `note ${LEAKED}`) {
  const r = await w.rt.gateway().invoke({ tenantId: T, agentId: A, taskId: "main" }, "state.put", { key: "plan", value });
  must(r.status === "pending" && typeof r.operationId === "string", `not held: ${show(r)}`);
  return r.operationId as string;
}

/** A provider route, as Raft calls it. `auth` null sends no credential. */
async function call(w: World, method: string, path: string, opts: { body?: unknown; auth?: string | null } = {}) {
  const auth = opts.auth === undefined ? w.token : opts.auth;
  const res = await worker.fetch(new Request(`https://x/provision/${path}`, {
    method, headers: auth === null ? {} : { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    ...(opts.body === undefined ? {} : { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }),
  }), w.env as never);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}
const OWNER = { raftUserId: "u-owner-1", role: "agent_owner" };
const decide = (w: World, op: string, decision: string, by: unknown = OWNER, auth?: string | null) =>
  call(w, "POST", `agents/${A}/approvals/${op}/decide`, { body: { decision, decidedBy: by }, auth });

/** Alarm passes until the model has been asked `n` things. */
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
async function idle(w: World) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await (await w.rt.agent(T, A)).running())) return;
    await w.D.alarm();
    await sleep(10);
  }
  throw new Error("the turn did not end");
}
/** What job `i` sent the model, as it left (the real queue consumer, `fetch` replaced); answered so the turn ends. */
async function sentText(w: World, i: number): Promise<string> {
  const job = await (w.D as any).takeJob(T, A, w.jobs[i]!);
  const before = globalThis.fetch;
  const out: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    out.push(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await callQueuedModel(w.env as never, job, w.jobs[i]!); } finally { globalThis.fetch = before; }
  await (w.D as any).deliverAnswer(T, A, w.jobs[i]!, { role: "assistant", content: [{ type: "text", text: "ok" }], api: job.model?.api ?? "x",
    provider: job.model?.provider ?? "x", model: String(job.model?.id ?? "x"), usage: USAGE, stopReason: "stop", timestamp: 0 } as never, 5);
  await idle(w);
  must(out.length === 1, `model requests: ${out.length}`);
  return out[0]!;
}
/** The decision reaches the model: the next job's request carries the notice for `op`. */
async function noticeSent(w: World, op: string): Promise<string> {
  const n = w.jobs.length;
  await settle(w, n + 1);
  must(w.jobs.length === n + 1, `no model call after the decision (jobs ${w.jobs.length}, alarm ${w.alarmAt()})`);
  const body = await sentText(w, n);
  const at = body.indexOf(`[approval ${op} `);
  must(at >= 0, `the model was not told of ${op}: ${body.slice(-600)}`);
  // As it went in the request's JSON: the phrases checked hold no character JSON would escape.
  return body.slice(at, at + 2000);
}
const row = (w: World, op: string) => w.raw.sql.exec("SELECT * FROM approvals WHERE operation_id = ?", op).toArray()[0] as any;
const opRow = (w: World, op: string) => w.raw.sql.exec("SELECT status FROM operations WHERE operation_id = ?", op).toArray()[0] as any;
const indexRow = (w: World, op: string) => w.DB.raw.prepare("SELECT * FROM provider_approvals WHERE operation_id = ?").get(op) as any;

// ---- listing ------------------------------------------------------------------------------------------------

await check("list: a pending hold, with its mapping, what approving does, its deadline, and arguments without the credential", async () => {
  const w = await world();
  const before = Date.now();
  const op = await hold(w);
  const r = await call(w, "GET", `agents/${A}/approvals?status=pending`);
  must(r.status === 200, `${r.status} ${r.text}`);
  must(r.body.providerAgentId === A && r.body.raftAgentId === RAFT_ID && r.body.approvals.length === 1, show(r.body));
  const a = r.body.approvals[0];
  must(a.operationId === op && a.status === "pending" && a.mount === "state" && a.plugin === "state" && a.tool === "put", show(a));
  must(a.raftAgentId === RAFT_ID && a.raftServerId === "srv-1" && a.providerAgentId === A, `mapping: ${show(a)}`);
  must(a.heldBy === "policy" && a.policyKey === null && a.route === null && a.service === null && a.action === null, show(a));
  must(a.args.summary.includes("key: plan") && a.args.summary.includes("value: <redacted:"), `summary: ${a.args.summary}`);
  must(!r.text.includes(LEAKED) && a.args.redactions >= 1 && a.args.withheld === false, `the credential reached the card: ${a.args.summary}`);
  const created = Date.parse(a.createdAt), expires = Date.parse(a.expiresAt);
  must(created >= before - 5 && expires - created >= DEFAULT_APPROVAL_TTL_MS - 5 && expires - created <= DEFAULT_APPROVAL_TTL_MS + 5, `deadline: ${a.createdAt} ${a.expiresAt}`);
  must(a.description.startsWith("Approving runs state.put once, exactly as shown") && a.description.includes(`Undecided at ${a.expiresAt}, it is denied as expired`), a.description);
  // By Raft's own id too, and `status` narrows: none approved yet.
  const byRaft = await call(w, "GET", `agents/by-raft-agent/${RAFT_ID}/approvals`);
  must(byRaft.status === 200 && byRaft.body.approvals.length === 1, `by-raft-agent: ${byRaft.status} ${byRaft.text}`);
  const approved = await call(w, "GET", `agents/${A}/approvals?status=approved`);
  must(approved.status === 200 && approved.body.approvals.length === 0, show(approved.body));
  must((await call(w, "GET", `agents/${A}/approvals?status=maybe`)).status === 400, "an unknown status was taken");
});

await check("auth: no token and an unknown one are 401; another tenant's token and a wrong agent are 404; a platform token needs the server", async () => {
  const w = await world();
  const op = await hold(w);
  const none = await call(w, "GET", `agents/${A}/approvals`, { auth: null });
  must(none.status === 401 && none.body.error.code === "unauthorized", `${none.status} ${none.text}`);
  const forged = await call(w, "GET", `agents/${A}/approvals`, { auth: newProviderToken() });
  must(forged.status === 401, `forged: ${forged.status}`);
  const theirs = await call(w, "GET", `agents/${A}/approvals`, { auth: w.other });
  must(theirs.status === 404 && !theirs.text.includes(op), `another tenant: ${theirs.status} ${theirs.text}`);
  const theirDecide = await decide(w, op, "approve", OWNER, w.other);
  must(theirDecide.status === 404 && row(w, op).state === "pending", `another tenant decided: ${theirDecide.status} ${theirDecide.text}`);
  const wrong = await call(w, "GET", `agents/raft_NOPE/approvals`);
  must(wrong.status === 404 && wrong.body.error.code === "not_found", `wrong agent: ${wrong.status}`);
  const wrongDecide = await call(w, "POST", `agents/raft_NOPE/approvals/${op}/decide`, { body: { decision: "approve", decidedBy: OWNER } });
  must(wrongDecide.status === 404 && row(w, op).state === "pending", `wrong agent decided: ${wrongDecide.status}`);
  const platformBare = await call(w, "GET", `agents/${A}/approvals`, { auth: w.platform });
  must(platformBare.status === 422 && platformBare.body.error.param === "raftServerId", `platform without server: ${platformBare.status}`);
  const otherServer = await call(w, "GET", `agents/${A}/approvals?raftServerId=srv-2`, { auth: w.platform });
  must(otherServer.status === 404, `platform, another server: ${otherServer.status}`);
});

// ---- deciding -----------------------------------------------------------------------------------------------

await check("decide: approve answers before the call runs; the run ends it executed; the same again is a replay; the other is 409", async () => {
  const w = await world({ keepTrace: true });
  const op = await hold(w, "the plan");
  const r = await decide(w, op, "approve");
  must(r.status === 200 && r.body.replay === false && r.body.approval.status === "approved", `${r.status} ${r.text}`);
  must(show(r.body.approval.decidedBy) === show({ via: "raft", ...OWNER }) && r.body.approval.outcome === null, show(r.body.approval));
  // Answered, and nothing has run: the operation is still open and the put has not landed.
  must(row(w, op).state === "approved" && row(w, op).run_at === null, `row: ${show(row(w, op))}`);
  must(opRow(w, op).status !== "succeeded" && !w.raw.sql.exec("SELECT 1 FROM agent_state WHERE key = 'plan'").toArray().length, "the call ran inside the decide");
  must(row(w, op).approver === "raft:u-owner-1" && JSON.parse(row(w, op).decided_by).raftUserId === "u-owner-1", show(row(w, op)));
  // Repeated while it waits to run: the same answer, nothing run twice.
  const during = await decide(w, op, "approve", { raftUserId: "u-admin-2", role: "server_admin" });
  must(during.status === 200 && during.body.replay === true && during.body.approval.status === "approved" && during.body.approval.decidedBy.raftUserId === "u-owner-1",
    `replay while executing: ${during.status} ${during.text}`);
  const conflictDuring = await decide(w, op, "deny");
  must(conflictDuring.status === 409 && conflictDuring.body.error.code === "approval_already_decided" && conflictDuring.body.error.decision === "approved"
    && conflictDuring.body.error.status === "approved", `deny while executing: ${conflictDuring.status} ${conflictDuring.text}`);
  // Its deadline passes before the run: an approval made in time is run, never expired.
  w.raw.sql.exec("UPDATE approvals SET expires_at = ? WHERE operation_id = ?", Date.now() - 1, op);
  await w.D.alarm();
  must(row(w, op).state === "executed" && opRow(w, op).status === "succeeded", `after the pass: ${row(w, op).state}, ${show(opRow(w, op))}`);
  const stored = w.raw.sql.exec("SELECT value FROM agent_state WHERE key = 'plan'").toArray()[0] as any;
  must(stored && String(stored.value).includes("the plan"), `the approved put did not land: ${show(stored)}`);
  const listed = (await call(w, "GET", `agents/${A}/approvals?status=executed`)).body.approvals;
  must(listed.length === 1 && listed[0].outcome?.summary.length > 0 && listed[0].description.startsWith("Approved and executed:"), show(listed));
  const again = await decide(w, op, "approve");
  must(again.status === 200 && again.body.replay === true && again.body.approval.status === "executed", `replay after: ${again.status} ${again.text}`);
  const runs = () => Number((w.raw.sql.exec("SELECT COUNT(*) AS n FROM trace_outbox WHERE kind = 'tool.call' AND span_id = ?", op).toArray()[0] as any)?.n ?? 0);
  must(runs() === 1, `the call ran ${runs()} times, not once`);
  await w.D.alarm();
  must(runs() === 1, `a later pass changed the count of runs: ${runs()}`);
  const conflict = await decide(w, op, "deny");
  must(conflict.status === 409 && conflict.body.error.code === "approval_already_decided" && conflict.body.error.decision === "approved"
    && conflict.body.error.status === "executed" && conflict.body.error.decidedBy.raftUserId === "u-owner-1" && typeof conflict.body.error.decidedAt === "string",
    `${conflict.status} ${conflict.text}`);
});

await check("decide: an approved call whose run fails ends failed, with its error as the outcome, credentials redacted", async () => {
  const w = await world();
  const op = await hold(w);
  // What the run will be asked: a tool the mount does not have, so the run is refused, with a credential in its arguments.
  w.raw.sql.exec("UPDATE approvals SET request = ? WHERE operation_id = ?",
    JSON.stringify({ tool: "state.no_such_tool", args: { key: "k", value: LEAKED }, heldBy: "policy" }), op);
  must((await decide(w, op, "approve")).status === 200, "decide");
  await w.D.alarm();
  const r = row(w, op);
  must(r.state === "failed" && JSON.parse(r.outcome).summary.length > 0, `row: ${show(r)}`);
  const listed = await call(w, "GET", `agents/${A}/approvals?status=failed`);
  must(listed.body.approvals.length === 1 && listed.body.approvals[0].description.startsWith("Approved, but the run failed"), listed.text);
  must(!listed.text.includes(LEAKED), "the outcome or the arguments carry the credential");
});

await check("decide: a run the object stopped during is ended failed after the grace, and never run again", async () => {
  const w = await world();
  const op = await hold(w);
  must((await decide(w, op, "approve")).status === 200, "decide");
  // Taken long ago and never ended: as if the object stopped in the middle of the run.
  w.raw.sql.exec("UPDATE approvals SET run_at = ? WHERE operation_id = ?", Date.now() - 16 * 60_000, op);
  await w.D.alarm();
  const r = row(w, op);
  must(r.state === "failed" && JSON.parse(r.outcome).summary.includes("not known"), `row: ${show(r)}`);
  must(!w.raw.sql.exec("SELECT 1 FROM agent_state WHERE key = 'plan'").toArray().length, "the stale run was run again");
});

await check("decide: a body that is not the contract's is 422, and an operation that is not held is approval_not_found", async () => {
  const w = await world();
  const op = await hold(w);
  for (const [label, body] of [
    ["no decision", { decidedBy: OWNER }],
    ["approved, not approve", { decision: "approved", decidedBy: OWNER }],
    ["no decidedBy", { decision: "approve" }],
    ["an unknown field", { decision: "approve", decidedBy: OWNER, force: true }],
    ["an unknown decidedBy field", { decision: "approve", decidedBy: { ...OWNER, name: "x" } }],
  ] as const) {
    const r = await call(w, "POST", `agents/${A}/approvals/${op}/decide`, { body });
    must(r.status === 422, `${label}: ${r.status} ${r.text}`);
  }
  for (const role of ["member", "owner", "AGENT_OWNER", 3]) {
    const r = await decide(w, op, "approve", { raftUserId: "u1", role });
    must(r.status === 400 && r.body.error.code === "invalid_role" && r.body.error.param === "decidedBy.role", `role ${show(role)}: ${r.status} ${r.text}`);
  }
  must(row(w, op).state === "pending", "a refused body decided");
  const missing = await decide(w, "op_doesnotexist000000", "approve");
  must(missing.status === 404 && missing.body.error.code === "approval_not_found", `${missing.status} ${missing.text}`);
});

// ---- expiry -------------------------------------------------------------------------------------------------

await check("expiry: the alarm denies a hold past its deadline as expired, ends the operation approval_expired, and a late decision is 409", async () => {
  const w = await world();
  const op = await hold(w);
  w.raw.sql.exec("UPDATE approvals SET expires_at = ? WHERE operation_id = ?", Date.now() - 1, op);
  await w.D.alarm();
  const r = row(w, op);
  must(r.state === "expired" && r.approver === "expiry" && JSON.parse(r.decided_by).via === "expiry", `row: ${show(r)}`);
  must(opRow(w, op).status === "rejected", `operation: ${show(opRow(w, op))}`);
  const ev = w.raw.sql.exec("SELECT payload FROM events WHERE kind = 'operation.completed' ORDER BY rowid DESC LIMIT 1").toArray()[0] as any;
  must(ev && String(ev.payload).includes("approval_expired"), `the completion does not say approval_expired: ${show(ev)}`);
  const late = await decide(w, op, "approve");
  must(late.status === 409 && late.body.error.code === "approval_expired" && late.body.approval.status === "expired", `${late.status} ${late.text}`);
  const listed = await call(w, "GET", `agents/${A}/approvals?status=expired`);
  must(listed.body.approvals.length === 1 && listed.body.approvals[0].description.startsWith("Expired:"), show(listed.body));
});

await check("expiry: a decision on a hold past its deadline, before any sweep, expires it rather than running it", async () => {
  const w = await world();
  const op = await hold(w, "must not land");
  w.raw.sql.exec("UPDATE approvals SET expires_at = ? WHERE operation_id = ?", Date.now() - 1, op);
  const r = await decide(w, op, "approve");
  must(r.status === 409 && r.body.error.code === "approval_expired", `${r.status} ${r.text}`);
  must(row(w, op).state === "expired" && opRow(w, op).status === "rejected", `row ${row(w, op).state}, operation ${show(opRow(w, op))}`);
  must(!(w.raw.sql.exec("SELECT 1 FROM agent_state WHERE key = 'plan'").toArray().length), "the expired call ran");
});

await check("expiry: an idle agent with a hold has its alarm set for the deadline", async () => {
  const w = await world();
  const op = await hold(w);
  const deadline = Date.now() + 60 * 60_000;
  w.raw.sql.exec("UPDATE approvals SET expires_at = ? WHERE operation_id = ?", deadline, op);
  await w.D.alarm();
  const at = w.alarmAt();
  must(at !== null && at <= deadline + 1000, `alarm ${at}, deadline ${deadline}`);
});

// ---- the notice ---------------------------------------------------------------------------------------------

await check("notice: approved and run, the agent's next model call is told the operation, the tool, who, and the result", async () => {
  const w = await world();
  const op = await hold(w, "the plan");
  must((await decide(w, op, "approve")).status === 200, "decide");
  const said = await noticeSent(w, op);
  must(said.includes(`[approval ${op} — state.put — approved by your owner in Raft and run: succeeded; a notice from the harness`), said);
  must(row(w, op).told_at !== null, "not marked told");
  // Told once: another pass says nothing more.
  const n = w.jobs.length;
  await w.D.alarm();
  must(w.jobs.length === n, "the notice was posted twice");
});

await check("notice: denied, the agent is told nothing ran", async () => {
  const w = await world();
  const op = await hold(w);
  must((await decide(w, op, "deny", { raftUserId: "u-adm", role: "server_admin" })).status === 200, "decide");
  must(opRow(w, op).status === "cancelled", `operation: ${show(opRow(w, op))}`);
  const said = await noticeSent(w, op);
  must(said.includes(`[approval ${op} — state.put — denied by a Raft server admin;`) && said.includes("Nothing was run."), said);
});

await check("notice: expired, the agent is told nobody decided and that it may ask again", async () => {
  const w = await world();
  const op = await hold(w);
  // As if made a day ago with the default deadline.
  const now = Date.now();
  w.raw.sql.exec("UPDATE approvals SET created_at = ?, expires_at = ? WHERE operation_id = ?", now - 1 - DEFAULT_APPROVAL_TTL_MS, now - 1, op);
  const said = await noticeSent(w, op);
  must(said.includes(`[approval ${op} — state.put — expired;`) && said.includes("Nobody decided within 24 hours") && said.includes("you may call it again"), said);
});

// ---- publishing: the D1 copy and the hint -------------------------------------------------------------------

await check("publish: the hold and each change reach D1, and a signed hint names only ids; a failing hint is retried and never blocks", async () => {
  const w = await world({ hints: true });
  outbound = [];
  const op = await hold(w);
  await w.D.alarm();
  must(indexRow(w, op)?.status === "pending" && indexRow(w, op).raft_origin === ORIGIN && indexRow(w, op).raft_agent_id === RAFT_ID, `index: ${show(indexRow(w, op))}`);
  must(!String(indexRow(w, op).item).includes(LEAKED), "the D1 copy carries the credential");
  const h = hints();
  must(h.length === 1, `hints: ${h.length}`);
  const body = JSON.parse(h[0]!.body);
  must(body.type === "approval.requested" && body.operationId === op && body.providerAgentId === A && body.raftAgentId === RAFT_ID && body.status === "pending", h[0]!.body);
  must(!h[0]!.body.includes("plan") && !h[0]!.body.includes(LEAKED), `the hint carries more than ids: ${h[0]!.body}`);
  const ok = await verifyHint(HINT_SECRET, { signature: h[0]!.headers.get(SIGNATURE_HEADER), timestamp: h[0]!.headers.get(TIMESTAMP_HEADER) }, h[0]!.body, Math.floor(Date.now() / 1000));
  must(ok, "the hint's signature does not verify");
  must(!(await verifyHint("another-secret", { signature: h[0]!.headers.get(SIGNATURE_HEADER), timestamp: h[0]!.headers.get(TIMESTAMP_HEADER) }, h[0]!.body, Math.floor(Date.now() / 1000))), "a wrong secret verified");
  must(!(await verifyHint(HINT_SECRET, { signature: h[0]!.headers.get(SIGNATURE_HEADER), timestamp: h[0]!.headers.get(TIMESTAMP_HEADER) }, h[0]!.body, Math.floor(Date.now() / 1000) + 301)), "a stale hint verified");
  // Raft is down: the decision still lands, D1 still moves, and the hint is kept with when to retry.
  // (The approve → executed path's hints are checked in the case after this one.)
  hintStatus = 503;
  try {
    must((await decide(w, op, "deny")).status === 200, "decide with Raft down");
    await w.D.alarm();
    must(indexRow(w, op)?.status === "denied", `index after deny: ${show(indexRow(w, op))}`);
    const kept = w.raw.sql.exec("SELECT attempts, next_at FROM approval_publish WHERE operation_id = ?", op).toArray()[0] as any;
    must(kept && Number(kept.attempts) === 1 && Number(kept.next_at) > Date.now(), `retry not kept: ${show(kept)}`);
    must(w.alarmAt() !== null && w.alarmAt()! <= Number(kept.next_at) + 1000, `no alarm for the retry: ${w.alarmAt()}`);
    must(row(w, op).state === "denied", "the failing hint touched the hold");
  } finally { hintStatus = 200; }
  // Bounded: after the last attempt it is left to the reconcile.
  w.raw.sql.exec("UPDATE approval_publish SET attempts = 5, next_at = 0 WHERE operation_id = ?", op);
  hintStatus = 503;
  try { await w.D.alarm(); } finally { hintStatus = 200; }
  must(row(w, op).published_state === "denied" && !w.raw.sql.exec("SELECT 1 FROM approval_publish WHERE operation_id = ?", op).toArray().length, `not given up: ${show(row(w, op))}`);
  must(publishBackoffMs(1) === 30_000 && publishBackoffMs(20) === 15 * 60_000, "backoff");
});

await check("publish: an approval sends a hint for each transition, approved then executed, and D1 follows", async () => {
  const w = await world({ hints: true });
  const op = await hold(w, "the plan");
  await w.D.alarm();
  outbound = [];
  must((await decide(w, op, "approve")).status === 200, "decide");
  await w.D.alarm();
  const types = hints().map((h) => JSON.parse(h.body)).filter((b) => b.operationId === op).map((b) => `${b.type}/${b.status}`);
  must(show(types) === show(["approval.decided/approved", "approval.executed/executed"]), `hints: ${show(types)}`);
  for (const h of hints()) {
    must(await verifyHint(HINT_SECRET, { signature: h.headers.get(SIGNATURE_HEADER), timestamp: h.headers.get(TIMESTAMP_HEADER) }, h.body, Math.floor(Date.now() / 1000)), "unsigned hint");
  }
  must(indexRow(w, op)?.status === "executed" && JSON.parse(indexRow(w, op).item).outcome !== null, `index: ${show(indexRow(w, op))}`);
  // A late write of an earlier state does not move the copy back.
  const { d1ApprovalIndex } = await import("../cf/src/approvals.ts");
  const item = JSON.parse(indexRow(w, op).item);
  await d1ApprovalIndex(w.DB).upsert({ tenantId: T, agentId: A, operationId: op, raftOrigin: ORIGIN, raftServerId: "srv-1", raftAgentId: RAFT_ID,
    status: "approved", item: { ...item, status: "approved" }, createdAt: 1, expiresAt: null, updatedAt: Date.now() });
  must(indexRow(w, op).status === "executed", "the copy moved back to approved");
});

await check("publish: hints go only to the agent's own Raft origin, and only when both the path and the secret are set", () => {
  must(hintTarget({}, ORIGIN) === null, "unset");
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "/x" }, ORIGIN) === null, "no secret");
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "https://evil.example/x", RAFT_APPROVAL_CALLBACK_SECRET: "s" }, ORIGIN) === null, "an absolute URL");
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "//evil.example/x", RAFT_APPROVAL_CALLBACK_SECRET: "s" }, ORIGIN) === null, "a scheme-relative URL");
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "/x", RAFT_APPROVAL_CALLBACK_SECRET: "s" }, ORIGIN)?.url === `${ORIGIN}/x`, "the agent's own origin");
});

await check("provider-wide list: scoped by token, paginated, filtered by status and updatedSince; no other provider's rows", async () => {
  const w = await world();
  // Different values: an identical call while one is pending is merged into it (`holdApproval`).
  const op1 = await hold(w, "one");
  const op2 = await hold(w, "two");
  await w.D.alarm();
  // Rows the token must never see: another origin's, in the same tenant, and (for the tenant token) another tenant's.
  const put = (tenant: string, origin: string, op: string) => w.DB.raw.prepare(
    "INSERT INTO provider_approvals(tenant_id, agent_id, operation_id, raft_origin, raft_server_id, raft_agent_id, status, item, created_at, expires_at, updated_at) VALUES (?, 'raft_x', ?, ?, 'srv-x', 'x', 'pending', ?, 1, NULL, 1)")
    .run(tenant, op, origin, JSON.stringify({ operationId: op }));
  put(T, "https://other-raft.example", "op_other_origin");
  put("t-other", ORIGIN, "op_other_tenant");
  const mine = await call(w, "GET", "approvals?status=pending");
  must(mine.status === 200, `${mine.status} ${mine.text}`);
  const ids = mine.body.approvals.map((a: any) => a.operationId).sort();
  must(show(ids) === show([op1, op2].sort()), `tenant token: ${show(ids)}`);
  const plat = await call(w, "GET", "approvals", { auth: w.platform });
  const pids = plat.body.approvals.map((a: any) => a.operationId);
  must(pids.includes(op1) && pids.includes("op_other_tenant") && !pids.includes("op_other_origin"), `platform token: ${show(pids)}`);
  const platServer = await call(w, "GET", "approvals?raftServerId=srv-1", { auth: w.platform });
  must(platServer.status === 200 && platServer.body.approvals.every((a: any) => a.operationId !== "op_other_tenant"), `platform, one server: ${platServer.text}`);
  const away = await call(w, "GET", "approvals", { auth: w.elsewhere });
  must(away.status === 200 && away.body.approvals.every((a: any) => a.operationId === "op_other_origin"), `another origin's token: ${away.text}`);
  // Pages of one, continued by the cursor, until there are none.
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    const page: any = await call(w, "GET", `approvals?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
    must(page.status === 200 && page.body.approvals.length <= 1, `page ${i}: ${page.text}`);
    seen.push(...page.body.approvals.map((a: any) => a.operationId));
    cursor = page.body.nextCursor;
    if (!cursor) break;
  }
  must(show(seen.sort()) === show([op1, op2].sort()), `paged: ${show(seen)}`);
  // A change moves a row past `updatedSince`, with its new status.
  const mark = Date.now() + 1;
  await sleep(5);
  must((await decide(w, op1, "deny")).status === 200, "deny");
  await w.D.alarm();
  const since = await call(w, "GET", `approvals?updatedSince=${new Date(mark).toISOString()}`);
  must(since.body.approvals.length === 1 && since.body.approvals[0].operationId === op1 && since.body.approvals[0].status === "denied", `since: ${since.text}`);
  must((await call(w, "GET", "approvals?cursor=garbage")).status === 400, "a bad cursor was taken");
  must((await call(w, "GET", "approvals?limit=0")).status === 400, "limit 0 was taken");
});

// ---- origin, scope and policy at run time ------------------------------------------------------------------

/**
 * An agent made by the platform token at ORIGIN for server srv-1, so its tenant is that server's derivation
 * (`raft_srv-1`), with one call held: the tenant a platform token of any origin naming srv-1 also derives.
 */
async function platformAgent(w: World) {
  const res = await worker.fetch(new Request("https://x/provision/agents", {
    method: "POST", headers: { authorization: `Bearer ${w.platform}`, "content-type": "application/json" },
    body: JSON.stringify({ raftAgentId: "01JPLATFORM", raftServerId: "srv-1", raftOrigin: ORIGIN, name: "p", instructions: "p", credential: RAFT_CRED }),
  }), w.env as never);
  must(res.status === 201, `platform create: ${res.status} ${await res.text()}`);
  const P = "raft_01JPLATFORM", PT = "raft_srv-1";
  const rt: any = (w.objects.get(agentObjectName(PT, P)) as any).runtime();
  await rt.ready();
  must(await rt.store.updateMountPolicy(PT, P, "state", { tools: { put: "approval" } }), "policy");
  const h = await rt.gateway().invoke({ tenantId: PT, agentId: P, taskId: "main" }, "state.put", { key: "p", value: "p" });
  must(h.status === "pending", show(h));
  const state = async () => (await rt.store.getApproval(PT, h.operationId))?.state;
  return { P, op: h.operationId as string, state };
}

await check("per-agent routes: a platform token of another Raft origin naming this agent's server is 404, and decides nothing", async () => {
  const w = await world();
  // The gap the origin check closes: the same derived tenant, another origin. Control first: this origin's token sees it.
  const p = await platformAgent(w);
  const mine = await call(w, "GET", `agents/${p.P}/approvals?raftServerId=srv-1`, { auth: w.platform });
  must(mine.status === 200 && mine.text.includes(p.op), `control: the agent's own origin does not list it: ${mine.status} ${mine.text}`);
  const theirs = await call(w, "GET", `agents/${p.P}/approvals?raftServerId=srv-1`, { auth: w.elsewhere });
  must(theirs.status === 404 && !theirs.text.includes(p.op), `list from another origin: ${theirs.status} ${theirs.text}`);
  const theirsByRaft = await call(w, "GET", "agents/by-raft-agent/01JPLATFORM/approvals?raftServerId=srv-1", { auth: w.elsewhere });
  must(theirsByRaft.status === 404, `by-raft-agent from another origin: ${theirsByRaft.status}`);
  const theirDecide = await call(w, "POST", `agents/${p.P}/approvals/${p.op}/decide?raftServerId=srv-1`,
    { body: { decision: "approve", decidedBy: OWNER }, auth: w.elsewhere });
  must(theirDecide.status === 404 && await p.state() === "pending", `decide from another origin: ${theirDecide.status} ${theirDecide.text}, ${await p.state()}`);
  // And a tenant-made agent, whose tenant another origin's server id does not derive.
  const op = await hold(w);
  const list = await call(w, "GET", `agents/${A}/approvals?raftServerId=srv-1`, { auth: w.elsewhere });
  must(list.status === 404 && !list.text.includes(op), `list: ${list.status} ${list.text}`);
  const byRaft = await call(w, "GET", `agents/by-raft-agent/${RAFT_ID}/approvals?raftServerId=srv-1`, { auth: w.elsewhere });
  must(byRaft.status === 404, `by-raft-agent: ${byRaft.status}`);
  const d = await call(w, "POST", `agents/${A}/approvals/${op}/decide?raftServerId=srv-1`, { body: { decision: "approve", decidedBy: OWNER }, auth: w.elsewhere });
  must(d.status === 404 && row(w, op).state === "pending", `decide: ${d.status} ${d.text}`);
});

await check("per-agent routes: the platform token of the agent's own origin lists and decides with the server named", async () => {
  const w = await world();
  const op = await hold(w);
  const list = await call(w, "GET", `agents/${A}/approvals?raftServerId=srv-1`, { auth: w.platform });
  // The provisioning POST used a tenant token for T; a platform token derives `raft_srv-1`, another tenant, so the
  // happy path needs the agent made under the platform token's own derivation.
  must(list.status === 404, `control: a platform token's tenant is the server's derivation, not T: ${list.status}`);
  const { P, op: held } = await platformAgent(w);
  const h = { operationId: held };
  const listed = await call(w, "GET", `agents/${P}/approvals?raftServerId=srv-1`, { auth: w.platform });
  must(listed.status === 200 && listed.body.approvals.length === 1 && listed.body.approvals[0].operationId === h.operationId, `list: ${listed.text}`);
  const d = await call(w, "POST", `agents/${P}/approvals/${h.operationId}/decide?raftServerId=srv-1`, { body: { decision: "deny", decidedBy: OWNER }, auth: w.platform });
  must(d.status === 200 && d.body.approval.status === "denied", `decide: ${d.status} ${d.text}`);
  void op;
});

await check("decide: another agent's hold in the same tenant is approval_not_found on this agent, and stays pending", async () => {
  const w = await world();
  await hold(w);
  const other = await secondAgent(w);
  const r = await decide(w, other.op, "approve");
  must(r.status === 404 && r.body.error.code === "approval_not_found", `${r.status} ${r.text}`);
  const theirs = await call(w, "GET", `agents/${other.B}/approvals?status=pending`);
  must(theirs.body.approvals.length === 1 && theirs.body.approvals[0].status === "pending", theirs.text);
});

await check("policy at run time: a mount switched to deny after the hold refuses the approved call, ends it failed, and tells the agent", async () => {
  const w = await world();
  const op = await hold(w, "must not land");
  must(await w.rt.store.updateMountPolicy(T, A, "state", { tools: { put: "deny" } }), "deny");
  must((await decide(w, op, "approve")).status === 200, "decide");
  const said = await noticeSent(w, op);
  const r = row(w, op);
  must(r.state === "failed" && JSON.parse(r.outcome).summary.includes("policy_denied"), `row: ${show(r)}`);
  must(opRow(w, op).status === "rejected", `operation: ${show(opRow(w, op))}`);
  must(!w.raw.sql.exec("SELECT 1 FROM agent_state WHERE key = 'plan'").toArray().length, "the denied call ran");
  must(said.includes(`[approval ${op} — state.put — approved by your owner in Raft, but not run: rejected;`) && said.includes("policy_denied"), said);
  // The console path is the same gateway call: a deny wins there too.
  must(await w.rt.store.updateMountPolicy(T, A, "state", { tools: { put: "approval" } }), "back to approval");
  const op3 = await hold(w, "nor this");
  must(await w.rt.store.updateMountPolicy(T, A, "state", { tools: { put: "deny" } }), "deny again");
  const ran = await w.rt.gateway().applyApproval(T, op3, "approved", "alice", { via: "console", approver: "alice" });
  must(ran.ok && (ran.result as any)?.status === "rejected" && (ran.result as any)?.error?.code === "policy_denied", `console path: ${show(ran)}`);
  must(row(w, op3).state === "failed", `console path's row: ${row(w, op3).state}`);
});

await check("hints: a tampered body, a tampered signature, or no timestamp do not verify", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ type: "approval.requested", operationId: "op_1", providerAgentId: A, raftAgentId: RAFT_ID, raftServerId: "srv-1", status: "pending" });
  const { signHint } = await import("../cf/src/approvals.ts");
  const sig = await signHint(HINT_SECRET, ts, body);
  must(await verifyHint(HINT_SECRET, { signature: sig, timestamp: String(ts) }, body, ts), "control: the genuine hint does not verify");
  must(!(await verifyHint(HINT_SECRET, { signature: sig, timestamp: String(ts) }, body.replace("op_1", "op_2"), ts)), "a changed body verified");
  must(!(await verifyHint(HINT_SECRET, { signature: sig.replace(/.$/, (c) => (c === "0" ? "1" : "0")), timestamp: String(ts) }, body, ts)), "a changed signature verified");
  must(!(await verifyHint(HINT_SECRET, { signature: sig, timestamp: String(ts + 1) }, body, ts)), "another timestamp verified");
  must(!(await verifyHint(HINT_SECRET, { signature: sig, timestamp: null }, body, ts)), "no timestamp verified");
});

await check("provider-wide copy: a deleted agent's rows are gone and not listed; ended rows past the retention are pruned", async () => {
  const w = await world();
  const op = await hold(w);
  await w.D.alarm();
  must(indexRow(w, op)?.status === "pending", "control: not copied");
  // Retention: an ended row older than 30 days goes at the next list; a pending one of the same age stays.
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  w.DB.raw.prepare("INSERT INTO provider_approvals(tenant_id, agent_id, operation_id, raft_origin, raft_server_id, raft_agent_id, status, item, created_at, expires_at, updated_at) VALUES (?, ?, 'op_old_denied', ?, 'srv-1', ?, 'denied', '{}', 1, NULL, ?)")
    .run(T, A, ORIGIN, RAFT_ID, old);
  w.DB.raw.prepare("UPDATE provider_approvals SET updated_at = ? WHERE operation_id = ?").run(old, op);
  const listed = await call(w, "GET", "approvals");
  const ids = listed.body.approvals.map((a: any) => a.operationId);
  must(ids.includes(op) && !ids.includes("op_old_denied") && !indexRow(w, "op_old_denied"), `retention: ${show(ids)}`);
  // Deleted: the agent's copies are removed, and a row written after (a late publish) is still not listed.
  const del = await call(w, "DELETE", `agents/${A}`);
  must(del.status === 200, `delete: ${del.status} ${del.text}`);
  must(!indexRow(w, op), "the deleted agent's copy is still in D1");
  w.DB.raw.prepare("INSERT INTO provider_approvals(tenant_id, agent_id, operation_id, raft_origin, raft_server_id, raft_agent_id, status, item, created_at, expires_at, updated_at) VALUES (?, ?, 'op_late', ?, 'srv-1', ?, 'pending', '{}', 1, NULL, ?)")
    .run(T, A, ORIGIN, RAFT_ID, Date.now());
  const after = await call(w, "GET", "approvals");
  must(after.body.approvals.every((a: any) => a.operationId !== "op_late"), `a deleted agent's row is listed: ${after.text}`);
});

await check("notice: the agent writing the notice's own head first does not stop it being told", async () => {
  const w = await world();
  const op = await hold(w);
  // What the transcript search used to key on, said by the agent before the decision lands.
  await w.rt.postMessage(T, A, `[approval ${op} — `, "prompt");
  const n0 = w.jobs.length;
  await settle(w, n0 + 1);
  if (w.jobs.length > n0) await sentText(w, n0);
  must((await decide(w, op, "deny")).status === 200, "decide");
  const said = await noticeSent(w, op);
  must(said.includes(`[approval ${op} — state.put — denied by your owner in Raft;`), said);
});

// ---- the console, and the migration -------------------------------------------------------------------------

await check("console: POST /ui/decide still decides, records the signed-in approver, and the agent is told", async () => {
  const w = await world();
  const op = await hold(w, "from the console");
  const cookie = (await sessionCookieFor(SESSION, { email: "p@x.test", name: null, username: null, picture: null, source: "github", agentId: PROVIDER_HOME, tenantId: T }, "gh-provider")).split(";")[0]!;
  const res = await worker.fetch(new Request("https://console.test/ui/decide", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", cookie },
    body: new URLSearchParams({ agentId: A, operationId: op, decision: "approved" }),
  }), w.env as never);
  must(res.status === 200, `${res.status} ${await res.text()}`);
  const r = row(w, op);
  // The console still runs the call before it answers, so the hold has already ended.
  must(r.state === "executed" && JSON.parse(r.decided_by).via === "console" && opRow(w, op).status === "succeeded", `row: ${show(r)}`);
  const said = await noticeSent(w, op);
  must(said.includes(`[approval ${op} — state.put — approved by`) && said.includes("on the antiproton console and run: succeeded"), said);
});

await check("migration: an older approvals table gets deadlines for pending holds, and its old decisions are neither told nor published", async () => {
  const OLD = `CREATE TABLE approvals (tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL, mount_alias TEXT NOT NULL, tool TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL,
    approver TEXT, decided_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, operation_id))`;
  const seed = (exec: (q: string) => void) => {
    exec(OLD);
    exec(`INSERT INTO approvals VALUES ('t', 'op_old_pending', 'a', 'main', 'm', 'x', '{}', 'pending', NULL, NULL, 1000)`);
    exec(`INSERT INTO approvals VALUES ('t', 'op_old_denied', 'a', 'main', 'm', 'x', '{}', 'denied', 'alice', 2000, 1000)`);
    // Approved when approving ran the call at once: it has run, and no pass may run it again.
    exec(`INSERT INTO approvals VALUES ('t', 'op_old_approved', 'a', 'main', 'm', 'x', '{}', 'approved', 'alice', 3000, 1000)`);
  };
  const host = sqliteHost();
  seed((q) => host.sql.exec(q));
  const store = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as never);
  await store.init();
  const pending = await store.getApproval("t", "op_old_pending");
  must(pending?.expiresAt === 1000 + DEFAULT_APPROVAL_TTL_MS, `DO pending: ${show(pending)}`);
  const told = host.sql.exec("SELECT told_at, published_state FROM approvals WHERE operation_id = 'op_old_denied'").toArray()[0] as any;
  must(told.told_at === 2000 && told.published_state === "denied", `DO decided: ${show(told)}`);
  must((await store.untoldApprovals("t")).length === 0, "an old decision would be announced");
  const ran = host.sql.exec("SELECT state, run_at, published_state FROM approvals WHERE operation_id = 'op_old_approved'").toArray()[0] as any;
  must(ran.state === "failed" && ran.run_at === 3000 && ran.published_state === "failed", `an old approval (no operation found) would run again: ${show(ran)}`);
  must((await store.listApprovals("t", "approved")).length === 0, "an old approval is still waiting to run");
  must(host.sql.exec("SELECT published_state FROM approvals WHERE operation_id = 'op_old_pending'").toArray()[0] && (host.sql.exec("SELECT published_state AS p FROM approvals WHERE operation_id = 'op_old_pending'").toArray()[0] as any).p === null, "the old pending hold would not be published");
  // Again: nothing moves a second time.
  await store.init();
  must((await store.getApproval("t", "op_old_pending"))?.expiresAt === 1000 + DEFAULT_APPROVAL_TTL_MS, "a second init moved it");
  // The node store, the same way.
  const file = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "raft-approvals-")), "old.db");
  const db = new DatabaseSync(file);
  seed((q) => db.exec(q));
  db.close();
  const sq = new SqliteStore(file);
  await sq.init();
  must((await sq.getApproval("t", "op_old_pending"))?.expiresAt === 1000 + DEFAULT_APPROVAL_TTL_MS, "sqlite pending");
  must((await sq.untoldApprovals("t")).length === 0, "sqlite would announce an old decision");
});

globalThis.fetch = realFetch;
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
