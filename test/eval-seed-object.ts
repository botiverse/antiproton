/**
 * An evaluation's setup routes through the Worker's own `fetch`, the real migrations on node:sqlite and the whole
 * `AgentDO` under node (the `cloudflare:workers` stand-in test/agents-api-model.ts uses), with a push arriving at an
 * inbound hook as in test/hook-fast-ack.ts: the seal that the first accepted push or turn makes, a file large enough
 * to be spilled read back with the hash it was seeded with, a fresh main conversation and what its first model call
 * was sent, the audit lines, and the routes being absent where EVAL_SEED_ROUTES is not "1".
 *
 * The rules of the routes themselves, over fake deps and the two stores, are test/eval-seed.ts's.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { d1ProviderTokens, d1ProvisionedAgents } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import { readTranscript } from "../cf/src/transcript-read.ts";
import { canonJson } from "../src/core/canon-json.ts";
import { seedSnapshot, sha256Hex } from "../src/store/seed-files.ts";
import { ensureClientCalls } from "../src/runtime/client-calls.ts";
import { callQueuedModel } from "../cf/src/model-request.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { AgentRuntime } = await import("../cf/src/runtime.ts");
const { clearHookRoutes } = await import("../cf/src/hook-route.ts");
const { setLogSink } = await import("../src/core/log.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const T = "t-raft", A = "raft_01JEVAL", OTHER_T = "t-other", AUTOMATION = "operator-token";
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const lines: string[] = [];
setLogSink((line) => { lines.push(line); });

/** What `pushy`'s one tool answers: `{}`, or what a case that needs a particular tool result sets. */
let pushyAnswer: Record<string, unknown> = {};
/** A push plugin as in test/hook-fast-ack.ts, minus the HMAC: the hook's secret in a header, `{id, text}` as the body. */
const pushy: Plugin = {
  id: "pushy", version: "1.0.0",
  tools: [{ name: "noop", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { return pushyAnswer as never; },
  async receive(event, secret) {
    if (event.headers["x-signed-with"] !== secret) return { deliver: false, reason: "bad signature", rejected: true };
    const body = JSON.parse(new TextDecoder().decode(event.body)) as { id: string; text: string };
    return { deliver: true, text: body.text, dedupeKey: body.id };
  },
};

/** A plugin whose one tool asks the model a question before acting: what `resume` exists to answer. */
const asker: Plugin = {
  id: "asker", version: "1.0.0",
  tools: [{ name: "ask", summary: "asks first", parameters: {}, sideEffects: "write", idempotency: "native" }],
  async invoke() { return {}; },
  interrupts: { async resume() { return { done: true }; } },
};
/** Why `asker` cannot run on this deployment, or null: what a plugin's `unavailable()` says, set by the case that needs it. */
let askerOffline: string | null = null;
asker.unavailable = () => askerOffline;

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

/** The artifacts bucket, kept: what a spill writes is what a read finds. */
function bucket() {
  const objects = new Map<string, Uint8Array>();
  const view = (key: string, bytes: Uint8Array) => ({
    key, size: bytes.byteLength, uploaded: new Date(1), httpMetadata: {},
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  return {
    objects,
    put: async (key: string, body: Uint8Array | string) => { objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body)); return {}; },
    get: async (key: string) => (objects.has(key) ? view(key, objects.get(key)!) : null),
    head: async (key: string) => (objects.has(key) ? view(key, objects.get(key)!) : null),
    list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false }),
  };
}

/**
 * One provisioned agent of tenant T in its object, the Worker in front of it, a hook on its `pushy` mount and a
 * `state` mount (with `raft`, the mounts Raft's adopt makes instead, beside the same two), and two provider tokens: T's and another tenant's. `flag` is EVAL_SEED_ROUTES as the deployment sets it,
 * null for not at all.
 */
async function world(flag: string | null = "1", opts: { raft?: boolean; post?: Record<string, unknown>; none?: true } = {}) {
  clearHookRoutes();
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
  class TestDO extends AgentDO { protected override extraPlugins() { return [pushy, asker]; } }
  const objects = new Map<string, InstanceType<typeof TestDO>>();
  const another = (n: string) => {
    const host = sqliteHost();
    const o = new TestDO({ ...ctx, storage: { ...ctx.storage, sql: host.sql, transactionSync: host.transactionSync }, id: { toString: () => n } } as never, env as never);
    objects.set(n, o);
    return o;
  };
  const R2 = bucket();
  const env: Record<string, unknown> = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: R2, ARTIFACT_BUCKET: "b", CONTROL_DB: DB, HARNESS_MODEL: "m1",
    DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", AUTOMATION_TOKEN: AUTOMATION,
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    ...(flag === null ? {} : { EVAL_SEED_ROUTES: flag }),
    // Any other object (the provider's home, which a POST lists the agent under) is made when first asked for.
    AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? another(n) },
  };
  const D = new TestDO(ctx as never, env as never);
  objects.set(agentObjectName(T, A), D);
  const token = newProviderToken(), other = newProviderToken();
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(token), label: "raft-test", raftOrigin: "https://raft.example", scope: "tenant", tenantId: T });
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(other), label: "raft-other", raftOrigin: "https://raft.example", scope: "tenant", tenantId: OTHER_T });
  const made0 = { D, rt: D.runtime(), raw, DB, R2, env, jobs, token, other, tokenHash: await hashProviderToken(token), alarmAt: () => alarmAt };
  // Made by Raft's own call (`POST /provision/agents`), with Raft stood in for: nothing else is added, so the agent has
  // exactly what that request gave it. The answer is kept for the cases that read it.
  if (opts.none) { await made0.rt.ready(); return { ...made0, hook: { hookId: "", secret: "" }, posted: null }; }
  if (opts.post) {
    const posted = await provisionPost(made0, opts.post);
    must(posted.status === 201, `POST /provision/agents: ${posted.status} ${posted.text}`);
    await made0.rt.ready();
    return { ...made0, hook: { hookId: "", secret: "" }, posted };
  }
  // A Raft-provisioned agent is made the way Raft makes one (`provisionAdopt`: the default mounts, then a raft mount).
  if (opts.raft) {
    const adopted = await D.provisionAdopt(T, A, JSON.stringify({ name: "n", instructions: "be brief", raftOrigin: "https://raft.example" }));
    must(adopted.ok, `adopt: ${JSON.stringify(adopted)}`);
  } else await D.uiAdoptAgent(T, A, { name: "n", description: "d", avatar: "x" });
  const rt = D.runtime();
  await rt.ready();
  await rt.bindOperatorModel(T, A);
  await rt.store.setPluginChoice(T, A, "pushy", "enable");
  await rt.store.markSeedsChosen(T, A);
  // Adopt has made `state` already.
  for (const [alias, plugin] of opts.raft ? [["p", "pushy"]] as const : [["p", "pushy"], ["state", "state"]] as const) {
    await rt.store.addMount({ tenantId: T, agentId: A, alias, plugin, installationId: `i-${alias}`, connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  }
  const made = await (await worker.fetch(new Request("https://x/admin/hooks", {
    method: "POST", headers: { "x-harness-token": AUTOMATION, "content-type": "application/json" },
    body: JSON.stringify({ tenantId: T, agentId: A, alias: "p" }),
  }), env as never)).json() as { hookId: string; secret: string };
  must(made.hookId && made.secret, `hook: ${show(made)}`);
  await d1ProvisionedAgents(DB).create({ tenantId: T, raftAgentId: "01JEVAL", agentId: A, raftServerId: "srv-1", raftOrigin: "https://raft.example",
    name: "n", instructions: "", credentialHash: null, status: "active", pushRegistered: true, pushError: null });
  return { ...made0, rt, hook: made, posted: null };
}
type World = Awaited<ReturnType<typeof world>>;
/** The deployment and its tokens, and no agent yet: a POST's refusal can be seen to make nothing. */
const bareWorld = (flag: string | null) => world(flag, { none: true });

const RAFT_CRED = "sk_agent_" + "R".repeat(32);
/**
 * `POST /provision/agents` as Raft sends it, for this world's agent (`raftAgentId` 01JEVAL is A), with Raft stood in
 * for by a fetch that answers the credential's identity check (test/provision-runtime.ts) and refuses everything else.
 */
async function provisionPost(w: Pick<World, "env" | "token">, extra: Record<string, unknown>, auth?: string) {
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
      method: "POST", headers: { authorization: `Bearer ${auth ?? w.token}`, "content-type": "application/json" },
      body: JSON.stringify({ raftAgentId: "01JEVAL", raftServerId: "srv-1", raftOrigin: "https://raft.example", name: "n", instructions: "", credential: RAFT_CRED, ...extra }),
    }), w.env as never);
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, text };
  } finally { globalThis.fetch = real; }
}

/** A provider route, as Raft calls it. `auth` null sends no credential. */
async function call(w: World, method: string, path: string, opts: { body?: BodyInit; auth?: string | null } = {}) {
  const auth = opts.auth === undefined ? w.token : opts.auth;
  const res = await worker.fetch(new Request(`https://x/provision/agents/${path}`, {
    method, headers: auth === null ? {} : { authorization: `Bearer ${auth}` }, ...(opts.body === undefined ? {} : { body: opts.body }),
  }), w.env as never);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}
const seed = (w: World, path: string, text: string | Uint8Array, mode = "writable", auth?: string | null) =>
  call(w, "PUT", `${A}/seed?path=${encodeURIComponent(path)}&mode=${mode}`, { body: text, auth });

async function push(w: World, id: string, text: string) {
  const res = await worker.fetch(new Request(`https://x/hooks/${w.hook.hookId}`, {
    method: "POST", headers: { "x-signed-with": w.hook.secret, "content-type": "application/json" }, body: JSON.stringify({ id, text }),
  }), w.env as never);
  return { status: res.status, body: await res.text() };
}

/** Alarm passes until the model has been asked `n` things, or the object has nothing due soon (test/hook-fast-ack.ts). */
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
const asked = async (w: World, i: number) => show(await w.D.takeJob(T, A, w.jobs[i]!));
async function answer(w: World, i: number, text: string) {
  const job = JSON.parse(await asked(w, i)) as { model?: { api?: string; provider?: string } };
  await w.D.deliverAnswer(T, A, w.jobs[i]!, { role: "assistant", content: [{ type: "text", text }], api: job.model?.api ?? "x",
    provider: job.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0 } as never, 5);
}
/** A function, not `w.jobs.length`: an assertion would narrow the property to one literal for the rest of a case. */
const jobCount = (w: World) => w.jobs.length;
const engineIdle = async (w: World) => !(await (await w.rt.agent(T, A)).running());

// ---- the gate --------------------------------------------------------------

await check("without EVAL_SEED_ROUTES = \"1\" every setup route is 404 as an unknown route is, and nothing is written", async () => {
  for (const flag of [null, "0", "true", " 1"]) {
    const w = await world(flag);
    for (const [method, path, body] of [["PUT", `${A}/seed?path=MEMORY.md`, "x"], ["POST", `${A}/seed/seal`, undefined],
      ["GET", `${A}/seed/manifest`, undefined], ["POST", `${A}/fresh-context`, undefined], ["POST", `${A}/restart`, undefined], ["GET", `${A}/model-input`, undefined], ["GET", `${A}/tools`, undefined],
      ["GET", `${A}/transcript`, undefined], ["GET", `${A}/trace`, undefined]] as const) {
      const r = await call(w, method, path, { ...(body === undefined ? {} : { body }) });
      must(r.status === 404 && r.body?.error?.code === "not_found" && /raft-agent-provider\.v1/.test(r.body.error.message), `${flag} ${method} ${path}: ${r.status} ${r.text}`);
    }
    must((await w.rt.store.listSeedFiles(T, A)).length === 0 && !(await w.rt.store.isSealed(T, A)), `${flag}: something was written`);
  }
});

