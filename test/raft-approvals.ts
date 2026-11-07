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
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { d1ProviderTokens } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import { sessionCookieFor } from "../cf/src/auth.ts";
import { PROVIDER_HOME } from "../cf/src/provision/steps.ts";
import { verifyHint, signHint, importSigningKey, hintKeyId, SIGNATURE_HEADER, TIMESTAMP_HEADER, hintTarget, publishBackoffMs, approvalDescription } from "../cf/src/approvals.ts";
import { expiredNotice } from "../src/runtime/approval-notice.ts";
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
/** A fresh Ed25519 key for the world's hints, as RAFT_APPROVAL_SIGNING_KEY holds it, and Raft's {key id: public key}. */
function newHintKey() {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const pub = Buffer.from(jwk.x!, "base64url");
  return { secret: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x }), keyId: createHash("sha256").update(pub).digest("hex").slice(0, 16), pub: pub.toString("base64") };
}
const HINT_KEY = newHintKey(), OTHER_KEY = newHintKey();
const HINT_KEYS = { [HINT_KEY.keyId]: HINT_KEY.pub };
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
    ...(opts.hints ? { RAFT_APPROVAL_CALLBACK_PATH: "/hooks/antiproton/approvals", RAFT_APPROVAL_SIGNING_KEY: HINT_KEY.secret } : {}),
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
const DAY = 24 * 60 * 60 * 1000;
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
  must(a.description.startsWith("Approving runs state.put once, exactly as shown") && a.description.includes(`Undecided at ${a.expiresAt}, it expires and nothing runs.`), a.description);
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
  must(said.includes(`[approval ${op} — state.put — expired;`) && said.includes("Nobody decided within 24 hours") && said.includes("you may call it again") &&
    said.includes(`You made this call at ${new Date(now - 1 - DEFAULT_APPROVAL_TTL_MS).toISOString()}.`), said);
});

// ---- Raft's delivery report ---------------------------------------------------------------------------------

const deliver = (w: World, op: string, body: unknown, auth?: string | null, agent = `by-raft-agent/${RAFT_ID}`, server = "") =>
  call(w, "POST", `agents/${agent}/approvals/${op}/delivery${server}`, { body, auth });
const delivered = (t: number) => ({ outcome: "delivered", deliveredAt: new Date(t).toISOString() });
const noRecipient = (t: number) => ({ outcome: "no_recipient", checkedAt: new Date(t).toISOString() });
const recorded = (w: World, op: string) => { const r = row(w, op); return r.delivery_outcome === null ? null : `${r.delivery_outcome}@${r.delivery_at}`; };
/** A hold that expired at `endedAt`: deadline there, then the alarm's sweep. */
async function expiredHold(w: World, endedAt: number) {
  const op = await hold(w);
  w.raw.sql.exec("UPDATE approvals SET created_at = ?, expires_at = ? WHERE operation_id = ?", endedAt - DEFAULT_APPROVAL_TTL_MS, endedAt, op);
  await w.D.alarm();
  must(row(w, op).state === "expired", `not expired: ${show(row(w, op))}`);
  return op;
}

await check("delivery: refused exactly where decide is refused: no token, a forged one, another tenant, another origin, a platform token without the server", async () => {
  const w = await world();
  const op = await hold(w);
  const p = await platformAgent(w);
  const t = Date.now();
  // The same request through both routes, so a difference in how they are authorised shows as a difference here.
  const cases: Array<[string, string | null, string, string]> = [
    ["no token", null, `by-raft-agent/${RAFT_ID}`, ""],
    ["a forged token", newProviderToken(), `by-raft-agent/${RAFT_ID}`, ""],
    ["another tenant's token", w.other, `by-raft-agent/${RAFT_ID}`, ""],
    ["another origin's platform token, this agent's server", w.elsewhere, `by-raft-agent/${RAFT_ID}`, "?raftServerId=srv-1"],
    ["another origin's platform token, a platform agent", w.elsewhere, "by-raft-agent/01JPLATFORM", "?raftServerId=srv-1"],
    ["a platform token with no server", w.platform, "by-raft-agent/01JPLATFORM", ""],
  ];
  for (const [name, auth, agent, server] of cases) {
    const target = agent.endsWith("01JPLATFORM") ? p.op : op;
    const d = await call(w, "POST", `agents/${agent}/approvals/${target}/decide${server}`, { body: { decision: "approve", decidedBy: OWNER }, auth });
    const r = await deliver(w, target, delivered(t), auth, agent, server);
    must(r.status === d.status && [401, 404, 422].includes(r.status), `${name}: delivery ${r.status} ${r.text}, decide ${d.status} ${d.text}`);
    // Raft stops on a 404 only with this code, and an agent it cannot see is one it should stop on.
    if (r.status === 404) must(r.body.error.code === "approval_not_found", `${name}: ${r.text}`);
    if (r.status === 401) must(r.body.error.code === d.body.error.code, `${name}: ${r.text} vs ${d.text}`);
  }
  must(recorded(w, op) === null && row(w, op).state === "pending" && await p.state() === "pending", `a refused report or decision landed: ${show(row(w, op))}`);
  // Control: the right tokens are taken, the tenant's and the agent's own origin's platform token with its server.
  const mine = await deliver(w, op, delivered(t));
  must(mine.status === 200 && mine.body.outcome === "delivered" && mine.body.deliveredAt === new Date(t).toISOString(), `control: ${mine.status} ${mine.text}`);
  const plat = await deliver(w, p.op, noRecipient(t), w.platform, "raft_01JPLATFORM", "?raftServerId=srv-1");
  must(plat.status === 200 && plat.body.outcome === "no_recipient" && plat.body.checkedAt === new Date(t).toISOString(), `platform control: ${plat.status} ${plat.text}`);
});

await check("delivery: a body that is not the contract's is 400 with a code, and records nothing", async () => {
  const w = await world();
  const op = await hold(w);
  const at = new Date().toISOString();
  const bad: Array<[string, unknown, string, string | undefined]> = [
    ["not an object", [], "invalid", undefined],
    ["no outcome", { deliveredAt: at }, "missing", "outcome"],
    ["an unknown outcome", { outcome: "read", deliveredAt: at }, "invalid_outcome", "outcome"],
    ["delivered without deliveredAt", { outcome: "delivered" }, "missing", "deliveredAt"],
    ["no_recipient without checkedAt", { outcome: "no_recipient" }, "missing", "checkedAt"],
    ["delivered with checkedAt", { outcome: "delivered", checkedAt: at }, "invalid", "checkedAt"],
    ["an approver named", { outcome: "delivered", deliveredAt: at, approver: "u-1" }, "invalid", "approver"],
    ["a card id", { outcome: "delivered", deliveredAt: at, cardId: "c-1" }, "invalid", "cardId"],
    ["a date without a time", { outcome: "delivered", deliveredAt: "2026-11-04" }, "invalid_timestamp", "deliveredAt"],
    ["a time without an offset", { outcome: "delivered", deliveredAt: "2026-11-04T10:00:00" }, "invalid_timestamp", "deliveredAt"],
    ["a number", { outcome: "delivered", deliveredAt: Date.now() }, "invalid_timestamp", "deliveredAt"],
    ["month 13", { outcome: "no_recipient", checkedAt: "2026-13-04T10:00:00Z" }, "invalid_timestamp", "checkedAt"],
  ];
  for (const [name, body, code, param] of bad) {
    const r = await deliver(w, op, body);
    must(r.status === 400 && r.body.error.code === code && r.body.error.param === param, `${name}: ${r.status} ${r.text}`);
  }
  must(recorded(w, op) === null, `a refused body was recorded: ${recorded(w, op)}`);
});

