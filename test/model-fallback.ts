/**
 * The first-turn model fallback (src/model/model-fallback.ts), the busy answer and the object's own retry of a busy
 * turn (src/runtime/busy-retry.ts):
 *
 * - MODEL_FALLBACK is validated: absent is off, every malformed value is refused with its reason and is off;
 * - the busy answer's fixed text matches none of pi-ai's retry or overflow patterns (both pi-ai versions, their own
 *   functions), so no harness retries it;
 * - the consumer (`callQueuedModel`): a primary 503 or 429 past its retries, a hang past the limit, or a transport
 *   failure goes to the fallback once; a 400 never does; both failing is the busy answer, not a throw, and the queue
 *   acks it; an unmarked job is the call it always was;
 * - through the whole `AgentDO` under node (as test/prewarm.ts runs it): only a first-turn call of a `firstTurn` agent on
 *   the operator's DeepSeek model is marked; a busy turn is re-dispatched at +2 and +5 min and then given up, with the
 *   exact `errorClass` on Raft's activity events; the retry survives an eviction, never duplicates a turn a newer
 *   message carried on, carries tool results without re-running them, and the answer is metered under the model that
 *   gave it.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { isContextOverflow as overflow085, isRetryableAssistantError as retryable085 } from "@earendil-works/pi-ai";
import { isRetryableAssistantError as retryable1 } from "pi-ai-1";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { d1ProviderTokens } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import { consumeModelCalls, type QueuedModelCall } from "../cf/src/model-queue.ts";
import { callQueuedModel } from "../cf/src/model-request.ts";
import {
  BUSY_UNDECIDED, busyGivenUp, busyRetrying, MODEL_BUSY_ERROR, modelFallbackFrom, parseModelFallback,
} from "../src/model/model-fallback.ts";
import { providersFrom } from "../src/model/providers.ts";
import { overflowKind } from "../src/runtime/overflow-backstop.ts";
import { activityEvents } from "../src/runtime/activity.ts";
import { inFirstTurn } from "../src/runtime/prewarm.ts";
import { errorMessage } from "../src/model/pi-bridge.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { clearHookRoutes } = await import("../cf/src/hook-route.ts");
const { setLogSink } = await import("../src/core/log.ts");
const logged: Array<{ event: string; [k: string]: unknown }> = [];
setLogSink((line: string) => { const e = JSON.parse(line); logged.push({ ...e, event: e.evt }); });

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

// AbortSignal.timeout's timer does not hold node open, and a hung call waits on nothing else: this does.
const keepAlive = setInterval(() => {}, 1_000);

// The object's clock, moved forward to reach a retry minutes away without waiting for it.
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;

const LUNA = "openai/gpt-5.6-luna";
const PROVIDERS = [
  { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
  { id: "cloudflare", baseUrl: "https://gw.example/compat", auth: { secret: "GW", header: "cf-aig-authorization" }, modelFormat: "vendor/model" },
];
const USER_MODELS = [
  { id: "deepseek-flash", label: "DeepSeek Flash", provider: "deepseek", model: "deepseek-flash" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "cloudflare", model: LUNA },
];
const FALLBACK = { to: "gpt-5.6-luna", scope: "firstTurn", primaryS: 2, fallbackS: 2, retryAfterS: [120, 300] };
const BASE_ENV = { HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "k", GW: "g",
  MODEL_PROVIDERS: PROVIDERS, USER_MODELS };

// ---- the provider, stood in for -------------------------------------------------------------------------------------

type Behaviour = "ok" | "503" | "429" | "400" | "hang" | "network";
/** Every provider request, with how it was answered; `primary` is DeepSeek, `fallback` the gateway. */
const plan: { primary: Behaviour; fallback: Behaviour; sent: Array<{ url: string; body: any }> } = { primary: "ok", fallback: "ok", sent: [] };
const realFetch = globalThis.fetch;
function untilAborted(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
async function answer(b: Behaviour, url: string, init?: RequestInit): Promise<Response> {
  if (b === "hang") return untilAborted(init?.signal);
  if (b === "network") throw new TypeError("fetch failed");
  if (b === "503") return new Response('{"error":{"message":"busy upstream"}}', { status: 503 });
  if (b === "429") return new Response('{"error":{"message":"slow down"}}', { status: 429 });
  if (b === "400") return new Response('{"error":{"message":"bad field","type":"invalid_request_error"}}', { status: 400 });
  if (url.endsWith("/responses")) {
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Hello from the fallback." }] }],
      usage: { input_tokens: 700, output_tokens: 9, input_tokens_details: { cached_tokens: 0 } } });
  }
  return Response.json({ choices: [{ message: { content: "Hello from the primary." }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 7 } });
}
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith("https://api.deepseek.com/")) { plan.sent.push({ url: u, body: JSON.parse(String(init?.body)) }); return answer(plan.primary, u, init); }
  if (u.startsWith("https://gw.example/")) { plan.sent.push({ url: u, body: JSON.parse(String(init?.body)) }); return answer(plan.fallback, u, init); }
  return realFetch(url as never, init);
}) as typeof fetch;
const using = (primary: Behaviour, fallback: Behaviour) => { plan.primary = primary; plan.fallback = fallback; plan.sent = []; };