await check("with the flag the routes answer: no credential is 401, another tenant's token is 404, this tenant's token reaches the agent", async () => {
  const w = await world();
  const none = await seed(w, "MEMORY.md", "hello", "writable", null);
  must(none.status === 401, `no credential: ${none.status} ${none.text}`);
  const wrong = await seed(w, "MEMORY.md", "hello", "writable", "pt-" + "x".repeat(43));
  must(wrong.status === 401, `an unissued token: ${wrong.status} ${wrong.text}`);
  const other = await seed(w, "MEMORY.md", "hello", "writable", w.other);
  must(other.status === 404 && other.body?.error?.code === "not_found", `another tenant's token: ${other.status} ${other.text}`);
  const elsewhere = await call(w, "PUT", `raft_nobody/seed?path=MEMORY.md`, { body: "hello" });
  must(elsewhere.status === 404, `another agent: ${elsewhere.status} ${elsewhere.text}`);
  must((await w.rt.store.listSeedFiles(T, A)).length === 0, "a refused request wrote");
  const ok = await seed(w, "MEMORY.md", "hello");
  must(ok.status === 200 && ok.body.path === "MEMORY.md" && ok.body.sha256 === sha256Hex("hello") && ok.body.bytes === 5, `${ok.status} ${ok.text}`);
  const byRaft = await call(w, "GET", "by-raft-agent/01JEVAL/seed/manifest");
  must(byRaft.status === 200 && byRaft.body.manifest.length === 1 && byRaft.body.sealed === false, `by Raft id: ${byRaft.text}`);
});

const tableNames = (sql: { exec(q: string): { toArray(): any[] } }) =>
  sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((r) => String(r.name));

await check("without the flag a real turn records no model input: no evidence table is made; with it, the same turn writes its row", async () => {
  for (const flag of [null, "1"] as const) {
    const w = await world(flag);
    await w.rt.postMessage(T, A, "a real turn", "prompt");
    await settle(w, 1);
    must(jobCount(w) === 1 && (await asked(w, 0)).includes("a real turn"), `${flag}: the turn did not reach the model: ${jobCount(w)} jobs`);
    const has = tableNames(w.raw.sql as never).includes("model_input_digests");
    if (flag === null) must(!has, "production made the model_input_digests table");
    else must(has && w.raw.sql.exec("SELECT COUNT(*) AS n FROM model_input_digests").toArray()[0]!.n === 1, "the flagged object recorded nothing");
  }
});

await check("a seed write to an object that is no agent's is not_found and makes no table", async () => {
  const raw = sqliteHost();
  const ctx = {
    storage: { sql: raw.sql, transactionSync: raw.transactionSync, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => "do-unclaimed" }, getWebSockets: () => [], exports: {},
  };
  const D = new AgentDO(ctx as never, (await world()).env as never);
  const before = tableNames(raw.sql as never);
  const r = await D.seedWrite(T, A, "MEMORY.md", "writable", "hello");
  must(!r.ok && r.code === "not_found", show(r));
  const after = tableNames(raw.sql as never);
  must(show(after) === show(before), `tables made: ${after.filter((t) => !before.includes(t))}`);
});

await check("the transcript id \"main\" is not the console's main conversation while it is the current one", async () => {
  const w = await world();
  const MARK = "MAIN-ALIAS-MARKER-0e9d";
  await w.rt.postMessage(T, A, MARK, "prompt");
  must(show(readTranscript(w.raw.sql as never, T, A, `t_${A}`)).includes(MARK), "the console's id does not read the main conversation");
  must(readTranscript(w.raw.sql as never, T, A, "main") === null, "\"main\" read the current main conversation");
});

// ---- the seal --------------------------------------------------------------

await check("the first accepted push seals in the step that queues it: a write while that push waits to be posted is 409, and so is one while its turn runs", async () => {
  const w = await world();
  must((await seed(w, "MEMORY.md", "before")).status === 200, "the write before any push");
  const p = await push(w, "n1", "hello there");
  must(p.status === 202 && p.body === '{"outcome":"delivered"}', `push: ${show(p)}`);
  must(jobCount(w) === 0 && await engineIdle(w), "a turn started before the alarm");
  const queued = await seed(w, "MEMORY.md", "after the push");
  must(queued.status === 409 && queued.body.error.code === "sealed", `while queued: ${queued.status} ${queued.text}`);
  const man = await call(w, "GET", `${A}/seed/manifest`);
  must(man.body.sealed === true && man.body.how === "first-inbound" && man.body.manifest[0].sha256 === sha256Hex("before"), `manifest: ${man.text}`);
  await settle(w, 1);
  must(jobCount(w) === 1 && !(await engineIdle(w)), `the turn is not running: ${jobCount(w)} jobs`);
  const running = await seed(w, "notes/new.md", "while running");
  must(running.status === 409 && running.body.error.code === "sealed", `while running: ${running.status} ${running.text}`);
  const after = await call(w, "GET", `${A}/seed/manifest`);
  must(show(after.body) === show(man.body), `the manifest moved: ${after.text}`);
  const state = await w.rt.store.getState(T, A, "MEMORY.md");
  must(state?.value === "before", `the working copy: ${show(state)}`);
});

await check("a rejected push seals nothing; the first turn by another route seals as first-turn", async () => {
  const w = await world();
  const bad = await worker.fetch(new Request(`https://x/hooks/${w.hook.hookId}`, {
    method: "POST", headers: { "x-signed-with": "wrong", "content-type": "application/json" }, body: JSON.stringify({ id: "n1", text: "x" }),
  }), w.env as never);
  must(bad.status === 401, `the unsigned push: ${bad.status}`);
  must(!(await w.rt.store.isSealed(T, A)), "a rejected push sealed");
  must((await seed(w, "a.md", "one")).status === 200, "a write after a rejected push");
  await w.rt.postMessage(T, A, "start", "prompt");
  const late = await seed(w, "a.md", "two");
  must(late.status === 409, `after the first turn: ${late.status} ${late.text}`);
  const m = await call(w, "GET", `${A}/seed/manifest`);
  must(m.body.how === "first-turn" && m.body.manifest.length === 1, m.text);
});

await check("an agent that ran before seals existed is sealed by the first write that finds it, as prior-activity, by a turn or by an accepted push", async () => {
  for (const how of ["turn", "push"] as const) {
    const w = await world();
    if (how === "turn") { await w.rt.postMessage(T, A, "before seals", "prompt"); await settle(w, 1); }
    else must((await push(w, "old-1", "before seals")).status === 202, "push");
    // What an agent that ran before this deploy looks like: the activity, and no seal row.
    w.raw.sql.exec("DELETE FROM seed_seal");
    must(!(await w.rt.store.isSealed(T, A)), `${how}: still sealed`);
    const r = await seed(w, "MEMORY.md", "over its own state");
    must(r.status === 409 && r.body.error.code === "sealed", `${how}: ${r.status} ${r.text}`);
    const m = await call(w, "GET", `${A}/seed/manifest`);
    must(m.body.sealed === true && m.body.how === "prior-activity" && m.body.manifest.length === 0, `${how}: ${m.text}`);
    must((await w.rt.store.getState(T, A, "MEMORY.md")) === null, `${how}: the working copy was written`);
  }
});

await check("POST seal is idempotent and answers the manifest it closed on, with its hash", async () => {
  const w = await world();
  must((await seed(w, "notes/b.md", "bee", "readonly")).status === 200 && (await seed(w, "MEMORY.md", "mem")).status === 200, "seeding");
  const first = await call(w, "POST", `${A}/seed/seal`);
  must(first.status === 200 && first.body.how === "explicit", first.text);
  must(show(first.body.manifest.map((f: any) => f.path)) === show(["MEMORY.md", "notes/b.md"]), `order: ${first.text}`);
  must(first.body.manifestSha256 === sha256Hex(canonJson(first.body.manifest)), "the hash is not of the canonical manifest");
  const again = await call(w, "POST", `${A}/seed/seal`);
  must(show(again.body) === show(first.body), `second seal: ${again.text}`);
  must((await seed(w, "MEMORY.md", "changed")).status === 409, "a write after the seal");
});

// ---- spill -----------------------------------------------------------------

await check("a file over 32 KiB is spilled, both copies, and reads back through workspace-files/read with the sha256 it was seeded with", async () => {
  const w = await world();
  const text = "é🙂 line of seeded text\n".repeat(2000);
  const put = await seed(w, "notes/big.md", text);
  must(put.status === 200 && put.body.bytes === new TextEncoder().encode(text).byteLength, put.text);
  const row = await w.rt.store.getState(T, A, "notes/big.md");
  must(row?.ref && row.value === null, `the working copy is not spilled: ${show(row)?.slice(0, 200)}`);
  must([...w.R2.objects.keys()].some((k) => k === `t/${T}/${A}/seed/${put.body.sha256}.txt`), `no snapshot object: ${[...w.R2.objects.keys()]}`);
  const read = await call(w, "GET", `${A}/workspace-files/read?path=${encodeURIComponent("state/notes/big.md")}`);
  must(read.status === 200 && read.body.content === text && read.body.sha256 === put.body.sha256, `read: ${read.status} sha ${read.body?.sha256} vs ${put.body.sha256}`);
  const snapshot = w.R2.objects.get(`t/${T}/${A}/seed/${put.body.sha256}.txt`)!;
  must(sha256Hex(snapshot) === put.body.sha256, "the snapshot object's bytes do not hash to the seeded sha256");
  const small = await seed(w, "notes/small.md", "small");
  const smallRead = await call(w, "GET", `${A}/workspace-files/read?path=state/notes/small.md`);
  must(smallRead.body.sha256 === small.body.sha256 && smallRead.body.content === "small", smallRead.text);
});

await check("a large file sent inline as a repeat that stopped being one is spilled: no row keeps more than 32 KiB", async () => {
  const w = await world();
  const X = "x".repeat(40_000), Y = "y".repeat(40_000);
  must((await seed(w, "notes/big.md", X)).status === 200, "X");
  const xMeta = (await w.rt.store.listSeedFiles(T, A))[0]!;
  must((await seed(w, "notes/big.md", Y)).status === 200, "Y");
  // The runtime's look at the files, taken before Y landed: X again reads as a repeat.
  const store = w.rt.store as unknown as { listSeedFiles: (t: string, a: string) => Promise<unknown[]> };
  const real = store.listSeedFiles;
  store.listSeedFiles = async () => [xMeta];
  let r;
  try { r = await seed(w, "notes/big.md", X); } finally { store.listSeedFiles = real; }
  must(r.status === 200 && r.body.changed === true && r.body.sha256 === sha256Hex(X), `${r.status} ${r.text}`);
  const snap = seedSnapshot(w.raw.sql as never, T, A, "notes/big.md")!;
  must(snap.content === null && snap.ref && snap.sha256 === sha256Hex(X), `the snapshot is inline: ${snap.content?.length} chars`);
  const working = await w.rt.store.getState(T, A, "notes/big.md");
  must(working?.value === null && working.ref, `the working copy is inline: ${show(working)?.length} chars`);
  const read = await call(w, "GET", `${A}/workspace-files/read?path=${encodeURIComponent("state/notes/big.md")}`);
  must(read.body.content === X, "the spilled working copy does not read back as X");
});

// ---- fresh context ---------------------------------------------------------