await check("delivery: delivered is first-wins, and a no_recipient after it is answered with the delivered and changes nothing", async () => {
  const w = await world();
  const op = await hold(w);
  const t1 = Date.now() - 5_000, t2 = Date.now();
  const first = await deliver(w, op, delivered(t1));
  must(first.status === 200 && show(first.body) === show({ outcome: "delivered", deliveredAt: new Date(t1).toISOString() }), first.text);
  const second = await deliver(w, op, delivered(t2));
  must(second.status === 200 && second.body.deliveredAt === new Date(t1).toISOString(), `a second delivered moved it: ${second.text}`);
  const none = await deliver(w, op, noRecipient(t2));
  must(none.status === 200 && show(none.body) === show({ outcome: "delivered", deliveredAt: new Date(t1).toISOString() }), `no_recipient over delivered: ${none.text}`);
  must(recorded(w, op) === `delivered@${t1}`, `row: ${recorded(w, op)}`);
  // The read view says what is recorded.
  const listed = await call(w, "GET", `agents/${A}/approvals`);
  must(show(listed.body.approvals[0].delivery) === show({ outcome: "delivered", at: new Date(t1).toISOString() }), show(listed.body.approvals[0]));
});

await check("delivery: no_recipient keeps its first time, a delivered after it replaces it, and the provider copy follows", async () => {
  const w = await world();
  const op = await hold(w);
  await w.D.alarm();
  must(JSON.parse(indexRow(w, op).item).delivery === null, `copy before any report: ${indexRow(w, op).item}`);
  const c1 = Date.now() - 9_000, c2 = Date.now() - 8_000, d1 = Date.now() - 1_000;
  must((await deliver(w, op, noRecipient(c1))).body.checkedAt === new Date(c1).toISOString(), "first no_recipient");
  const again = await deliver(w, op, noRecipient(c2));
  must(again.status === 200 && again.body.checkedAt === new Date(c1).toISOString(), `a second no_recipient moved it: ${again.text}`);
  must(show(JSON.parse(indexRow(w, op).item).delivery) === show({ outcome: "no_recipient", at: new Date(c1).toISOString() }), `copy: ${indexRow(w, op).item}`);
  const over = await deliver(w, op, delivered(d1));
  must(over.status === 200 && show(over.body) === show({ outcome: "delivered", deliveredAt: new Date(d1).toISOString() }), `delivered over no_recipient: ${over.text}`);
  must(recorded(w, op) === `delivered@${d1}`, `row: ${recorded(w, op)}`);
  must(show(JSON.parse(indexRow(w, op).item).delivery) === show({ outcome: "delivered", at: new Date(d1).toISOString() }), `copy: ${indexRow(w, op).item}`);
});

await check("delivery: after the hold ended, a report within 60 s of the end is recorded; later is 409 approval_not_pending and records nothing", async () => {
  const w = await world();
  const end = Date.now() - 10 * 60_000;
  const op = await expiredHold(w, end);
  const notice = row(w, op).notice;
  must(String(notice).includes("whether it reached an approver is not known"), `notice at expiry: ${notice}`);
  const late = await deliver(w, op, delivered(end + 60_001));
  must(late.status === 409 && late.body.error.code === "approval_not_pending" && late.body.error.param === "deliveredAt", `${late.status} ${late.text}`);
  const lateNone = await deliver(w, op, noRecipient(end + 60_001));
  must(lateNone.status === 409 && lateNone.body.error.code === "approval_not_pending", `no_recipient: ${lateNone.status} ${lateNone.text}`);
  must(recorded(w, op) === null, `a late report was recorded: ${recorded(w, op)}`);
  const inTime = await deliver(w, op, delivered(end + 60_000));
  must(inTime.status === 200 && inTime.body.deliveredAt === new Date(end + 60_000).toISOString(), `within the skew: ${inTime.status} ${inTime.text}`);
  must(recorded(w, op) === `delivered@${end + 60_000}`, `row: ${recorded(w, op)}`);
  // The record moves; the notice the expiry wrote does not.
  must(row(w, op).notice === notice, `the notice was rewritten: ${row(w, op).notice}`);
  const listed = await call(w, "GET", `agents/${A}/approvals?status=expired`);
  must(listed.body.approvals[0].description.startsWith("Expired: it reached an approver, but nobody decided in time"), listed.body.approvals[0].description);
  // A repeat of what is recorded is answered with it, however late it comes.
  const repeat = await deliver(w, op, delivered(end + DAY));
  must(repeat.status === 200 && repeat.body.deliveredAt === new Date(end + 60_000).toISOString(), `repeat: ${repeat.status} ${repeat.text}`);
  // A decided hold ends at its decision.
  const op2 = await hold(w);
  must((await decide(w, op2, "deny")).status === 200, "deny");
  const decidedAt = Number(row(w, op2).decided_at);
  must((await deliver(w, op2, noRecipient(decidedAt + 61_000))).status === 409, "after a decision, beyond the skew");
  must((await deliver(w, op2, noRecipient(decidedAt + 59_000))).status === 200 && recorded(w, op2) === `no_recipient@${decidedAt + 59_000}`, "after a decision, within the skew");
});

await check("delivery: an unknown hold, another agent's hold, and an unknown agent are 404 approval_not_found, in decide's error format", async () => {
  const w = await world();
  const other = await secondAgent(w);
  const at = Date.now();
  for (const [name, op, agent] of [["unknown hold", "op_doesnotexist000000", `by-raft-agent/${RAFT_ID}`], ["another agent's hold", other.op, `by-raft-agent/${RAFT_ID}`],
    ["unknown agent", "op_doesnotexist000000", "by-raft-agent/01JNOBODY"], ["an operation id out of shape", "op%20bad", `by-raft-agent/${RAFT_ID}`]] as const) {
    const r = await deliver(w, op, delivered(at), undefined, agent);
    must(r.status === 404 && r.body.error.code === "approval_not_found" && typeof r.body.error.message === "string" && Object.keys(r.body).length === 1,
      `${name}: ${r.status} ${r.text}`);
  }
  const theirs = (w.objects.get(agentObjectName(T, other.B)) as any).runtime();
  must((await theirs.store.getApproval(T, other.op)).delivery === null, "another agent's hold took the report");
});

