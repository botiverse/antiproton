/**
 * The prompt-cache prewarm after a workspace import, and `firstTurn: { reasoning: "off" }` on POST /provision/agents
 * (src/runtime/prewarm.ts), through the Worker's own `fetch` and the whole `AgentDO` under node, as
 * test/workspace-import.ts runs the import:
 *
 * - an import queues exactly one prewarm message; its request is the first turn's own system prompt and tools, byte
 *   for byte, with a one-character user message; it writes no transcript entry, message or job; its tokens reach the
 *   usage outbox and a `model.prewarm` trace row; a redelivery and an import's retry call nothing more;
 * - with instructions it waits until they are applied, so it warms the persona the turn will have;
 * - it is skipped when the first turn has already started, and for a model it is not known to help;
 * - a provider failure is its outcome, never a retry and never the import's;
 * - the consumer's request: chat/completions with a one-token cap, the Responses API with `prewarm`, reasoning as the
 *   first turn's;
 * - `firstTurn`: the first turn's calls are taken with `reasoning: "off"` (every call of it, tool calls included), the
 *   next turn's are not, the prewarm matches the first turn, and a request with it sends DeepSeek `thinking: disabled`;
 *   the field is validated and compared on a replay. Without it every request is the one it was.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { d1ProviderTokens } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import { sha256Hex } from "../src/store/seed-files.ts";
import { consumeModelCalls, type QueuedModelCall } from "../cf/src/model-queue.ts";
import { callPrewarm, callQueuedModel } from "../cf/src/model-request.ts";
import { canonJson } from "../src/core/canon-json.ts";
import { inFirstTurn, prewarmable } from "../src/runtime/prewarm.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { clearHookRoutes } = await import("../cf/src/hook-route.ts");
const { setLogSink } = await import("../src/core/log.ts");
setLogSink(() => {});

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const T = "t-raft", A = "raft_01JCIN", RAFT_ID = "01JCIN";
const RAFT_CRED = "sk_agent_" + "C".repeat(32);

/** A push plugin, so a message can be queued while the agent is held (test/workspace-import.ts). */
const pushy: Plugin = {
  id: "pushy", version: "1.0.0",
  tools: [{ name: "noop", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { return {} as never; },
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

/**
 * The deployment and the agent made by Raft's own `POST /provision/agents` (with `post` added to its body). Every
 * queue message is kept (`sent`); model jobs also by id (`jobs`). `model` is HARNESS_MODEL; `queueFails` makes every
 * send throw.
 */
async function world(opts: { post?: Record<string, unknown>; pushy?: boolean; model?: string; queueFails?: boolean } = {}) {
  clearHookRoutes();
  const DB = d1();
  const raw = sqliteHost();
  const jobs: string[] = [];
  const sent: QueuedModelCall[] = [];
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
  const another = (n: string) => {
    const host = sqliteHost();
    const o = new TestDO({ ...ctx, storage: { ...ctx.storage, sql: host.sql, transactionSync: host.transactionSync }, id: { toString: () => n } } as never, env as never);
    objects.set(n, o);
    return o;
  };
  const R2 = bucket();
  const env: Record<string, unknown> = {
    MODEL_QUEUE: { send: async (m: QueuedModelCall) => {
      if (opts.queueFails) throw new Error("the queue is away");
      sent.push(m);
      if (m.kind !== "prewarm") jobs.push(m.jobId);
    } },
    ARTIFACTS: R2, ARTIFACT_BUCKET: "b", CONTROL_DB: DB, HARNESS_MODEL: opts.model ?? "deepseek-flash",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "k", AUTOMATION_TOKEN: "operator-token",
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    AGENT: { idFromName: (n: string) => n, idFromString: (n: string) => n, get: (n: string) => objects.get(n) ?? another(n) },
  };
  const D = new TestDO(ctx as never, env as never);
  objects.set(agentObjectName(T, A), D);
  objects.set("do-1", D);
  const token = newProviderToken();
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(token), label: "raft-test", raftOrigin: "https://raft.example", scope: "tenant", tenantId: T });
  const w0 = { D, rt: D.runtime(), raw, env, jobs, sent, token, alarmAt: () => alarmAt, hook: { hookId: "", secret: "" } };
  const posted = await provisionPost(w0, opts.post ?? {});
  must(posted.status === 201, `POST /provision/agents: ${posted.status} ${posted.text}`);
  await w0.rt.ready();
  if (opts.pushy) {
    await w0.rt.store.setPluginChoice(T, A, "pushy", "enable");
    await w0.rt.store.addMount({ tenantId: T, agentId: A, alias: "p", plugin: "pushy", installationId: "i-p", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
    const made = await (await worker.fetch(new Request("https://x/admin/hooks", {
      method: "POST", headers: { "x-harness-token": "operator-token", "content-type": "application/json" },
      body: JSON.stringify({ tenantId: T, agentId: A, alias: "p" }),
    }), env as never)).json() as { hookId: string; secret: string };
    w0.hook = made;
  }
  return w0;
}
type World = Awaited<ReturnType<typeof world>>;

async function provisionPost(w: { env: Record<string, unknown>; token: string }, extra: Record<string, unknown>) {
  const real = globalThis.fetch;
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
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, text };
  } finally { globalThis.fetch = real; }
}

const enc = (s: string) => new TextEncoder().encode(s);
const importBody = (migrationId: string, files: Array<{ path: string; text: string }>, extra: Record<string, unknown> = {}) => ({
  migrationId, totalBytes: files.reduce((n, f) => n + enc(f.text).byteLength, 0), ...extra,
  files: files.map((f) => ({ path: f.path, contentBase64: Buffer.from(enc(f.text)).toString("base64"), sha256: sha256Hex(enc(f.text)) })),
});
async function imp(w: World, b: unknown) {
  const res = await worker.fetch(new Request(`https://x/provision/agents/${A}/import`, {
    method: "POST", headers: { authorization: `Bearer ${w.token}` }, body: JSON.stringify(b),
  }), w.env as never);
  return { status: res.status, text: await res.text() };
}
async function push(w: World, id: string, text: string) {
  const res = await worker.fetch(new Request(`https://x/hooks/${w.hook.hookId}`, {
    method: "POST", headers: { "x-signed-with": w.hook.secret, "content-type": "application/json" }, body: JSON.stringify({ id, text }),
  }), w.env as never);
  return res.status;
}

/** The queue consumer as the Worker runs it, with the provider call stood in for; returns what each prewarm was asked. */
function consumer(w: World, prewarm: (job: any) => Promise<any> = async (job) => ({ model: job.operatorModel, outcome: "warmed", ms: 5,
  usage: { input: 9340, output: 1, cacheRead: 0, cacheWrite: 0 } })) {
  const asked: any[] = [];
  const deps = {
    stub: () => w.D as never,
    call: async () => { throw new Error("a model job reached the prewarm consumer"); },
    givenUp: () => null,
    prewarm: async (job: unknown) => { asked.push(job); return prewarm(job); },
  };
  const run = async (messages: QueuedModelCall[], queue = "model-calls") => {
    const acks: string[] = [];
    await consumeModelCalls({ queue, messages: messages.map((body) => ({ body, ack: () => acks.push("ack"), retry: () => acks.push("retry") })) }, deps as never);
    return acks;
  };
  return { asked, run };
}
const prewarms = (w: World) => w.sent.filter((m) => m.kind === "prewarm");

/** Alarm passes until the model has been asked `n` things, or nothing is due soon. */
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
const USAGE = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (jobId: string, r: { text: string } | { call: string }) => ({
  jobId, role: "assistant", api: "offloaded", provider: "openai-compatible", model: "deepseek-flash", usage: USAGE, timestamp: Date.now(),
  content: "text" in r ? [{ type: "text", text: r.text }] : [{ type: "toolCall", id: `c_${jobId}`, name: r.call, arguments: {} }],
  stopReason: "text" in r ? "stop" : "toolUse",
});
const count = (w: World, q: string) => { try { return Number(w.raw.sql.exec(q).toArray()[0]!.n); } catch { return 0; } };
const traceRows = (w: World, kind: string) => {
  let rows: any[] = [];
  try { rows = w.raw.sql.exec("SELECT status, verdict, attrs FROM trace_outbox WHERE kind = ?", kind).toArray().map((r: any) => ({ ...r, attrs: JSON.parse(r.attrs) })); }
  catch { /* no outbox */ }
  // A pass may have exported them already (cf/src/trace-r2.ts).
  return rows;
};
const usageRows = (w: World) => {
  try { return w.raw.sql.exec("SELECT key, quantity FROM usage_outbox WHERE resource = 'model.tokens'").toArray().map((r: any) => ({ key: String(r.key), n: Number(r.quantity) })); }
  catch { return []; }
};
const uuid = () => crypto.randomUUID();

// ---- the prewarm ---------------------------------------------------------------------------------------------------

let firstJobContext: any = null, prewarmJob: any = null;
await check("an import queues one prewarm; its request is the first turn's system prompt and tools byte for byte, with one '.' user message", async () => {
  const w = await world({ pushy: true });
  const id = uuid();
  must((await imp(w, importBody(id, [{ path: "MEMORY.md", text: "# Memory\nPREWARM-MEMORY-7\n" }]))).status === 201, "import");
  must(prewarms(w).length === 1 && prewarms(w)[0]!.jobId === `prewarm_${id}` && prewarms(w)[0]!.doId === "do-1", `messages: ${show(w.sent)}`);
  const c = consumer(w);
  const acks = await c.run(prewarms(w));
  must(show(acks) === show(["ack"]) && c.asked.length === 1, `acks ${show(acks)}, asked ${c.asked.length}`);
  prewarmJob = c.asked[0];
  must(prewarmJob.operatorModel === "deepseek-flash" && prewarmJob.operatorProvider === "deepseek" && !("reasoning" in prewarmJob), show({ ...prewarmJob, context: undefined }));
  const ctx = prewarmJob.context;
  must(show(ctx.messages.map((m: any) => [m.role, m.content])) === show([["user", [{ type: "text", text: "." }]]]), `messages: ${show(ctx.messages)}`);
  must(ctx.systemPrompt.includes("PREWARM-MEMORY-7"), "the prewarm's prompt does not carry the imported memory");
  // Nothing the agent or a person reads: no message, no job, no inbound.
  must(count(w, "SELECT COUNT(*) AS n FROM pi_entries WHERE type = 'message'") === 0, "the prewarm wrote a transcript message");
  must(count(w, "SELECT COUNT(*) AS n FROM pi_model_jobs") === 0 && w.jobs.length === 0, "the prewarm made a model job");
  // The first turn: its own first job carries the same prefix.
  must(await push(w, "e1", "Hi Cindy") === 202, "push");
  await settle(w, 1);
  must(w.jobs.length === 1, `jobs: ${w.jobs.length}`);
  const job = await w.D.takeJob(T, A, w.jobs[0]!) as any;
  firstJobContext = job.context;
  must(job.context.systemPrompt === ctx.systemPrompt, "the first turn's system prompt is not the prewarm's");
  must(canonJson(job.context.tools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters }))) === canonJson(ctx.tools),
    `tools differ: first ${show(job.context.tools.map((t: any) => t.name))} vs prewarm ${show(ctx.tools.map((t: any) => t.name))}`);
  must(job.context.tools.length > 3, `too few tools to mean anything: ${job.context.tools.length}`);
  must(!("reasoning" in job), "a job of an agent without firstTurn carries reasoning");
  must(show(job.context.messages.filter((m: any) => m.role === "user").map((m: any) => m.content)).includes("Hi Cindy")
    && !show(job.context.messages).includes('"text":"."'), "the prewarm's message reached the conversation");
  if (process.env.PREWARM_DUMP) writeFileSync(process.env.PREWARM_DUMP, JSON.stringify({ prewarmJob, firstJob: job }));
});