await check("fresh-context: the new conversation's first model call carries no old message, no summary, the working copy written meanwhile, and the old transcript stays readable", async () => {
  const w = await world();
  const OLD = "OLD-ONLY-MARKER-7f3a", REPLY = "OLD-REPLY-MARKER-91c2", POSITIVE = "REFUSED-OBJECTIVE-MARKER-5d0e", NEW = "NEW-QUESTION-MARKER-c4b1";
  must((await seed(w, "notes/objectives.md", "objective one")).status === 200, "seed");
  await w.rt.postMessage(T, A, OLD, "prompt");
  await settle(w, 1);
  must(jobCount(w) === 1 && (await asked(w, 0)).includes(OLD), "the old conversation's first call");
  await answer(w, 0, REPLY);
  for (let i = 0; i < 5 && !(await engineIdle(w)); i++) await w.D.alarm();
  must(await engineIdle(w), "the old turn did not end");
  // What the agent would write with `remember` during the old conversation: a working copy, which survives.
  await w.rt.store.putState(T, A, "memory", { value: `objective refused: ${POSITIVE}`, ref: null, bytes: 40 });
  const fresh = await call(w, "POST", `${A}/fresh-context`);
  must(fresh.status === 200 && fresh.body.oldSessionId === "main" && fresh.body.newSessionId === "main.1", fresh.text);
  await w.rt.postMessage(T, A, NEW, "prompt");
  await settle(w, 2);
  must(jobCount(w) === 2, `jobs: ${jobCount(w)}`);
  const sent = await asked(w, 1);
  // Negative control: the marker only the old conversation held.
  must(!sent.includes(OLD) && !sent.includes(REPLY), "the old conversation reached the new call");
  must(sent.includes(NEW), "the new message is not in the new call");
  // Positive control: what was written to a working copy is in it, by the working set.
  must(sent.includes(POSITIVE), "the working copy written before the fresh context is not in the new call");
  const ev = await call(w, "GET", `${A}/model-input?session=main.1&call=1`);
  must(ev.status === 200 && ev.body.sessionId === "main.1" && ev.body.call === 1, ev.text);
  must(ev.body.summaryBlock === false, "a summary block");
  must(ev.body.messages.length === 1 && ev.body.messages[0].role === "user" && ev.body.messages[0].sourceSessionId === "main.1", `messages: ${show(ev.body.messages)}`);
  must(ev.body.messages.every((m: any) => m.sourceSessionId !== "main"), "an old message is referenced");
  must(ev.body.workingSetKeys.includes("memory"), `working set: ${show(ev.body.workingSetKeys)}`);
  must(!ev.text.includes(NEW) && !ev.text.includes(POSITIVE), "the evidence carries text");
  const old = await call(w, "GET", `${A}/model-input?session=main&call=1`);
  must(old.status === 200 && old.body.messages.some((m: any) => m.sourceSessionId === "main" && m.messageId), `the old call's sources: ${old.text}`);
  const oldShas = new Set(old.body.messages.map((m: any) => m.sha256));
  must(ev.body.messages.every((m: any) => !oldShas.has(m.sha256)), "a message of the old call is in the new one");
  // The old transcript, read where the console's transcript reads read it.
  const transcript = show(readTranscript(w.raw.sql as never, T, A, "main"));
  must(transcript.includes(OLD) && transcript.includes(REPLY), "the old transcript is not readable under its id");
  must(!show(readTranscript(w.raw.sql as never, T, A, "main.1")).includes(OLD), "the new transcript holds the old message");
  must(show(readTranscript(w.raw.sql as never, T, A, `t_${A}`)).includes(NEW), "the console's main conversation is not the new one");
  // Untouched: the seeded file and its working copy.
  must((await w.rt.store.getState(T, A, "notes/objectives.md"))?.value === "objective one", "the working copy moved");
  must((await w.rt.store.listSeedFiles(T, A)).length === 1, "the seeded files moved");
  const list = await call(w, "GET", `${A}/model-input`);
  must(list.body.current === "main.1" && show(list.body.sessions.map((s: any) => [s.sessionId, s.current, s.calls])) === show([["main", false, 1], ["main.1", true, 1]]), list.text);
});

await check("fresh-context is refused while a turn is out, and a second one after it starts main.2", async () => {
  const w = await world();
  await w.rt.postMessage(T, A, "hello", "prompt");
  await settle(w, 1);
  const busy = await call(w, "POST", `${A}/fresh-context`);
  must(busy.status === 409 && busy.body.error.code === "busy", `while out: ${busy.status} ${busy.text}`);
  await answer(w, 0, "hi");
  for (let i = 0; i < 5 && !(await engineIdle(w)); i++) await w.D.alarm();
  must((await call(w, "POST", `${A}/fresh-context`)).body.newSessionId === "main.1", "first");
  const second = await call(w, "POST", `${A}/fresh-context`);
  must(second.status === 200 && second.body.oldSessionId === "main.1" && second.body.newSessionId === "main.2", second.text);
  must(show(readTranscript(w.raw.sql as never, T, A, "main")).includes("hello"), "the first conversation is gone");
});