// ---- configuration --------------------------------------------------------------------------------------------------

await check("MODEL_FALLBACK: absent or empty is off; a valid value resolves its USER_MODELS id; fallbackS defaults to 50", () => {
  const providers = providersFrom(BASE_ENV);
  must(show(modelFallbackFrom({ ...BASE_ENV }, providers)) === show({ config: null }), "absent");
  must(show(modelFallbackFrom({ ...BASE_ENV, MODEL_FALLBACK: "" }, providers)) === show({ config: null }), "empty");
  const on = modelFallbackFrom({ ...BASE_ENV, MODEL_FALLBACK: JSON.stringify({ to: "gpt-5.6-luna", scope: "firstTurn", primaryS: 60, retryAfterS: [120, 300] }) }, providers);
  must(show(on) === show({ config: { to: "gpt-5.6-luna", provider: "cloudflare", model: LUNA, scope: "firstTurn", primaryMs: 60_000, fallbackMs: 50_000, retryAfterMs: [120_000, 300_000] } }), show(on));
});

await check("MODEL_FALLBACK: every malformed value is refused with its reason, and is off", () => {
  const providers = providersFrom(BASE_ENV);
  const offered = modelFallbackFrom({ ...BASE_ENV, MODEL_FALLBACK: FALLBACK }, providers);
  must(offered.config !== null, `the base case is refused: ${offered.error}`);
  const cases: Array<[unknown, RegExp]> = [
    ["{not json", /not JSON/],
    [[FALLBACK], /is an object/],
    [{ ...FALLBACK, extra: 1 }, /unknown field extra/],
    [{ ...FALLBACK, scope: "everyTurn" }, /scope is "firstTurn"/],
    [{ ...FALLBACK, to: "gpt-9" }, /not a USER_MODELS option offered now/],
    [{ ...FALLBACK, to: "deepseek-flash" }, /is a DeepSeek model/],
    [{ ...FALLBACK, primaryS: 0 }, /primaryS is whole seconds/],
    [{ ...FALLBACK, primaryS: 1.5 }, /primaryS is whole seconds/],
    [{ ...FALLBACK, primaryS: "60" }, /primaryS is whole seconds/],
    [{ ...FALLBACK, fallbackS: 111 }, /fallbackS is whole seconds from 1 to 110/],
    [{ ...FALLBACK, primaryS: 111 }, /primaryS is whole seconds from 1 to 110/],
    // Together past the redelivery bound (FALLBACK_TOTAL_MAX_S): the brief's first example, and one second over.
    [{ ...FALLBACK, primaryS: 60, fallbackS: 300 }, /fallbackS is whole seconds from 1 to 110/],
    [{ ...FALLBACK, primaryS: 60, fallbackS: 51 }, /add up to 111 s, more than 110 s/],
    [{ ...FALLBACK, primaryS: 61, fallbackS: undefined }, /\(default 50\) add up to 111 s/],
    [{ ...FALLBACK, retryAfterS: 120 }, /retryAfterS is a list/],
    [{ ...FALLBACK, retryAfterS: [120, -1] }, /retryAfterS is a list/],
  ];
  for (const [raw, why] of cases) {
    const r = modelFallbackFrom({ ...BASE_ENV, MODEL_FALLBACK: raw }, providers);
    must(r.config === null && why.test(r.error ?? ""), `${show(raw)}: ${show(r)}`);
  }
  // An option whose provider's secret is unset is not offered, so it is no fallback either.
  const noKey = modelFallbackFrom({ ...BASE_ENV, GW: undefined, MODEL_FALLBACK: FALLBACK }, providersFrom({ ...BASE_ENV, GW: undefined }));
  must(noKey.config === null && /not a USER_MODELS option offered now/.test(noKey.error ?? ""), show(noKey));
  let refused = "";
  try { parseModelFallback(FALLBACK, []); } catch (e) { refused = String((e as Error).message); }
  must(/not a USER_MODELS option/.test(refused), `parse with nothing offered: ${refused}`);
});