await check("…metered like any call (usage outbox) and traced as model.prewarm; once: a redelivery and the import's retry call nothing more", async () => {
  const w = await world();
  const id = uuid();
  const b = importBody(id, [{ path: "a.md", text: "x" }]);
  must((await imp(w, b)).status === 201, "import");
  const c = consumer(w);
  await c.run(prewarms(w));
  const usage = usageRows(w);
  must(usage.some((u) => u.key === "deepseek-flash:input" && u.n === 9340) && usage.some((u) => u.key === "deepseek-flash:output" && u.n === 1), `usage: ${show(usage)}`);
  const rows = traceRows(w, "model.prewarm");
  must(rows.length === 1 && rows[0].status === "warmed" && rows[0].verdict === "ok" && rows[0].attrs.inputTokens === 9340, `trace: ${show(rows)}`);
  // The same message again, as the queue may redeliver it, and the import's identical retry (200), which may send it again.
  must((await imp(w, b)).status === 200, "the retry");
  await c.run(prewarms(w));
  must(c.asked.length === 1, `the provider was asked ${c.asked.length} times`);
  must(usageRows(w).length === usage.length && traceRows(w, "model.prewarm").length === 1, "a second report was metered");
  must(show(w.raw.sql.exec("SELECT state, outcome FROM model_prewarm").toArray()) === show([{ state: "done", outcome: "warmed" }]), "row");
});