await check("fresh-context and restart are 409 while a push is queued, and while a delivery pass is handing one over", async () => {
  const w = await world();
  must((await push(w, "q1", "queued push")).status === 202, "push");
  must(jobCount(w) === 0 && await engineIdle(w), "the push was delivered before the alarm");
  for (const route of ["fresh-context", "restart"]) {
    const r = await call(w, "POST", `${A}/${route}`);
    must(r.status === 409 && r.body.error.code === "busy" && /push is queued/.test(r.body.error.message), `${route} while queued: ${r.status} ${r.text}`);
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pass = w.rt.deliverPendingInbound(T, A, { beforeFirstPost: () => gate });
  await sleep(20);
  for (const route of ["fresh-context", "restart"]) {
    const r = await call(w, "POST", `${A}/${route}`);
    must(r.status === 409 && /push is being delivered/.test(r.body.error.message), `${route} during delivery: ${r.status} ${r.text}`);
  }
  release();
  const out = await pass;
  must(out.posted === 1, `the pass: ${show(out)}`);
  must(readTranscript(w.raw.sql as never, T, A, "main") === null && show(readTranscript(w.raw.sql as never, T, A, `t_${A}`)).includes("queued push"),
    "the push did not land in the main conversation it was queued for");
});

await check("fresh-context and restart are 409 while a function call waits for the Agents API caller", async () => {
  const w = await world();
  ensureClientCalls(w.raw.sql as never);
  w.raw.sql.exec("INSERT INTO api_client_calls(session, call_id, name, arguments, state, created_at) VALUES ('s1', 'c1', 'lookup', '{}', 'pending', 1)");
  for (const route of ["fresh-context", "restart"]) {
    const r = await call(w, "POST", `${A}/${route}`);
    must(r.status === 409 && /1 function call\(s\) wait for the Agents API caller/.test(r.body.error.message), `${route}: ${r.status} ${r.text}`);
  }
  w.raw.sql.exec("UPDATE api_client_calls SET state = 'done'");
  must((await call(w, "POST", `${A}/fresh-context`)).status === 200, "after the call was answered");
});

await check("restart keeps the conversation: the next call after it carries the earlier messages, from the same session; a fresh context after it does not", async () => {
  const w = await world();
  const OLD = "BEFORE-RESTART-MARKER-2b8e";
  await w.rt.postMessage(T, A, OLD, "prompt");
  await settle(w, 1);
  const busy = await call(w, "POST", `${A}/restart`);
  must(busy.status === 409 && busy.body.error.code === "busy", `while out: ${busy.status} ${busy.text}`);
  await answer(w, 0, "noted");
  for (let i = 0; i < 5 && !(await engineIdle(w)); i++) await w.D.alarm();
  const before = w.D.runtime();
  const r = await call(w, "POST", `${A}/restart`);
  must(r.status === 200 && r.body.sessionId === "main" && typeof r.body.restartedAt === "string", r.text);
  must(w.D.runtime() !== before, "the runtime in memory was kept");
  w.rt = w.D.runtime();
  await w.rt.postMessage(T, A, "after the restart", "prompt");
  await settle(w, 2);
  must(jobCount(w) === 2, `jobs: ${jobCount(w)}`);
  // Positive: the conversation carried on.
  must((await asked(w, 1)).includes(OLD), "the message before the restart is not in the next call");
  const ev = await call(w, "GET", `${A}/model-input?session=main&call=2`);
  must(ev.status === 200 && ev.body.messages.filter((m: any) => m.sourceSessionId === "main").length >= 3, `sources: ${ev.text}`);
  await answer(w, 1, "ok");
  for (let i = 0; i < 5 && !(await engineIdle(w)); i++) await w.D.alarm();
  must((await call(w, "POST", `${A}/fresh-context`)).status === 200, "fresh context");
  await w.rt.postMessage(T, A, "after the fresh context", "prompt");
  await settle(w, 3);
  must(jobCount(w) === 3 && !(await asked(w, 2)).includes(OLD), "the fresh context kept the conversation");
});

// ---- the tool export -------------------------------------------------------

/** Every table's every row, so "nothing was written" is a comparison rather than a list of places someone thought of. */
function everything(sql: { exec(q: string): { toArray(): any[] } }): string {
  const out: Record<string, unknown[]> = {};
  for (const t of tableNames(sql)) out[t] = sql.exec(`SELECT * FROM "${t}"`).toArray().map((r) => ({ ...r }));
  return show(out);
}

/** The tools the model request for job `i` sends, as they leave for the provider: the real consumer with `fetch` replaced. */
async function wireTools(w: World, i: number): Promise<Array<{ name: string; description: string; parameters: unknown }>> {
  const job = JSON.parse(await asked(w, i));
  const real = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await callQueuedModel(w.env as never, job, w.jobs[i]!); } finally { globalThis.fetch = real; }
  must(bodies.length === 1, `requests: ${bodies.length}`);
  return (JSON.parse(bodies[0]!).tools ?? []).map((t: any) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
}
const shape = (tools: Array<{ name: string; description: string; parameters: unknown }>) =>
  tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

/**
 * The raft mount's list as a credential that holds two capabilities' worth would leave it: a snapshot under this build's
 * basis, so a turn's start does not re-take it, naming two generated tools and skipping a third with a reason.
 */
async function raftSnapshot(w: World, basis?: string) {
  const raft = w.rt.plugins().find((p) => p.id === "raft")!;
  const own = new Set(raft.mountTools!({ toolSnapshot: { hash: "h", tools: [], skipped: [], takenAt: 0 } } as never).map((t) => t.name));
  const generated = raft.tools.filter((t) => !own.has(t.name)).map((t) => t.name);
  must(generated.length >= 3, `generated raft tools: ${generated.length}`);
  await w.rt.store.updateMountToolSnapshot(T, A, "raft", {
    hash: "snap-1", takenAt: 1_800_000_000_000, basis: basis ?? raft.toolsBasis,
    tools: generated.slice(0, 2).map((name) => ({ name, summary: "", parameters: {}, sideEffects: "read", idempotency: "native" })),
    skipped: [{ name: generated[2]!, reason: "the credential lacks the capability it needs" }],
  } as never);
  return { kept: generated.slice(0, 2), skipped: generated[2]!, basis: raft.toolsBasis! };
}

await check("tools: another tenant's token and an unknown agent are 404, no token is 401, this tenant's token answers", async () => {
  const w = await world();
  const other = await call(w, "GET", `${A}/tools`, { auth: w.other });
  must(other.status === 404 && other.body?.error?.code === "not_found", `another tenant: ${other.status} ${other.text}`);
  must(!other.text.includes('"tools"'), "another tenant's answer carries a tool list");
  must((await call(w, "GET", `raft_nobody/tools`)).status === 404, "an unknown agent");
  must((await call(w, "GET", `${A}/tools`, { auth: null })).status === 401, "no credential");
  must((await call(w, "POST", `${A}/tools`)).status !== 200, "POST is not the route");
  const ok = await call(w, "GET", `${A}/tools`);
  must(ok.status === 200 && ok.body.agentId === A && Array.isArray(ok.body.tools) && ok.body.tools.length > 0, `control: ${ok.status} ${ok.text.slice(0, 300)}`);
});

await check("tools: a Raft-provisioned agent's export is exactly what its next turn's model request carries, state and raft tools included, in order", async () => {
  const w = await world("1", { raft: true });
  const snap = await raftSnapshot(w);
  const before = await call(w, "GET", `by-raft-agent/01JEVAL/tools`);
  must(before.status === 200, `${before.status} ${before.text.slice(0, 300)}`);
  const ex = before.body;
  must(typeof ex.asOf === "string" && !Number.isNaN(Date.parse(ex.asOf)) && ex.retakePending === false, `asOf/retake: ${show({ asOf: ex.asOf, retakePending: ex.retakePending })}`);
  await w.rt.postMessage(T, A, "a real turn", "prompt");
  await settle(w, 1);
  must(jobCount(w) === 1, `jobs: ${jobCount(w)}`);
  const wire = await wireTools(w, 0);
  must(wire.length > 0, "the model request carries no tools");
  must(show(shape(ex.tools)) === show(wire),
    `export and request differ:\n export  ${show(ex.tools.map((t: any) => t.name))}\n request ${show(wire.map((t) => t.name))}`);
  // What the comparison covers: both mounts this is about, and the harness's own.
  const byAlias = (alias: string) => ex.tools.filter((t: any) => t.alias === alias);
  must(byAlias("state").length > 0 && byAlias("state").every((t: any) => t.plugin === "state" && t.name.startsWith("state__")), `state: ${show(byAlias("state").map((t: any) => t.name))}`);
  const raftNames = byAlias("raft").map((t: any) => t.tool);
  must(snap.kept.every((n) => raftNames.includes(n)) && !raftNames.includes(snap.skipped), `raft: ${show(raftNames)}`);
  must(byAlias("raft").every((t: any) => t.plugin === "raft" && t.source === "mount" && typeof t.sideEffects === "string" && (t.replay === "never" || t.replay === "safe")), "raft flags");
  must(ex.tools.some((t: any) => t.name === "run_js" && t.source === "harness" && t.alias === null), "run_js is not listed as the harness's");
  must(ex.tools.some((t: any) => t.modelOnly === true), "no model-only tool is marked (raft's receive_events is one)");
  const raftMount = ex.mounts.find((m: any) => m.alias === "raft");
  must(raftMount.offered === true && raftMount.snapshot.basis === snap.basis && raftMount.basis === snap.basis && raftMount.retake === null, `raft mount: ${show(raftMount)}`);
  must(raftMount.snapshot.takenAt === new Date(1_800_000_000_000).toISOString() && show(raftMount.snapshot.skipped) === show([{ name: snap.skipped, reason: "the credential lacks the capability it needs" }]), `snapshot: ${show(raftMount.snapshot)}`);
  must(show(raftMount.tools) === show(byAlias("raft").map((t: any) => t.name)), "the mount's tools are not its offered names");
  // Nothing secret: no mount config, no secret ref, no token.
  must(!before.text.includes("secretRef") && !before.text.includes("publicConfig") && !before.text.includes(w.token), "the export carries a mount's config, a secret ref or the token");
  // After the turn the export is unchanged: the turn offered what it said.
  const after = await call(w, "GET", `${A}/tools`);
  must(show(after.body.tools) === show(ex.tools), "the export moved across the turn");
});

await check("tools: a plugin switched off is no tool and is listed as not offered, with its reason; the turn agrees", async () => {
  const w = await world();
  await w.rt.store.setPluginChoice(T, A, "pushy", "disable");
  const ex = (await call(w, "GET", `${A}/tools`)).body;
  const p = ex.mounts.find((m: any) => m.alias === "p");
  must(p.offered === false && p.notOffered === "switched_off" && p.tools.length === 0, `p: ${show(p)}`);
  must(!ex.tools.some((t: any) => t.alias === "p"), "a switched-off mount's tool is listed");
  await w.rt.postMessage(T, A, "a real turn", "prompt");
  await settle(w, 1);
  must(show(shape(ex.tools)) === show(await wireTools(w, 0)), "the export and the request differ");
});

await check("tools: reading the export writes nothing — no row, no table, no seal, no turn, no re-take of a stale snapshot", async () => {
  const w = await world("1", { raft: true });
  await raftSnapshot(w, "an-older-basis");
  must(!(await w.rt.store.isSealed(T, A)), "sealed before the read");
  const rows = everything(w.raw.sql as never);
  const r = await call(w, "GET", `${A}/tools`);
  must(r.status === 200, r.text);
  const raftMount = r.body.mounts.find((m: any) => m.alias === "raft");
  must(raftMount.retake === "due" && r.body.retakePending === true && raftMount.snapshot.basis === "an-older-basis", `the stale snapshot: ${show(raftMount)}`);
  must(everything(w.raw.sql as never) === rows, "a row or a table moved");
  must(!(await w.rt.store.isSealed(T, A)), "the read sealed");
  must(jobCount(w) === 0, "the read started a turn");
  must(raftMount.snapshotError === null, `a snapshot error before any re-take: ${raftMount.snapshotError}`);
  // Control: a turn's start does ask for the re-take. With no credential behind the mount it fails and keeps the list
  // (the gateway's keepCredentialed), which it records — the write the read did not make — and backs off.
  await w.rt.postMessage(T, A, "a real turn", "prompt");
  await settle(w, 1);
  must(everything(w.raw.sql as never) !== rows, "control: the turn wrote nothing either");
  const after = (await call(w, "GET", `${A}/tools`)).body;
  const asked = after.mounts.find((m: any) => m.alias === "raft");
  must(asked.retake === "backed_off" && typeof asked.snapshotError === "string" && asked.snapshot.basis === "an-older-basis",
    `the turn did not ask for the re-take: ${show(asked)}`);
  must(after.retakePending === false, "a backed-off re-take is still pending");
  must(show(shape(after.tools)) === show(await wireTools(w, 0)), "the export and the request differ");
});

await check("tools: reading the export on an agent whose mount_snapshot_errors table was never made does not make it", async () => {
  // The Raft world above has the table already (adopt's mounts listed theirs), so it cannot see the read making it.
  const w = await world();
  const has = () => tableNames(w.raw.sql as never).includes("mount_snapshot_errors");
  must(!has(), "the table exists before the read: this case would test nothing");
  const rows = everything(w.raw.sql as never);
  const r = await call(w, "GET", `${A}/tools`);
  must(r.status === 200 && r.body.mounts.length >= 2, `${r.status} ${r.text.slice(0, 300)}`);
  must(r.body.mounts.every((m: any) => m.snapshotError === null), `snapshot errors: ${show(r.body.mounts.map((m: any) => m.snapshotError))}`);
  must(!has(), "the read made mount_snapshot_errors");
  must(everything(w.raw.sql as never) === rows, "a row or a table moved");
  // Control: the console's read of the same field does make it, so `has` can see the table appear.
  w.rt.snapshotError("p");
  must(has(), "control: snapshotError made no table");
});

await check("tools: under pd the export is exactly what the next turn's model request carries", async () => {
  const w = await world();
  const m = await w.D.migrateEngine(T, A, "migrate", false);
  must(!!m && (m as any).ok, `migrate: ${show(m)}`);
  const ex = (await call(w, "GET", `${A}/tools`)).body;
  must(ex.engine === "pd", `engine: ${ex.engine}`);
  must(ex.tools.some((t: any) => t.alias === "p") && ex.tools.some((t: any) => t.alias === "state"), `tools: ${show(ex.tools.map((t: any) => t.name))}`);
  await w.rt.postMessage(T, A, "a real turn", "prompt");
  await settle(w, 1);
  must(jobCount(w) === 1, `jobs: ${jobCount(w)}`);
  const wire = await wireTools(w, 0);
  must(wire.length > 0, "the model request carries no tools");
  must(show(shape(ex.tools)) === show(wire),
    `export and request differ:\n export  ${show(ex.tools.map((t: any) => t.name))}\n request ${show(wire.map((t) => t.name))}`);
});

await check("tools: every mount tool a turn offers carries the result-limit note, but the tool that reads a parked result", async () => {
  const w = await world();
  const ex = (await call(w, "GET", `${A}/tools`)).body;
  await w.rt.postMessage(T, A, "a real turn", "prompt");
  await settle(w, 1);
  const wire = await wireTools(w, 0);
  const NOTE = /A result over \d+ KB comes back as a summary \(preview\)/;
  const mountNames = new Set(ex.tools.filter((t: any) => t.source === "mount").map((t: any) => t.name));
  const mountWire = wire.filter((t) => mountNames.has(t.name));
  must(mountWire.length >= 2 && mountWire.length === mountNames.size, `mount tools on the request: ${show(mountWire.map((t) => t.name))}`);
  const without = mountWire.filter((t) => !NOTE.test(t.description));
  // The reader (`parkedReader`) is named in the others' note and is the one tool left without it.
  const reader = /with the (\S+) call that reads all of it/.exec(mountWire.find((t) => NOTE.test(t.description))?.description ?? "")?.[1] ?? null;
  must(without.length <= 1 && without.every((t) => t.name === reader), `without the note: ${show(without.map((t) => t.name))}, reader ${reader}`);
  must(wire.filter((t) => !mountNames.has(t.name)).every((t) => !NOTE.test(t.description)), "a harness tool carries the mount note");
});

// ---- an evaluation's tool choice (mounts, harness) -------------------------

const HARNESS_OWN = ["run_js", "resume", "jobs"];
const mountAliases = async (w: World) => (await w.rt.store.listMounts(T, A)).map((m) => m.alias).sort();
const toolConfigOfRecord = (a: { config: unknown } | null) => (a?.config as { toolConfig?: unknown } | undefined)?.toolConfig;
const raftCatalogue = () => AgentRuntime.DEFAULT_MOUNTS.filter((m) => m.for.includes("raft"));

await check("toolConfig: a POST without mounts or harness makes today's agent — every catalogue mount, run_js, resume and jobs, reconciled as ever", async () => {
  const w = await world("1", { post: {} });
  const config = (await w.rt.store.loadAgent(T, A))?.config as Record<string, unknown>;
  must(!("toolConfig" in config), `the record carries a toolConfig: ${show(config)}`);
  must((await w.rt.store.seedRecord(T, A)).chosen === false, "a default agent is marked chosen");
  const ex = (await call(w, "GET", `${A}/tools`)).body;
  must(ex.toolConfig === null, `export toolConfig: ${show(ex.toolConfig)}`);
  const names = ex.tools.map((t: any) => t.name);
  must(HARNESS_OWN.every((n) => names.includes(n)), `harness tools: ${show(names.filter((n: string) => !n.includes("__")))}`);
  const want = [...raftCatalogue().map((m) => m.alias), "raft"].sort();
  must(show(await mountAliases(w)) === show(want), `mounts ${show(await mountAliases(w))}, want ${show(want)}`);
  const manifest = (await call(w, "GET", `${A}/seed/manifest`)).body;
  must(manifest.toolConfig === null && manifest.manifestSha256 === sha256Hex(canonJson([])), `manifest: ${show(manifest)}`);
  await w.rt.postMessage(T, A, "a real turn", "prompt");
  await settle(w, 1);
  must(show(shape(ex.tools)) === show(await wireTools(w, 0)), "the export and the request differ");
});

/** A minimal agent with only state and raft, its raft list snapshotted as test/eval-seed-object's other Raft cases do. */
async function minimalWorld(extra: Record<string, unknown> = { mounts: ["state"], harness: "minimal" }) {
  const w = await world("1", { post: extra });
  await raftSnapshot(w);
  return w;
}

for (const engine of ["pi085", "pd"] as const) {
  await check(`toolConfig: mounts ["state"] and harness minimal offer only raft__* and state__*, and the real model request (${engine}) carries exactly that`, async () => {
    const w = await minimalWorld();
    must(w.posted?.status === 201, "made");
    must(show(await mountAliases(w)) === show(["raft", "state"]), `mounts: ${show(await mountAliases(w))}`);
    must(show(toolConfigOfRecord(await w.rt.store.loadAgent(T, A))) === show({ mounts: ["state"], harness: "minimal" }), "the record");
    if (engine === "pd") {
      const m = await w.D.migrateEngine(T, A, "migrate", false);
      must(!!m && (m as any).ok, `migrate: ${show(m)}`);
    }
    const ex = (await call(w, "GET", `${A}/tools`)).body;
    must(ex.engine === engine, `engine ${ex.engine}`);
    const names: string[] = ex.tools.map((t: any) => t.name);
    must(names.length > 0 && names.every((n) => n.startsWith("raft__") || n.startsWith("state__")), `offered: ${show(names)}`);
    must(names.some((n) => n.startsWith("raft__")) && names.some((n) => n.startsWith("state__")), `both mounts: ${show(names)}`);
    must(show(ex.toolConfig) === show({ mounts: ["state"], harness: "minimal" }), `export toolConfig: ${show(ex.toolConfig)}`);
    await w.rt.postMessage(T, A, "a real turn", "prompt");
    await settle(w, 1);
    must(jobCount(w) === 1, `jobs: ${jobCount(w)}`);
    const wire = await wireTools(w, 0);
    must(show(shape(ex.tools)) === show(wire),
      `export and request differ:\n export  ${show(names)}\n request ${show(wire.map((t) => t.name))}`);
    // The system prompt says nothing of run_js either: its paragraph follows the tool.
    must(!(await asked(w, 0)).includes("special tool, run_js"), "the prompt describes run_js");
  });
}


await check("toolConfig: a steer and a push delivered to a minimal agent are offered no harness tool either", async () => {
  const w = await minimalWorld();
  // An operator's mount with an inbound hook, so a push can start a turn; the catalogue never adds one.
  await w.rt.store.setPluginChoice(T, A, "pushy", "enable");
  await w.rt.store.addMount({ tenantId: T, agentId: A, alias: "p", plugin: "pushy", installationId: "i-p", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  const hook = await (await worker.fetch(new Request("https://x/admin/hooks", {
    method: "POST", headers: { "x-harness-token": AUTOMATION, "content-type": "application/json" },
    body: JSON.stringify({ tenantId: T, agentId: A, alias: "p" }),
  }), w.env as never)).json() as { hookId: string; secret: string };
  w.hook.hookId = hook.hookId; w.hook.secret = hook.secret;
  const pushed = await push(w, "e1", "a pushed event");
  must(pushed.status < 300, `push: ${show(pushed)}`);
  await settle(w, 1);
  must(jobCount(w) === 1 && (await asked(w, 0)).includes("a pushed event"), `the push did not reach the model: ${jobCount(w)}`);
  const pushedWire = (await wireTools(w, 0)).map((t) => t.name);
  must(pushedWire.length > 0 && !pushedWire.some((n) => HARNESS_OWN.includes(n)), `push turn: ${show(pushedWire)}`);
  await answer(w, 0, "ok");
  await w.rt.postMessage(T, A, "a steer", "steer");
  await settle(w, 2);
  must(jobCount(w) === 2, `jobs: ${jobCount(w)}`);
  const steerWire = (await wireTools(w, 1)).map((t) => t.name);
  must(steerWire.length > 0 && !steerWire.some((n) => HARNESS_OWN.includes(n)), `steer turn: ${show(steerWire)}`);
  const ex = (await call(w, "GET", `${A}/tools`)).body;
  must(show(ex.tools.map((t: any) => t.name)) === show(steerWire), `export ${show(ex.tools.map((t: any) => t.name))} vs ${show(steerWire)}`);
});

await check("toolConfig: mounts [] is raft alone; harness minimal alone keeps the catalogue's mounts and drops only run_js, resume and jobs", async () => {
  const bare = await minimalWorld({ mounts: [] });
  must(show(await mountAliases(bare)) === show(["raft"]), `mounts []: ${show(await mountAliases(bare))}`);
  const bareNames = (await call(bare, "GET", `${A}/tools`)).body.tools.map((t: any) => t.name);
  // harness is the default here: raft's questions still need resume, so it is offered; run_js and jobs as ever.
  must(bareNames.every((n: string) => n.startsWith("raft__") || HARNESS_OWN.includes(n)) && bareNames.includes("resume"), `mounts []: ${show(bareNames)}`);
  const h = await minimalWorld({ harness: "minimal" });
  must(show(await mountAliases(h)) === show([...raftCatalogue().map((m) => m.alias), "raft"].sort()), `harness only: ${show(await mountAliases(h))}`);
  const names = (await call(h, "GET", `${A}/tools`)).body.tools.map((t: any) => t.name);
  must(!names.some((n: string) => HARNESS_OWN.includes(n)) && names.some((n: string) => n.startsWith("web__")), `harness only: ${show(names)}`);
  must((await h.rt.store.seedRecord(T, A)).chosen === false, "harness alone marked the agent chosen");
});

await check("toolConfig: the catalogue never adds a mount to an agent given mounts, at a turn or a reconcile; a default agent does get it", async () => {
  // A plugin no catalogue entry gives yet, switched on for both agents, so only the catalogue decides.
  const entry = { alias: "p2", plugin: "pushy", config: {}, secretRef: null, policy: null, for: ["console", "raft"] as const, since: 99 };
  AgentRuntime.DEFAULT_MOUNTS.push(entry as never);
  try {
    const w = await minimalWorld();
    await w.rt.store.setPluginChoice(T, A, "pushy", "enable");
    const before = await mountAliases(w);
    const pass = await w.rt.reconcileSeeds(T, A);
    must(pass.ran === false && (pass as { why: string }).why === "chosen", `reconcile: ${show(pass)}`);
    await w.rt.postMessage(T, A, "a real turn", "prompt");
    await settle(w, 1);
    must(jobCount(w) === 1, `jobs: ${jobCount(w)}`);
    must(show(await mountAliases(w)) === show(before), `mounts moved: ${show(before)} -> ${show(await mountAliases(w))}`);
    must(!(await wireTools(w, 0)).some((t) => t.name.startsWith("p2__")), "the new entry was offered");
    // Control: the same catalogue reaches an agent provisioned without the fields, at its next turn.
    const d = await world("1", { post: {} });
    await d.rt.store.setPluginChoice(T, A, "pushy", "enable");
    await d.rt.postMessage(T, A, "a real turn", "prompt");
    await settle(d, 1);
    must((await mountAliases(d)).includes("p2"), `control: a default agent did not get the bumped entry: ${show(await mountAliases(d))}`);
  } finally { AgentRuntime.DEFAULT_MOUNTS.splice(AgentRuntime.DEFAULT_MOUNTS.indexOf(entry as never), 1); }
});

await check("toolConfig: a re-POST asking other tools is 409 and changes nothing; the same ones again is 200; a default agent cannot be made minimal", async () => {
  const w = await minimalWorld();
  const before = everything(w.raw.sql as never);
  for (const extra of [{}, { mounts: ["state", "web"], harness: "minimal" }, { mounts: ["state"] }, { harness: "minimal" }]) {
    const r = await provisionPost(w, extra);
    must(r.status === 409 && r.body?.error?.code === "tool_config_conflict", `${show(extra)}: ${r.status} ${r.text}`);
  }
  must(show(await mountAliases(w)) === show(["raft", "state"]), `mounts after the refusals: ${show(await mountAliases(w))}`);
  must(show(toolConfigOfRecord(await w.rt.store.loadAgent(T, A))) === show({ mounts: ["state"], harness: "minimal" }), "the record moved");
  const now = everything(w.raw.sql as never);
  const [a, b] = [JSON.parse(before), JSON.parse(now)];
  // The object's own busy-time log records each RPC it served; that the refused ones went no further is read there.
  const served = b.do_activity.slice(a.do_activity.length).map((r: any) => r.kind);
  must(served.length === 4 && served.every((k: string) => k === "provisionAdopt"), `after a refusal the POST went on: ${show(served)}`);
  delete a.do_activity; delete b.do_activity;
  if (show(a) !== show(b)) {
    const moved = Object.keys(b).filter((t) => show(a[t]) !== show(b[t]));
    throw new Error(`a refused re-POST wrote: ${moved.map((t) => `${t}: ${show(a[t])?.slice(0, 300)} -> ${show(b[t])?.slice(0, 300)}`).join("\n")}`);
  }
  const same = await provisionPost(w, { harness: "minimal", mounts: ["state"] });
  must(same.status === 200, `the same request: ${same.status} ${same.text}`);
  must(show(await mountAliases(w)) === show(["raft", "state"]), "the replay added a mount");
  const d = await world("1", { post: {} });
  const r = await provisionPost(d, { harness: "minimal" });
  must(r.status === 409 && r.body?.error?.code === "tool_config_conflict", `default -> minimal: ${r.status} ${r.text}`);
  must(toolConfigOfRecord(await d.rt.store.loadAgent(T, A)) === undefined, "the default agent's record gained a toolConfig");
});

await check("toolConfig: on a deployment without the setup routes either field is 400 and no agent is made; an unknown mount is 400 here too", async () => {
  for (const flag of [null, "0"]) {
    const w = await world(flag, {}).catch(() => null);
    must(w, "world");
    for (const extra of [{ mounts: ["state"] }, { harness: "minimal" }]) {
      const r = await provisionPost(w, { ...extra });
      must(r.status === 400 && r.body?.error?.code === "eval_only", `${flag} ${show(extra)}: ${r.status} ${r.text}`);
    }
  }
  const fresh = await bareWorld(null);
  const r = await provisionPost(fresh, { mounts: ["state"], harness: "minimal" });
  must(r.status === 400 && r.body?.error?.code === "eval_only", `${r.status} ${r.text}`);
  must(!(await fresh.rt.store.loadAgent(T, A)), "an agent was made");
  must(!(await d1ProvisionedAgents(fresh.DB).get(T, "01JEVAL")), "a registry row was made");
  const on = await bareWorld("1");
  const unknown = await provisionPost(on, { mounts: ["state", "nosuch"] });
  must(unknown.status === 400 && /"nosuch"/.test(unknown.body?.error?.message ?? ""), `${unknown.status} ${unknown.text}`);
  must(!(await on.rt.store.loadAgent(T, A)) && !(await d1ProvisionedAgents(on.DB).get(T, "01JEVAL")), "an unknown mount made something");
});

// ---- instructions ----------------------------------------------------------

/** What call `i` sent the provider, as the bytes on the wire, and its system message's text. */
async function wireSystem(w: World, i: number): Promise<{ raw: Buffer; system: string }> {
  const job = JSON.parse(await asked(w, i));
  const real = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await callQueuedModel(w.env as never, job, w.jobs[i]!); } finally { globalThis.fetch = real; }
  must(bodies.length === 1, `requests: ${bodies.length}`);
  const sys = (JSON.parse(bodies[0]!).messages ?? []).filter((m: any) => m.role === "system" || m.role === "developer");
  must(sys.length === 1 && typeof sys[0].content === "string", `system messages: ${sys.length}`);
  return { raw: Buffer.from(bodies[0]!, "utf8"), system: sys[0].content };
}
/** About `n` UTF-8 bytes of persona: CJK, emoji and ASCII, every line numbered so no stretch repeats another. */
function persona(n: number, tag: string): string {
  const out: string[] = [];
  for (let i = 0; Buffer.byteLength(out.join("\n"), "utf8") < n; i++) out.push(`${tag} 第${i}条：请逐步核对每一个结果 🚀✅🧪 then answer in English, line ${i}.`);
  return out.join("\n");
}

await check("instructions: with EVAL_SEED_ROUTES a 35 KB CJK-and-emoji persona is made (201), kept whole, and reaches the model byte for byte; a PATCH to one of exactly 64 KiB does too", async () => {
  // NEXT is exactly the limit, so a cap anywhere downstream short of it reddens the PATCH half.
  const INSTR = persona(35_000, "甲"), body = persona(65_400, "乙"), NEXT = body + ".".repeat(65_536 - Buffer.byteLength(body, "utf8"));
  const size = Buffer.byteLength(INSTR, "utf8");
  must(Buffer.byteLength(NEXT, "utf8") === 65_536, `NEXT: ${Buffer.byteLength(NEXT, "utf8")} bytes`);
  must(size >= 35_000 && size < 65_536 && INSTR.length < size && /\p{Extended_Pictographic}/u.test(INSTR), `persona: ${size} bytes, ${INSTR.length} units`);
  const w = await world("1", { post: { instructions: INSTR } });
  must(w.posted?.status === 201 && w.posted.body.instructions === INSTR, `POST answered ${w.posted?.status}, ${Buffer.byteLength(String(w.posted?.body?.instructions), "utf8")} bytes`);
  must((await d1ProvisionedAgents(w.DB).get(T, "01JEVAL"))?.instructions === INSTR, "the registry row is not the persona sent");
  must(((await w.rt.store.loadAgent(T, A))?.config as any)?.description === INSTR, "the agent's record is not the persona sent");
  const replay = await provisionPost(w, { instructions: INSTR });
  must(replay.status === 200, `the same POST again: ${replay.status} ${replay.text.slice(0, 200)}`);
  await w.rt.postMessage(T, A, "a real turn", "prompt");
  await settle(w, 1);
  must(jobCount(w) === 1, `jobs: ${jobCount(w)}`);
  const first = await wireSystem(w, 0);
  // Compared as bytes, in the request body as sent (where JSON escapes only the newlines; CJK and emoji travel as
  // their own UTF-8) and in its system message once parsed: the persona follows "You are n." whole.
  must(first.raw.includes(Buffer.from(JSON.stringify(INSTR).slice(1, -1), "utf8")), "the request body does not carry the persona's bytes");
  must(Buffer.from(first.system, "utf8").includes(Buffer.from(`You are n.\n\n${INSTR}\n\n`, "utf8")), `system prompt: ${Buffer.byteLength(first.system, "utf8")} bytes, persona ${size}`);
  await answer(w, 0, "ok");
  for (let i = 0; i < 5 && !(await engineIdle(w)); i++) await w.D.alarm();
  const patched = await call(w, "PATCH", A, { body: JSON.stringify({ instructions: NEXT }) });
  must(patched.status === 200 && patched.body.instructions === NEXT, `PATCH: ${patched.status} ${patched.text.slice(0, 200)}`);
  must((await d1ProvisionedAgents(w.DB).get(T, "01JEVAL"))?.instructions === NEXT, "PATCH: the registry row");
  must(((await w.rt.store.loadAgent(T, A))?.config as any)?.description === NEXT, "PATCH: the agent's record");
  // The harness already built keeps the prompt it was built with (AgentRuntime.agent, cf/src/runtime.ts, rebuilds on a
  // catalogue change or an eviction, not on a persona edit); a restart builds the next one from the record.
  const restarted = await call(w, "POST", `${A}/restart`);
  must(restarted.status === 200, `restart: ${restarted.status} ${restarted.text}`);
  w.rt = w.D.runtime();
  await w.rt.postMessage(T, A, "the next turn", "prompt");
  await settle(w, 2);
  must(jobCount(w) === 2, `jobs after PATCH: ${jobCount(w)}`);
  const second = await wireSystem(w, 1);
  must(Buffer.from(second.system, "utf8").includes(Buffer.from(`You are n.\n\n${NEXT}\n\n`, "utf8")) && !second.system.includes(INSTR), `after PATCH: new ${second.system.includes(NEXT)} old ${second.system.includes(INSTR)} same-as-first ${second.system === first.system}`);
});

await check("instructions: with EVAL_SEED_ROUTES one byte over 64 KiB is 422 with both sizes and makes nothing; without it, 8000 characters is the bound", async () => {
  const on = await bareWorld("1");
  const over = "汉".repeat(21_845) + "ab";
  const r = await provisionPost(on, { instructions: over });
  must(r.status === 422 && r.body?.error?.param === "instructions" && r.body.error.message === "instructions is at most 65536 UTF-8 bytes; this one is 65537", `${r.status} ${r.text.slice(0, 300)}`);
  must(!(await on.rt.store.loadAgent(T, A)) && !(await d1ProvisionedAgents(on.DB).get(T, "01JEVAL")), "a refused POST made something");
  for (const flag of [null, "0"]) {
    const off = await bareWorld(flag);
    const no = await provisionPost(off, { instructions: "x".repeat(8_001) });
    must(no.status === 422 && no.body?.error?.param === "instructions" && /at most 8000 characters; this one is 8001/.test(no.body.error.message), `${flag} 8001: ${no.status} ${no.text.slice(0, 300)}`);
    must(!(await d1ProvisionedAgents(off.DB).get(T, "01JEVAL")), `${flag}: a refused POST made a row`);
    const yes = await provisionPost(off, { instructions: "x".repeat(8_000) });
    must(yes.status === 201 && yes.body.instructions === "x".repeat(8_000), `${flag} 8000: ${yes.status} ${yes.text.slice(0, 300)}`);
    const patch = await call(off as World, "PATCH", A, { body: JSON.stringify({ instructions: "x".repeat(8_001) }) });
    must(patch.status === 422 && patch.body?.error?.param === "instructions", `${flag} PATCH 8001: ${patch.status} ${patch.text.slice(0, 300)}`);
  }
});

await check("toolConfig: under minimal a mount whose plugin asks questions is refused (400, nothing recorded); without minimal it is given", async () => {
  const entry = { alias: "asker", plugin: "asker", config: { account: "a" }, secretRef: null, policy: null, for: ["console", "raft"] as const, since: 98 };
  AgentRuntime.DEFAULT_MOUNTS.push(entry as never);
  try {
    const w = await bareWorld("1");
    const r = await provisionPost(w, { mounts: ["asker"], harness: "minimal" });
    must(r.status === 400 && /asks the model questions/.test(r.body?.error?.message ?? ""), `${r.status} ${r.text}`);
    must(!(await w.rt.store.loadAgent(T, A)), "the refused agent's record was written");
    // The refused POST made the registry row (D1, before the object is asked), so this is its replay finishing it.
    const ok = await provisionPost(w, { mounts: ["asker"] });
    must(ok.status === 200 && ok.body.status === "active", `control: ${ok.status} ${ok.text}`);
    const names = (await call(w, "GET", `${A}/tools`)).body.tools.map((t: any) => t.name);
    must(names.includes("asker__ask") && names.includes("resume"), `control: ${show(names)}`);
  } finally { AgentRuntime.DEFAULT_MOUNTS.splice(AgentRuntime.DEFAULT_MOUNTS.indexOf(entry as never), 1); }
});

await check("toolConfig: the seed manifest and the seal carry it, and manifestSha256 covers it", async () => {
  const w = await minimalWorld();
  must((await seed(w, "MEMORY.md", "hello")).status === 200, "seed");
  const tc = { mounts: ["state"], harness: "minimal" };
  const m = (await call(w, "GET", `${A}/seed/manifest`)).body;
  must(m.sealed === false && show(m.toolConfig) === show(tc), `manifest: ${show(m)}`);
  must(m.manifestSha256 === sha256Hex(canonJson({ manifest: m.manifest, toolConfig: tc })), "the unsealed hash does not cover toolConfig");
  must(m.manifestSha256 !== sha256Hex(canonJson(m.manifest)), "the hash is the files' alone");
  const s = (await call(w, "POST", `${A}/seed/seal`)).body;
  must(show(s.toolConfig) === show(tc) && s.manifestSha256 === m.manifestSha256, `seal: ${show(s)}`);
  const after = (await call(w, "GET", `${A}/seed/manifest`)).body;
  must(after.sealed === true && show(after.toolConfig) === show(tc) && after.manifestSha256 === m.manifestSha256, `sealed manifest: ${show(after)}`);
});

await check("toolConfig: mounts are kept sorted, so the same mounts in either order are one agent: same record, same hash", async () => {
  const a = await world("1", { post: { mounts: ["state", "web"] } });
  const b = await world("1", { post: { mounts: ["web", "state"] } });
  for (const w of [a, b]) {
    must(show(toolConfigOfRecord(await w.rt.store.loadAgent(T, A))) === show({ mounts: ["state", "web"], harness: "default" }), `record: ${show(toolConfigOfRecord(await w.rt.store.loadAgent(T, A)))}`);
    must((await seed(w, "MEMORY.md", "hello")).status === 200, "seed");
  }
  const [ma, mb] = [(await call(a, "GET", `${A}/seed/manifest`)).body, (await call(b, "GET", `${A}/seed/manifest`)).body];
  must(ma.manifestSha256 === mb.manifestSha256 && show(ma.toolConfig) === show(mb.toolConfig), `by order: ${show([ma.toolConfig, mb.toolConfig])} ${ma.manifestSha256} ${mb.manifestSha256}`);
});

await check("toolConfig: after the seal a re-POST in another order is 200 and changes nothing; the seal reports its own copy, recomputable, whatever the record later says", async () => {
  const w = await world("1", { post: { mounts: ["state", "web"], harness: "minimal" } });
  must((await seed(w, "MEMORY.md", "hello")).status === 200, "seed");
  const s = (await call(w, "POST", `${A}/seed/seal`)).body;
  const recompute = (m: any) => sha256Hex(canonJson({ manifest: m.manifest, toolConfig: m.toolConfig }));
  must(s.manifestSha256 === recompute(s), `the seal's hash is not its own manifest and toolConfig's: ${show(s)}`);
  const r = await provisionPost(w, { mounts: ["web", "state"], harness: "minimal" });
  must(r.status === 200, `reordered replay: ${r.status} ${r.text}`);
  const after = (await call(w, "GET", `${A}/seed/manifest`)).body;
  must(after.sealed === true && show(after.toolConfig) === show(s.toolConfig) && after.manifestSha256 === s.manifestSha256, `after the replay: ${show(after)} vs ${show(s)}`);
  must(after.manifestSha256 === recompute(after), "the published manifest no longer recomputes to its hash");
  // The record moved by a path no route offers: the seal still reports what it closed on.
  const config = (await w.rt.store.loadAgent(T, A))!.config as Record<string, unknown>;
  await w.rt.store.updateAgentConfig(T, A, { ...config, toolConfig: { mounts: ["state"], harness: "default" } } as never);
  const moved = (await call(w, "GET", `${A}/seed/manifest`)).body;
  must(show(moved.toolConfig) === show(s.toolConfig) && moved.manifestSha256 === s.manifestSha256 && moved.manifestSha256 === recompute(moved),
    `the seal followed the record: ${show(moved)}`);
});

await check("toolConfig: a named mount whose plugin cannot run on this deployment is 400 naming it, and no agent is made", async () => {
  const entry = { alias: "asker", plugin: "asker", config: { account: "a" }, secretRef: null, policy: null, for: ["console", "raft"] as const, since: 97 };
  AgentRuntime.DEFAULT_MOUNTS.push(entry as never);
  askerOffline = "the asker service is not configured here";
  try {
    const w = await bareWorld("1");
    const r = await provisionPost(w, { mounts: ["asker"] });
    must(r.status === 400 && /"asker"/.test(r.body?.error?.message ?? "") && /not configured here/.test(r.body?.error?.message ?? ""), `${r.status} ${r.text}`);
    must(!(await w.rt.store.loadAgent(T, A)), "the refused agent's record was written");
    askerOffline = null;
    const ok = await provisionPost(w, { mounts: ["asker"] });
    must(ok.status === 200 && show(await mountAliases(w)) === show(["asker", "raft"]), `control: ${ok.status} ${ok.text} ${show(await mountAliases(w))}`);
  } finally {
    askerOffline = null;
    AgentRuntime.DEFAULT_MOUNTS.splice(AgentRuntime.DEFAULT_MOUNTS.indexOf(entry as never), 1);
  }
});

await check("toolConfig: a catalogue entry that asks questions, added after a minimal agent was made, is refused at reconcile and recorded with its reason", async () => {
  const w = await minimalWorld({ harness: "minimal" });
  const before = await mountAliases(w);
  const entry = { alias: "asker", plugin: "asker", config: { account: "a" }, secretRef: null, policy: null, for: ["console", "raft"] as const, since: 96 };
  AgentRuntime.DEFAULT_MOUNTS.push(entry as never);
  try {
    await w.rt.store.setPluginChoice(T, A, "asker", "enable");
    const pass = await w.rt.reconcileSeeds(T, A);
    must(pass.ran === true, `reconcile: ${show(pass)}`);
    const row = pass.changed.find((c) => c.alias === "asker");
    must(row?.outcome === "refused" && /harness is "minimal"/.test(row.reason ?? ""), `outcome: ${show(pass.changed)}`);
    must(show(await mountAliases(w)) === show(before), `mounts moved: ${show(before)} -> ${show(await mountAliases(w))}`);
    // Control: a default agent is given it by the same pass.
    const d = await world("1", { post: {} });
    await d.rt.store.setPluginChoice(T, A, "asker", "enable");
    await d.rt.reconcileSeeds(T, A);
    must((await mountAliases(d)).includes("asker"), `control: ${show(await mountAliases(d))}`);
  } finally { AgentRuntime.DEFAULT_MOUNTS.splice(AgentRuntime.DEFAULT_MOUNTS.indexOf(entry as never), 1); }
});

await check("toolConfig: an agent whose record names its mounts is never reconciled, even if it was never marked chosen", async () => {
  const w = await minimalWorld();
  w.raw.sql.exec("UPDATE seed_reconcile SET chosen=0");
  const pass = await w.rt.reconcileSeeds(T, A);
  must(pass.ran === false && (pass as { why: string }).why === "chosen", `reconcile: ${show(pass)}`);
});

await check("toolConfig: under minimal a held raft send reaches the model as resumable:false with \"Call it again\", no resume offered, and calling again sends it once", async () => {
  const w = await world("1", { post: { mounts: ["state"], harness: "minimal" } });
  // The raft list a credential that can send leaves, under this build's basis, so the turn does not re-take it.
  const raft = w.rt.plugins().find((p) => p.id === "raft")!;
  await w.rt.store.updateMountToolSnapshot(T, A, "raft", {
    hash: "snap-send", takenAt: 1_800_000_000_000, basis: raft.toolsBasis,
    tools: [{ name: "messages_send", summary: "", parameters: {}, sideEffects: "write", idempotency: "native" }], skipped: [],
  } as never);
  // Raft stood in for: the first send is held (a newer message arrived), any later one is sent. Every request is kept.
  const sends: any[] = [];
  /** A function, as `jobCount`: an assertion would narrow `sends.length` to one literal. */
  const sendCount = () => sends.length;
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST" && /\/internal\/agent-api\/v2\/send$/.test(new URL(u).pathname)) {
      const body = JSON.parse(String(init.body));
      sends.push(body);
      if (sends.length === 1) {
        return Response.json({ ok: true, state: "held", newMessageCount: 1, seenUpToSeq: 20, omittedMessageCount: 0, freshnessContextMode: "inline",
          heldMessages: [{ seq: 20, id: "abcdef12-0000", content: "wait, one more thing", sender_type: "human", sender_name: "tygg", channel_name: "general", channel_type: "channel", timestamp: "2026-09-28T10:00:00Z" }] });
      }
      return Response.json({ ok: true, state: "sent", messageId: "m-21", messageSeq: 21 });
    }
    return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  }) as typeof fetch;
  try {
    const args = { target: "#general", content: "done", idempotencyKey: "k1" };
    const callSend = async (i: number, id: string) => {
      const job = JSON.parse(await asked(w, i)) as { model?: { api?: string; provider?: string } };
      await w.D.deliverAnswer(T, A, w.jobs[i]!, { role: "assistant", content: [{ type: "toolCall", id, name: "raft__messages_send", arguments: args }],
        api: job.model?.api ?? "x", provider: job.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: "toolUse", timestamp: 0 } as never, 5);
    };
    await w.rt.postMessage(T, A, "tell #general you are done", "prompt");
    await settle(w, 1);
    must(jobCount(w) === 1, `jobs: ${jobCount(w)}`);
    const offered = (await wireTools(w, 0)).map((t) => t.name);
    must(offered.includes("raft__messages_send") && !offered.some((n) => HARNESS_OWN.includes(n)), `offered: ${show(offered)}`);
    await callSend(0, "call-1");
    await settle(w, 2);
    must(jobCount(w) === 2 && sendCount() === 1, `after the held send: ${jobCount(w)} jobs, ${sendCount()} sends`);
    // What the model is shown next: the question, dropped, with the note; and the turn's record says it is not resumable.
    const second = await asked(w, 1);
    must(second.includes("Call it again if it still applies") && second.includes("wait, one more thing"), `the model was not shown the dropped question: ${second.slice(-1500)}`);
    const results = (await (await w.rt.agent(T, A)).branch() as any[]).filter((m) => m?.role === "toolResult" || m?.message?.role === "toolResult");
    const held = results.map((m) => m.message ?? m).find((m: any) => m.toolCallId === "call-1");
    must(held?.details?.interrupted === true && held.details.resumable === false, `the held result's details: ${show(held?.details)}`);
    must(!(await wireTools(w, 1)).some((t) => HARNESS_OWN.includes(t.name)), "resume offered after the question");
    await callSend(1, "call-2");
    await settle(w, 3);
    must(sendCount() === 2, `sends: ${sendCount()}`);
    must(sends[1].seenUpToSeq === 20 && sends[1].content === "done", `the repeat did not go ahead on what was shown: ${show(sends[1])}`);
    const repeat = ((await (await w.rt.agent(T, A)).branch()) as any[]).map((m) => m.message ?? m).find((m: any) => m.toolCallId === "call-2");
    must(repeat && !repeat.details?.interrupted && /"state":"sent"/.test(repeat.content?.[0]?.text ?? "") && (await asked(w, 2)).includes("m-21"),
      `the repeated call's result: ${show(repeat)}`);
    await answer(w, 2, "done");
    await settle(w, 4);
    must(sendCount() === 2 && jobCount(w) === 3, `after the turn ended: ${sendCount()} sends, ${jobCount(w)} jobs`);
  } finally { globalThis.fetch = real; }
});

