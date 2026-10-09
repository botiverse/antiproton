/**
 * Credits phase 1: what usage cost, in estimated US dollars, with nothing enforced (docs/metering.md, "Prices").
 *
 * The real migrations on node:sqlite (as test/agents-api-model.ts runs them), so the prices read here are the ones
 * cf/migrations/0016_usage_prices_seed.sql writes; the Worker's own `fetch` and `scheduled` for the routes and the
 * Cron Trigger; the real gateway and container accounting for whose credential paid. The same arithmetic on real D1
 * is in test/spec/usage-spec.ts.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { countHeldTime, heldReports } from "../src/usage/container.ts";
import { modelTokenRows, pendingUsage, toHourly, OWN_KEY_PREFIX, UNACCEPTED_TOKENS, type UsageRow } from "../src/usage/outbox.ts";
import { KEEP_HOURLY_DAYS, priceFor, readAgentLedger, readUsage, readUsageCosts, usagePrices, DAY_MS } from "../cf/src/usage-d1.ts";
import { parseCostsQuery } from "../cf/src/admin-usage-costs.ts";
import { d1ApiKeys } from "../cf/src/control-plane.ts";
import { hashApiKey, newApiKey } from "../cf/src/agents-api/keys.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
/** Dollars agree to a billionth: the products are floats, the prices are not round in binary. */
const near = (a: number | null | undefined, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;

/** D1 as node:sqlite, with every migration in cf/migrations applied. */
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

const H = 3_600_000;
const FROM = Date.parse("2026-10-09T00:00:00Z"); // the seed's effective_from
const AT = FROM + 26 * H; // 2026-10-10T02:00Z, inside the priced era
/** Usage rows into the hourly ledger, as sendUsage would sum them. */
function put(db: D1Database & { raw: DatabaseSync }, rows: UsageRow[]) {
  for (const h of toHourly(rows)) {
    db.raw.prepare(
      "INSERT INTO usage_hourly(tenant_id, hour, agent_id, resource, key, unit, quantity) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(tenant_id, hour, agent_id, resource, key, unit) DO UPDATE SET quantity = quantity + excluded.quantity",
    ).run(h.tenantId, h.hour, h.agentId, h.resource, h.key, h.unit, h.quantity);
  }
}
const row = (over: Partial<UsageRow>): UsageRow =>
  ({ at: AT, tenantId: "t", agentId: "a", resource: "model.tokens", key: "deepseek-flash:input", quantity: 1, unit: "tokens", ...over });
/** One DeepSeek reply and one Luna reply, with every subset the clients fill. */
const flashReply = (at = AT, agentId = "a", tenantId = "t") => modelTokenRows({ at, tenantId, agentId }, "deepseek-flash",
  { input: 1_000_000, cacheRead: 400_000, output: 1_000_000, reasoning: 600_000, cacheWrite: 1000, cacheWrite1h: 400 });
const lunaReply = (at = AT) => modelTokenRows({ at, tenantId: "t", agentId: "a" }, "openai/gpt-5.6-luna",
  { input: 1_000_000, cacheRead: 500_000, output: 1_000_000, reasoning: 500_000 });
// What each reply costs, by hand from the rough table: the uncached input, the cached input, all of the output.
const FLASH_COST = 0.6 * 0.30 + 0.4 * 0.006 + 1.0 * 1.20; // 1.3824
const LUNA_COST = 1.0 * 0.20 + 1.0 * 1.20; // cache_read priced as input

const sumCost = (rows: Array<{ cost?: number | null }>) => rows.reduce((a, r) => a + (r.cost ?? 0), 0);
const tenantRead = (db: D1Database, from = FROM, to = FROM + 3 * DAY_MS, bucket: "1h" | "1d" = "1d") =>
  readUsage(db, "t", { window: "custom", from, to, bucket, by: "total" });

// ---- the seed ---------------------------------------------------------------------------------------

await check("the seed: dollars per unit from 2026-10-09T00:00Z, at the rough table's values", async () => {
  const db = d1();
  const prices = await usagePrices(db);
  must(prices.length > 0 && prices.every((p) => p.effectiveFrom === FROM), `every row takes effect at the migration's date: ${show(prices.filter((p) => p.effectiveFrom !== FROM))}`);
  const at = (resource: string, key: string, unit: string) => priceFor(prices, { bucket: AT, resource, key, unit });
  const spot: Array<[string, string, string, number]> = [
    ["model.tokens", "deepseek-flash:input", "tokens", 0.30e-6],
    ["model.tokens", "deepseek-flash:cache_read", "tokens", 0.006e-6 - 0.30e-6],
    ["model.tokens", "deepseek-flash:output", "tokens", 1.20e-6],
    ["model.tokens", "openai/gpt-5.6-luna:input", "tokens", 0.20e-6],
    ["model.tokens", "openai/gpt-5.6-luna:output", "tokens", 1.20e-6],
    ["model.tokens", "openai/gpt-5.6-luna:cache_read", "tokens", 0],
    ["object.active", "", "ms", 12.5 / 1e6 * 0.125 / 1000],
    ["sandbox.container", "sandbox", "seconds", 0.00004],
    ["sandbox.container", "sandbox", "execs", 0],
    ["tool.call", "exa.search", "calls", 0.007],
  ];
  for (const [resource, key, unit, want] of spot) {
    const got = at(resource, key, unit);
    must(got !== null && Math.abs(got - want) < 1e-15, `${resource} ${key} ${unit}: ${got}, the table says ${want}`);
  }
  // Every subset key has a row of its own, so no `*` can become its price (0005's corollary): model.tokens has no `*`.
  for (const model of ["deepseek-flash", "openai/gpt-5.6-luna"]) {
    for (const kind of ["reasoning", "cache_write", "cache_write_1h"]) {
      must(prices.some((p) => p.resource === "model.tokens" && p.key === `${model}:${kind}` && p.creditsPerUnit === 0), `${model}:${kind} has no explicit 0 delta`);
    }
  }
  must(!prices.some((p) => p.resource === "model.tokens" && p.key === "*"), "a model.tokens * would price every unknown model's subsets at full rate");
  // The unaccepted resource carries the same prices: it is our cost, read only by the operator.
  for (const p of prices.filter((p) => p.resource === "model.tokens")) {
    must(prices.some((u) => u.resource === UNACCEPTED_TOKENS && u.key === p.key && u.unit === p.unit && u.creditsPerUnit === p.creditsPerUnit), `${p.key} has no unaccepted twin`);
  }
  must(at("tool.call", "github.issue_list", "calls") === null && at("js.run", "run_js", "runs") === null, "another tool is left unpriced, not 0");
  must(priceFor(prices, { bucket: FROM - 1, resource: "model.tokens", key: "deepseek-flash:input", unit: "tokens" }) === null, "usage before the seed's date reads unpriced");
});

// ---- no double charge -------------------------------------------------------------------------------

await check("a reply is charged once: reasoning inside output and cache hits inside input are not charged again", async () => {
  const db = d1();
  put(db, [...flashReply(), ...lunaReply()]);
  const { rows, priced } = await tenantRead(db);
  must(priced, "the seed counts as priced");
  const flash = rows.filter((r) => r.key.startsWith("deepseek-flash:"));
  const luna = rows.filter((r) => r.key.startsWith("openai/gpt-5.6-luna:"));
  must(flash.every((r) => typeof r.cost === "number") && luna.every((r) => typeof r.cost === "number"), `every kind is priced: ${show(rows)}`);
  must(near(sumCost(flash), FLASH_COST), `deepseek-flash cost ${sumCost(flash)}, by hand ${FLASH_COST}`);
  must(near(sumCost(luna), LUNA_COST), `luna cost ${sumCost(luna)}, by hand ${LUNA_COST}`);
  // The two charges a full-rate subset would add, said directly.
  must(near(flash.find((r) => r.key.endsWith(":reasoning"))!.cost, 0), "reasoning was charged on top of output");
  must(near(flash.find((r) => r.key.endsWith(":cache_write_1h"))!.cost, 0), "cache_write_1h was charged on top of cache_write");
});

// ---- the worker: v1 usage, the admin view, the cron --------------------------------------------------

const T = "t1", OWNER = "owner1", TOKEN = "automation-token-xyz";
const hosts: Array<{ dispose(): void }> = [];
function env(db: D1Database, over: Record<string, unknown> = {}) {
  const objects = new Map<string, any>();
  const e: Record<string, unknown> = {
    MODEL_QUEUE: { send: async () => {} },
    ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
    ARTIFACT_BUCKET: "b", CONTROL_DB: db, HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_API_KEY: "dk-x", SECRET_KEK: Buffer.alloc(32, 7).toString("base64"), AUTOMATION_TOKEN: TOKEN,
    AGENT: {
      idFromName: (n: string) => n,
      get: (n: string) => objects.get(n) ?? (() => {
        const own = sqliteHost();
        hosts.push(own);
        let alarmAt: number | null = null;
        const o = new AgentDO({
          storage: { sql: own.sql, transactionSync: own.transactionSync, getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } },
          blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => n }, getWebSockets: () => [], exports: {},
        } as never, e as never);
        objects.set(n, o);
        return o;
      })(),
    },
    ...over,
  };
  return e;
}
async function call(e: Record<string, unknown>, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const r = await worker.fetch(new Request(`https://api.test${path}`, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), e as never);
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: r.status, text, body: parsed };
}