await check("an import with instructions warms after they are applied, so the prewarm carries the persona the first turn will", async () => {
  const w = await world();
  must((await imp(w, importBody(uuid(), [{ path: "a.md", text: "x" }], { instructions: "CINDY-PERSONA-31" }))).status === 201, "import");
  must(prewarms(w).length === 1, `messages: ${show(w.sent)}`);
  const c = consumer(w);
  await c.run(prewarms(w));
  must(c.asked.length === 1 && c.asked[0].context.systemPrompt.includes("CINDY-PERSONA-31"), "the prewarm's prompt lacks the imported persona");
});

await check("skipped when the first turn has already started (a push held for the import runs at once), with the reason; nothing is called", async () => {
  const w = await world({ post: { awaitImport: true }, pushy: true });
  must(await push(w, "e1", "queued before the import") === 202, "push");
  must((await imp(w, importBody(uuid(), [{ path: "a.md", text: "x" }]))).status === 201, "import");
  await settle(w, 1);
  must(w.jobs.length === 1, `the first turn did not start: ${w.jobs.length}`);
  const c = consumer(w);
  await c.run(prewarms(w));
  must(c.asked.length === 0, "a prewarm was called for an agent already running");
  const row = w.raw.sql.exec("SELECT state, outcome FROM model_prewarm").toArray()[0] as any;
  must(row.state === "done" && /^skipped: the agent has started/.test(row.outcome), show(row));
  must(traceRows(w, "model.prewarm")[0]?.status === "skipped", show(traceRows(w, "model.prewarm")));
});

