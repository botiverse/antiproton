/**
 * A push at an inbound hook, through the worker's `fetch` and the whole `AgentDO` under node (the
 * `cloudflare:workers` stand-in test/pd-migrate-object.ts uses): the answer comes once the push is verified,
 * deduplicated, rate-checked and queued, and the alarm pass posts it (cf/src/index.ts `hookReceive`,
 * `#deliverInbound`; cf/src/runtime.ts `receiveHook`, `deliverPendingInbound`). The worker routes a hook it has
 * seen from its route cache rather than the control plane (cf/src/hook-route.ts), so the D1 stand-in here
 * counts every statement prepared on it.
 *
 * The engine is the default one (PiAgent), the one a Raft-made agent runs; the model is the queue, answered
 * by hand, so "a turn started" is read as the model being asked something.
 */
import { register } from "node:module";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { INBOUND_PER_MINUTE } from "../src/runtime/inbound.ts";
import { agentObjectName } from "../cf/src/object-name.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { clearHookRoutes, HOOK_ROUTE_TTL_MS } = await import("../cf/src/hook-route.ts");
const { setLogSink } = await import("../src/core/log.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const T = "t", A = "a", TOKEN = "operator-token";
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// The log lines, so the `http` line's new fields can be read.
const lines: Array<Record<string, unknown>> = [];
setLogSink((line) => { try { lines.push(JSON.parse(line)); } catch { /* not ours */ } });

/**
 * A test plugin that receives the way Raft's does, minus the HMAC: `x-signed-with` must be the hook's secret
 * (401 otherwise), the body is `{id, text}`, the id is the dedupe key. Headers ask for the other answers.
 */
const received: string[] = [];
const barrier: Array<() => void> = [];
const pushy: Plugin = {
  id: "pushy", version: "1.0.0",
  tools: [{ name: "noop", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { return {}; },
  async receive(event, secret) {
    if (event.headers["x-throw"]) throw new Error("the plugin fell over");
    // Held until two pushes are both inside `receive`, so both resume past the plugin's await together.
    if (event.headers["x-barrier"]) await new Promise<void>((go) => { barrier.push(go); if (barrier.length === 2) barrier.splice(0).forEach((g) => g()); });
    if (event.headers["x-signed-with"] !== secret) return { deliver: false, reason: "bad signature", rejected: true };
    if (event.headers["x-malformed"]) return { deliver: false, reason: "not my shape", malformed: true };
    const body = JSON.parse(new TextDecoder().decode(event.body)) as { id: string; text: string; ignore?: boolean };
    if (body.ignore) return { deliver: false, reason: "not for this agent" };
    received.push(body.id);
    return { deliver: true, text: body.text, dedupeKey: body.id };
  },
};

/** A D1 stand-in holding `inbound_hooks`; every statement prepared on it is logged, by its SQL. */
function controlDb() {
  const hooks = new Map<string, { hook_id: string; tenant_id: string; agent_id: string; alias: string; created_at: number; revoked_at: number | null }>();
  const log: string[] = [];
  const prepare = (sql: string) => {
    log.push(sql.replace(/\s+/g, " ").slice(0, 80));
    let args: unknown[] = [];
    const stmt = {
      bind: (...a: unknown[]) => { args = a; return stmt; },
      async first() {
        if (/^SELECT hook_id, tenant_id, agent_id, alias FROM inbound_hooks WHERE hook_id = \? AND revoked_at IS NULL/.test(sql)) {
          const r = hooks.get(String(args[0]));
          return r && r.revoked_at === null ? r : null;
        }
        if (/^UPDATE inbound_hooks SET revoked_at/.test(sql)) {
          const r = hooks.get(String(args[1]));
          if (!r || r.revoked_at !== null) return null;
          r.revoked_at = Number(args[0]);
          return r;
        }
        return null;
      },
      async all() { return { results: [] }; },
      async run() {
        if (/^INSERT INTO inbound_hooks/.test(sql)) {
          const [hook_id, tenant_id, agent_id, alias, created_at] = args as [string, string, string, string, number];
          hooks.set(hook_id, { hook_id, tenant_id, agent_id, alias, created_at, revoked_at: null });
        }
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  };
  return { db: { prepare, batch: async (s: unknown[]) => s.map(() => ({ results: [], meta: { changes: 1 } })) }, hooks, log };
}

/**
 * One agent, its object, the worker in front of it, and a hook on its `p` mount. `evict()` replaces the object
 * with a fresh instance on the same storage, as an eviction does: nothing held in memory survives.
 */
async function world(opts: { raftMade?: boolean } = {}) {
  clearHookRoutes();
  const raw = sqliteHost();
  const jobs: string[] = [];
  let alarmAt: number | null = null;
  const ctx = {
    storage: {
      sql: raw.sql, transactionSync: raw.transactionSync,
      getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; },
    },
    id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
  };
  class TestDO extends AgentDO { protected override extraPlugins() { return [pushy]; } }
  const d1 = controlDb();
  const objects = new Map<string, InstanceType<typeof TestDO>>();
  const env: Record<string, unknown> = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
    ARTIFACT_BUCKET: "b", CONTROL_DB: d1.db, HARNESS_MODEL: "m1",
    DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", AUTOMATION_TOKEN: TOKEN,
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n)! },
  };
  const w = {
    raw, jobs, d1, env, hookId: "", secret: "",
    D: new TestDO(ctx as never, env as never),
    alarmAt: () => alarmAt,
    evict() { w.D = new TestDO(ctx as never, env as never); objects.set(agentObjectName(T, A), w.D); return w.D; },
  };
  objects.set(agentObjectName(T, A), w.D);
  await w.D.uiAdoptAgent(T, A, { name: "n", description: "d", avatar: "x" });
  const rt = w.D.runtime();
  await rt.ready();
  await rt.bindOperatorModel(T, A);
  if (opts.raftMade) {
    const agent = await rt.store.loadAgent(T, A);
    await rt.store.updateAgentConfig(T, A, { ...(agent?.config as object), provisionedBy: "raft" } as never);
  }
  await rt.store.setPluginChoice(T, A, "pushy", "enable");
  await rt.store.addMount({ tenantId: T, agentId: A, alias: "p", plugin: "pushy", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  const made = await (await worker.fetch(new Request("https://x/admin/hooks", {
    method: "POST", headers: { "x-harness-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ tenantId: T, agentId: A, alias: "p" }),
  }), env as never)).json() as { hookId: string; secret: string };
  must(/^[A-Za-z0-9_-]{43}$/.test(made.hookId) && made.secret, `hook: ${show(made)}`);
  w.hookId = made.hookId;
  w.secret = made.secret;
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

/** A push as a service sends it; the answer's status and body, and the D1 statements it cost. */
async function push(w: World, id: string, text: string, headers: Record<string, string> = {}, body?: BodyInit) {
  const before = w.d1.log.length;
  const res = await worker.fetch(new Request(`https://x/hooks/${w.hookId}`, {
    method: "POST", headers: { "x-signed-with": w.secret, "content-type": "application/json", ...headers },
    body: body ?? JSON.stringify({ id, text }),
  }), w.env as never);
  return { status: res.status, body: await res.text(), retryAfter: res.headers.get("retry-after"), d1: w.d1.log.slice(before) };
}

/** What the model has been asked so far, as text: one string per job, in the order they were sent. Each is read once. */
const seen = new Map<string, string>();
async function asked(w: World): Promise<string[]> {
  const out: string[] = [];
  for (const id of w.jobs) {
    if (!seen.has(id)) seen.set(id, show(await w.D.takeJob(T, A, id)));
    out.push(seen.get(id)!);
  }
  return out;
}
/** How many times `text` occurs across everything the model was asked, last request only (it carries the history). */
const timesAsked = async (w: World, text: string) => ((await asked(w)).at(-1) ?? "").split(text).length - 1;

/** Alarm passes until the model has been asked `n` things, or the object has nothing due soon. */
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

/** Answer job `i` with text, or with a call to the `p` mount's tool, which keeps the run going. */
async function answer(w: World, i: number, text: string, opts: { callTool?: boolean } = {}) {
  await asked(w);
  const id = w.jobs[i]!;
  const job = JSON.parse(seen.get(id)!) as { model?: { api?: string; provider?: string } };
  const content = opts.callTool
    ? [{ type: "text", text }, { type: "toolCall", id: "call-1", name: "p__noop", arguments: {} }]
    : [{ type: "text", text }];
  await w.D.deliverAnswer(T, A, id, { role: "assistant", content, api: job.model?.api ?? "x", provider: job.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: opts.callTool ? "toolUse" : "stop", timestamp: 0 } as never, 5);
}

const pendingRows = (w: World) => Number((w.raw.sql.exec("SELECT COUNT(*) AS n FROM inbound_pending").toArray()[0] as any).n);
/** A function, not `w.jobs.length`: an assertion would narrow the property to one literal for the rest of a case. */
const jobCount = (w: World) => w.jobs.length;
const outcomes = (w: World) => (w.raw.sql.exec("SELECT outcome FROM inbound_events ORDER BY rowid").toArray() as any[]).map((r) => String(r.outcome));

await check("the answer comes before the turn: nothing is posted when the 202 resolves, the alarm is armed, and the alarm pass starts the turn", async () => {
  const w = await world();
  lines.length = 0;
  const r = await push(w, "n1", "PUSH-ONE");
  must(r.status === 202 && r.body === '{"outcome":"delivered"}', `answer: ${show(r)}`);
  const rt = w.D.runtime();
  const engine = await rt.agent(T, A);
  must(!(await engine.running()), "a run was already going when the answer resolved");
  must(!show(await engine.branch()).includes("PUSH-ONE"), "the push was in the transcript when the answer resolved");
  must(jobCount(w) === 0 && pendingRows(w) === 1, `when the answer resolved: ${jobCount(w)} jobs, ${pendingRows(w)} queued`);
  must(w.alarmAt() !== null && w.alarmAt()! <= Date.now(), `the alarm: ${w.alarmAt()}`);
  const http = lines.find((l) => l.evt === "http" && l.route === "/hooks/:hook");
  must(http?.path === "deferred" && http.lookup === "index" && typeof http.doMs === "number" && typeof http.objectMs === "number", `http line: ${show(http)}`);
  await settle(w, 1);
  must(jobCount(w) === 1 && pendingRows(w) === 0 && await timesAsked(w, "PUSH-ONE") === 1, `after the alarm: ${jobCount(w)} jobs, ${pendingRows(w)} queued`);
  must(show(outcomes(w)) === show(["delivered"]), `records: ${show(outcomes(w))}`);
  const deliver = lines.find((l) => l.evt === "hook.deliver");
  must(deliver?.posted === 1 && typeof deliver.waitedMs === "number", `hook.deliver line: ${show(deliver)}`);
});

await check("no control-plane read on a routed push: the first costs the one index lookup, the next none; the model choice is read in the alarm pass", async () => {
  const w = await world({ raftMade: true });
  const first = await push(w, "n1", "ROUTED-ONE");
  must(first.status === 202 && show(first.d1) === show(["SELECT hook_id, tenant_id, agent_id, alias FROM inbound_hooks WHERE hook_id = ? "]), `first push: ${show(first.d1)}`);
  const second = await push(w, "n2", "ROUTED-TWO");
  must(second.status === 202 && second.d1.length === 0, `second push: ${show(second.d1)}`);
  const before = w.d1.log.length;
  await settle(w, 1);
  const inPass = w.d1.log.slice(before);
  must(inPass.some((q) => /model_overrides/.test(q)), `the alarm pass did not read the model choice: ${show(inPass)}`);
  must(jobCount(w) === 1 && await timesAsked(w, "ROUTED-ONE") === 1 && await timesAsked(w, "ROUTED-TWO") === 1, "the two pushes did not reach the model");
});

await check("dedupe across the answer and the post: an eviction after the 202, the service's retry, and the new instance's alarm post it once", async () => {
  const w = await world();
  must((await push(w, "n1", "ONLY-ONCE")).status === 202, "first");
  w.evict();
  const again = await push(w, "n1", "ONLY-ONCE");
  must(again.status === 202 && again.body === '{"outcome":"duplicate"}', `the retry: ${show(again)}`);
  await settle(w, 1);
  must(await timesAsked(w, "ONLY-ONCE") === 1, `asked ${await timesAsked(w, "ONLY-ONCE")} times`);
  const third = await push(w, "n1", "ONLY-ONCE");
  must(third.body === '{"outcome":"duplicate"}', `after the post: ${show(third)}`);
  must(show(outcomes(w)) === show(["duplicate", "delivered", "duplicate"]), `records: ${show(outcomes(w))}`);
});

await check("two pushes with one key at once: the second is a duplicate and the agent gets one message", async () => {
  const w = await world();
  const [a, b] = await Promise.all([
    push(w, "same", "CONCURRENT", { "x-barrier": "1" }),
    push(w, "same", "CONCURRENT", { "x-barrier": "1" }),
  ]);
  must(show([a.body, b.body].sort()) === show(['{"outcome":"delivered"}', '{"outcome":"duplicate"}']), `answers: ${a.body} ${b.body}`);
  must(pendingRows(w) === 1, `queued: ${pendingRows(w)}`);
  await settle(w, 1);
  must(await timesAsked(w, "CONCURRENT") === 1, `asked ${await timesAsked(w, "CONCURRENT")} times`);
});

await check("a pass that dies before the post is retried after its wait and posts once; one that dies inside the post is not posted again", async () => {
  const w = await world();
  // Dies opening the harness: the row is claimed, never marked, and the instance is gone.
  await push(w, "n1", "DIES-BEFORE");
  const rt = w.D.runtime();
  (rt as any).agent = () => new Promise(() => {});
  void w.D.alarm();
  await sleep(50);
  must(pendingRows(w) === 1, `queued after the dead pass: ${pendingRows(w)}`);
  w.evict();
  await w.D.alarm();
  must(jobCount(w) === 0 && pendingRows(w) === 1, "a claimed row was posted before its wait");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    await settle(w, 1);
  } finally { Date.now = realNow; }
  must(await timesAsked(w, "DIES-BEFORE") === 1 && pendingRows(w) === 0, `after the wait: asked ${await timesAsked(w, "DIES-BEFORE")}`);

  // Dies inside the post, after the engine's write: the next instance must not post it again.
  const v = await world();
  await push(v, "n2", "DIES-INSIDE");
  const engine = await v.D.runtime().agent(T, A);
  const say = engine.say.bind(engine);
  (engine as any).say = async (...a: Parameters<typeof say>) => { await say(...a); return new Promise(() => {}); };
  void v.D.alarm();
  await sleep(100);
  v.evict();
  // Past the row's retry wait, so a row left to be tried again would be.
  try {
    Date.now = () => realNow() + 31_000;
    await settle(v, 2);
  } finally { Date.now = realNow; }
  must(await timesAsked(v, "DIES-INSIDE") === 1, `asked ${await timesAsked(v, "DIES-INSIDE")} times`);
  const rows = v.raw.sql.exec("SELECT outcome, reason FROM inbound_events").toArray() as any[];
  must(rows.length === 1 && rows[0].outcome === "failed" && /may or may not have arrived/.test(rows[0].reason), `record: ${show(rows)}`);
});

await check("a post that throws is retried on its own row and then delivered; one that keeps throwing is given up, recorded as failed with the reason, and still holds its key", async () => {
  const w = await world();
  await push(w, "n1", "FLAKY");
  // The engine's write throws: nothing was written, so the row goes back to the queue.
  const engine = await w.D.runtime().agent(T, A);
  const say = engine.say.bind(engine);
  let fail = 1;
  (engine as any).say = (...a: Parameters<typeof say>) => (fail-- > 0 ? Promise.reject(new Error("harness would not open")) : say(...a));
  await w.D.alarm();
  const row = w.raw.sql.exec("SELECT attempts, state, last_error FROM inbound_pending").toArray() as any[];
  must(row.length === 1 && row[0].attempts === 1 && row[0].state === "queued" && /would not open/.test(row[0].last_error), `after one throw: ${show(row)}`);
  must(w.alarmAt() !== null, "no alarm for the retry");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    await settle(w, 1);
  } finally { Date.now = realNow; }
  must(await timesAsked(w, "FLAKY") === 1 && show(outcomes(w)) === show(["delivered"]), `after the retry: ${show(outcomes(w))}`);

  const v = await world();
  await push(v, "n2", "BROKEN");
  const broken = await v.D.runtime().agent(T, A);
  (broken as any).say = () => Promise.reject(new Error("harness would not open"));
  // The schedule, read pass by pass: a second before each wait ends nothing is tried, a second after it the
  // next attempt is; the fifth attempt fails it, 17.5 minutes after the first.
  const attempts = () => Number((v.raw.sql.exec("SELECT attempts FROM inbound_pending").toArray()[0] as any)?.attempts ?? -1);
  let shift = 0;
  const at = async (ms: number) => { shift = ms; Date.now = () => realNow() + shift; await v.D.alarm(); };
  try {
    await at(0);
    must(attempts() === 1, `first attempt: ${attempts()}`);
    for (const [i, wait] of [30_000, 120_000, 300_000, 600_000].entries()) {
      const tried = shift;
      await at(tried + wait - 1_000);
      must(attempts() === i + 1, `retry ${i + 1} came before its ${wait} ms wait: attempts ${attempts()}`);
      await at(tried + wait + 1_000);
      if (i < 3) must(attempts() === i + 2, `retry ${i + 1} did not come after its ${wait} ms wait: attempts ${attempts()}`);
    }
    must(shift === 1_054_000 && pendingRows(v) === 0, `given up at ${shift} ms, ${pendingRows(v)} queued`);
  } finally { Date.now = realNow; }
  const rec = v.raw.sql.exec("SELECT outcome, reason, dedupe_key FROM inbound_events").toArray() as any[];
  must(pendingRows(v) === 0 && rec.length === 1 && rec[0].outcome === "failed" && /after 5 attempts: harness would not open/.test(rec[0].reason), `given up: ${show(rec)} ${pendingRows(v)} queued`);
  const log = await v.D.hookLog(T, A);
  must(log[0]?.outcome === "failed" && /after 5 attempts/.test(String(log[0]?.reason)), `/admin/hooks recent: ${show(log[0])}`);
  must((await push(v, "n2", "BROKEN")).body === '{"outcome":"duplicate"}', "a given-up key was taken again");
});

await check("two quick pushes reach the agent in the order they arrived", async () => {
  const w = await world();
  await push(w, "x", "FIRST-PUSH");
  await push(w, "y", "SECOND-PUSH");
  await settle(w, 1);
  const q = (await asked(w)).at(-1)!;
  must(q.indexOf("FIRST-PUSH") > 0 && q.indexOf("SECOND-PUSH") > q.indexOf("FIRST-PUSH"), `order: ${q.indexOf("FIRST-PUSH")} ${q.indexOf("SECOND-PUSH")}`);
  must(show(outcomes(w)) === show(["delivered", "delivered"]), show(outcomes(w)));
});

await check("a push during a running turn is a steer: no second run, and the model reads it at the turn's next call, not after the turn", async () => {
  const w = await world();
  await w.D.uiSay(T, A, `t_${A}`, "FROM-THE-PERSON", "steer");
  await settle(w, 1);
  must(jobCount(w) === 1 && await (await w.D.runtime().agent(T, A)).running(), "control: the person's turn is running");
  must((await push(w, "s", "STEER-PUSH")).status === 202, "push");
  await w.D.alarm();
  must(jobCount(w) === 1 && pendingRows(w) === 0, `a push during the turn: ${jobCount(w)} jobs, ${pendingRows(w)} queued`);
  must(!(await asked(w))[0]!.includes("STEER-PUSH"), "the push reached the request already out");
  // The turn goes on (a tool call), so its next model call is inside the same turn: a steer is read there;
  // a follow-up would wait for the turn to end.
  await answer(w, 0, "PERSON-ANSWERED", { callTool: true });
  await settle(w, 2);
  const q = (await asked(w)).at(-1)!;
  must(jobCount(w) === 2 && q.indexOf("PERSON-ANSWERED") > 0 && q.indexOf("STEER-PUSH") > q.indexOf("PERSON-ANSWERED"), `the turn's next request: ${q.indexOf("PERSON-ANSWERED")} ${q.indexOf("STEER-PUSH")}`);
});

await check("every refusal answers as it did: 401, 400, 202 ignored, 202 duplicate, 413, 503, 429, 404, 405, none of them is queued, and only the 429 says when to retry", async () => {
  const w = await world();
  const warm = await push(w, "warm", "warm the route");
  must(warm.status === 202 && warm.retryAfter === null, `control: ${show({ ...warm, d1: undefined })}`);
  const got: Array<[string, number, string]> = [];
  const retry: Array<[string, string | null]> = [];
  const note = (name: string, r: { status: number; body: string; retryAfter: string | null }) => { got.push([name, r.status, r.body]); retry.push([name, r.retryAfter]); };
  note("rejected", await push(w, "r", "t", { "x-signed-with": "wrong" }));
  note("malformed", await push(w, "m", "t", { "x-malformed": "1" }));
  note("ignored", await push(w, "i", "t", {}, JSON.stringify({ id: "i", text: "t", ignore: true })));
  note("duplicate", await push(w, "warm", "warm the route"));
  note("too_large", await push(w, "big", "t", {}, new Uint8Array(1_000_001)));
  note("failed", await push(w, "f", "t", { "x-throw": "1" }));
  const unknown = await worker.fetch(new Request(`https://x/hooks/${"A".repeat(43)}`, { method: "POST", body: "{}" }), w.env as never);
  got.push(["unknown", unknown.status, await unknown.text()]);
  retry.push(["unknown", unknown.headers.get("retry-after")]);
  const shape = await worker.fetch(new Request("https://x/hooks/short", { method: "POST", body: "{}" }), w.env as never);
  got.push(["bad id", shape.status, await shape.text()]);
  retry.push(["bad id", shape.headers.get("retry-after")]);
  const get = await worker.fetch(new Request(`https://x/hooks/${w.hookId}`), w.env as never);
  got.push(["GET", get.status, `${await get.text()}allow=${get.headers.get("allow")}`]);
  retry.push(["GET", get.headers.get("retry-after")]);
  for (let i = 1; i < INBOUND_PER_MINUTE; i++) must((await push(w, `burst-${i}`, "b")).status === 202, `burst ${i}`);
  note("rate_limited", await push(w, "over", "t"));
  must(show(got) === show([
    ["rejected", 401, '{"outcome":"rejected"}'], ["malformed", 400, '{"outcome":"malformed"}'], ["ignored", 202, '{"outcome":"ignored"}'],
    ["duplicate", 202, '{"outcome":"duplicate"}'], ["too_large", 413, '{"outcome":"too_large"}'], ["failed", 503, '{"outcome":"failed"}'],
    ["unknown", 404, ""], ["bad id", 404, ""], ["GET", 405, "allow=POST"], ["rate_limited", 429, '{"outcome":"rate_limited"}'],
  ]), show(got));
  // The burst took well under a second, so the minute opens again in 60 s, give or take the second it took.
  must(show(retry.filter(([n]) => n !== "rate_limited")) === show(retry.filter(([n]) => n !== "rate_limited").map(([n]) => [n, null])), `retry-after: ${show(retry)}`);
  must(/^(59|60)$/.test(String(retry.find(([n]) => n === "rate_limited")?.[1])), `retry-after: ${show(retry)}`);
  must(pendingRows(w) === INBOUND_PER_MINUTE, `queued: ${pendingRows(w)}`);
});

await check("a burst cannot pass the rate while its pushes are still queued", async () => {
  const w = await world();
  const answers = await Promise.all(Array.from({ length: INBOUND_PER_MINUTE + 5 }, (_, i) => push(w, `q${i}`, "burst")));
  const accepted = answers.filter((a) => a.body === '{"outcome":"delivered"}').length;
  const limited = answers.filter((a) => a.status === 429).length;
  must(accepted === INBOUND_PER_MINUTE && limited === 5 && jobCount(w) === 0, `accepted ${accepted}, limited ${limited}`);
});

await check("revocation: a revoked hook answers 404 at once though its route is cached; one whose secret drop failed is routed for at most the TTL", async () => {
  const w = await world();
  must((await push(w, "n1", "x")).status === 202, "control: routed");
  must((await push(w, "n2", "x")).d1.length === 0, "control: the route is cached");
  const revoked = await worker.fetch(new Request("https://x/admin/hooks", {
    method: "POST", headers: { "x-harness-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ revoke: w.hookId }),
  }), w.env as never);
  must((await revoked.json() as { revoked?: boolean }).revoked === true, "revoke");
  const before = outcomes(w).length;
  // Oversized, through the cached route: the hook is unknown before the body is too large.
  const oversized = await push(w, "n3", "x", {}, new Uint8Array(1_000_001));
  must(oversized.status === 404 && oversized.body === "", `an oversized push to the revoked hook: ${show({ ...oversized, d1: undefined })}`);
  const after = await push(w, "n3", "x");
  must(after.status === 404 && after.body === "" && after.d1.length === 1, `after the revoke: ${show(after)}`);
  must(outcomes(w).length === before, `the revoked push left a record: ${show(outcomes(w))}`);
  must((await push(w, "n4", "x")).status === 404, "the route came back");

  // The index says revoked and the object still has the secret: routed from the cache until it expires.
  const v = await world();
  must((await push(v, "m1", "x")).status === 202, "control");
  v.d1.hooks.get(v.hookId)!.revoked_at = Date.now();
  must((await push(v, "m2", "x")).status === 202, "control: within the TTL a stale route still delivers");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + HOOK_ROUTE_TTL_MS + 1;
    const late = await push(v, "m3", "x");
    must(late.status === 404 && late.d1.length === 1, `past the TTL: ${show(late)}`);
  } finally { Date.now = realNow; }
});

await check("a live hook whose secret is gone answers 503 and is recorded once, as before", async () => {
  const w = await world();
  must((await push(w, "n1", "x")).status === 202, "control: routed and cached");
  await w.D.hookDropSecret(T, A, w.hookId);
  const r = await push(w, "n2", "x");
  must(r.status === 503 && r.body === '{"outcome":"failed"}' && r.d1.length === 1, `answer: ${show(r)}`);
  const failed = (w.raw.sql.exec("SELECT reason FROM inbound_events WHERE outcome = 'failed'").toArray() as any[]);
  must(failed.length === 1 && /no secret/.test(failed[0].reason), `records: ${show(failed)}`);
});

await check("while posting keeps failing, a push queued 30 minutes is given up wherever it stands, and the alarm is set for it", async () => {
  const w = await world();
  await push(w, "a", "HEAD");
  await push(w, "b", "BEHIND");
  const engine = await w.D.runtime().agent(T, A);
  (engine as any).say = () => Promise.reject(new Error("posting is down"));
  const realNow = Date.now;
  try {
    await w.D.alarm();
    must(pendingRows(w) === 2 && w.alarmAt() !== null, "control: both queued, the head waiting on its retry");
    const behind = () => (w.raw.sql.exec("SELECT attempts FROM inbound_pending WHERE dedupe_key = 'b'").toArray()[0] as any)?.attempts;
    must(behind() === 0, `the row behind was tried: ${behind()}`);
    Date.now = () => realNow() + 30 * 60_000 + 1_000;
    await w.D.alarm();
  } finally { Date.now = realNow; }
  const rec = w.raw.sql.exec("SELECT dedupe_key, outcome, reason FROM inbound_events ORDER BY rowid").toArray() as any[];
  must(pendingRows(w) === 0 && rec.length === 2 && rec.every((r) => r.outcome === "failed" && /queued for more than 30 minutes/.test(r.reason)),
    `after 30 minutes: ${show(rec)}, ${pendingRows(w)} queued`);
  must(/posting is down/.test(rec[0].reason), `the head's record lost why: ${rec[0].reason}`);
  must(jobCount(w) === 0, "something was posted");
});

await check("a hook with 30 pushes queued is answered as the rate limit answers, and recorded with why; a busy queue whose head is due says retry in 3 s", async () => {
  const w = await world();
  const realNow = Date.now;
  try {
    // Three seconds apart, so the per-minute rate never trips: only the queue can.
    for (let i = 0; i < 30; i++) {
      Date.now = () => realNow() + i * 3_000;
      must((await push(w, `q${i}`, "waiting")).status === 202, `push ${i}`);
    }
    Date.now = () => realNow() + 30 * 3_000;
    const full = await push(w, "q30", "waiting");
    must(full.status === 429 && full.body === '{"outcome":"rate_limited"}' && full.retryAfter === "3", `the 31st: ${show({ ...full, d1: undefined })}`);
  } finally { Date.now = realNow; }
  const last = (w.raw.sql.exec("SELECT outcome, reason FROM inbound_events ORDER BY rowid DESC LIMIT 1").toArray()[0] as any);
  must(last?.outcome === "rate_limited" && /30 pushes from this hook are already waiting/.test(last.reason), `record: ${show(last)}`);
  must(pendingRows(w) === 30, `queued: ${pendingRows(w)}`);
});

await check("a rate-limited push is told to retry when the minute lets it in; once the rate would, a full queue says 3 s", async () => {
  const w = await world();
  const realNow = Date.now;
  const base = realNow();
  const at = async (ms: number, id: string) => { Date.now = () => base + ms; return push(w, id, "r"); };
  try {
    // One a second: the rate fills at the 30th push, and those 30 also fill the queue (the alarm never runs).
    for (let i = 0; i < INBOUND_PER_MINUTE; i++) must((await at(i * 1_000, `r${i}`)).status === 202, `push ${i}`);
    const answers: Array<[number, number, string, string | null]> = [];
    // The oldest counted push, at +0, stops counting at +60 000: the rate refuses until then, rounding up
    // (30.3 s is 31, where rounding to nearest would say 30).
    for (const ms of [29_700, 59_000, 59_999]) {
      const r = await at(ms, `over-${ms}`);
      answers.push([ms, r.status, r.body, r.retryAfter]);
    }
    // At +60 000 the rate lets it in, and the full queue refuses it instead.
    const full = await at(60_000, "over-60000");
    answers.push([60_000, full.status, full.body, full.retryAfter]);
    const limited = '{"outcome":"rate_limited"}';
    must(show(answers) === show([[29_700, 429, limited, "31"], [59_000, 429, limited, "1"], [59_999, 429, limited, "1"], [60_000, 429, limited, "3"]]), show(answers));
  } finally { Date.now = realNow; }
  const reasons = (w.raw.sql.exec("SELECT reason FROM inbound_events WHERE outcome = 'rate_limited' ORDER BY rowid").toArray() as any[]).map((r) => r.reason);
  must(reasons.length === 4 && reasons.slice(0, 3).every((r) => /a minute/.test(r)) && /already waiting/.test(reasons[3]), `records: ${show(reasons)}`);
});

await check("a full queue stuck behind a failing head says to retry at the head's next try, not every 3 s; while a pass is posting it says 3", async () => {
  const w = await world();
  const engine = await w.D.runtime().agent(T, A);
  (engine as any).say = () => Promise.reject(new Error("posting is down"));
  const realNow = Date.now;
  const base = realNow();
  const at = (ms: number) => { Date.now = () => base + ms; };
  const answers: Array<[string, number, string | null]> = [];
  try {
    // 29 queued two seconds apart, so the rate never trips; the head's first try fails at +60 s (next try
    // in 30 s) and its second at +90 s (next try in 2 min, at +210 s).
    for (let i = 0; i < 29; i++) { at(i * 2_000); must((await push(w, `s${i}`, "stuck")).status === 202, `push ${i}`); }
    at(60_000); await w.D.alarm();
    at(90_000); await w.D.alarm();
    const head = (w.raw.sql.exec("SELECT attempts, next_at FROM inbound_pending ORDER BY seq LIMIT 1").toArray()[0] as any);
    must(head.attempts === 2 && head.next_at === base + 210_000, `control: the head is waiting its 2-minute retry: ${show(head)}`);
    must((await push(w, "s29", "stuck")).status === 202, "the 30th");
    at(90_700);
    const stuck = await push(w, "s30", "stuck");
    answers.push(["stuck", stuck.status, stuck.retryAfter]);
    // A pass at work is moving the queue. It claims the head (its next try set 5 min ahead) and then opens the
    // harness, which takes most of a second, before the row reads `posting`: held there, then held in the post.
    const rt = w.D.runtime() as any;
    const open = rt.agent;
    let opened!: () => void, failed!: () => void;
    // Only the post's open is held; the step after the pass opens as usual.
    rt.agent = (...a: unknown[]) => {
      rt.agent = open;
      return new Promise((resolve) => { opened = () => resolve(open.apply(rt, a)); });
    };
    (engine as any).say = () => new Promise<void>((_, fail) => { failed = () => fail(new Error("still down")); });
    const row = () => (w.raw.sql.exec("SELECT state, next_at FROM inbound_pending ORDER BY seq LIMIT 1").toArray()[0] as any);
    at(210_000);
    const pass = w.D.alarm();
    for (let i = 0; i < 100 && !opened; i++) await sleep(5);
    must(opened && row().state === "queued" && row().next_at === base + 510_000, `control: claimed, opening the harness: ${show(row())}`);
    const opening = await push(w, "s31", "stuck");
    answers.push(["opening", opening.status, opening.retryAfter]);
    opened();
    for (let i = 0; i < 100 && !failed; i++) await sleep(5);
    must(failed && row().state === "posting", `control: posting: ${show(row())}`);
    const posting = await push(w, "s32", "stuck");
    answers.push(["posting", posting.status, posting.retryAfter]);
    failed();
    await pass;
  } finally { Date.now = realNow; }
  must(show(answers) === show([["stuck", 429, "120"], ["opening", 429, "3"], ["posting", 429, "3"]]), show(answers));
});

await check("provisioning and the model choice run once in a pass that posts, and not in one that only waits out a retry", async () => {
  const w = await world({ raftMade: true });
  await push(w, "a", "P-ONE");
  await push(w, "b", "P-TWO");
  const choices = (from: number) => w.d1.log.slice(from).filter((q) => /model_overrides/.test(q)).length;
  // Provisioning changes the catalogue, so the harness is rebuilt: the first say of whichever engine is open fails.
  const rt = w.D.runtime();
  const open = rt.agent.bind(rt);
  let fail = 1;
  (rt as any).agent = async (...a: Parameters<typeof open>) => {
    const engine = await open(...a);
    if (!(engine as any).__wrapped) {
      const say = engine.say.bind(engine);
      Object.assign(engine, { __wrapped: true, say: (...b: Parameters<typeof say>) => (fail-- > 0 ? Promise.reject(new Error("once")) : say(...b)) });
    }
    return engine;
  };
  let from = w.d1.log.length;
  await w.D.alarm();
  const failing = choices(from);
  must(failing === 1 && pendingRows(w) === 2, `the pass that tried: ${failing} model-choice reads, ${pendingRows(w)} queued`);
  from = w.d1.log.length;
  await w.D.alarm();
  must(choices(from) === 0 && pendingRows(w) === 2, `the pass that only waited: ${choices(from)} model-choice reads`);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    from = w.d1.log.length;
    await w.D.alarm();
  } finally { Date.now = realNow; }
  must(choices(from) === 1 && pendingRows(w) === 0, `the pass that posted two rows: ${choices(from)} model-choice reads, ${pendingRows(w)} queued`);
});

await check("a settle whose record cannot be written leaves its queued row, and the push is not posted again", async () => {
  const w = await world();
  await push(w, "a", "ATOMIC");
  w.raw.sql.exec("CREATE TRIGGER refuse_events BEFORE INSERT ON inbound_events BEGIN SELECT RAISE(ABORT, 'the record cannot be written'); END");
  let threw = "";
  try { await w.D.alarm(); } catch (e) { threw = String((e as Error).message); }
  must(/cannot be written/.test(threw), `control: the settle failed: ${threw || "it did not"}`);
  must(pendingRows(w) === 1 && outcomes(w).length === 0, `after the failed settle: ${pendingRows(w)} queued, records ${show(outcomes(w))}`);
  w.raw.sql.exec("DROP TRIGGER refuse_events");
  await settle(w, 1);
  must(pendingRows(w) === 0 && await timesAsked(w, "ATOMIC") === 1 && outcomes(w).length === 1, `after: asked ${await timesAsked(w, "ATOMIC")}, ${show(outcomes(w))}`);
});

await check("two hooks whose ids differ only in the last character route apart, from memory and from the colo's cache", async () => {
  const store = new Map<string, string>();
  (globalThis as any).caches = { default: {
    async match(r: Request) { const v = store.get(r.url); return v ? new Response(v) : undefined; },
    async put(r: Request, res: Response) { store.set(r.url, await res.text()); },
    async delete(r: Request) { return store.delete(r.url); },
  } };
  try {
    const w = await world();
    const rt = w.D.runtime();
    await rt.store.addMount({ tenantId: T, agentId: A, alias: "p2", plugin: "pushy", installationId: "i", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
    const ids = ["Z".repeat(42) + "a", "Z".repeat(42) + "b"];
    const secrets: string[] = [];
    for (const [i, id] of ids.entries()) {
      const made = await w.D.hookCreateSecret(T, A, i === 0 ? "p" : "p2", id) as { ok: boolean; secret?: string };
      must(made.ok && made.secret, `secret ${i}`);
      secrets.push(made.secret!);
      w.d1.hooks.set(id, { hook_id: id, tenant_id: T, agent_id: A, alias: i === 0 ? "p" : "p2", created_at: 1, revoked_at: null });
    }
    const send = async (i: number, n: string) => {
      w.hookId = ids[i]!; w.secret = secrets[i]!;
      return push(w, n, "x");
    };
    const aliasOf = (n: string) => (w.raw.sql.exec("SELECT alias, hook_id FROM inbound_pending WHERE dedupe_key = ?", n).toArray()[0] as any);
    const reads: number[] = [];
    const from: unknown[] = [];
    for (const round of ["index", "memory", "cache"]) {
      if (round === "cache") clearHookRoutes();
      for (const i of [0, 1]) {
        const n = `${round}-${i}`;
        lines.length = 0;
        const r = await send(i, n);
        reads.push(r.d1.length);
        from.push(lines.find((l) => l.evt === "http")?.lookup);
        const got = aliasOf(n);
        must(r.status === 202 && got?.alias === (i === 0 ? "p" : "p2") && got.hook_id === ids[i], `${round} ${i}: ${r.status} ${show(got)}`);
      }
    }
    must(show(reads) === show([1, 1, 0, 0, 0, 0]), `index reads per push: ${show(reads)}`);
    must(show(from) === show(["index", "index", "memory", "memory", "cache", "cache"]), `where each route came from: ${show(from)}`);
  } finally { delete (globalThis as any).caches; }
});

await check("the colo's cache serves a route another isolate read, with no index lookup", async () => {
  const store = new Map<string, string>();
  (globalThis as any).caches = { default: {
    async match(r: Request) { const v = store.get(r.url); return v ? new Response(v) : undefined; },
    async put(r: Request, res: Response) { store.set(r.url, await res.text()); },
    async delete(r: Request) { return store.delete(r.url); },
  } };
  try {
    const w = await world();
    must((await push(w, "n1", "x")).d1.length === 1 && store.size === 1, "control: the first push read the index and filled the cache");
    clearHookRoutes();
    lines.length = 0;
    const r = await push(w, "n2", "x");
    must(r.status === 202 && r.d1.length === 0, `from the cache: ${show(r)}`);
    must(lines.find((l) => l.evt === "http")?.lookup === "cache", `lookup: ${show(lines.find((l) => l.evt === "http"))}`);
  } finally { delete (globalThis as any).caches; }
});

console.log(`\n  An inbound hook answers before the turn\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
