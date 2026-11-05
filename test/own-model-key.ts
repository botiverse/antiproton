/**
 * An agent's model calls on its owner's own key (src/model/user-key.ts): the owner stores a Kimi Code key from the
 * model card (`agentModelKey`, cf/src/agent-model.ts, through the real AgentDO's `uiPutModelKey`), the agent is bound
 * to a Kimi model on it, and the queue consumer (`callQueuedModel`) opens the key from the agent's object for each
 * call — never the operator's key, whatever the answer. Both engines are driven through the real runtime over
 * node:sqlite, the real consumer and the real provider call, with only `fetch` replaced. Also: the key never leaves
 * (responses, tables, logs, transcript, the generic secret resolver), its usage is `own:` and unpriced, the rate cap,
 * the spend gate, and the usage page's third price state.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { consumeModelCalls, replyingUnknownJob, type ModelJobStub, type ModelQueueDeps, type ModelQueueMessage } from "../cf/src/model-queue.ts";
import { callQueuedModel, type UserKeys } from "../cf/src/model-request.ts";
import { agentModel, agentModelKey, type AgentModelKeyDeps } from "../cf/src/agent-model.ts";
import { readEntries } from "../cf/src/transcript-read.ts";
import { readDaySpend, SpendGate, spendAdmit, limitsOf } from "../cf/src/spend-limit.ts";
import { readUsage } from "../cf/src/usage-d1.ts";
import { OWN_PAID_TEXT, usagePanel } from "../cf/src/usage.ts";
import { agentModelBlock } from "../cf/src/ui.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { agentSecrets, importKek, MODEL_KEY_PREFIX } from "../src/runtime/secrets.ts";
import { pendingUsage, toHourly, type UsageRow } from "../src/usage/outbox.ts";
import { USER_KEY_CALLS_PER_MINUTE, USER_KEY_ERRORS, USER_KEY_USER_AGENT } from "../src/model/user-key.ts";
import { setLogSink } from "../src/core/log.ts";
import { isRetryableAssistantError as retryable085 } from "@earendil-works/pi-ai";
import { isRetryableAssistantError as retryable1 } from "pi-ai-1";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const USER_KEY = "sk-kimi-OWNERS-OWN-KEY-0123456789abcdef";
const OPERATOR_KEY = "operator-deepseek-key-xyz";
const KEK = Buffer.alloc(32, 7).toString("base64");
const ENV = { DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: OPERATOR_KEY, HARNESS_MODEL: "deepseek-flash" };
const OK_BODY = JSON.stringify({ choices: [{ message: { content: "Sunny." }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 7 } });

/** Every request `fetch` was asked to make, answered by `answer`. */
function fetchAs(answer: (url: string) => Response) {
  const real = globalThis.fetch;
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), headers: { ...(init.headers as Record<string, string>) }, body: String(init.body ?? "") });
    return answer(String(url));
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

/** Log lines and console output while `fn` runs. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  setLogSink((l) => lines.push(l));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try { return { value: await fn(), out: lines.join("\n") }; }
  finally { setLogSink(null); Object.assign(console, saved); }
}

/** Every value in every table of an object's SQLite, as text. */
function everything(sql: any): string {
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r: any) => String(r.name));
  return tables.map((t: string) => JSON.stringify(sql.exec(`SELECT * FROM "${t}"`).toArray())).join("\n");
}

/** D1 as node:sqlite with every migration applied (test/spend-limit.ts's). */
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
  return { raw: db, prepare: (q: string) => stmt(q), batch: async (s: any[]) => s.map((x) => ({ results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } })) } as any;
}

/** The model-card route's deps with no admin row and no owner pick. */
const unlocked = {
  choices: { layers: async () => ({ agent: null, tenant: null, deployment: null, owner: null }), put: async () => {}, remove: async () => {} } as any,
  userModels: { offered: [] }, defaultModel: "deepseek-flash", now: Date.now,
};
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

