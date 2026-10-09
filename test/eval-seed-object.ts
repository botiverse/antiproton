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

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
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

/** A push plugin as in test/hook-fast-ack.ts, minus the HMAC: the hook's secret in a header, `{id, text}` as the body. */
const pushy: Plugin = {
  id: "pushy", version: "1.0.0",
  tools: [{ name: "noop", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { return {}; },
  async receive(event, secret) {
    if (event.headers["x-signed-with"] !== secret) return { deliver: false, reason: "bad signature", rejected: true };
    const body = JSON.parse(new TextDecoder().decode(event.body)) as { id: string; text: string };
    return { deliver: true, text: body.text, dedupeKey: body.id };
  },
};

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
 * `state` mount, and two provider tokens: T's and another tenant's. `flag` is EVAL_SEED_ROUTES as the deployment sets it,
 * null for not at all.
 */
async function world(flag: string | null = "1") {
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
  class TestDO extends AgentDO { protected override extraPlugins() { return [pushy]; } }
  const objects = new Map<string, InstanceType<typeof TestDO>>();
  const R2 = bucket();
  const env: Record<string, unknown> = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: R2, ARTIFACT_BUCKET: "b", CONTROL_DB: DB, HARNESS_MODEL: "m1",
    DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", AUTOMATION_TOKEN: AUTOMATION,
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    ...(flag === null ? {} : { EVAL_SEED_ROUTES: flag }),
    AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n)! },
  };
  const D = new TestDO(ctx as never, env as never);
  objects.set(agentObjectName(T, A), D);
  await D.uiAdoptAgent(T, A, { name: "n", description: "d", avatar: "x" });
  const rt = D.runtime();
  await rt.ready();
  await rt.bindOperatorModel(T, A);
  await rt.store.setPluginChoice(T, A, "pushy", "enable");
  await rt.store.markSeedsChosen(T, A);
  for (const [alias, plugin] of [["p", "pushy"], ["state", "state"]] as const) {
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
  const token = newProviderToken(), other = newProviderToken();
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(token), label: "raft-test", raftOrigin: "https://raft.example", scope: "tenant", tenantId: T });
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(other), label: "raft-other", raftOrigin: "https://raft.example", scope: "tenant", tenantId: OTHER_T });
  return { D, rt, raw, DB, R2, env, jobs, token, other, tokenHash: await hashProviderToken(token), hook: made, alarmAt: () => alarmAt };
}
type World = Awaited<ReturnType<typeof world>>;

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
      ["GET", `${A}/seed/manifest`, undefined], ["POST", `${A}/fresh-context`, undefined], ["POST", `${A}/restart`, undefined], ["GET", `${A}/model-input`, undefined]] as const) {
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