// ---- the transcript and trace exports ---------------------------------------

/** Every table of the object and every row of each, so a read can be seen to have changed nothing at all. */
const dump = (sql: { exec(q: string): { toArray(): any[] } }) => show(tableNames(sql).map((t) =>
  [t, sql.exec(`SELECT * FROM "${t}"`).toArray().map((r) => JSON.stringify(r, (_k: string, v: unknown) => (v instanceof Uint8Array ? [...v] : v))).sort()]));
/** The bucket's keys and bytes. */
const bucketDump = (w: World) => show([...w.R2.objects.entries()].map(([k, v]) => [k, [...v].length]).sort());
/** The fake bucket lists nothing (other cases rely on that); the trace export lists one agent's prefix, so here it does. */
function listByPrefix(w: World) {
  (w.R2 as any).list = async (o: { prefix?: string } = {}) => ({
    objects: [...w.R2.objects.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().map((key) => ({ key, uploaded: new Date() })),
    delimitedPrefixes: [], truncated: false,
  });
}
/** One turn in which the model calls `p__noop`, which answers `result`, and then ends with `reply`; `base` is the jobs before it. */
async function toolTurn(w: World, prompt: string, result: Record<string, unknown>, reply: string, args: Record<string, unknown> = {}) {
  const base = jobCount(w);
  pushyAnswer = result;
  try {
    await w.rt.postMessage(T, A, prompt, "prompt");
    await settle(w, base + 1);
    must(jobCount(w) === base + 1, `the turn did not reach the model: ${jobCount(w)} jobs`);
    const job = JSON.parse(await asked(w, base)) as { model?: { api?: string; provider?: string } };
    await w.D.deliverAnswer(T, A, w.jobs[base]!, { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "toolCall", id: `call-${base}`, name: "p__noop", arguments: args }],
      api: job.model?.api ?? "x", provider: job.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: "toolUse", timestamp: 0 } as never, 5);
    await settle(w, base + 2);
    must(jobCount(w) === base + 2, `the tool's result did not go back to the model: ${jobCount(w)} jobs`);
    await answer(w, base + 1, reply);
    for (let i = 0; i < 5 && !(await engineIdle(w)); i++) await w.D.alarm();
    must(await engineIdle(w), "the turn did not end");
  } finally { pushyAnswer = {}; }
}
const admin = async (w: World, taskId?: string) => {
  const res = await worker.fetch(new Request(`https://x/admin/transcript?tenantId=${T}&agentId=${A}${taskId ? `&taskId=${taskId}` : ""}`,
    { headers: { "x-harness-token": AUTOMATION } }), w.env as never);
  return { status: res.status, body: await res.json() as any };
};