/**
 * An agent's object as the Worker builds it (AgentDO over node:sqlite), its runtime on `engine`, the owner's key stored
 * through the model card's route when `withKey`, a first turn dispatched, and the consumer's deps wired the way
 * cf/src/index.ts wires them: the key from the object's own `modelKeyFor`, never from the message or the job.
 */
async function agentOn(engine: "pi085" | "pd", opts: { withKey?: boolean } = {}) {
  const host = sqliteHost();
  if (engine === "pd") {
    const ap = new ApStore(host, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const sent: string[] = [];
  const env: Record<string, unknown> = {
    ...ENV, SECRET_KEK: KEK, CONTROL_DB: d1(), ARTIFACT_BUCKET: "b",
    ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
    // What the object's dispatcher sends is the whole queue message: ids, never a key.
    MODEL_QUEUE: { send: async (m: Record<string, unknown>) => { must(show(Object.keys(m).sort()) === show(["agentId", "doId", "jobId", "tenantId"]), show(m)); sent.push(String(m.jobId)); } },
  };
  const o: any = new AgentDO({
    storage: { sql: host.sql, transactionSync: host.transactionSync, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
  } as never, env as never);
  const rt: any = o.runtime();
  await rt.ready();
  await rt.bindOperatorModel("t", "a", null);
  const routeDeps: AgentModelKeyDeps = {
    ...unlocked,
    agent: {
      put: (p, m, k) => o.uiPutModelKey("t", "a", p, m, k),
      remove: () => o.uiRemoveModelKey("t", "a"),
      state: () => o.uiModelKeyState("t", "a"),
    },
  };
  let stored: Response | null = null;
  if (opts.withKey !== false) {
    stored = await agentModelKey("POST", form({ provider: "kimi-code", model: "kimi-for-coding", key: USER_KEY }), { tenantId: "t", agentId: "a", actor: "owner" }, routeDeps);
  }
  await rt.postMessage("t", "a", "What's the weather in Oslo?");
  await rt.step("t", "a");
  must(sent.length >= 1, `${engine}: dispatched ${show(sent)}`);
  const stub: ModelJobStub = {
    takeJob: (t, a, j, taker) => replyingUnknownJob(() => rt.takeJob(t, a, j, taker)),
    releaseJob: (t, a, j, taker) => replyingUnknownJob(() => rt.releaseJob(t, a, j, taker)),
    deliverAnswer: (t, a, j, answer, _ms, taker) => replyingUnknownJob(() => rt.deliverAnswer(t, a, j, answer, taker)),
  };
  const keysFor = (m: { tenantId: string; agentId: string }): UserKeys => ({
    get: (provider) => o.modelKeyFor(m.tenantId, m.agentId, provider),
    refused: (provider, status) => o.modelKeyRefused(m.tenantId, m.agentId, provider, status),
  });
  const deps: ModelQueueDeps = {
    stub: () => stub,
    call: (taken, m) => callQueuedModel(ENV, taken, m.jobId, undefined, undefined, keysFor(m)),
    givenUp: (m) => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "given up", jobId: m.jobId }),
  };
  const q = { acked: 0, retried: 0 };
  const msg = (jobId = sent.at(-1)!): ModelQueueMessage => ({ body: { doId: "do-1", tenantId: "t", agentId: "a", jobId }, ack() { q.acked++; }, retry() { q.retried++; } });
  return { host, rt, o, deps, msg, q, sent, stored, routeDeps };
}

/** Steps the agent until it has nothing due soon, so a harness retry (pd's waits 2 s) would have happened. */
async function settle(rt: any) {
  for (let pass = 0; pass < 3; pass++) {
    const r = await rt.step("t", "a");
    if (r.wakeInMs === null || r.wakeInMs > 10_000) break;
    await new Promise((res) => setTimeout(res, r.wakeInMs! + 50));
  }
}
const lastMessage = (sql: any) => (readEntries(sql, "main").at(-1) as { message?: any } | undefined)?.message;

// ---- storing the key ---------------------------------------------------------------------------------------------

await check("the model card stores the key sealed through the real object: no response, state, table or log line holds it; the card shows the Kimi binding after and not before", async () => {
  const { value: a, out } = await captured(() => agentOn("pi085", { withKey: false }));
  try {
    const before = await (await agentModel("GET", null, { tenantId: "t", agentId: "a", actor: "owner" }, { ...unlocked, ownKey: () => a.o.uiModelKeyState("t", "a") })).json() as any;
    must(before.ownKey === null && before.effective.source === "default" && before.effective.model === "deepseek-flash", `before: ${show(before)}`);
    // The Kimi models are offered on the card before any key, as what the key form picks among.
    must(before.keyProviders?.[0]?.id === "kimi-code" && before.keyProviders[0].models.some((m: any) => m.id === "kimi-for-coding"), show(before.keyProviders));
    const { value: res, out: putOut } = await captured(() => agentModelKey("POST", form({ provider: "kimi-code", model: "kimi-for-coding", key: USER_KEY }),
      { tenantId: "t", agentId: "a", actor: "owner" }, a.routeDeps));
    const text = await res.text();
    must(res.status === 200 && !text.includes(USER_KEY), `${res.status} ${text}`);
    const after = JSON.parse(text);
    must(after.ownKey?.provider === "kimi-code" && after.ownKey.model === "kimi-for-coding" && after.ownKey.refusedAt === null
      && after.effective.source === "own" && after.effective.model === "kimi-for-coding", `after: ${show(after)}`);
    const html = agentModelBlock(after);
    must(!html.includes(USER_KEY) && html.includes("your own key") && html.includes('type="password"'), html);
    const b = await a.rt.store.getModelBinding("t", "a");
    must(b?.secretRef === "user:model:kimi-code" && b.model === "kimi-for-coding" && b.baseUrl === "https://api.kimi.com/coding/v1", show(b));
    const tables = everything(a.host.sql);
    must(!tables.includes(USER_KEY) && !tables.includes("OWNERS-OWN-KEY"), "the key is in the object's tables in the clear");
    const row = a.host.sql.exec("SELECT name FROM secrets WHERE name = ?", `${MODEL_KEY_PREFIX}kimi-code`).toArray();
    must(row.length === 1, `sealed row ${show(row)}`);
    must(!out.includes(USER_KEY) && !putOut.includes(USER_KEY) && putOut.includes("model_key.stored"), putOut);
    // Not among the owner's console secrets, which a mount's {{name}} slot can send anywhere.
    must(show(await a.rt.ownerSecrets("t", "a")) === "[]", show(await a.rt.ownerSecrets("t", "a")));
    // A refused key is not echoed either.
    const bad = await agentModelKey("POST", form({ provider: "kimi-code", model: "kimi-for-coding", key: `${USER_KEY} extra` }), { tenantId: "t", agentId: "a", actor: "owner" }, a.routeDeps);
    const badText = await bad.text();
    must(bad.status === 422 && !badText.includes(USER_KEY), `${bad.status} ${badText}`);
    const unknown = await agentModelKey("POST", form({ provider: "kimi-code", model: "gpt-5", key: USER_KEY }), { tenantId: "t", agentId: "a", actor: "owner" }, a.routeDeps);
    must(unknown.status === 422, `${unknown.status}`);
  } finally { a.host.dispose(); }
});

await check("an admin's agent row refuses a key (409) and stores nothing; on the key, the deployment picker refuses a pick", async () => {
  const a = await agentOn("pi085", { withKey: false });
  try {
    const admin = { ...a.routeDeps, choices: { ...unlocked.choices, layers: async () => ({ agent: { provider: "deepseek", model: "deepseek-flash" }, tenant: null, deployment: null, owner: null }) } };
    const r = await agentModelKey("POST", form({ provider: "kimi-code", model: "kimi-for-coding", key: USER_KEY }), { tenantId: "t", agentId: "a", actor: "owner" }, admin);
    must(r.status === 409 && (await a.rt.store.getModelBinding("t", "a"))?.secretRef === "operator:model", `${r.status}`);
    await agentModelKey("POST", form({ provider: "kimi-code", model: "k3", key: USER_KEY }), { tenantId: "t", agentId: "a", actor: "owner" }, a.routeDeps);
    const pick = await agentModel("POST", form({ choice: "default" }), { tenantId: "t", agentId: "a", actor: "owner" }, { ...unlocked, ownKey: () => a.o.uiModelKeyState("t", "a") });
    must(pick.status === 409 && (await pick.json() as any).error.code === "own_key", `${pick.status}`);
  } finally { a.host.dispose(); }
});

await check("the key is reachable only by the object's own key RPC: asked for another tenant or agent it answers null; no mount reference (agent:, owner:, model:) resolves it", async () => {
  const a = await agentOn("pi085");
  try {
    must(await a.o.modelKeyFor("t", "other", "kimi-code") === null && await a.o.modelKeyFor("t2", "a", "kimi-code") === null, "another agent got an answer");
    must(await a.o.modelKeyRefused("t2", "a", "kimi-code", 401) === false, "another tenant marked the key refused");
    const own = await a.o.modelKeyFor("t", "a", "kimi-code");
    must(own?.kind === "key" && own.key === USER_KEY, `own: ${own?.kind}`);
    const fallback: string[] = [];
    const resolver = agentSecrets(a.rt.store, await importKek(KEK), { async resolve(ref: string) { fallback.push(ref); return null; } } as never);
    const scope = { tenantId: "t", agentId: "a" };
    for (const ref of [`agent:${MODEL_KEY_PREFIX}kimi-code`, `${MODEL_KEY_PREFIX}kimi-code`, "owner:kimi-code", "agent:owner:kimi-code"]) {
      must(await resolver.resolve(ref, scope) === null, `${ref} resolved`);
    }
    must(show(fallback) === show([`${MODEL_KEY_PREFIX}kimi-code`, "owner:kimi-code"]), `went to the operator resolver: ${show(fallback)}`);
  } finally { a.host.dispose(); }
});

// ---- calling on it -------------------------------------------------------------------------------------------------

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: a turn on the owner's key calls Kimi's endpoint with the key as Bearer and antiproton's User-Agent; nothing of the operator's is sent; its tokens are own: and unpriced`, async () => {
    const a = await agentOn(engine);
    try {
      const f = fetchAs(() => new Response(OK_BODY, { status: 200 }));
      try { await consumeModelCalls({ queue: "model-calls", messages: [a.msg()] }, a.deps); } finally { f.restore(); }
      must(f.seen.length === 1 && a.q.acked === 1 && a.q.retried === 0, `calls ${f.seen.length}, queue ${show(a.q)}`);
      const call = f.seen[0]!;
      must(call.url === "https://api.kimi.com/coding/v1/chat/completions", call.url);
      must(call.headers.authorization === `Bearer ${USER_KEY}` && call.headers["user-agent"] === USER_KEY_USER_AGENT, show(call.headers));
      must(!/kimi.?cli|claude|KimiCLI/i.test(call.headers["user-agent"]!), call.headers["user-agent"]);
      must(!JSON.stringify(call).includes(OPERATOR_KEY), "the operator's key was on the request");
      must(JSON.parse(call.body).model === "kimi-for-coding", call.body);
      await settle(a.rt);
      const last = lastMessage(a.host.sql);
      must(last?.stopReason !== "error" && last?.model === "kimi-for-coding" && last?.payer === "own", show(last));
      const rows = pendingUsage(a.host.sql as never, 0).filter((r) => r.resource === "model.tokens");
      must(rows.length > 0 && rows.every((r) => r.key.startsWith("own:kimi-for-coding:")), `usage ${show(rows.map((r) => r.key))}`);
      must(!everything(a.host.sql).includes(USER_KEY), "the key reached the object's tables");
    } finally { a.host.dispose(); }
  });

  await check(`${engine}: a 401 that quotes the key: one call, to Kimi only; the key is marked refused, the turn ends once saying to reconnect, and the next turn calls nothing`, async () => {
    const a = await agentOn(engine);
    try {
      const body = JSON.stringify({ error: { message: `Invalid Authentication: ${USER_KEY}`, type: "invalid_authentication_error" } });
      const f = fetchAs(() => new Response(body, { status: 401 }));
      const { out } = await captured(async () => {
        try { await consumeModelCalls({ queue: "model-calls", messages: [a.msg()] }, a.deps); await settle(a.rt); } finally { f.restore(); }
      });
      must(f.seen.length === 1 && f.seen.every((c) => c.url.startsWith("https://api.kimi.com/")), `calls ${show(f.seen.map((c) => c.url))}`);
      must(a.q.acked === 1 && a.q.retried === 0 && a.sent.length === 1, `queue ${show(a.q)}, sent ${a.sent.length}`);
      const last = lastMessage(a.host.sql);
      must(last?.stopReason === "error" && last.errorMessage === USER_KEY_ERRORS.refused, show(last));
      must(/Kimi Code refused your API key \(HTTP 401\)/.test(last.providerError) && /reconnect it/.test(last.providerError), last.providerError);
      for (const [name, isRetryable] of [["pi-ai 0.85.1", retryable085], ["pi-ai 1.0.0", retryable1]] as const) must(!isRetryable(last), `${name} retries it`);
      must(!everything(a.host.sql).includes(USER_KEY) && !out.includes(USER_KEY), "the echoed key reached a table or a log line");
      const state = await a.o.uiModelKeyState("t", "a");
      must(state?.refusedAt !== null, show(state));
      // The next turn makes no call at all: the refused key is not tried again, and nothing else is.
      await a.rt.postMessage("t", "a", "And tomorrow?");
      await a.rt.step("t", "a");
      const g = fetchAs(() => new Response(OK_BODY, { status: 200 }));
      try { await consumeModelCalls({ queue: "model-calls", messages: [a.msg()] }, a.deps); await settle(a.rt); } finally { g.restore(); }
      must(g.seen.length === 0, `called ${show(g.seen.map((c) => c.url))}`);
      must(lastMessage(a.host.sql)?.errorMessage === USER_KEY_ERRORS.missing, show(lastMessage(a.host.sql)));
      // Storing a key again clears the mark.
      await agentModelKey("POST", form({ provider: "kimi-code", model: "kimi-for-coding", key: USER_KEY }), { tenantId: "t", agentId: "a", actor: "owner" }, a.routeDeps);
      must((await a.o.uiModelKeyState("t", "a"))?.refusedAt === null, "a new key is still marked refused");
    } finally { a.host.dispose(); }
  });

  await check(`${engine}: a 429 that quotes the key ends the turn with Kimi's limit, acked rather than retried; neither the log nor the turn's error holds the key`, async () => {
    const a = await agentOn(engine);
    try {
      const body = JSON.stringify({ error: { message: `rate limit reached for ${USER_KEY}`, type: "rate_limit_reached_error" } });
      const f = fetchAs(() => new Response(body, { status: 429 }));
      const { out } = await captured(async () => {
        try { await consumeModelCalls({ queue: "model-calls", messages: [a.msg()] }, a.deps); await settle(a.rt); } finally { f.restore(); }
      });
      must(f.seen.length === 3 && f.seen.every((c) => c.url.startsWith("https://api.kimi.com/") && !JSON.stringify(c).includes(OPERATOR_KEY)), `calls ${f.seen.length}`);
      must(a.q.acked === 1 && a.q.retried === 0 && a.sent.length === 1, `queue ${show(a.q)}, sent ${a.sent.length}`);
      const last = lastMessage(a.host.sql);
      must(last?.errorMessage === USER_KEY_ERRORS.limited && /over its rate or plan limit \(HTTP 429\)/.test(last.providerError), show(last));
      for (const [name, isRetryable] of [["pi-ai 0.85.1", retryable085], ["pi-ai 1.0.0", retryable1]] as const) must(!isRetryable(last), `${name} retries it`);
      must(!out.includes(USER_KEY) && !last.providerError.includes(USER_KEY) && !everything(a.host.sql).includes(USER_KEY), out);
      must((await a.o.uiModelKeyState("t", "a"))?.refusedAt === null, "a rate limit marked the key refused");
    } finally { a.host.dispose(); }
  });
}

await check("a 503 that quotes the key goes back to the queue on the same key; the consumer's log line holds no key", async () => {
  const a = await agentOn("pi085");
  try {
    const body = JSON.stringify({ error: { message: `upstream down for ${USER_KEY}`, type: "server_error" } });
    const f = fetchAs(() => new Response(body, { status: 503 }));
    const { out } = await captured(async () => {
      try { await consumeModelCalls({ queue: "model-calls", messages: [a.msg()] }, a.deps, 10); } finally { f.restore(); }
    });
    must(f.seen.length === 3 && f.seen.every((c) => c.url.startsWith("https://api.kimi.com/")) && a.q.retried === 1, `calls ${f.seen.length}, queue ${show(a.q)}`);
    must(out.includes("model call failed") && out.includes("model 503") && !out.includes(USER_KEY), out);
  } finally { a.host.dispose(); }
});

await check("the rate cap: the key is opened at most USER_KEY_CALLS_PER_MINUTE times a minute per agent; past it the turn ends saying so and nothing is called", async () => {
  const a = await agentOn("pi085");
  try {
    const t0 = Date.now();
    for (let i = 0; i < USER_KEY_CALLS_PER_MINUTE; i++) {
      const r = await a.rt.modelKeyFor("t", "a", "kimi-code", t0 + i);
      must(r.kind === "key", `call ${i}: ${r.kind}`);
    }
    must((await a.rt.modelKeyFor("t", "a", "kimi-code", t0 + 1000)).kind === "paced", "the cap let one more through");
    const f = fetchAs(() => new Response(OK_BODY, { status: 200 }));
    try { await consumeModelCalls({ queue: "model-calls", messages: [a.msg()] }, a.deps); await settle(a.rt); } finally { f.restore(); }
    must(f.seen.length === 0, `called ${f.seen.length}`);
    must(lastMessage(a.host.sql)?.errorMessage === USER_KEY_ERRORS.paced, show(lastMessage(a.host.sql)));
    // A minute later the window has moved on.
    must((await a.rt.modelKeyFor("t", "a", "kimi-code", t0 + 61_000)).kind === "key", "the cap did not reopen");
  } finally { a.host.dispose(); }
});

// ---- without the binding -------------------------------------------------------------------------------------------

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: an agent without the binding still calls the operator's provider with the operator's key, sends no User-Agent of ours, and meters priced keys`, async () => {
    const a = await agentOn(engine, { withKey: false });
    try {
      const f = fetchAs(() => new Response(OK_BODY, { status: 200 }));
      try { await consumeModelCalls({ queue: "model-calls", messages: [a.msg()] }, a.deps); } finally { f.restore(); }
      must(f.seen.length === 1 && f.seen[0]!.url === "https://model.example/v1/chat/completions", show(f.seen.map((c) => c.url)));
      must(f.seen[0]!.headers.authorization === `Bearer ${OPERATOR_KEY}` && !("user-agent" in f.seen[0]!.headers), show(f.seen[0]!.headers));
      await settle(a.rt);
      must(lastMessage(a.host.sql)?.payer === undefined, show(lastMessage(a.host.sql)));
      const rows = pendingUsage(a.host.sql as never, 0).filter((r) => r.resource === "model.tokens");
      must(rows.length > 0 && rows.every((r) => r.key.startsWith("deepseek-flash:")), show(rows.map((r) => r.key)));
    } finally { a.host.dispose(); }
  });
}