await check("/v1/agents/{id}/usage: each row gains a cost, its kind's whole rate, adding up to the ledger's; null where unpriced", async () => {
  const db = d1();
  const e = env(db);
  const key = newApiKey();
  await d1ApiKeys(db).issue({ hash: await hashApiKey(key), tenantId: T, ownerAgentId: OWNER, label: "test" });
  const auth = { authorization: `Bearer ${key}` };
  const made = await call(e, "POST", "/v1/agents", auth, { model: "default" });
  must(made.status === 200, `${made.status} ${made.text}`);
  const id = made.body.id;
  put(db, [
    ...flashReply(AT, id, T),
    row({ tenantId: T, agentId: id, resource: "js.run", key: "run_js", unit: "runs", quantity: 3 }),
    row({ tenantId: T, agentId: id, resource: UNACCEPTED_TOKENS, key: "deepseek-flash:output", quantity: 1_000_000 }),
  ]);
  const qs = `from=${new Date(FROM).toISOString()}&to=${new Date(FROM + 2 * DAY_MS).toISOString()}&bucket=1d`;
  const u = await call(e, "GET", `/v1/agents/${id}/usage?${qs}`, auth);
  must(u.status === 200, `${u.status} ${u.text}`);
  const rows: any[] = u.body.rows;
  // Additive: the shape every caller already reads is all still there.
  must(rows.every((r) => typeof r.at === "string" && typeof r.resource === "string" && r.dimensions && typeof r.unit === "string" && typeof r.quantity === "number"), show(rows));
  must(rows.every((r) => "cost" in r), `a row without cost: ${show(rows)}`);
  const kind = (k: string) => rows.find((r) => r.resource === "model.tokens" && r.dimensions.kind === k);
  must(near(kind("input").cost, 0.6 * 0.30), `input is charged for its uncached part: ${show(kind("input"))}`);
  must(near(kind("cache_read").cost, 0.4 * 0.006), `cache_read at its whole rate: ${show(kind("cache_read"))}`);
  must(near(kind("output").cost, 0.4 * 1.20) && near(kind("reasoning").cost, 0.6 * 1.20), `output and reasoning split the output charge: ${show([kind("output"), kind("reasoning")])}`);
  must(near(sumCost(rows.filter((r) => r.resource === "model.tokens")), FLASH_COST), `v1 costs add to ${sumCost(rows)}, the ledger's to ${FLASH_COST}`);
  must(rows.find((r) => r.resource === "js.run")?.cost === null, `an unpriced row is null, not 0: ${show(rows.find((r) => r.resource === "js.run"))}`);
  must(!rows.some((r) => r.resource === UNACCEPTED_TOKENS), "the agent's usage shows an unaccepted answer");
});