await check("skipped for a model it is not known to help; prewarmable names DeepSeek's and OpenAI's models only", async () => {
  const w = await world({ model: "m1" });
  must((await imp(w, importBody(uuid(), [{ path: "a.md", text: "x" }]))).status === 201, "import");
  const c = consumer(w);
  await c.run(prewarms(w));
  must(c.asked.length === 0, "called for m1");
  must(/^skipped: m1 is not a model/.test(String((w.raw.sql.exec("SELECT outcome FROM model_prewarm").toArray()[0] as any).outcome)), "reason");
  for (const [m, want] of [["deepseek-flash", true], ["deepseek/deepseek-v4", true], ["openai/gpt-5.6-luna", true], ["anthropic/claude", false], ["m1", false], ["deepseekish/x", false]] as const) {
    must(prewarmable(m) === want, `prewarmable(${m}) is ${!want}`);
  }
});

await check("a provider failure is its outcome: acked, never retried, recorded failed; a queue that refuses the send does not fail the import", async () => {
  const w = await world();
  must((await imp(w, importBody(uuid(), [{ path: "a.md", text: "x" }]))).status === 201, "import");
  const c = consumer(w, async () => { throw new Error("provider 503"); });
  const acks = await c.run(prewarms(w));
  must(show(acks) === show(["ack"]), `acks ${show(acks)}`);
  const row = w.raw.sql.exec("SELECT state, outcome FROM model_prewarm").toArray()[0] as any;
  must(row.state === "done" && /^failed: provider 503/.test(row.outcome), show(row));
  must(traceRows(w, "model.prewarm")[0]?.verdict === "failed", "trace verdict");
  // On the dead letter queue a prewarm is only acked.
  const w2 = await world();
  must((await imp(w2, importBody(uuid(), [{ path: "a.md", text: "x" }]))).status === 201, "import 2");
  const c2 = consumer(w2);
  must(show(await c2.run(prewarms(w2), "model-calls-dlq")) === show(["ack"]) && c2.asked.length === 0, "dlq");
  const w3 = await world({ queueFails: true });
  const r = await imp(w3, importBody(uuid(), [{ path: "a.md", text: "x" }]));
  must(r.status === 201, `the import failed with the queue: ${r.status} ${r.text}`);
});