await check("removing the key deletes it and puts the agent back on the operator's account", async () => {
  const a = await agentOn("pi085");
  try {
    const r = await agentModelKey("POST", form({ remove: "1" }), { tenantId: "t", agentId: "a", actor: "owner" }, a.routeDeps);
    const s = await r.json() as any;
    must(r.status === 200 && s.ownKey === null && s.effective.source === "default", show(s));
    must((await a.rt.store.getModelBinding("t", "a"))?.secretRef === "operator:model", "still bound to the key");
    must(a.host.sql.exec("SELECT 1 FROM secrets WHERE name LIKE 'model:%'").toArray().length === 0, "the sealed key is still there");
  } finally { a.host.dispose(); }
});

// ---- money -----------------------------------------------------------------------------------------------------------

await check("spend: own: model tokens add nothing to the tenant's or the platform's day, even with a price row for the model; the dollar gate still stops a user-key call once priced usage reaches the limit", async () => {
  const db = d1();
  const H = 3_600_000;
  const now = Date.parse("2026-10-12T12:00:00Z");
  const hour = now - 3 * H;
  db.raw.prepare("INSERT INTO usage_prices(resource, key, unit, credits_per_unit, effective_from) VALUES ('model.tokens', 'kimi-for-coding:output', 'tokens', 1, 0)").run();
  db.raw.prepare("INSERT INTO usage_hourly(tenant_id, hour, agent_id, resource, key, unit, quantity) VALUES ('t', ?, 'a', 'model.tokens', 'own:kimi-for-coding:output', 'tokens', 1000000000)").run(hour);
  const s = await readDaySpend(db, "t", now);
  must(s.tenantUsd === 0 && s.platformUsd === 0, show(s));
  const limits = limitsOf({ DAILY_LIMIT_USD: "5" });
  const job = { userModel: { provider: "kimi-code", model: "kimi-for-coding" } };
  const m = { tenantId: "t", agentId: "a", jobId: "j" };
  const admit = spendAdmit(new SpendGate((t, at) => readDaySpend(db, t, at), limits, () => now), "deepseek-flash");
  must(await admit(job, m) === null, "a user-key call was refused on own: tokens alone");
  // Priced usage of ours (a container) over the limit: the turn's compute is still ours, so the call is refused.
  db.raw.prepare("INSERT INTO usage_hourly(tenant_id, hour, agent_id, resource, key, unit, quantity) VALUES ('t', ?, 'a', 'model.tokens', 'deepseek-flash:output', 'tokens', 10000000)").run(hour);
  const admit2 = spendAdmit(new SpendGate((t, at) => readDaySpend(db, t, at), limits, () => now), "deepseek-flash");
  const refused: any = await admit2(job, m);
  must(refused?.stopReason === "error" && refused.model === "kimi-for-coding", show(refused));
});