await check("notice: an expiry is worded by what was recorded then: reached an approver, reached nobody, or not known", async () => {
  const w = await world();
  const now = Date.now();
  const opD = await hold(w), opN = await hold(w, "second"), opU = await hold(w, "third");
  // Held earlier with the default deadline, so each expires at the next sweep.
  for (const op of [opD, opN, opU]) {
    w.raw.sql.exec("UPDATE approvals SET created_at = ?, expires_at = ? WHERE operation_id = ?", now - 1 - DEFAULT_APPROVAL_TTL_MS, now - 1, op);
  }
  must((await deliver(w, opD, delivered(now - DAY + 1000))).status === 200, "delivered");
  must((await deliver(w, opN, noRecipient(now - DAY + 1000))).status === 200, "no_recipient");
  await w.D.alarm();
  const made = `You made this call at ${new Date(now - 1 - DEFAULT_APPROVAL_TTL_MS).toISOString()}. `;
  const notices = [opD, opN, opU].map((op) => String(row(w, op).notice));
  must(notices[0]!.endsWith(made + "It reached an approver, but nobody decided within 24 hours, so it expired and nothing was run. " +
    "If it still matters you may call it again, which asks for a new approval."), `delivered: ${notices[0]}`);
  must(notices[1]!.endsWith(made + "It never reached any approver, because Raft had nobody to send it to, so it expired after 24 hours and nothing was run. " +
    "If it still matters you may call it again, which asks for a new approval. That one reaches nobody either unless Raft has someone to send it to by then."),
    `no_recipient: ${notices[1]}`);
  must(notices[2]!.endsWith(made + "Nobody decided within 24 hours, so it expired and nothing was run; whether it reached an approver is not known. " +
    "If it still matters you may call it again, which asks for a new approval."), `nothing recorded: ${notices[2]}`);
  // "Reached nobody" is said on a recorded no_recipient and on nothing else.
  must(notices.filter((n) => n.includes("never reached")).length === 1, show(notices));
  const base = { operationId: "op_x", mountAlias: "m", tool: "t", createdAt: 0, expiresAt: 3_600_000 };
  must(!expiredNotice({ ...base, delivery: null }).includes("never reached") && !expiredNotice({ ...base, delivery: { outcome: "delivered", at: 1 } }).includes("never reached"),
    "never reached without a no_recipient");
  const listed = (await call(w, "GET", `agents/${A}/approvals?status=expired`)).body.approvals as any[];
  const desc = (op: string) => listed.find((a) => a.operationId === op).description as string;
  must(desc(opD).startsWith("Expired: it reached an approver") && desc(opN).startsWith("Expired: it never reached any approver, because Raft had nobody")
    && desc(opU).endsWith("whether it reached an approver is not known."), show(listed.map((a) => a.description)));
});

await check("wording: no notice, description, error or doc says an expired hold was denied", async () => {
  const w = await world();
  const op = await expiredHold(w, Date.now() - 1);
  const late = await decide(w, op, "approve");
  const listed = await call(w, "GET", `agents/${A}/approvals`);
  const texts = [String(row(w, op).notice), late.text, listed.text];
  for (const f of ["src/runtime/approval-notice.ts", "cf/src/approvals.ts", "cf/src/provision/handlers.ts", "docs/raft-approvals.md"]) {
    texts.push(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
  }
  must(texts.every((t) => !t.includes("denied as expired") && !t.includes("denied as `expired`")), texts.find((t) => t.includes("denied as"))?.slice(0, 300) ?? "");
  must(late.status === 409 && late.body.error.message.includes("nothing was run"), late.text);
});

await check("description: an approved call that asked before acting says it was not run, not that the run failed or that it ran", () => {
  const base = { status: "failed" as const, mount: "raft", tool: "messages_send", service: null, action: null, route: null, expiresAt: null };
  const asked = approvalDescription({ ...base, outcome: { summary: "cancelled: asked_before_acting: Approved, but before acting …" } });
  must(asked.startsWith("Approved, but not run:") && asked.includes("nothing was done") && !/executed|run once|failed/.test(asked), asked);
  const ran = approvalDescription({ ...base, outcome: { summary: "failed: boom: it broke" } });
  must(ran.startsWith("Approved, but the run failed"), ran);
});

await check("hand-off: the approval.requested hint is recorded accepted, failed, or not_sent when this deployment has no hint channel", async () => {
  const sent = await world({ hints: true });
  const opA = await hold(sent);
  must(row(sent, opA).handoff === null, "a hand-off recorded before it was tried");
  await sent.D.alarm();
  must(row(sent, opA).handoff === "accepted", `accepted: ${row(sent, opA).handoff}`);
  hintStatus = 503;
  let opF = "";
  try { opF = await hold(sent, "second"); await sent.D.alarm(); } finally { hintStatus = 200; }
  must(row(sent, opF).handoff === "failed", `failed: ${row(sent, opF).handoff}`);
  // A retry that lands is the hand-off's last word.
  sent.raw.sql.exec("UPDATE approval_publish SET next_at = 0 WHERE operation_id = ?", opF);
  await sent.D.alarm();
  must(row(sent, opF).handoff === "accepted", `after the retry: ${row(sent, opF).handoff}`);
  // A later state's hint is not the hand-off.
  hintStatus = 503;
  try { must((await decide(sent, opA, "deny")).status === 200, "deny"); await sent.D.alarm(); } finally { hintStatus = 200; }
  must(row(sent, opA).handoff === "accepted", `a decided hint's failure moved it: ${row(sent, opA).handoff}`);
  const quiet = await world();
  const opN = await hold(quiet);
  await quiet.D.alarm();
  must(row(quiet, opN).handoff === "not_sent", `not_sent: ${row(quiet, opN).handoff}`);
  const listed = await call(quiet, "GET", `agents/${A}/approvals`);
  must(listed.body.approvals[0].handoff === "not_sent" && listed.body.approvals[0].delivery === null, show(listed.body.approvals[0]));
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
  const sent = { signature: h[0]!.headers.get(SIGNATURE_HEADER), timestamp: h[0]!.headers.get(TIMESTAMP_HEADER) };
  must(sent.signature?.startsWith(`keyid=${HINT_KEY.keyId}; ed25519=`), `the header: ${sent.signature}`);
  const ok = await verifyHint(HINT_KEYS, sent, h[0]!.body, Math.floor(Date.now() / 1000));
  must(ok, "the hint's signature does not verify");
  must(!(await verifyHint({ [HINT_KEY.keyId]: OTHER_KEY.pub }, sent, h[0]!.body, Math.floor(Date.now() / 1000))), "another public key verified");
  must(!(await verifyHint(HINT_KEYS, sent, h[0]!.body, Math.floor(Date.now() / 1000) + 301)), "a stale hint verified");
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
    must(await verifyHint(HINT_KEYS, { signature: h.headers.get(SIGNATURE_HEADER), timestamp: h.headers.get(TIMESTAMP_HEADER) }, h.body, Math.floor(Date.now() / 1000)), "unsigned hint");
  }
  must(indexRow(w, op)?.status === "executed" && JSON.parse(indexRow(w, op).item).outcome !== null, `index: ${show(indexRow(w, op))}`);
  // A late write of an earlier state does not move the copy back.
  const { d1ApprovalIndex } = await import("../cf/src/approvals.ts");
  const item = JSON.parse(indexRow(w, op).item);
  await d1ApprovalIndex(w.DB).upsert({ tenantId: T, agentId: A, operationId: op, raftOrigin: ORIGIN, raftServerId: "srv-1", raftAgentId: RAFT_ID,
    status: "approved", item: { ...item, status: "approved" }, createdAt: 1, expiresAt: null, updatedAt: Date.now() });
  must(indexRow(w, op).status === "executed", "the copy moved back to approved");
});