await check("transcript and trace: another tenant's token and an unknown agent are 404, no token is 401", async () => {
  const w = await world();
  for (const route of ["transcript", "trace"]) {
    const other = await call(w, "GET", `${A}/${route}`, { auth: w.other });
    must(other.status === 404 && other.body?.error?.code === "not_found" && !other.text.includes('"events"') && !other.text.includes('"rows"'), `${route} another tenant: ${other.status} ${other.text}`);
    must((await call(w, "GET", `raft_nobody/${route}`)).status === 404, `${route}: an unknown agent`);
    must((await call(w, "GET", `${A}/${route}`, { auth: null })).status === 401, `${route}: no credential`);
    must((await call(w, "POST", `${A}/${route}`)).status === 404, `${route}: POST is a route`);
    const ok = await call(w, "GET", `by-raft-agent/01JEVAL/${route}`);
    must(ok.status === 200 && ok.body.agentId === A && ok.body.redactions === 0, `${route} control: ${ok.status} ${ok.text.slice(0, 300)}`);
  }
});

await check("transcript: the same events, approvals and total as /admin/transcript for the agent, tool calls with arguments and results with status and body", async () => {
  const w = await world();
  await toolTurn(w, "PROMPT-MARKER-1a2b", { rows: [{ id: 1, note: "RESULT-MARKER-3c4d" }] }, "REPLY-MARKER-5e6f", { q: "ARGS-MARKER-7a8b" });
  const ours = await call(w, "GET", `${A}/transcript`);
  const theirs = await admin(w);
  must(ours.status === 200 && theirs.status === 200, `${ours.status} ${theirs.status}`);
  must(ours.body.sessionId === "main" && ours.body.current === true && ours.body.redactions === 0 && ours.body.nextCursor === null, ours.text.slice(0, 300));
  must(show(ours.body.events) === show(theirs.body.events), `events differ:\n ours   ${show(ours.body.events).slice(0, 600)}\n admin  ${show(theirs.body.events).slice(0, 600)}`);
  must(show(ours.body.byOp) === show(theirs.body.byOp) && ours.body.total === theirs.body.total && ours.body.shown === theirs.body.total, "byOp or total differ");
  const kinds = ours.body.events.map((e: any) => e.kind);
  must(show(kinds) === show(["message", "model.response", "tool.result", "model.response"]), `kinds: ${show(kinds)}`);
  const callEv = ours.body.events[1].payload.toolCalls?.[0];
  must(callEv?.name === "p__noop" && callEv.arguments.q === "ARGS-MARKER-7a8b", `the call: ${show(callEv)}`);
  const result = ours.body.events[2].payload;
  must(result.status === "succeeded" && result.isError === false && result.result.rows[0].note === "RESULT-MARKER-3c4d", `the result: ${show(result)}`);
  must(ours.body.events[0].payload.text === "PROMPT-MARKER-1a2b" && ours.body.events[3].payload.text === "REPLY-MARKER-5e6f", "the prompt or reply");
  // Paging: the same events, a page at a time, each page saying where the next starts.
  const pages: any[] = [];
  for (let cursor: string | null = "0"; cursor !== null;) {
    const p = await call(w, "GET", `${A}/transcript?limit=3&cursor=${cursor}`);
    must(p.status === 200 && p.body.shown <= 3 && p.body.total === 4, p.text.slice(0, 300));
    pages.push(...p.body.events);
    cursor = p.body.nextCursor;
  }
  must(show(pages) === show(theirs.body.events), "the pages are not the transcript");
});