await check("/admin/usage-costs: refused without the operator's token, with a wrong one, and when none is configured", async () => {
  const db = d1();
  put(db, flashReply());
  const path = "/admin/usage-costs?bucket=day&from=2026-10-09&to=2026-10-12";
  const none = await call(env(db), "GET", path);
  must(none.status === 401 && !/tenants/.test(none.text), `no token: ${none.status} ${none.text}`);
  const wrong = await call(env(db), "GET", path, { "x-harness-token": "nope" });
  must(wrong.status === 401 && !/tenants/.test(wrong.text), `wrong token: ${wrong.status}`);
  // A deployment that never set one refuses every caller, the one presenting an empty token included.
  const unset = env(db, { AUTOMATION_TOKEN: undefined });
  for (const h of [{}, { "x-harness-token": "" }, { "x-harness-token": TOKEN }] as Array<Record<string, string>>) {
    const r = await call(unset, "GET", path, h);
    must(r.status === 401 && !/tenants/.test(r.text), `token unset, header ${show(h)}: ${r.status} ${r.text}`);
  }
  const ok = await call(env(db), "GET", path, { "x-harness-token": TOKEN });
  must(ok.status === 200 && ok.body.currency === "USD" && ok.body.estimated === true, `${ok.status} ${ok.text}`);
});