await check("the usage page: own: model tokens are a third state, \"metered; billed by your provider\", never $0 or not priced yet, and are left out of the dollar headline", async () => {
  const db = d1();
  const at = Date.parse("2026-10-12T10:00:00Z");
  const rows: UsageRow[] = [
    { at, tenantId: "t", agentId: "a", resource: "model.tokens", key: "own:kimi-for-coding:output", quantity: 5_000_000, unit: "tokens" },
    { at, tenantId: "t", agentId: "a", resource: "model.tokens", key: "own:kimi-for-coding:input", quantity: 9_000_000, unit: "tokens" },
  ];
  for (const r of toHourly(rows)) {
    db.raw.prepare("INSERT INTO usage_hourly(tenant_id, hour, agent_id, resource, key, unit, quantity) VALUES (?,?,?,?,?,?,?)").run(r.tenantId, r.hour, r.agentId, r.resource, r.key, r.unit, r.quantity);
  }
  const read = await readUsage(db, "t", { window: "24h", from: at - 3_600_000, to: at + 3_600_000, bucket: "1h", by: "total" });
  must(read.priced && read.rows.length === 2 && read.rows.every((r) => r.paidBy === "own" && r.cost === undefined), show(read.rows));
  const html = usagePanel({ window: "24h", bucket: "1h", by: "total", from: at - 3_600_000, to: at + 3_600_000, rows: read.rows, priced: true, firstHours: {} } as never);
  const tile = html.slice(html.indexOf("<h3>model tokens</h3>"), html.indexOf("</section>", html.indexOf("<h3>model tokens</h3>")));
  must(tile.includes(OWN_PAID_TEXT) && !tile.includes("not priced") && !tile.includes("$0"), tile);
  must(html.includes(`your own provider keys is ${OWN_PAID_TEXT}`), html.slice(0, 600));
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