await check("publish: hints go only to the agent's own Raft origin, and only when both the path and the signing key are set", () => {
  const k = HINT_KEY.secret;
  must(hintTarget({}, ORIGIN) === null, "unset");
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "/x" }, ORIGIN) === null, "no signing key");
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "/x", RAFT_APPROVAL_SIGNING_KEY: " " }, ORIGIN) === null, "a blank signing key");
  must(hintTarget({ RAFT_APPROVAL_SIGNING_KEY: k }, ORIGIN) === null, "no path");
  // The secret it replaced is not read at all: a deployment that still has it sends nothing.
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "/x", RAFT_APPROVAL_CALLBACK_SECRET: "s" } as never, ORIGIN) === null, "the old HMAC secret");
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "https://evil.example/x", RAFT_APPROVAL_SIGNING_KEY: k }, ORIGIN) === null, "an absolute URL");
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "//evil.example/x", RAFT_APPROVAL_SIGNING_KEY: k }, ORIGIN) === null, "a scheme-relative URL");
  must(hintTarget({ RAFT_APPROVAL_CALLBACK_PATH: "/x", RAFT_APPROVAL_SIGNING_KEY: k }, ORIGIN)?.url === `${ORIGIN}/x`, "the agent's own origin");
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

await check("hints: a tampered body, a tampered signature, another timestamp, or no timestamp do not verify", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ type: "approval.requested", operationId: "op_1", providerAgentId: A, raftAgentId: RAFT_ID, raftServerId: "srv-1", status: "pending" });
  const { key, keyId } = await importSigningKey(HINT_KEY.secret);
  must(keyId === HINT_KEY.keyId, `the key id from the secret: ${keyId} (node: ${HINT_KEY.keyId})`);
  const sig = await signHint(key, keyId, ts, body);
  must(await verifyHint(HINT_KEYS, { signature: sig, timestamp: String(ts) }, body, ts), "control: the genuine hint does not verify");
  must(!(await verifyHint(HINT_KEYS, { signature: sig, timestamp: String(ts) }, body.replace("op_1", "op_2"), ts)), "a changed body verified");
  // A changed byte of the signature: a character in the middle, which carries six bits of it.
  const at = sig.indexOf("ed25519=") + 8 + 40;
  const flipped = sig.slice(0, at) + (sig[at] === "A" ? "B" : "A") + sig.slice(at + 1);
  must(flipped !== sig, "control: the signature was not changed");
  must(!(await verifyHint(HINT_KEYS, { signature: flipped, timestamp: String(ts) }, body, ts)), "a changed signature verified");
  // The last character before "==" carries two bits of the signature and four of padding: one that differs only in
  // the padding decodes to the same bytes, and is refused because it is not the canonical encoding.
  const last = sig.at(-3)!, ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const loose = sig.slice(0, -3) + ALPHA[ALPHA.indexOf(last) ^ 1] + "==";
  must(Buffer.from(loose.split("ed25519=")[1]!, "base64").equals(Buffer.from(sig.split("ed25519=")[1]!, "base64")), "control: the loose encoding decodes differently");
  must(!(await verifyHint(HINT_KEYS, { signature: loose, timestamp: String(ts) }, body, ts)), "a non-canonical encoding of the signature verified");
  must(!(await verifyHint(HINT_KEYS, { signature: sig, timestamp: String(ts + 1) }, body, ts)), "another timestamp verified");
  must(!(await verifyHint(HINT_KEYS, { signature: sig, timestamp: null }, body, ts)), "no timestamp verified");
  must(!(await verifyHint(HINT_KEYS, { signature: null, timestamp: String(ts) }, body, ts)), "no signature verified");
  must(!(await verifyHint({}, { signature: sig, timestamp: String(ts) }, body, ts)), "verified with no keys configured");
});

await check("hints: a malformed signing key fails the hint without quoting the key", async () => {
  const notJson = "MC4CAQAwBQYDK2VwBCIEI" + "secretmaterial".repeat(3);
  for (const bad of [notJson, '{"kty":"RSA"}', '{"kty":"OKP","crv":"Ed25519","x":"' + HINT_KEY.pub + '"}']) {
    let msg = "";
    try { await importSigningKey(bad); } catch (e) { msg = String((e as Error).message); }
    must(msg.startsWith("RAFT_APPROVAL_SIGNING_KEY is not"), `${bad.slice(0, 10)}: ${msg}`);
    must(!msg.includes("secretmaterial") && !msg.includes("MC4C"), `the error quotes the key: ${msg}`);
  }
});

await check("hints: the timestamp window is 300 s either way, and a hint outside it is refused though its signature is good", async () => {
  const ts = 1_800_000_000;
  const body = '{"type":"approval.expired"}';
  const { key, keyId } = await importSigningKey(HINT_KEY.secret);
  const h = { signature: await signHint(key, keyId, ts, body), timestamp: String(ts) };
  must(await verifyHint(HINT_KEYS, h, body, ts + 300) && await verifyHint(HINT_KEYS, h, body, ts - 300), "control: the window's edges were refused");
  must(!(await verifyHint(HINT_KEYS, h, body, ts + 301)), "a hint 301 s old verified");
  must(!(await verifyHint(HINT_KEYS, h, body, ts - 301)), "a hint 301 s ahead verified");
  // 1 to 12 digits: a zero-padded timestamp names the same second but is not the one the signer wrote.
  must(!(await verifyHint(HINT_KEYS, { ...h, timestamp: `0${ts}`.padStart(13, "0") }, body, ts)), "a 13-digit timestamp verified");
  must(!(await verifyHint(HINT_KEYS, { ...h, timestamp: `${ts}.0` }, body, ts)), "a timestamp with a fraction verified");
  // Signed over the padded text itself, so the signature is good and only the 1-12 digit rule can refuse it.
  const padded = `000${ts}`, { key: k } = await importSigningKey(HINT_KEY.secret);
  const raw = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, k, new TextEncoder().encode(`${padded}.${body}`))).toString("base64");
  const paddedHint = { signature: `keyid=${HINT_KEY.keyId}; ed25519=${raw}`, timestamp: padded };
  must(!(await verifyHint(HINT_KEYS, paddedHint, body, ts)), "a 13-digit timestamp with a good signature verified");
});