await check("the busy answer's fixed text and its sentences match no retry or overflow pattern of either pi-ai, run as pi-ai runs them", () => {
  const texts = [MODEL_BUSY_ERROR, BUSY_UNDECIDED, busyRetrying(120_000), busyRetrying(300_000), busyGivenUp(3)];
  for (const t of texts) {
    const m = { ...errorMessage(t, { api: "offloaded", provider: "openai-compatible", id: "deepseek-flash" }) };
    must(!retryable085(m as never) && !retryable1(m as never), `retryable: ${t}`);
    must(!overflow085(m as never) && overflowKind(m) === null, `read as an overflow: ${t}`);
  }
  // The control: the same functions do retry a text they should, so the assertions above can redden.
  const control = errorMessage("model 503: service unavailable", { api: "offloaded", provider: "openai-compatible", id: "deepseek-flash" });
  must(retryable085(control as never) && retryable1(control as never), "the control is not retryable: the check above proves nothing");
  for (const t of [busyRetrying(120_000), busyRetrying(300_000), busyGivenUp(3)]) must(t.length <= 120, `over Raft's 120: ${t.length} ${t}`);
  must(busyRetrying(120_000) === "model_busy: primary and fallback model both unavailable; retrying in 2 min", busyRetrying(120_000));
  must(busyRetrying(300_000).endsWith("retrying in 5 min") && /^model_unavailable: .*giving up$/.test(busyGivenUp(3)), busyGivenUp(3));
});

await check("inFirstTurn: a busy answer does not end the first turn; any other failed answer still does", () => {
  const user = { role: "user", content: "Hi", timestamp: 1 };
  const busy = { ...errorMessage(MODEL_BUSY_ERROR, { api: "offloaded", provider: "openai-compatible", id: "deepseek-flash" }), providerError: busyGivenUp(3) };
  const other = errorMessage("model refused (HTTP 400, permanent): see the turn's error", { api: "offloaded", provider: "openai-compatible", id: "deepseek-flash" });
  must(inFirstTurn({ messages: [user, busy, user] }), "a busy answer ended the first turn");
  // The control: the same position with another failure is the turn's end, so the assertion above can redden.
  must(!inFirstTurn({ messages: [user, other, user] }), "another failure no longer ends the first turn");
});

// ---- the consumer ---------------------------------------------------------------------------------------------------

const CONTEXT = { systemPrompt: "You are Cindy.", messages: [{ role: "user", content: [{ type: "text", text: "Hi" }], timestamp: 1 }], tools: [] };
const JOB_ENV = { ...BASE_ENV } as any;
const marked = (primaryMs = 2000, fallbackMs = 2000) => ({ context: CONTEXT, operatorModel: "deepseek-flash", operatorProvider: "deepseek", reasoning: "off",
  fallback: { provider: "cloudflare", model: LUNA, primaryMs, fallbackMs } });
const urls = () => plan.sent.map((s) => s.url.replace(/^https:\/\/([^/]+).*\/([a-z_]+)$/, "$1/$2"));

for (const [primary, outcome] of [["503", "http_5xx"], ["429", "http_429"], ["network", "network"]] as const) {
  await check(`consumer: a primary ${primary} past its in-call retries goes to the fallback once, which answers and is named on the answer`, async () => {
    using(primary, "ok");
    const a = await callQueuedModel(JOB_ENV, marked(), "mj_1") as any;
    must(show(urls()) === show(["api.deepseek.com/completions", "api.deepseek.com/completions", "api.deepseek.com/completions", "gw.example/responses"]), show(urls()));
    must(a.stopReason === "stop" && a.model === LUNA && a.jobId === "mj_1" && a.usage.input === 700, show({ ...a, content: undefined }));
    must(a.fallback.fallbackFrom === "deepseek-flash" && a.fallback.primaryOutcome === outcome && typeof a.fallback.primaryMs === "number" && !("fallbackOutcome" in a.fallback), show(a.fallback));
    // The same turn's settings, in the fallback's own form: Luna's reasoning off is effort "none".
    const b = plan.sent[3]!.body;
    must(b.model === LUNA && b.reasoning?.effort === "none" && b.input[0].role === "developer" && b.input[1].content === "Hi", show(b));
    const ev = logged.filter((e) => e.event === "model_job.fallback").pop();
    must(ev?.outcome === "answered" && ev.primaryOutcome === outcome && ev.to === LUNA, show(ev));
  });
}

await check("consumer: a primary that hangs past its limit goes to the fallback, within the limit", async () => {
  using("hang", "ok");
  const t0 = realNow();
  const a = await callQueuedModel(JOB_ENV, marked(150), "mj_2") as any;
  const ms = realNow() - t0;
  must(a.model === LUNA && a.fallback.primaryOutcome === "timeout" && a.fallback.primaryMs >= 140 && ms < 1500, show({ ms, f: a.fallback }));
});

await check("consumer: a primary 400 is the refusal it always was; the fallback is never called", async () => {
  using("400", "ok");
  const a = await callQueuedModel(JOB_ENV, marked(), "mj_3") as any;
  must(show(urls()) === show(["api.deepseek.com/completions"]), `called: ${show(urls())}`);
  must(a.stopReason === "error" && /HTTP 400/.test(a.providerError) && a.fallback.primaryOutcome === "refused_400" && !a.fallback.fallbackFrom, show(a));
});