await check("transcript: after a fresh context the ended conversation is read by its id, the current one by default, an unknown id is 404", async () => {
  const w = await world();
  await toolTurn(w, "OLD-PROMPT-91aa", { v: "OLD-RESULT-22bb" }, "OLD-REPLY-33cc");
  must((await call(w, "POST", `${A}/fresh-context`)).body.newSessionId === "main.1", "fresh context");
  await w.rt.postMessage(T, A, "NEW-PROMPT-44dd", "prompt");
  const old = await call(w, "GET", `${A}/transcript?session=main`);
  must(old.status === 200 && old.body.sessionId === "main" && old.body.current === false, old.text.slice(0, 300));
  must(old.text.includes("OLD-RESULT-22bb") && old.text.includes("OLD-REPLY-33cc") && !old.text.includes("NEW-PROMPT-44dd"), "the ended conversation's content");
  must(show(old.body.events) === show((await admin(w, "main")).body.events), "the ended conversation differs from the operator's read of it");
  const now = await call(w, "GET", `${A}/transcript`);
  const named = await call(w, "GET", `${A}/transcript?session=main.1`);
  must(now.body.sessionId === "main.1" && now.body.current === true && now.text.includes("NEW-PROMPT-44dd") && !now.text.includes("OLD-PROMPT-91aa"), now.text.slice(0, 300));
  must(show(named.body.events) === show(now.body.events) && show(now.body.events) === show((await admin(w)).body.events), "main.1 by name, by default and the operator's read differ");
  const none = await call(w, "GET", `${A}/transcript?session=main.7`);
  must(none.status === 404 && none.body.error.code === "not_found", none.text);
});