await check("hints: the key id picks the key; an unknown one is refused and never tried against the configured keys", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"type":"approval.decided"}';
  const { key } = await importSigningKey(HINT_KEY.secret);
  // Signed with the configured key but naming another id: the signature is good under HINT_KEYS' only key, so only
  // the key-id lookup can refuse it.
  const unknownId = OTHER_KEY.keyId;
  const sig = await signHint(key, unknownId, ts, body);
  must(await verifyHint({ [unknownId]: HINT_KEY.pub }, { signature: sig, timestamp: String(ts) }, body, ts), "control: the signature is not good under the right public key");
  must(!(await verifyHint(HINT_KEYS, { signature: sig, timestamp: String(ts) }, body, ts)), "an unknown key id verified against a configured key");
  // A wrong key id that is configured, for another key: refused too.
  must(!(await verifyHint({ ...HINT_KEYS, [unknownId]: OTHER_KEY.pub }, { signature: sig, timestamp: String(ts) }, body, ts)), "verified with the key the id names, which did not sign");
  // Rotation: two keys configured, each hint verifies under the one its id names.
  const { key: k2, keyId: id2 } = await importSigningKey(OTHER_KEY.secret);
  const both = { ...HINT_KEYS, [OTHER_KEY.keyId]: OTHER_KEY.pub };
  must(await verifyHint(both, { signature: await signHint(k2, id2, ts, body), timestamp: String(ts) }, body, ts), "the new key, during a rotation");
  must(await verifyHint(both, { signature: await signHint(key, HINT_KEY.keyId, ts, body), timestamp: String(ts) }, body, ts), "the old key, during a rotation");
  // Ids that are object properties rather than configured keys.
  for (const id of ["__proto__", "constructor", "toString"]) {
    must(!(await verifyHint(HINT_KEYS, { signature: sig.replace(`keyid=${unknownId}`, `keyid=${id}`), timestamp: String(ts) }, body, ts)), `keyid=${id} verified`);
  }
});

// The vector docs/raft-approvals.md publishes ("Test vector"), for Raft to put in its own tests. TEST-ONLY KEY: it
// is published, so it must never be configured anywhere.
const VECTOR = {
  privateKeyJwk: '{"kty":"OKP","crv":"Ed25519","d":"x_qwznyTeNjGjnhzhNnuUD9qNvphU0-F5iTbBiD26mw","x":"Qh0z7hW_fenoBF-qTen6HVDqIJuJq6qUsKmxxpTeaZk"}',
  publicKey: "Qh0z7hW/fenoBF+qTen6HVDqIJuJq6qUsKmxxpTeaZk=",
  keyId: "ed95939c506fd5c5",
  timestamp: 1767225600,
  body: '{"type":"approval.requested","operationId":"op_test_vector","providerAgentId":"raft_01TESTVECTOR","raftAgentId":"01TESTVECTOR","raftServerId":"srv-test","status":"pending"}',
  header: "keyid=ed95939c506fd5c5; ed25519=HKqyRp+2SGY4L0Fpdl3JGP4j+vGq0JWTbPUYwBJpqy+VFJjTTPC47vonSyDQoU42C0MzEIW08bQ0pex6eU4CBQ==",
};

await check("hints: the published test vector reproduces exactly, and the docs carry the same values", async () => {
  const { key, keyId } = await importSigningKey(VECTOR.privateKeyJwk);
  must(keyId === VECTOR.keyId, `key id ${keyId}`);
  must(await hintKeyId(Buffer.from(VECTOR.publicKey, "base64")) === VECTOR.keyId, "the key id from the public key alone");
  must(createHash("sha256").update(Buffer.from(VECTOR.publicKey, "base64")).digest("hex").slice(0, 16) === VECTOR.keyId, "the key id by node:crypto");
  const header = await signHint(key, keyId, VECTOR.timestamp, VECTOR.body);
  must(header === VECTOR.header, `header ${header}`);
  must(await verifyHint({ [VECTOR.keyId]: VECTOR.publicKey }, { signature: VECTOR.header, timestamp: String(VECTOR.timestamp) }, VECTOR.body, VECTOR.timestamp + 10), "the vector does not verify");
  must(SIGNATURE_HEADER === "x-antiproton-signature", `header name ${SIGNATURE_HEADER}`);
  must(/^[A-Za-z0-9._-]{1,64}$/.test(VECTOR.keyId) && VECTOR.publicKey.length === 44, "the key id's charset or the public key's length");
  const mapEntry = JSON.stringify({ [VECTOR.keyId]: VECTOR.publicKey });
  const doc = readFileSync(new URL("../docs/raft-approvals.md", import.meta.url), "utf8");
  for (const v of [VECTOR.publicKey, VECTOR.keyId, String(VECTOR.timestamp), VECTOR.body, `X-Antiproton-Signature: ${VECTOR.header}`,
    `X-Antiproton-Timestamp: ${VECTOR.timestamp}`, mapEntry]) must(doc.includes(v), `the docs do not carry ${v}`);
  // The private half is in the docs too, as test-only, so Raft can sign as well as verify.
  must(doc.includes(VECTOR.privateKeyJwk), "the docs do not carry the vector's private key");
});