await check("/admin/usage-costs: per tenant, period and resource, with the unaccepted answers the tenant never sees", async () => {
  const db = d1();
  put(db, [
    ...flashReply(),
    row({ resource: UNACCEPTED_TOKENS, key: "deepseek-flash:output", quantity: 1_000_000 }),
    row({ tenantId: "u", resource: "sandbox.container", key: "sandbox", unit: "seconds", quantity: 1000 }),
    row({ tenantId: "u", resource: "tool.call", key: "github.issue_list", unit: "calls", quantity: 2, at: AT + DAY_MS }),
  ]);
  const r = await call(env(db), "GET", "/admin/usage-costs?bucket=day&from=2026-10-09&to=2026-10-12", { "x-harness-token": TOKEN });
  must(r.status === 200, `${r.status} ${r.text}`);
  const t = r.body.tenants.find((x: any) => x.tenantId === "t");
  const res = (tenant: any, name: string) => tenant.periods.flatMap((p: any) => p.resources).find((x: any) => x.resource === name);
  must(near(res(t, "model.tokens").cost, FLASH_COST), `tenant usage: ${show(res(t, "model.tokens"))}`);
  must(near(res(t, UNACCEPTED_TOKENS)?.cost, 1.2), `the unaccepted answer is our cost and is here: ${show(t)}`);
  must(near(t.total, FLASH_COST + 1.2), `tenant total ${t.total}`);
  const u = r.body.tenants.find((x: any) => x.tenantId === "u");
  must(near(res(u, "sandbox.container").cost, 0.04) && u.periods.length === 2, `the other tenant, by day: ${show(u)}`);
  must(show(res(u, "tool.call").unpriced) === show(["github.issue_list calls"]), `what the total leaves out is named: ${show(res(u, "tool.call"))}`);
  must(r.body.from === "2026-10-09T00:00:00.000Z" && r.body.to === "2026-10-12T00:00:00.000Z" && r.body.bucket === "day", show(r.body));
  // While the tenant's own read of the same window leaves it out, priced or not.
  const mine = await tenantRead(db);
  must(!mine.rows.some((x) => x.resource === UNACCEPTED_TOKENS) && near(sumCost(mine.rows), FLASH_COST), `tenant view: ${show(mine.rows.map((x) => [x.resource, x.cost]))}`);
  must(!(await readAgentLedger(db, "t", "a", FROM, FROM + 3 * DAY_MS, DAY_MS)).some((x) => x.resource === UNACCEPTED_TOKENS), "the agent ledger shows it");
  // Months fold days together; a bad query is refused with its reason.
  const m = await readUsageCosts(db, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1), "month");
  must(m.find((x) => x.tenantId === "u")!.periods.length === 1, `one October: ${show(m)}`);
  for (const bad of ["bucket=week", "from=yesterday", "from=2026-10-09&to=2026-10-01", "from=2025-01-01&to=2026-10-01"]) {
    const b = await call(env(db), "GET", `/admin/usage-costs?${bad}`, { "x-harness-token": TOKEN });
    must(b.status === 400 && typeof b.body?.error === "string", `${bad}: ${b.status} ${b.text}`);
  }
  const q = parseCostsQuery(new URLSearchParams("bucket=month&from=2026-10-09T05:00:00Z&to=2026-11-03T00:00:00Z"), 0);
  must(typeof q === "object" && q.from === Date.UTC(2026, 9, 1) && q.to === Date.UTC(2026, 11, 1), `widened to whole months: ${show(q)}`);
});