// ---- the consumer's request ----------------------------------------------------------------------------------------

/** Every request a provider call made, with a canned answer: DeepSeek's chat/completions or OpenAI's Responses. */
async function capture<T>(fn: () => Promise<T>) {
  const real = globalThis.fetch;
  const sent: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith("/responses")) return Response.json({ status: "completed", output: [], usage: { input_tokens: 8049, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } });
    return Response.json({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 9116, completion_tokens: 1, prompt_cache_hit_tokens: 0 } });
  }) as typeof fetch;
  try { return { out: await fn(), sent }; } finally { globalThis.fetch = real; }
}
const ENV = {
  HARNESS_MODEL: "deepseek-flash", DEEPSEEK_API_KEY: "k", GW: "g",
  MODEL_PROVIDERS: [
    { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
    { id: "cloudflare", baseUrl: "https://gw.example/compat", auth: { secret: "GW", header: "cf-aig-authorization" }, modelFormat: "vendor/model" },
  ],
} as any;

await check("chat/completions: the system prompt, '.', the tools, max_tokens 1, no reasoning field unless the first turn has it off", async () => {
  must(prewarmJob, "the first case did not run");
  const { out, sent } = await capture(() => callPrewarm(ENV, prewarmJob));
  must(out.outcome === "warmed" && out.usage?.input === 9116 && out.usage.output === 1, show(out));
  const b = sent[0]!.body;
  must(sent.length === 1 && sent[0]!.url === "https://api.deepseek.com/chat/completions", show(sent.map((s) => s.url)));
  must(b.model === "deepseek-flash" && b.max_tokens === 1 && b.messages.length === 2 && b.messages[0].role === "system"
    && b.messages[0].content === prewarmJob.context.systemPrompt && show(b.messages[1]) === show({ role: "user", content: "." }), show({ ...b, tools: undefined, messages: b.messages.map((m: any) => m.role) }));
  must(!("thinking" in b) && !("reasoning_effort" in b), "a reasoning field on a default prewarm");
  // The first turn's request, built by the consumer from the first job, has the same system message and tools field.
  const turn = await capture(() => callQueuedModel(ENV, { context: firstJobContext, operatorModel: "deepseek-flash", operatorProvider: "deepseek" }, "j1"));
  const tb = turn.sent[0]!.body;
  must(canonJson(tb.tools) === canonJson(b.tools) && show(tb.messages[0]) === show(b.messages[0]), "the first turn's request does not share the prewarm's prefix");
  const off = await capture(() => callPrewarm(ENV, { ...prewarmJob, reasoning: "off" }));
  must(show(off.sent[0]!.body.thinking) === show({ type: "disabled" }), show(off.sent[0]!.body.thinking));
});

await check("Responses (an OpenAI reasoning model): the developer message and tools with prompt_cache_options.prewarm, no user message", async () => {
  const job = { ...prewarmJob, operatorModel: "openai/gpt-5.6-luna", operatorProvider: "cloudflare" };
  const { out, sent } = await capture(() => callPrewarm(ENV, job));
  const b = sent[0]!.body;
  must(sent[0]!.url === "https://gw.example/compat/responses" && out.outcome === "warmed" && out.usage?.input === 8049, show({ url: sent[0]!.url, out }));
  must(show(b.prompt_cache_options) === show({ prewarm: true }) && b.input.length === 1 && b.input[0].role === "developer", show({ ...b, tools: undefined, input: b.input.map((i: any) => i.role) }));
  must(b.reasoning?.effort === "medium", `effort ${show(b.reasoning)}: not the first turn's default`);
  const turn = await capture(() => callQueuedModel(ENV, { context: firstJobContext, operatorModel: "openai/gpt-5.6-luna", operatorProvider: "cloudflare" }, "j1"));
  const tb = turn.sent[0]!.body;
  must(!("prompt_cache_options" in tb) && show(tb.input[0]) === show(b.input[0]) && canonJson(tb.tools) === canonJson(b.tools) && show(tb.reasoning) === show(b.reasoning),
    "the first turn's Responses request does not share the prewarm's prefix");
  const off = await capture(() => callPrewarm(ENV, { ...job, reasoning: "off" }));
  must(off.sent[0]!.body.reasoning?.effort === "none", show(off.sent[0]!.body.reasoning));
});

// ---- firstTurn -----------------------------------------------------------------------------------------------------

await check("firstTurn off: every call of the first turn is taken with reasoning off, tool calls included; the next turn's are not", async () => {
  const w = await world({ pushy: true, post: { firstTurn: { reasoning: "off" } } });
  must((await w.rt.store.loadAgent(T, A) as any)?.config?.firstTurn?.reasoning === "off", "not recorded on the agent");
  must((await imp(w, importBody(uuid(), [{ path: "a.md", text: "x" }]))).status === 201, "import");
  const c = consumer(w);
  await c.run(prewarms(w));
  must(c.asked[0]?.reasoning === "off", `the prewarm does not match the first turn: ${show(c.asked[0]?.reasoning)}`);
  must(await push(w, "e1", "Hi Cindy") === 202, "push");
  await settle(w, 1);
  const j1 = await w.D.takeJob(T, A, w.jobs[0]!) as any;
  must(j1.reasoning === "off", `first call: ${show(j1.reasoning)}`);
  await w.D.deliverAnswer(T, A, w.jobs[0]!, reply(w.jobs[0]!, { call: "p__noop" }), 5);
  await settle(w, 2);
  must(w.jobs.length === 2, `no second call in the first turn: ${w.jobs.length}`);
  const j2 = await w.D.takeJob(T, A, w.jobs[1]!) as any;
  must(j2.reasoning === "off", `the first turn's second call: ${show(j2.reasoning)}`);
  await w.D.deliverAnswer(T, A, w.jobs[1]!, reply(w.jobs[1]!, { text: "Hello! I'm Cindy." }), 5);
  await settle(w, 2);
  must(await push(w, "e2", "Thanks") === 202, "second push");
  await settle(w, 3);
  must(w.jobs.length === 3, `no second turn: ${w.jobs.length}`);
  const j3 = await w.D.takeJob(T, A, w.jobs[2]!) as any;
  must(!("reasoning" in j3), `the second turn ran with ${show(j3.reasoning)}`);
  // A redelivered first-turn job is decided as it was: from its own context.
  must(inFirstTurn(j1.context) && inFirstTurn(j2.context) && !inFirstTurn(j3.context), "inFirstTurn");
  // And the consumer sends it: DeepSeek is told thinking is disabled, on the first turn only.
  const sent1 = await capture(() => callQueuedModel(ENV, j1, w.jobs[0]!));
  const sent3 = await capture(() => callQueuedModel(ENV, j3, w.jobs[2]!));
  must(show(sent1.sent[0]!.body.thinking) === show({ type: "disabled" }) && !("thinking" in sent3.sent[0]!.body), "the request's reasoning field");
});

await check("firstTurn on POST: only { reasoning: \"off\" } or absent/null; a replay must repeat it (409 otherwise); absent records nothing", async () => {
  for (const bad of [{ reasoning: "low" }, { reasoning: "off", extra: 1 }, "off", true, []]) {
    const w = await world();
    const r = await provisionPost({ env: w.env, token: w.token }, { raftAgentId: "01JBAD", firstTurn: bad });
    must(r.status === 422 && r.body?.error?.param === "firstTurn", `firstTurn ${show(bad)}: ${r.status} ${r.text}`);
  }
  const w = await world({ post: { firstTurn: { reasoning: "off" } } });
  must((await provisionPost(w, { firstTurn: { reasoning: "off" } })).status === 200, "the same replay");
  const without = await provisionPost(w, {});
  must(without.status === 409 && /firstTurn/.test(without.text), `a replay without it: ${without.status} ${without.text}`);
  const plain = await world();
  must(!("firstTurn" in ((await plain.rt.store.loadAgent(T, A) as any)?.config ?? {})), "recorded without being asked");
  must((await provisionPost(plain, { firstTurn: null })).status === 200, "null is absent on a replay");
  const asked = await provisionPost(plain, { firstTurn: { reasoning: "off" } });
  must(asked.status === 409, `asking for it on an agent made without: ${asked.status}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