await check("approval-signing-key.mjs: the child gets a private key that matches the printed public key, and nothing prints it", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "signing-key-"));
  const got = join(dir, "received");
  const script = new URL("../cf/scripts/approval-signing-key.mjs", import.meta.url).pathname;
  // The child stands in for `wrangler secret put`: it keeps what its stdin received, and says something on stdout
  // the way wrangler does, which must not reach the script's own stdout.
  const childSrc = `let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(got)},s);console.log("Success! Uploaded secret")})`;
  const r = spawnSync(process.execPath, [script, "--dry-run", "--", process.execPath, "-e", childSrc], { encoding: "utf8" });
  must(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  // Exactly one line, the JSON map entry Raft configures: {"<key id>":"<public key>"}.
  const m = /^\{"([0-9a-f]{16})":"([A-Za-z0-9+/]{43}=)"\}\n$/.exec(r.stdout);
  must(m, `stdout: ${r.stdout}`);
  const kid = m[1]!, pub = m[2]!;
  must(JSON.stringify(JSON.parse(r.stdout)) === r.stdout.trim(), "stdout is not exactly a JSON object");
  must(r.stderr.includes("Success! Uploaded secret"), `the child's output was not passed on: ${r.stderr}`);
  const received = readFileSync(got, "utf8");
  const jwk = JSON.parse(received);
  must(jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.d === "string" && jwk.d.length === 43, `received: ${Object.keys(jwk)}`);
  for (const [where, out] of [["stdout", r.stdout], ["stderr", r.stderr]] as const) {
    must(!out.includes(jwk.d), `${where} carries the private key`);
    must(!/PRIVATE KEY|"d"\s*:|MC4CAQAwBQYDK2Vw/.test(out), `${where} carries something private-key shaped`);
  }
  must(Buffer.from(jwk.x, "base64url").toString("base64") === pub, "the printed public key is not the received key's");
  must(createHash("sha256").update(Buffer.from(pub, "base64")).digest("hex").slice(0, 16) === kid, "the printed key id is not the public key's");
  must(readdirSync(dir).length === 1, `the script left files: ${readdirSync(dir)}`);
  return (async () => {
    const { key, keyId } = await importSigningKey(received);
    const ts = Math.floor(Date.now() / 1000);
    must(keyId === kid, "the received key's id");
    must(await verifyHint({ [kid]: pub }, { signature: await signHint(key, keyId, ts, "{}"), timestamp: String(ts) }, "{}", ts), "a hint signed with the received key does not verify with the printed public key");
  })();
});