for (const fb of ["503", "hang", "400"] as const) {
  await check(`consumer: primary down and the fallback ${fb}: the busy answer, delivered and not thrown`, async () => {
    using("503", fb);
    const a = await callQueuedModel(JOB_ENV, marked(2000, 200), "mj_4") as any;
    must(a.stopReason === "error" && a.errorMessage === MODEL_BUSY_ERROR && a.providerError === BUSY_UNDECIDED && a.jobId === "mj_4", show(a));
    must(a.fallback.fallbackFrom === "deepseek-flash" && a.fallback.primaryOutcome === "http_5xx"
      && a.fallback.fallbackOutcome === ({ "503": "http_5xx", hang: "timeout", "400": "refused_400" })[fb], show(a.fallback));
    // The fallback is called once: its own in-call retries are its client's, never a second fallback.
    must(plan.sent.filter((s) => s.url.startsWith("https://gw.example/")).length === (fb === "503" ? 3 : 1), show(urls()));
  });
}

await check("consumer: an unmarked job is the call it always was — a 503 past its retries throws, so the queue retries it", async () => {
  using("503", "ok");
  const { fallback: _f, ...plain } = marked();
  let thrown: unknown = null;
  try { await callQueuedModel(JOB_ENV, plain, "mj_5"); } catch (e) { thrown = e; }
  must(thrown && /model 503/.test(String((thrown as Error).message)), `not thrown: ${String(thrown)}`);
  must(plan.sent.every((s) => s.url.startsWith("https://api.deepseek.com/")), show(urls()));
  using("ok", "ok");
  const ok = await callQueuedModel(JOB_ENV, plain, "mj_6") as any;
  must(!("fallback" in ok) && ok.model === "deepseek-flash", show(ok));
});

await check("queue: a busy answer is acked and delivered, never sent back to the queue", async () => {
  using("503", "503");
  const delivered: unknown[] = [];
  const acks: string[] = [];
  await consumeModelCalls({ queue: "antiproton-model", messages: [{ body: { doId: "d", tenantId: "t", agentId: "a", jobId: "mj_7" }, ack: () => acks.push("ack"), retry: () => acks.push("retry") }] }, {
    stub: () => ({ takeJob: async () => marked(2000, 200), releaseJob: async () => true, deliverAnswer: async (_t: string, _a: string, _j: string, ans: unknown) => { delivered.push(ans); return true; } }),
    call: (job, m) => callQueuedModel(JOB_ENV, job, m.jobId),
    givenUp: () => null,
  });
  must(show(acks) === show(["ack"]) && (delivered[0] as any)?.errorMessage === MODEL_BUSY_ERROR, show({ acks, delivered }));
});

// ---- the whole object -----------------------------------------------------------------------------------------------

const T = "t-raft", A = "raft_01JCIN", RAFT_ID = "01JCIN";
const RAFT_CRED = "sk_agent_" + "C".repeat(32);
let noopRuns = 0;
const pushy: Plugin = {
  id: "pushy", version: "1.0.0",
  tools: [{ name: "noop", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { noopRuns += 1; return {} as never; },
  async receive(event, secret) {
    if (event.headers["x-signed-with"] !== secret) return { deliver: false, reason: "bad signature", rejected: true };
    const body = JSON.parse(new TextDecoder().decode(event.body)) as { id: string; text: string };
    return { deliver: true, text: body.text, dedupeKey: body.id };
  },
};

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
  return { prepare: (q: string) => stmt(q), batch: async (s: any[]) => s.map((x) => ({ results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } })) } as unknown as D1Database;
}
function bucket() {
  const objects = new Map<string, Uint8Array>();
  const view = (key: string, bytes: Uint8Array) => ({ key, size: bytes.byteLength, uploaded: new Date(1), httpMetadata: {},
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  return {
    objects,
    put: async (key: string, body: Uint8Array | string) => { objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body)); return {}; },
    get: async (key: string) => (objects.has(key) ? view(key, objects.get(key)!) : null),
    head: async (key: string) => (objects.has(key) ? view(key, objects.get(key)!) : null),
    delete: async (keys: string | string[]) => { for (const k of [keys].flat()) objects.delete(k); },
    list: async (o: { prefix?: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((k) => view(k, objects.get(k)!)), delimitedPrefixes: [], truncated: false }),
  };
}