// ---- whose credential paid ---------------------------------------------------------------------------

await check("a box on the tenant's own run9 credential is counted under an own: key and priced 0; the operator's is charged", async () => {
  const host = sqliteHost();
  hosts.push(host);
  const report = (id: string) => ({ activity: null, usage: [{ id, startedAt: AT, endedAt: AT + 1000_000 }] });
  // The mounts as the agent's object lists them: one on the agent's own sealed run9 credential, one on the operator's.
  const named = heldReports([
    { alias: "mine", plugin: "sandbox", secretRef: "agent:run9" },
    { alias: "ours", plugin: "sandbox", secretRef: "operator:run9" },
  ], { mine: report("box-own"), ours: report("box-ops"), gone: report("box-gone") });
  must(show(Object.keys(named).sort()) === show(["mine", "ours"]), `a report for an unlisted mount: ${show(Object.keys(named))}`);
  countHeldTime(host.sql as any, named, { tenantId: "t", agentId: "a" }, AT + 2000_000);
  const rows = pendingUsage(host.sql as any, 0);
  const keys = [...new Set(rows.map((r) => r.key))].sort();
  must(show(keys) === show([`${OWN_KEY_PREFIX}sandbox`, "sandbox"]), `keys ${show(keys)}`);
  const db = d1();
  put(db, rows);
  const { rows: read } = await tenantRead(db);
  const own = read.filter((r) => r.key === `${OWN_KEY_PREFIX}sandbox` && r.unit === "seconds");
  const ops = read.filter((r) => r.key === "sandbox" && r.unit === "seconds");
  must(own.length && own.every((r) => r.cost === 0), `own box: ${show(own)}`);
  must(near(sumCost(ops), 1000 * 0.00004), `operator box: ${show(ops)}`);
  // Counted as the tenant's container time all the same: the tile totals the resource.
  must(read.filter((r) => r.resource === "sandbox.container" && r.unit === "seconds").reduce((a, r) => a + r.quantity, 0) === 2000, "own seconds left the resource");
  // Whatever the table says: a price written for an own: key, or a * meant for our account, does not reach it.
  const prices = [...await usagePrices(db), { resource: "sandbox.container", key: `${OWN_KEY_PREFIX}sandbox`, unit: "seconds", creditsPerUnit: 9, effectiveFrom: 0 }];
  must(priceFor(prices, { bucket: AT, resource: "sandbox.container", key: `${OWN_KEY_PREFIX}sandbox`, unit: "seconds" }) === 0, "an own: key was priced");
});