await check("approval-signing-key.mjs: a child that fails stores nothing, and no public key is printed", () => {
  const script = new URL("../cf/scripts/approval-signing-key.mjs", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [script, "--dry-run", "--", process.execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(3))"], { encoding: "utf8" });
  must(r.status === 1 && r.stdout === "", `exit ${r.status}, stdout ${r.stdout}`);
  must(/not stored/.test(r.stderr), `stderr: ${r.stderr}`);
  const none = spawnSync(process.execPath, [script], { encoding: "utf8" });
  must(none.status === 2 && none.stdout === "", `no mode: exit ${none.status}, stdout ${none.stdout}`);
});

await check("deleted agent: its rows are kept as the record of who decided what, and neither list shows them", async () => {
  const w = await world();
  const op = await hold(w);
  must((await decide(w, op, "deny")).status === 200, "decide");
  // Still pending when the agent is deleted: a late publish could still move it forward.
  const open = await hold(w, "still pending");
  await w.D.alarm();
  must(indexRow(w, open)?.status === "pending", "control: the pending hold was not copied");
  const before = indexRow(w, op);
  must(before?.status === "denied" && before.agent_deleted_at === null && typeof JSON.parse(before.item).args?.summary === "string", `control: ${show(before)}`);
  // Control: both lists show it while the agent lives.
  must((await call(w, "GET", `agents/${A}/approvals`)).body.approvals.some((a: any) => a.operationId === op), "control: per-agent list");
  must((await call(w, "GET", "approvals")).body.approvals.some((a: any) => a.operationId === op), "control: provider list");
  const del = await call(w, "DELETE", `agents/${A}`);
  must(del.status === 200, `delete: ${del.status} ${del.text}`);
  const kept = indexRow(w, op);
  must(kept && kept.status === "denied" && kept.agent_deleted_at === Date.parse(del.body.deletedAt), `not kept, or not marked as of the delete: ${show(kept)}`);
  const item = JSON.parse(kept.item);
  must(item.operationId === op && item.providerAgentId === A && item.raftAgentId === RAFT_ID && item.tool === "put" && item.status === "denied"
    && show(item.decidedBy) === show({ via: "raft", ...OWNER }) && typeof item.decidedAt === "string" && typeof item.createdAt === "string",
    `the record does not say who decided what: ${kept.item}`);
  // The arguments' text goes; what the decision applied to and what came of it stay.
  must(!("args" in item) && "route" in item && "outcome" in item && typeof item.description === "string", `the record's fields: ${kept.item}`);
  // Hidden from both lists: the per-agent route is 404, the provider list leaves it out for every token that saw it.
  const own = await call(w, "GET", `agents/${A}/approvals`);
  must(own.status === 404, `per-agent list of a deleted agent: ${own.status} ${own.text}`);
  for (const auth of [w.token, w.platform]) {
    const all = await call(w, "GET", "approvals", { auth });
    must(all.status === 200 && all.body.approvals.every((a: any) => a.operationId !== op), `provider list shows a deleted agent's row: ${all.text}`);
  }
  // A repeated delete keeps the first mark. A publish after the delete (a hold that moved since) is written as the
  // record: marked as of the delete, without the arguments' text, and not listed; a new row likewise.
  must((await call(w, "DELETE", `agents/${A}`)).status === 200 && indexRow(w, op).agent_deleted_at === kept.agent_deleted_at, "a repeat moved the mark");
  const { d1ApprovalIndex } = await import("../cf/src/approvals.ts");
  const late = { tenantId: T, agentId: A, raftOrigin: ORIGIN, raftServerId: "srv-1", raftAgentId: RAFT_ID, createdAt: 1, expiresAt: null, updatedAt: Date.now() };
  await d1ApprovalIndex(w.DB).upsert({ ...late, operationId: "op_late", status: "pending",
    item: { operationId: "op_late", args: { summary: "late" }, route: { method: "POST", path: "/repos/o/r/pulls", repo: "o/r", body: "the body" } } as never });
  await d1ApprovalIndex(w.DB).upsert({ ...late, operationId: open, status: "denied", item: { ...item, operationId: open, status: "denied", args: { summary: "back" } } as never });
  const lateRow = indexRow(w, "op_late"), moved = indexRow(w, open);
  const lateItem = lateRow ? JSON.parse(lateRow.item) : null;
  must(lateRow?.agent_deleted_at === kept.agent_deleted_at && !("args" in lateItem) && !("body" in lateItem.route) && lateItem.route.repo === "o/r",
    `a new row after the delete: ${show(lateRow)}`);
  must(moved.status === "denied" && moved.agent_deleted_at === kept.agent_deleted_at && !moved.item.includes("back"), `a hold moved after the delete: ${show(moved)}`);
  const after = await call(w, "GET", "approvals");
  must(after.body.approvals.every((a: any) => a.operationId !== open && a.operationId !== "op_late"), `listed after the delete: ${after.text}`);
});

await check("deleted agent: a decision in flight as the delete completes reaches the kept row, with who decided, and no hint", async () => {
  const w = await world({ hints: true });
  const op = await hold(w);
  await w.D.alarm();
  must(indexRow(w, op)?.status === "pending", "control: not copied");
  // The decide request found the agent before the delete; its decision lands in the object after it.
  const del = await call(w, "DELETE", `agents/${A}`);
  must(del.status === 200 && indexRow(w, op)?.agent_deleted_at === Date.parse(del.body.deletedAt), `delete: ${del.status} ${show(indexRow(w, op))}`);
  outbound = [];
  const r = await w.D.provisionDecide(T, A, { raftAgentId: RAFT_ID, raftServerId: "srv-1" }, op, "approved", { via: "raft", ...OWNER } as never);
  must(r?.ok === true, `decide: ${show(r)}`);
  for (let i = 0; i < 20 && row(w, op)?.published_state !== row(w, op)?.state; i++) { await w.D.alarm(); await sleep(10); }
  const kept = indexRow(w, op);
  const item = JSON.parse(kept.item);
  // The copy follows the object, whatever it reached: approved, or run since.
  const state = row(w, op)?.state;
  must(["approved", "executed"].includes(state) && kept.status === state && item.status === state && show(item.decidedBy) === show({ via: "raft", ...OWNER }) && typeof item.decidedAt === "string",
    `the kept row did not follow the decision: ${show(kept)}`);
  must(kept.agent_deleted_at === Date.parse(del.body.deletedAt) && !("args" in item) && "outcome" in item && "route" in item, `the kept row's mark or fields: ${kept.item}`);
  must(hints().length === 0, `a hint went to Raft for a deleted agent: ${show(hints().map((h) => h.body))}`);
});

await check("deleted agent: deleted is final in the registry, and a marked row is not listed even if the registry said otherwise", async () => {
  const w = await world();
  const op = await hold(w);
  await w.D.alarm();
  must((await call(w, "DELETE", `agents/${A}`)).status === 200, "delete");
  const { d1ProvisionedAgents } = await import("../cf/src/control-plane.ts");
  // A push registration (or a credential PUT, or a create's replay) that read the row before the delete, writing after.
  const revived = await d1ProvisionedAgents(w.DB).update(T, RAFT_ID, { status: "active", pushRegistered: true, pushError: null });
  const reg = w.DB.raw.prepare("SELECT status, deleted_at, push_registered FROM provisioned_agents WHERE raft_agent_id = ?").get(RAFT_ID) as any;
  must(revived === false && reg.status === "deleted" && reg.deleted_at !== null && reg.push_registered === 0, `a deleted agent was revived: ${revived} ${show(reg)}`);
  // Control: a write that keeps it deleted still lands.
  must(await d1ProvisionedAgents(w.DB).update(T, RAFT_ID, { pushError: "x" }), "a write without a status was refused");
  // The index's own list, with no prune before it to mark anything: an unmarked row of a deleted agent is left out
  // by the registry alone.
  const { d1ApprovalIndex } = await import("../cf/src/approvals.ts");
  w.DB.raw.prepare("UPDATE provider_approvals SET agent_deleted_at = NULL WHERE operation_id = ?").run(op);
  const direct = await d1ApprovalIndex(w.DB).list({ raftOrigin: ORIGIN, tenantId: null }, { status: null, updatedSince: null, after: null, limit: 50 });
  must(direct.rows.every((r) => r.operationId !== op), `an unmarked row of a deleted agent was listed: ${show(direct.rows.map((r) => r.operationId))}`);
  w.DB.raw.prepare("UPDATE provider_approvals SET agent_deleted_at = ? WHERE operation_id = ?").run(Date.now(), op);
  // The second guard: were the registry to say active again, the kept row still is not listed.
  w.DB.raw.prepare("UPDATE provisioned_agents SET status = 'active' WHERE raft_agent_id = ?").run(RAFT_ID);
  const all = await call(w, "GET", "approvals");
  must(all.status === 200 && all.body.approvals.every((a: any) => a.operationId !== op) && typeof indexRow(w, op)?.agent_deleted_at === "number", `a marked row was listed, or is gone: ${all.text} ${show(indexRow(w, op))}`);
});

await check("deleted agent: a delete whose marking failed is finished by the repeat", async () => {
  const w = await world();
  const op = await hold(w);
  must((await decide(w, op, "deny")).status === 200, "decide");
  await w.D.alarm();
  const db = w.DB as any, prepare = db.prepare;
  db.prepare = (q: string) => { if (q.startsWith("UPDATE provider_approvals")) throw new Error("D1 is away"); return prepare(q); };
  const del = await call(w, "DELETE", `agents/${A}`);
  db.prepare = prepare;
  must(del.status === 200 && indexRow(w, op)?.agent_deleted_at === null, `control: the mark did not fail: ${show(indexRow(w, op))}`);
  must((await call(w, "DELETE", `agents/${A}`)).status === 200 && indexRow(w, op)?.agent_deleted_at === Date.parse(del.body.deletedAt), `the repeat did not mark it: ${show(indexRow(w, op))}`);
});

await check("deleted agent: a delete whose marking failed and was not repeated is marked by the next prune, kept past 30 days, and dropped a year after the delete", async () => {
  const w = await world();
  const op = await hold(w);
  must((await decide(w, op, "deny")).status === 200, "decide");
  await w.D.alarm();
  const db = w.DB as any, prepare = db.prepare;
  db.prepare = (q: string) => { if (q.startsWith("UPDATE provider_approvals")) throw new Error("D1 is away"); return prepare(q); };
  const del = await call(w, "DELETE", `agents/${A}`);
  db.prepare = prepare;
  must(del.status === 200 && indexRow(w, op)?.agent_deleted_at === null, `control: the mark did not fail: ${show(indexRow(w, op))}`);
  w.DB.raw.prepare("UPDATE provider_approvals SET updated_at = ? WHERE operation_id = ?").run(Date.now() - 31 * DAY, op);
  must((await call(w, "GET", "approvals")).status === 200, "list");
  const marked = indexRow(w, op);
  must(marked?.agent_deleted_at === Date.parse(del.body.deletedAt) && !("args" in JSON.parse(marked.item)), `the prune did not mark it, or dropped it as a live agent's: ${show(marked)}`);
  // Unmarked again, its delete over a year ago: the prune marks it as of then, and drops it.
  w.DB.raw.prepare("UPDATE provider_approvals SET agent_deleted_at = NULL WHERE operation_id = ?").run(op);
  w.DB.raw.prepare("UPDATE provisioned_agents SET deleted_at = ? WHERE raft_agent_id = ?").run(Date.now() - 366 * DAY, RAFT_ID);
  must((await call(w, "GET", "approvals")).status === 200 && !indexRow(w, op), `a deleted agent's unmarked row outlived the year: ${show(indexRow(w, op))}`);
});

await check("prune: a live agent's ended rows go 30 days after their last change; a deleted agent's rows a year after its delete", async () => {
  const w = await world();
  const { B } = await secondAgent(w);
  const now = Date.now();
  const put = (agent: string, op: string, status: string, updated: number) => w.DB.raw.prepare(
    "INSERT INTO provider_approvals(tenant_id, agent_id, operation_id, raft_origin, raft_server_id, raft_agent_id, status, item, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, 'srv-1', 'x', ?, '{}', 1, NULL, ?)")
    .run(T, agent, op, ORIGIN, status, updated);
  // The live agent B: an ended row past 30 days goes; a pending one as old, and an ended one of 29 days, stay.
  put(B, "op_live_old", "denied", now - 31 * DAY);
  put(B, "op_live_pending", "pending", now - 31 * DAY);
  put(B, "op_live_recent", "executed", now - 29 * DAY);
  // The deleted agent A: ended long ago, kept while its delete is under a year old, dropped past it.
  put(A, "op_audit_recent", "denied", now - 300 * DAY);
  put(A, "op_audit_old", "denied", now - 400 * DAY);
  must((await call(w, "DELETE", `agents/${A}`)).status === 200, "delete");
  w.DB.raw.prepare("UPDATE provider_approvals SET agent_deleted_at = ? WHERE operation_id = 'op_audit_old'").run(now - 366 * DAY);
  w.DB.raw.prepare("UPDATE provider_approvals SET agent_deleted_at = ? WHERE operation_id = 'op_audit_recent'").run(now - 364 * DAY);
  must((await call(w, "GET", "approvals")).status === 200, "list");
  const left = (w.DB.raw.prepare("SELECT operation_id FROM provider_approvals WHERE operation_id LIKE 'op_%' ORDER BY operation_id").all() as any[]).map((r) => r.operation_id);
  must(show(left) === show(["op_audit_recent", "op_live_pending", "op_live_recent"]), `left after the prune: ${show(left)}`);
});

await check("migration 0029: an existing copy gains the mark, an already-deleted agent's rows are marked as of its delete, and each prune has its index", async () => {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  const at = files.findIndex((n) => n.startsWith("0029_"));
  must(at > 0, "no migration 0029");
  for (const f of files.slice(0, at)) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const agent = (id: string, status: string, deletedAt: number | null) => db.prepare(
    "INSERT INTO provisioned_agents(tenant_id, raft_agent_id, agent_id, raft_server_id, raft_origin, name, instructions, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 'srv-1', ?, 'n', '', ?, 1, 2, ?)")
    .run(T, id, `raft_${id}`, ORIGIN, status, deletedAt);
  agent("LIVE", "active", null);
  agent("GONE", "deleted", 5000);
  const item = (op: string) => JSON.stringify({ operationId: op, tool: "put", status: "failed", decidedBy: { via: "raft", ...OWNER }, args: { summary: "secret" },
    outcome: { summary: "policy_denied" }, route: { method: "POST", path: "/repos/o/r/pulls", repo: "o/r", body: "secret body" }, description: "d" });
  for (const [id, op] of [["LIVE", "op_live"], ["GONE", "op_gone"]]) {
    db.prepare("INSERT INTO provider_approvals(tenant_id, agent_id, operation_id, raft_origin, raft_server_id, raft_agent_id, status, item, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, 'srv-1', ?, 'denied', ?, 1, NULL, 100)")
      .run(T, `raft_${id}`, op, ORIGIN, id!, item(op!));
  }
  for (const f of files.slice(at)) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const get = (op: string) => db.prepare("SELECT * FROM provider_approvals WHERE operation_id = ?").get(op) as any;
  const live = get("op_live"), gone = get("op_gone");
  must(live.agent_deleted_at === null && live.item === item("op_live"), `a live agent's row changed: ${show(live)}`);
  const g = JSON.parse(gone.item);
  must(gone.agent_deleted_at === 5000 && g.operationId === "op_gone" && show(g.decidedBy) === show({ via: "raft", ...OWNER }) && !("args" in g) && !("body" in g.route)
    && g.route.repo === "o/r" && g.route.path === "/repos/o/r/pulls" && g.outcome.summary === "policy_denied" && g.description === "d",
    `a deleted agent's row: ${show(gone)}`);
  // The prune's own statements, as it sends them, planned on the migrated table.
  const sent: string[] = [];
  const { d1ApprovalIndex } = await import("../cf/src/approvals.ts");
  await d1ApprovalIndex({ prepare: (q: string) => ({ q, bind: () => ({ q }) }), batch: async (s: Array<{ q: string }>) => { sent.push(...s.map((x) => x.q)); return []; } } as unknown as D1Database)
    .prune({ ended: 1, deleted: 1 });
  const plan = (q: string) => (db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...Array((q.match(/\?/g) ?? []).length).fill(1)) as any[]).map((r) => String(r.detail)).join("; ");
  const [mark, ended, audit] = sent.map(plan);
  must(sent.length === 3 && ended!.includes("USING INDEX provider_approvals_ended") && audit!.includes("USING INDEX provider_approvals_audit"),
    `the prunes do not use their indexes: ${ended} | ${audit}`);
  // The mark reads the registry's deleted agents and reaches their rows by key: never a scan of the copy.
  must(!/SCAN provider_approvals\b/.test(mark!) && /provider_approvals USING (?:PRIMARY KEY|INDEX)/.test(mark!), `the mark scans the copy: ${mark}`);
  // And the registry's deleted agents by their own index, never a scan of every agent.
  must(mark!.includes("provisioned_agents_deleted") && !/SCAN provisioned_agents(?! USING)/.test(mark!), `the mark scans the registry: ${mark}`);
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
  // An older table gains the delivery columns, empty ("not known"), and both stores apply one rule to them.
  for (const [name, st] of [["DO", store], ["sqlite", sq]] as const) {
    must((await st.getApproval("t", "op_old_pending"))?.delivery === null && (await st.getApproval("t", "op_old_pending"))?.handoff === null, `${name}: an old hold has a delivery`);
    const none = await st.recordApprovalDelivery("t", "op_old_pending", { outcome: "no_recipient", at: 5000 });
    must(none.ok && none.changed && show(none.record.delivery) === show({ outcome: "no_recipient", at: 5000 }), `${name} no_recipient: ${show(none)}`);
    const over = await st.recordApprovalDelivery("t", "op_old_pending", { outcome: "delivered", at: 6000 });
    must(over.ok && over.changed && over.record.delivery?.outcome === "delivered", `${name} delivered over no_recipient: ${show(over)}`);
    const kept = await st.recordApprovalDelivery("t", "op_old_pending", { outcome: "delivered", at: 7000 });
    must(kept.ok && !kept.changed && kept.record.delivery?.at === 6000, `${name} first-wins: ${show(kept)}`);
    const late = await st.recordApprovalDelivery("t", "op_old_denied", { outcome: "delivered", at: 2000 + 60_001 });
    must(!late.ok && late.reason === "late" && (await st.getApproval("t", "op_old_denied"))?.delivery === null, `${name} late: ${show(late)}`);
    must((await st.recordApprovalDelivery("t", "op_nope", { outcome: "delivered", at: 1 })).ok === false, `${name} unknown`);
  }
});

globalThis.fetch = realFetch;
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