/** The deployment, and an agent made by Raft's `POST /provision/agents` with `post` added, a push mount on it. */
async function world(opts: { post?: Record<string, unknown>; fallback?: unknown } = {}) {
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
  const R2 = bucket();
  const objects = new Map<string, InstanceType<typeof TestDO>>();
  // Any other object the Worker addresses (not this agent's) gets storage of its own.
  const another = (n: string) => {
    const host = sqliteHost();
    const o = new TestDO({ ...ctx, storage: { ...ctx.storage, sql: host.sql, transactionSync: host.transactionSync }, id: { toString: () => n } } as never, env as never);
    objects.set(n, o);
    return o;
  };
  const env: Record<string, unknown> = {
    ...BASE_ENV,
    ...(opts.fallback === undefined ? {} : { MODEL_FALLBACK: opts.fallback }),
    MODEL_QUEUE: { send: async (m: QueuedModelCall) => { if (m.kind !== "prewarm") jobs.push(m.jobId); } },
    ARTIFACTS: R2, ARTIFACT_BUCKET: "b", CONTROL_DB: DB, AUTOMATION_TOKEN: "operator-token",
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    AGENT: { idFromName: (n: string) => n, idFromString: (n: string) => n, get: (n: string) => objects.get(n) ?? another(n) },
  };
  const w = {
    D: new TestDO(ctx as never, env as never), raw, env, jobs, R2, DB, token: newProviderToken(), alarmAt: () => alarmAt, hook: { hookId: "", secret: "" },
    /** A new instance on the same storage, as after an eviction. */
    evict() { w.D = new TestDO(ctx as never, env as never); objects.set(agentObjectName(T, A), w.D); objects.set("do-1", w.D); },
  };
  objects.set(agentObjectName(T, A), w.D);
  objects.set("do-1", w.D);
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(w.token), label: "raft-test", raftOrigin: "https://raft.example", scope: "tenant", tenantId: T });
  const posted = await provisionPost(w, opts.post ?? {});
  must(posted.status === 201, `POST /provision/agents: ${posted.status} ${posted.text}`);
  const rt = w.D.runtime();
  await rt.ready();
  await rt.store.setPluginChoice(T, A, "pushy", "enable");
  await rt.store.addMount({ tenantId: T, agentId: A, alias: "p", plugin: "pushy", installationId: "i-p", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  w.hook = await (await worker.fetch(new Request("https://x/admin/hooks", {
    method: "POST", headers: { "x-harness-token": "operator-token", "content-type": "application/json" },
    body: JSON.stringify({ tenantId: T, agentId: A, alias: "p" }),
  }), env as never)).json() as { hookId: string; secret: string };
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

async function provisionPost(w: { env: Record<string, unknown>; token: string }, extra: Record<string, unknown>) {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    if (String(url) === "https://raft.example/internal/agent-api" && headers.get("authorization") === `Bearer ${RAFT_CRED}`) {
      return Response.json({ agentId: "ag-1", agentName: "cindy", agentDisplayName: "Cindy", serverId: "srv-1" });
    }
    return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  }) as typeof fetch;
  try {
    const res = await worker.fetch(new Request("https://x/provision/agents", {
      method: "POST", headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" },
      body: JSON.stringify({ raftAgentId: RAFT_ID, raftServerId: "srv-1", raftOrigin: "https://raft.example", name: "Cindy", instructions: "", credential: RAFT_CRED, ...extra }),
    }), w.env as never);
    return { status: res.status, text: await res.text() };
  } finally { globalThis.fetch = prev; }
}
async function push(w: World, id: string, text: string) {
  const res = await worker.fetch(new Request(`https://x/hooks/${w.hook.hookId}`, {
    method: "POST", headers: { "x-signed-with": w.hook.secret, "content-type": "application/json" }, body: JSON.stringify({ id, text }),
  }), w.env as never);
  return res.status;
}
/** Alarm passes until `n` model jobs exist (0: until nothing is due soon). */
async function settle(w: World, n = 0) {
  const deadline = realNow() + 15_000;
  for (;;) {
    await w.D.alarm();
    if (n > 0 && w.jobs.length >= n) return;
    const at = w.alarmAt();
    if (realNow() > deadline || at === null || at - Date.now() > 5_000) return;
    await sleep(Math.min(Math.max(0, at - Date.now()), 50));
  }
}
/** The queue consumer as the Worker runs it, with the provider stood in for (`plan`), for job `i`. */
async function consume(w: World, i: number, primary: Behaviour, fallback: Behaviour) {
  using(primary, fallback);
  const acks: string[] = [];
  await consumeModelCalls({ queue: "antiproton-model", messages: [{ body: { doId: "do-1", tenantId: T, agentId: A, jobId: w.jobs[i]! }, ack: () => acks.push("ack"), retry: () => acks.push("retry") }] }, {
    stub: () => w.D as never,
    call: (job, m) => callQueuedModel(w.env as never, job, m.jobId),
    givenUp: () => null,
  });
  must(show(acks) === show(["ack"]), `job ${i}: ${show(acks)}`);
}
/** Read through a call, so an assertion on the count does not narrow it for the next (TS2367). */
const jobCount = (w: World) => w.jobs.length;
/** What the queue consumer would be handed for job `i`, read without taking it. */
const peek = (w: World, i: number) => {
  const r = w.raw.sql.exec("SELECT request FROM pi_model_jobs WHERE id = ?", w.jobs[i]!).toArray()[0] as any;
  return JSON.parse(r.request);
};
/** Every trace row the agent wrote, exported (R2) or not. */
function traceRows(w: World): any[] {
  const bySeq = new Map<number, any>();
  for (const [k, v] of w.R2.objects) if (k.endsWith(".ndjson")) for (const line of new TextDecoder().decode(v).split("\n")) if (line) { const r = JSON.parse(line); bySeq.set(r.seq, r); }
  try { for (const r of w.raw.sql.exec("SELECT * FROM trace_outbox").toArray() as any[]) bySeq.set(Number(r.seq), { ...r, seq: Number(r.seq), attrs: JSON.parse(r.attrs) }); } catch { /* none */ }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
const fatal = (w: World) => activityEvents(A, traceRows(w)).filter((e) => e.hookEventName === "BridgeFatal").map((e) => e.errorClass);
const busyRow = (w: World) => w.raw.sql.exec("SELECT attempts, state, due_at FROM model_busy_retry").toArray()[0] as any;
/** Move the clock past the scheduled retry and run the passes it wakes. */
async function reachRetry(w: World) {
  const due = Number(busyRow(w).due_at);
  // The pass rounds a wake up to 50 ms from its own end (cf/src/index.ts `alarm`).
  must(w.alarmAt() !== null && w.alarmAt()! <= due + 1_000, `no wake is armed for the retry at ${due}: alarm ${w.alarmAt()}`);
  skew += due - Date.now() + 10;
  await settle(w, w.jobs.length + 1);
  const ev = logged.filter((e) => e.event === "model_job.busy_retry").pop();
  must(ev?.outcome === "started", `the retry did not start: ${show(ev)}`);
}
const userTexts = (ctx: any) => ctx.messages.filter((m: any) => m.role === "user").map((m: any) => JSON.stringify(m.content));
const ON = JSON.stringify(FALLBACK);

await check("only a first-turn call of a firstTurn agent on the operator's DeepSeek model is marked; its second turn is not", async () => {
  const w = await world({ post: { firstTurn: { reasoning: "off" } }, fallback: ON });
  must(await push(w, "e1", "Hi Cindy") === 202, "push");
  await settle(w, 1);
  const job = await w.D.takeJob(T, A, w.jobs[0]!) as any;
  must(show(job.fallback) === show({ provider: "cloudflare", model: LUNA, primaryMs: 2000, fallbackMs: 2000 }), show(job.fallback));
  await consume(w, 0, "ok", "ok");
  await settle(w);
  must(await push(w, "e2", "Thanks") === 202, "push 2");
  await settle(w, 2);
  must(!("fallback" in peek(w, 1)) && !("fallback" in (await w.D.takeJob(T, A, w.jobs[1]!) as any)), "the second turn was marked");
  // The primary answered: the call's row records how long it took, and nothing about a fallback.
  const row = traceRows(w).find((r) => r.kind === "model.call");
  must(row && row.attrs.primaryOutcome === "ok" && typeof row.attrs.primaryMs === "number" && !("fallbackFrom" in row.attrs), show(row));
});

await check("not marked: an agent made without firstTurn, an agent bound to another model, and every agent with the feature off", async () => {
  const plain = await world({ fallback: ON });
  must(await push(plain, "e1", "Hi") === 202, "push");
  await settle(plain, 1);
  must(!("fallback" in (await plain.D.takeJob(T, A, plain.jobs[0]!) as any)), "an agent without firstTurn");
  const luna = await world({ post: { firstTurn: { reasoning: "off" }, model: "gpt-5.6-luna" }, fallback: ON });
  must(await push(luna, "e1", "Hi") === 202, "push");
  await settle(luna, 1);
  const lj = await luna.D.takeJob(T, A, luna.jobs[0]!) as any;
  must(lj.operatorModel === LUNA && !("fallback" in lj), `a Luna-bound agent: ${show({ m: lj.operatorModel, f: lj.fallback })}`);
  for (const fallback of [undefined, "{broken"]) {
    const off = await world({ post: { firstTurn: { reasoning: "off" } }, fallback });
    must(await push(off, "e1", "Hi") === 202, "push");
    await settle(off, 1);
    const job = await off.D.takeJob(T, A, off.jobs[0]!) as any;
    must(show(Object.keys(job).sort()) === show(["context", "model", "operatorModel", "operatorProvider", "options", "reasoning"].filter((k) => k in job).sort()) && !("fallback" in job),
      `feature ${show(fallback)}: ${show(Object.keys(job))}`);
    // And a busy-shaped failure is the old failure: thrown, so the queue retries it.
    using("503", "ok");
    let thrown = false;
    try { await callQueuedModel(off.env as never, job, off.jobs[0]!); } catch { thrown = true; }
    must(thrown && plan.sent.every((s) => s.url.startsWith("https://api.deepseek.com/")), `feature ${show(fallback)}: not the old failure`);
  }
});

await check("a busy first turn: model_busy at +2 min, re-dispatched as the same turn; at +5 min; then model_unavailable and no more", async () => {
  const w = await world({ post: { firstTurn: { reasoning: "off" } }, fallback: ON });
  must(await push(w, "e1", "Hi Cindy") === 202, "push");
  await settle(w, 1);
  const first = peek(w, 0);
  await consume(w, 0, "503", "503");
  await settle(w);
  must(show(fatal(w)) === show(["model_busy: primary and fallback model both unavailable; retrying in 2 min"]), `activity: ${show(fatal(w))}`);
  const row = traceRows(w).find((r) => r.kind === "model.call");
  must(row.status === "error" && row.attrs.fallbackFrom === "deepseek-flash" && row.attrs.primaryOutcome === "http_5xx" && typeof row.attrs.primaryMs === "number"
    && row.attrs.fallbackOutcome === "http_5xx", show(row.attrs));
  must(busyRow(w).state === "scheduled" && busyRow(w).attempts === 1 && Math.abs(Number(busyRow(w).due_at) - Date.now() - 120_000) < 5_000, show(busyRow(w)));
  must(jobCount(w) === 1, `something ran before the retry was due: ${w.jobs.length}`);
  // +2 min: the same turn again, the busy answer not in it, still the first turn (marked).
  await reachRetry(w);
  must(jobCount(w) === 2, `no re-dispatch at +2 min: ${w.jobs.length}`);
  const second = peek(w, 1);
  must(show(userTexts(second.context)) === show(userTexts(first.context)) && second.context.messages.length === first.context.messages.length,
    `not the same turn: ${show(userTexts(second.context))} vs ${show(userTexts(first.context))}`);
  must(inFirstTurn(second.context) && "fallback" in (await w.D.takeJob(T, A, w.jobs[1]!) as any), "the retry is not marked as the first turn");
  await consume(w, 1, "hang", "503");
  await settle(w);
  must(show(fatal(w).slice(1)) === show(["model_busy: primary and fallback model both unavailable; retrying in 5 min"]), `activity: ${show(fatal(w))}`);
  await reachRetry(w);
  must(jobCount(w) === 3, `no re-dispatch at +5 min: ${w.jobs.length}`);
  await consume(w, 2, "503", "400");
  await settle(w);
  must(show(fatal(w).slice(2)) === show(["model_unavailable: primary and fallback model unavailable on 3 attempts; giving up"]), `activity: ${show(fatal(w))}`);
  must(busyRow(w).state === "gave_up" && busyRow(w).due_at === null, show(busyRow(w)));
  skew += 3_600_000;
  await settle(w);
  must(jobCount(w) === 3, `a call after giving up: ${w.jobs.length}`);
  // Given up is not the end of the first turn either: the person's next message is still it, and marked.
  must(await push(w, "e2", "Hello?") === 202, "push 2");
  await settle(w, 4);
  must(jobCount(w) === 4 && "fallback" in (await w.D.takeJob(T, A, w.jobs[3]!) as any), "the message after giving up is not the first turn");
});

await check("the retry survives an eviction, and a redelivered or replayed busy answer decides nothing twice", async () => {
  const w = await world({ post: { firstTurn: { reasoning: "off" } }, fallback: ON });
  must(await push(w, "e1", "Hi") === 202, "push");
  await settle(w, 1);
  await consume(w, 0, "503", "503");
  const before = show(busyRow(w));
  // The same answer again, as a replayed RPC would bring it: the job is answered, nothing moves.
  must(await w.D.deliverAnswer(T, A, w.jobs[0]!, { ...errorMessage(MODEL_BUSY_ERROR, { api: "offloaded", provider: "openai-compatible", id: "deepseek-flash" }), providerError: BUSY_UNDECIDED, jobId: w.jobs[0]! }, 5) === false, "a second delivery was written");
  must(show(busyRow(w)) === before, `${show(busyRow(w))} vs ${before}`);
  await settle(w);
  w.evict();
  await reachRetry(w);
  must(jobCount(w) === 2, `the retry did not survive the eviction: ${w.jobs.length}`);
  must(busyRow(w).state === "redispatched", show(busyRow(w)));
  // Another pass, another alarm: nothing more.
  await w.D.alarm();
  must(jobCount(w) === 2, `a retry ran twice: ${w.jobs.length}`);
});

await check("a newer message before the retry is due carries the turn: no duplicate turn at +2 min", async () => {
  const w = await world({ post: { firstTurn: { reasoning: "off" } }, fallback: ON });
  must(await push(w, "e1", "Hi") === 202, "push");
  await settle(w, 1);
  await consume(w, 0, "503", "503");
  await settle(w);
  must(await push(w, "e2", "Are you there?") === 202, "push 2");
  await settle(w, 2);
  must(jobCount(w) === 2, `the newer message ran no call: ${w.jobs.length}`);
  const job = await w.D.takeJob(T, A, w.jobs[1]!) as any;
  must("fallback" in job && show(userTexts(job.context)).includes("Are you there?") && show(userTexts(job.context)).includes("Hi"), "the newer run is not the first turn carried on");
  await consume(w, 1, "ok", "ok");
  await settle(w);
  skew += 130_000;
  await settle(w);
  must(jobCount(w) === 2, `the old turn was re-dispatched after the newer one: ${w.jobs.length}`);
  must(busyRow(w).state === "superseded", show(busyRow(w)));
});

await check("a busy call mid tool loop: the retry carries the tool's result and does not run the tool again; recovery ends the first turn", async () => {
  const w = await world({ post: { firstTurn: { reasoning: "off" } }, fallback: ON });
  must(await push(w, "e1", "Hi") === 202, "push");
  await settle(w, 1);
  const j0 = w.jobs[0]!;
  await w.D.takeJob(T, A, j0);
  await w.D.deliverAnswer(T, A, j0, {
    jobId: j0, role: "assistant", api: "offloaded", provider: "openai-compatible", model: "deepseek-flash", timestamp: Date.now(),
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "toolCall", id: "c_1", name: "p__noop", arguments: {} }], stopReason: "toolUse",
  }, 5);
  await settle(w, 2);
  must(jobCount(w) === 2 && noopRuns > 0, `no second call: ${w.jobs.length}, tool runs ${noopRuns}`);
  const runs = noopRuns;
  const busyCtx = peek(w, 1).context;
  await consume(w, 1, "503", "503");
  await settle(w);
  await reachRetry(w);
  must(jobCount(w) === 3, `no retry: ${w.jobs.length}`);
  const again = peek(w, 2).context;
  must(show(again.messages.map((m: any) => [m.role, m.toolCallId ?? null])) === show(busyCtx.messages.map((m: any) => [m.role, m.toolCallId ?? null])),
    `not the busy call's conversation: ${show(again.messages.map((m: any) => m.role))} vs ${show(busyCtx.messages.map((m: any) => m.role))}`);
  must(noopRuns === runs, `the tool ran again: ${noopRuns} vs ${runs}`);
  // The retry is answered by the fallback: metered under the model that answered, and the first turn is over.
  await consume(w, 2, "503", "ok");
  await settle(w);
  // Read where the pass flushed it (cf/src/usage-flush.ts), with whatever is still in the outbox.
  const flushed = (await w.DB.prepare("SELECT key, SUM(quantity) AS n FROM usage_hourly WHERE resource = 'model.tokens' GROUP BY key").all()).results as any[];
  const pending = w.raw.sql.exec("SELECT key, SUM(quantity) AS n FROM usage_outbox WHERE resource = 'model.tokens' GROUP BY key").toArray() as any[];
  const total = new Map<string, number>();
  for (const r of [...flushed, ...pending]) total.set(String(r.key), (total.get(String(r.key)) ?? 0) + Number(r.n));
  must(total.get(`${LUNA}:input`) === 700 && total.get(`${LUNA}:output`) === 9, `usage: ${show([...total])}`);
  // The primary is metered for the one call it answered (the tool call, 10 in), and nothing of the fallback's.
  must(total.get("deepseek-flash:input") === 10, `metered under the primary: ${show([...total])}`);
  const last = traceRows(w).filter((r) => r.kind === "model.call").pop();
  must(last.status === "stop" && last.attrs.model === LUNA && last.attrs.fallbackFrom === "deepseek-flash", show(last));
  must(await push(w, "e2", "Thanks") === 202, "push 2");
  await settle(w, 4);
  must(!("fallback" in (await w.D.takeJob(T, A, w.jobs[3]!) as any)), "the turn after a recovered first turn is marked");
});

await check("/admin/models shows the fallback in force, or why it was refused", async () => {
  for (const [fallback, want] of [[ON, (b: any) => b.modelFallback?.model === LUNA && !b.modelFallbackError],
    ['{"to":"gpt-5.6-luna"}', (b: any) => !b.modelFallback && /scope/.test(b.modelFallbackError)],
    [undefined, (b: any) => !("modelFallback" in b) && !("modelFallbackError" in b)]] as const) {
    const w = await world({ fallback });
    const b = await (await worker.fetch(new Request("https://x/admin/models", { headers: { "x-harness-token": "operator-token" } }), w.env as never)).json();
    must(want(b), `${show(fallback)}: ${show({ f: (b as any).modelFallback, e: (b as any).modelFallbackError })}`);
  }
});

globalThis.fetch = realFetch;
clearInterval(keepAlive);
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