await check("a tool call through a mount holding the agent's own key is counted under an own: key and priced 0", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  const exa: Plugin = { id: "exa", version: "1.0.0", tools: [{ name: "search", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }], async invoke() { return { results: [] }; } };
  for (const [alias, secretRef] of [["mine", "agent:exa-key"], ["search", "operator:exa"]] as const) {
    await store.addMount({ tenantId: "t", agentId: "a", alias, plugin: "exa", installationId: "i", connectionId: null, toolVersion: "1.0.0", publicConfig: {}, secretRef, policy: null });
  }
  const gw = new ToolGateway(store, [exa], new Set(["exa"]), { async resolve() { return "KEY"; } });
  for (const alias of ["mine", "search"]) {
    const r: any = await gw.invoke({ tenantId: "t", agentId: "a", taskId: "k" }, `${alias}.search`, { query: "x" });
    must(r.status === "succeeded", `${alias}: ${show(r)}`);
  }
  const calls = store.usageOutbox().filter((r: UsageRow) => r.resource === "tool.call" && r.unit === "calls").map((r: UsageRow) => r.key).sort();
  must(show(calls) === show(["exa.search", `${OWN_KEY_PREFIX}exa.search`]), `calls ${show(calls)}`);
  const db = d1();
  put(db, store.usageOutbox().map((r: UsageRow) => ({ ...r, at: AT })));
  const { rows } = await tenantRead(db);
  const cost = (k: string) => rows.find((r) => r.key === k && r.unit === "calls")?.cost;
  must(cost(`${OWN_KEY_PREFIX}exa.search`) === 0 && near(cost("exa.search"), 0.007), `own ${cost(`${OWN_KEY_PREFIX}exa.search`)}, operator ${cost("exa.search")}`);
});

// ---- retention: the Cron Trigger ---------------------------------------------------------------------

await check("the daily Cron Trigger folds old hours into days, twice changes nothing, and a read across the boundary keeps its totals", async () => {
  const db = d1();
  const now = AT + (KEEP_HOURLY_DAYS + 5) * DAY_MS;
  put(db, [
    ...flashReply(AT), ...flashReply(AT + 5 * H),
    row({ resource: "sandbox.container", key: "sandbox", unit: "seconds", quantity: 500, at: AT + 3 * H }),
    // Young enough to keep its hour.
    ...flashReply(now - 2 * DAY_MS),
  ]);
  const window = { from: FROM, to: now, bucket: "1d" as const };
  const shape = async () => (await tenantRead(db, window.from, window.to, window.bucket)).rows
    .map((r) => `${(r.bucket - FROM) / DAY_MS}/${r.resource}/${r.key}/${r.unit}=${r.quantity}$${(r.cost ?? 0).toFixed(9)}`).join(" ");
  const count = (t: string) => Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
  const before = await shape();
  const hourlyBefore = count("usage_hourly");
  await worker.scheduled({ scheduledTime: now, cron: "17 3 * * *", noRetry() {} } as never, env(db) as never);
  const once = await shape();
  must(count("usage_daily") > 0 && count("usage_hourly") < hourlyBefore, `nothing was folded: hourly ${count("usage_hourly")} of ${hourlyBefore}, daily ${count("usage_daily")}`);
  must(Number((db.raw.prepare("SELECT COUNT(*) AS n FROM usage_hourly WHERE hour < ?").get(now - KEEP_HOURLY_DAYS * DAY_MS - DAY_MS) as any).n) === 0, "an old hour survived the fold");
  must(once === before, `the fold changed a read:\n  before ${before}\n  after  ${once}`);
  const daily = count("usage_daily");
  await worker.scheduled({ scheduledTime: now, cron: "17 3 * * *", noRetry() {} } as never, env(db) as never);
  must(count("usage_daily") === daily && (await shape()) === before, "a second run moved something");
  // The operator's totals agree across the boundary too.
  const costs = await readUsageCosts(db, FROM, now, "month");
  must(near(costs[0]!.total, 3 * FLASH_COST + 500 * 0.00004), `admin total after the fold: ${costs[0]!.total}`);
});

await check("both Worker configs schedule the fold daily", () => {
  for (const f of ["wrangler.jsonc", "wrangler.preview.jsonc"]) {
    const text = readFileSync(new URL(`../cf/${f}`, import.meta.url), "utf8");
    must(/"triggers":\s*\{\s*"crons":\s*\["\d+ \d+ \* \* \*"\]\s*\}/.test(text), `${f} has no daily cron`);
  }
});

for (const h of hosts) h.dispose();
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
