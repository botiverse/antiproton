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
  return { status: res.status, body: await res.text(), d1: w.d1.log.slice(before) };
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
  await settle(v, 1);
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
  let shift = 0;
  try {
    for (let i = 0; i < 5; i++) {
      Date.now = () => realNow() + shift;
      await v.D.alarm();
      shift += 16 * 60_000;
    }
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

await check("every refusal answers as it did: 401, 400, 202 ignored, 202 duplicate, 413, 503, 429, 404, 405, and none of them is queued", async () => {
  const w = await world();
  must((await push(w, "warm", "warm the route")).status === 202, "control");
  const got: Array<[string, number, string]> = [];
  const note = (name: string, r: { status: number; body: string }) => got.push([name, r.status, r.body]);
  note("rejected", await push(w, "r", "t", { "x-signed-with": "wrong" }));
  note("malformed", await push(w, "m", "t", { "x-malformed": "1" }));
  note("ignored", await push(w, "i", "t", {}, JSON.stringify({ id: "i", text: "t", ignore: true })));
  note("duplicate", await push(w, "warm", "warm the route"));
  note("too_large", await push(w, "big", "t", {}, new Uint8Array(1_000_001)));
  note("failed", await push(w, "f", "t", { "x-throw": "1" }));
  const unknown = await worker.fetch(new Request(`https://x/hooks/${"A".repeat(43)}`, { method: "POST", body: "{}" }), w.env as never);
  got.push(["unknown", unknown.status, await unknown.text()]);
  const shape = await worker.fetch(new Request("https://x/hooks/short", { method: "POST", body: "{}" }), w.env as never);
  got.push(["bad id", shape.status, await shape.text()]);
  const get = await worker.fetch(new Request(`https://x/hooks/${w.hookId}`), w.env as never);
  got.push(["GET", get.status, `${await get.text()}allow=${get.headers.get("allow")}`]);
  for (let i = 1; i < INBOUND_PER_MINUTE; i++) must((await push(w, `burst-${i}`, "b")).status === 202, `burst ${i}`);
  note("rate_limited", await push(w, "over", "t"));
  must(show(got) === show([
    ["rejected", 401, '{"outcome":"rejected"}'], ["malformed", 400, '{"outcome":"malformed"}'], ["ignored", 202, '{"outcome":"ignored"}'],
    ["duplicate", 202, '{"outcome":"duplicate"}'], ["too_large", 413, '{"outcome":"too_large"}'], ["failed", 503, '{"outcome":"failed"}'],
    ["unknown", 404, ""], ["bad id", 404, ""], ["GET", 405, "allow=POST"], ["rate_limited", 429, '{"outcome":"rate_limited"}'],
  ]), show(got));
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