await check("transcript: a credential anywhere in a tool's result or arguments is replaced and counted; the sealed credential and mount secrets are never in it", async () => {
  const v = await world("1", { post: {} });
  await v.rt.store.setPluginChoice(T, A, "pushy", "enable");
  await v.rt.store.addMount({ tenantId: T, agentId: A, alias: "p", plugin: "pushy", installationId: "i-p", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  const KEY = "sk-" + "proj-" + "Kx7".repeat(12), AGENT_KEY = "sk_agent_" + "Ab3".repeat(8), GH = "ghp_" + "M".repeat(36);
  await toolTurn(v, "use the tool", { page: { items: [{ meta: { auth: { header: `Bearer ${AGENT_KEY}` } } }, [[[KEY]]]], [GH]: "x" } }, "done", { token: KEY });
  const r = await call(v, "GET", `${A}/transcript`);
  must(r.status === 200, r.text.slice(0, 300));
  for (const secret of [KEY, AGENT_KEY, GH, RAFT_CRED]) must(!r.text.includes(secret), `the export carries ${secret.slice(0, 8)}…`);
  const result = r.body.events.find((e: any) => e.kind === "tool.result").payload.result;
  must(result.page.items[0].meta.auth.header === "<redacted:Raft agent credential>" && result.page.items[1][0][0][0] === "<redacted:api-key>", show(result));
  must(result.page["<redacted:github-token>"] === "x", show(result));
  must(r.body.events.find((e: any) => e.kind === "model.response").payload.toolCalls[0].arguments.token === "<redacted:api-key>", "the call's argument");
  // Exactly the four planted: the agent's sealed Raft credential (which has the same shape) was never there to count.
  must(r.body.redactions === 4, `redactions: ${r.body.redactions}`);
  // Positive control: the sealed credential is on the agent's mount, and the operator's unredacted read holds none of it either.
  const mount = (await v.rt.store.listMounts(T, A)).find((m: any) => m.alias === "raft") as any;
  must(mount?.secretRef, `the raft mount holds no sealed credential: ${show(mount)}`);
  const plain = show((await admin(v)).body);
  must(plain.includes(KEY) && !plain.includes(RAFT_CRED) && !plain.includes(String(mount.secretRef)), "the operator's read carries the sealed credential or its reference");
  must(!r.text.includes(String(mount.secretRef)), "the export carries the mount's secret reference");
});

await check("trace: a turn's rows are read from the object, then from the bucket once the alarm pass exports and prunes them; the same rows either way", async () => {
  const w = await world();
  listByPrefix(w);
  const t0 = Date.now() - 1;
  await toolTurn(w, "trace me", { ok: 1 }, "done");
  const before = await call(w, "GET", `${A}/trace`);
  must(before.status === 200 && before.body.rows.length > 0 && before.body.redactions === 0, before.text.slice(0, 400));
  must(before.body.rows.every((r: any) => r.tenantId === T && r.agentId === A && r.at >= t0), "a row of someone else or from before");
  must(before.body.rows.some((r: any) => r.kind === "tool.call" && r.attrs.tool === "pushy.noop" && r.attrs.mount === "p"), `the tool call: ${show(before.body.rows)}`);
  const seqs = before.body.rows.map((r: any) => r.seq);
  must(show(seqs) === show([...seqs].sort((a: number, b: number) => a - b)), "rows not in seq order");
  // The export: a pass with nothing else due still drains the outbox to the bucket.
  for (let i = 0; i < 3 && w.raw.sql.exec("SELECT COUNT(*) AS n FROM trace_outbox").toArray()[0]!.n > 0; i++) await w.D.alarm();
  const keys = [...w.R2.objects.keys()].filter((k) => k.startsWith(`trace/${T}/${A}/`));
  must(keys.length > 0, `nothing exported: ${show([...w.R2.objects.keys()])}`);
  const left = Number(w.raw.sql.exec("SELECT COUNT(*) AS n FROM trace_outbox").toArray()[0]!.n);
  // Every row now only in the bucket: what follows reads it from there or not at all.
  must(left === 0, `${left} rows still in the object after the export`);
  const after = await call(w, "GET", `${A}/trace`);
  must(after.status === 200 && show(after.body.rows) === show(before.body.rows), `rows moved across the export (${left} left locally):\n before ${show(before.body.rows.map((r: any) => r.seq))}\n after  ${show(after.body.rows.map((r: any) => r.seq))}`);
  must(after.body.scanned.objects === keys.length, show(after.body.scanned));
  // Limit and cursor: one row at a time reaches the same rows.
  const one: any[] = [];
  for (let cursor = "0"; ;) {
    const p = await call(w, "GET", `${A}/trace?limit=1&cursor=${cursor}`);
    must(p.status === 200 && p.body.rows.length <= 1, p.text.slice(0, 300));
    one.push(...p.body.rows);
    if (p.body.nextCursor === null) break;
    cursor = p.body.nextCursor;
  }
  must(show(one) === show(before.body.rows), "paging one row at a time does not reach the same rows");
  // A window that ends before the turn holds none of it.
  const early = await call(w, "GET", `${A}/trace?from=${t0 - 3_600_000}&to=${t0}`);
  must(early.status === 200 && early.body.rows.length === 0 && early.body.from === new Date(t0 - 3_600_000).toISOString(), early.text.slice(0, 300));
});

await check("transcript and trace write nothing: every table and row of the object, and the bucket, are as they were; no table is made", async () => {
  // An agent that never traced anything: the outbox table does not exist, and reading it must not make it.
  const fresh = await world();
  listByPrefix(fresh);
  must(!tableNames(fresh.raw.sql as never).includes("trace_outbox"), "the fixture already has an outbox");
  const fresh0 = dump(fresh.raw.sql as never);
  must((await call(fresh, "GET", `${A}/trace`)).status === 200 && (await call(fresh, "GET", `${A}/transcript`)).status === 200, "the reads");
  must(dump(fresh.raw.sql as never) === fresh0, `the reads changed the object: tables now ${show(tableNames(fresh.raw.sql as never))}`);
  // An agent with a conversation, a tool call, an ended conversation, exported trace and rows still held.
  const w = await world();
  listByPrefix(w);
  await toolTurn(w, "one", { a: 1 }, "done");
  await w.D.alarm();
  must((await call(w, "POST", `${A}/fresh-context`)).status === 200, "fresh context");
  await w.rt.postMessage(T, A, "two", "prompt");
  await settle(w, 3);
  const db0 = dump(w.raw.sql as never), r20 = bucketDump(w), jobs0 = jobCount(w), sealed0 = await w.rt.store.isSealed(T, A);
  for (const q of ["transcript", "transcript?session=main", "transcript?limit=1&cursor=1", "trace", "trace?limit=1", `trace?from=${Date.now() - 60_000}`]) {
    const r = await call(w, "GET", `${A}/${q}`);
    must(r.status === 200, `${q}: ${r.status} ${r.text.slice(0, 200)}`);
  }
  must(dump(w.raw.sql as never) === db0, "a read changed the object's rows or tables");
  must(bucketDump(w) === r20 && jobCount(w) === jobs0 && (await w.rt.store.isSealed(T, A)) === sealed0, "a read wrote to the bucket, started a turn or sealed");
});

// ---- audit -----------------------------------------------------------------

await check("each write, explicit seal, fresh context and restart logs one line with the token's hash, never the token or the text", async () => {
  const w = await world();
  lines.length = 0;
  const BODY = "secret-free body text 1234";
  await seed(w, "MEMORY.md", BODY);
  await call(w, "POST", `${A}/seed/seal`);
  await call(w, "POST", `${A}/fresh-context`);
  await call(w, "POST", `${A}/restart`);
  const ours = lines.map((l) => JSON.parse(l)).filter((l) => l.evt === "eval.seed");
  must(show(ours.map((l) => l.op)) === show(["write", "seal", "fresh-context", "restart"]), `lines: ${show(ours)}`);
  must(ours.every((l) => l.credentialId === w.tokenHash && l.tenant === T && l.agent === A), `ids: ${show(ours)}`);
  must(ours[0].path === "MEMORY.md" && ours[0].sha256 === sha256Hex(BODY), show(ours[0]));
  const all = lines.join("\n");
  must(!all.includes(w.token) && !all.includes(BODY), "a log line carries the token or the body");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
