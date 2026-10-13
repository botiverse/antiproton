/**
 * `GET /provision/usage` (cf/src/provision/usage.ts, docs/agent-surface.md "The tenant's spend"): the token's
 * tenant's spend against its daily limit, for Raft's panel.
 *
 * The real migrations on node:sqlite as D1 (as test/spend-limit.ts runs them), so the prices are the seeded ones
 * and the provider tokens are looked up in their real table; the Worker's own `fetch` for the route, so the token,
 * the tenant and the wiring are the deployed ones. `today` is compared with the enforcer's own reading and verdict
 * (`readDaySpend`, `judge`) on the same ledger.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { d1ProviderTokens } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import { dayOf, judge, limitsOf, readDaySpend, type SpendLimitEnv } from "../cf/src/spend-limit.ts";
import { readTenantCosts, type OwnCosts } from "../cf/src/usage-d1.ts";
import { sharedUsageCache, tenantUsage, USAGE_CACHE_ENTRIES, USAGE_CACHE_MS, UsageCache, type ProvisionUsage } from "../cf/src/provision/usage.ts";
import { UNACCEPTED_TOKENS } from "../src/usage/outbox.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { default: worker } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const tidy = (n: number) => Math.round(n * 1e10) / 1e10;

/** D1 as node:sqlite, with every migration in cf/migrations applied (test/spend-limit.ts's). */
function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  // The seeded price starts on 2026-10-09; the history checks put spend on days before that, relative to today.
  db.prepare("INSERT INTO usage_prices (resource, key, unit, credits_per_unit, effective_from) VALUES ('model.tokens', 'deepseek-flash:output', 'tokens', 0.0000012, 0)").run();
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
type Db = ReturnType<typeof d1>;

const H = 3_600_000;
const DAY = 24 * H;
/**
 * Today as the Worker will read it (it reads `Date.now()`). Rows go at today's 00:00, so a run that is not
 * itself straddling midnight UTC reads them as today; `fresh()` refuses to start within a second of it.
 */
function today(): number {
  const now = Date.now();
  if (dayOf(now + 5_000) !== dayOf(now)) throw new Error("too close to 00:00 UTC to say which day the Worker will read; run again");
  return dayOf(now);
}
/** deepseek-flash output is $1.20 per 1M tokens (0016): this many tokens cost `usd`. */
const tokensFor = (usd: number) => Math.round(usd / 0.0000012);
function row(db: Db, r: { tenant: string; hour: number; agent?: string; resource?: string; key?: string; unit?: string; quantity: number }) {
  db.raw.prepare("INSERT INTO usage_hourly(tenant_id, hour, agent_id, resource, key, unit, quantity) VALUES (?,?,?,?,?,?,?)")
    .run(r.tenant, r.hour, r.agent ?? "a", r.resource ?? "model.tokens", r.key ?? "deepseek-flash:output", r.unit ?? "tokens", r.quantity);
}
const spend = (db: Db, tenant: string, usd: number, hour: number, agent = "a") => row(db, { tenant, hour, agent, quantity: tokensFor(usd) });

const ORIGIN = "https://api.raft.build";
async function token(db: Db, who: { scope: "tenant"; tenantId: string } | { scope: "platform" }): Promise<string> {
  const t = newProviderToken();
  await d1ProviderTokens(db).issue({ hash: await hashProviderToken(t), label: "raft-test", raftOrigin: ORIGIN, ...who } as never);
  return t;
}
function env(db: Db, extra: SpendLimitEnv = {}) {
  return { CONTROL_DB: db, AGENT: { idFromName: (s: string) => s, get: () => ({}) }, ARTIFACTS: {}, HARNESS_MODEL: "deepseek-flash", ...extra };
}
/** One request through the Worker. The isolate's answer cache is emptied first unless `keep`: each check has its own ledger. */
async function get(e: object, path: string, auth: string | null, keep = false) {
  if (!keep) sharedUsageCache.clear();
  const r = await worker.fetch(new Request(`https://antiproton.test${path}`, auth === null ? {} : { headers: { authorization: auth } }), e as never);
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* left null: the assertion says what came back */ }
  return { status: r.status, body, text, cache: r.headers.get("cache-control") };
}

// ---- whose numbers -----------------------------------------------------------------------------------------

await check("a token sees its own tenant only: another tenant's spend, agents and periods are never in its answer", async () => {
  const db = d1();
  const day = today();
  spend(db, "t-a", 1.25, day, "raft_alpha");
  spend(db, "t-a", 0.5, day - 3 * DAY, "raft_beta");
  spend(db, "t-b", 2.75, day, "raft_gamma");
  spend(db, "t-b", 4, day - 5 * DAY, "raft_delta");
  const a = await token(db, { scope: "tenant", tenantId: "t-a" });
  const b = await token(db, { scope: "tenant", tenantId: "t-b" });
  const e = env(db);
  const ra = await get(e, "/provision/usage", `Bearer ${a}`);
  const rb = await get(e, "/provision/usage", `Bearer ${b}`);
  must(ra.status === 200 && rb.status === 200, `${ra.status} ${ra.text} / ${rb.status} ${rb.text}`);
  must(ra.body.tenantId === "t-a" && rb.body.tenantId === "t-b", `${ra.body.tenantId} / ${rb.body.tenantId}`);
  must(show(ra.body.agents.map((x: any) => x.providerAgentId)) === show(["raft_alpha", "raft_beta"]), show(ra.body.agents));
  must(show(rb.body.agents.map((x: any) => x.providerAgentId)) === show(["raft_delta", "raft_gamma"]), show(rb.body.agents));
  must(Math.abs(ra.body.today.spentUsd - 1.25) < 1e-5 && Math.abs(ra.body.totalUsd - 1.75) < 1e-5, show(ra.body));
  must(Math.abs(rb.body.today.spentUsd - 2.75) < 1e-5 && Math.abs(rb.body.totalUsd - 6.75) < 1e-5, show(rb.body));
  for (const other of ["t-b", "raft_gamma", "raft_delta", "2.75", "6.75"]) must(!ra.text.includes(other), `A's answer carries ${other}: ${ra.text}`);
  for (const other of ["t-a", "raft_alpha", "raft_beta", "1.25", "1.75"]) must(!rb.text.includes(other), `B's answer carries ${other}: ${rb.text}`);
});

await check("a platform token is the tenant its ?raftServerId= names, and without one it is refused, not answered for every tenant", async () => {
  const db = d1();
  const day = today();
  spend(db, "raft_srv-1", 0.75, day, "raft_one");
  spend(db, "raft_srv-2", 3, day, "raft_two");
  const p = await token(db, { scope: "platform" });
  const e = env(db);
  const r1 = await get(e, "/provision/usage?raftServerId=srv-1", `Bearer ${p}`);
  must(r1.status === 200 && r1.body.tenantId === "raft_srv-1" && show(r1.body.agents.map((x: any) => x.providerAgentId)) === show(["raft_one"]), r1.text);
  must(!r1.text.includes("raft_two") && !r1.text.includes("srv-2"), r1.text);
  const none = await get(e, "/provision/usage", `Bearer ${p}`);
  must(none.status === 422 && none.body.error.param === "raftServerId", `${none.status} ${none.text}`);
});

await check("a tenant token naming another server or tenant in the query still gets its own tenant, and nothing of theirs", async () => {
  const db = d1();
  const day = today();
  spend(db, "t-a", 0.25, day, "raft_mine");
  spend(db, "raft_srv-2", 2.5, day, "raft_srv2agent");
  spend(db, "t-b", 3.5, day, "raft_tbagent");
  const a = await token(db, { scope: "tenant", tenantId: "t-a" });
  const e = env(db);
  for (const q of ["?raftServerId=srv-2", "?tenantId=t-b", "?raftServerId=srv-2&tenantId=t-b", "?tenantId=t-b&raftServerId=srv-2&bucket=day"]) {
    const r = await get(e, `/provision/usage${q}`, `Bearer ${a}`);
    must(r.status === 200 && r.body.tenantId === "t-a" && show(r.body.agents.map((x: any) => x.providerAgentId)) === show(["raft_mine"]), `${q}: ${r.status} ${r.text}`);
    must(Math.abs(r.body.today.spentUsd - 0.25) < 1e-5 && Math.abs(r.body.totalUsd - 0.25) < 1e-5, `${q}: ${show(r.body)}`);
    for (const other of ["raft_srv2agent", "raft_tbagent", "srv-2", "t-b", "2.5", "3.5"]) must(!r.text.includes(other), `${q}: carries ${other}: ${r.text}`);
  }
});

await check("no token, a malformed one, an unknown one and a revoked one: the same refusal as every /provision route", async () => {
  const db = d1();
  const e = env(db);
  const revoked = await token(db, { scope: "tenant", tenantId: "t-a" });
  await d1ProviderTokens(db).revoke(await hashProviderToken(revoked));
  for (const auth of [null, "Bearer nope", `Bearer ${newProviderToken()}`, `Bearer ${revoked}`, `Basic ${newProviderToken()}`]) {
    const mine = await get(e, "/provision/usage", auth);
    const theirs = await get(e, "/provision/models", auth);
    must(mine.status === 401 && mine.status === theirs.status && mine.text === theirs.text && mine.cache === "no-store", `${auth?.slice(0, 12)}: ${mine.status} ${mine.text} vs ${theirs.status} ${theirs.text}`);
  }
});

// ---- today: the enforcer's reading and verdict ------------------------------------------------------------

await check("today under, at and over the limit: spentUsd, limitUsd and refusing are readDaySpend's and judge's", async () => {
  for (const [usd, refused, at] of [[2, false, false], [3, true, true], [6.5, true, false]] as const) {
    const db = d1();
    const day = today();
    spend(db, "t-a", usd, day);
    // "At" exactly: the limit set to the very figure the enforcer reads, so no rounding of tokens stands either side of it.
    if (at) db.raw.prepare("INSERT INTO spend_limits (tenant_id, limit_usd, set_by, set_at) VALUES (?, ?, ?, ?)")
      .run("t-a", (await readDaySpend(db, "t-a", Date.now())).tenantUsd, "github:1", 0);
    // An answer no job accepted is ours: not in the tenant's today, nor in its history.
    row(db, { tenant: "t-a", hour: day, resource: UNACCEPTED_TOKENS, quantity: tokensFor(9) });
    const a = await token(db, { scope: "tenant", tenantId: "t-a" });
    const r = await get(env(db), "/provision/usage", `Bearer ${a}`);
    must(r.status === 200, `${usd}: ${r.status} ${r.text}`);
    const enforced = await readDaySpend(db, "t-a", Date.now());
    const verdict = judge(enforced, limitsOf({}));
    must(r.body.today.spentUsd === tidy(enforced.tenantUsd) && r.body.today.limitUsd === (at ? enforced.tenantUsd : 5), `${usd}: ${show(r.body.today)} vs ${show(enforced)}`);
    must(r.body.today.refusing === !verdict.admit && r.body.today.refusing === refused, `${usd}: refusing ${r.body.today.refusing}, judge ${show(verdict)}`);
    must(r.body.today.exempt === false && r.body.today.platformLimitReached === false, show(r.body.today));
    must(r.body.today.day === new Date(day).toISOString().slice(0, 10) && r.body.today.resetsAt === new Date(day + DAY).toISOString(), show(r.body.today));
    const todays = r.body.periods.find((p: any) => p.start === new Date(day).toISOString());
    must(todays && todays.totalUsd === r.body.today.spentUsd && !todays.resources.some((x: any) => x.resource === UNACCEPTED_TOKENS), `${usd}: ${show(r.body.periods)}`);
  }
});

await check("an admin's override is the limit shown; an override of null is no per-tenant limit, and nothing is refused under the platform", async () => {
  const db = d1();
  const day = today();
  spend(db, "t-a", 6, day);
  const a = await token(db, { scope: "tenant", tenantId: "t-a" });
  const e = env(db);
  db.raw.prepare("INSERT INTO spend_limits (tenant_id, limit_usd, set_by, set_at) VALUES (?, ?, ?, ?)").run("t-a", 12.5, "github:1", 0);
  let r = await get(e, "/provision/usage", `Bearer ${a}`);
  must(r.body.today.limitUsd === 12.5 && r.body.today.refusing === false && r.body.today.exempt === false, show(r.body.today));
  db.raw.prepare("UPDATE spend_limits SET limit_usd = NULL WHERE tenant_id = ?").run("t-a");
  r = await get(e, "/provision/usage", `Bearer ${a}`);
  must(r.body.today.limitUsd === null && r.body.today.refusing === false && r.body.today.exempt === false, show(r.body.today));
});

await check("an exempt tenant: limitUsd null and exempt true, never refusing, even over the default limit", async () => {
  const db = d1();
  const day = today();
  spend(db, "t-a", 7, day);
  spend(db, "t-c", 7, day);
  const a = await token(db, { scope: "tenant", tenantId: "t-a" });
  const c = await token(db, { scope: "tenant", tenantId: "t-c" });
  const e = env(db, { DAILY_LIMIT_EXEMPT_TENANTS: "bench,t-a" });
  const r = await get(e, "/provision/usage", `Bearer ${a}`);
  must(r.body.today.exempt === true && r.body.today.limitUsd === null && r.body.today.refusing === false && Math.abs(r.body.today.spentUsd - 7) < 1e-5, show(r.body.today));
  // The control: the same spend in a tenant that is not exempt is refused.
  const rc = await get(e, "/provision/usage", `Bearer ${c}`);
  must(rc.body.today.exempt === false && rc.body.today.limitUsd === 5 && rc.body.today.refusing === true, show(rc.body.today));
});

await check("the platform limit reached: refusing and platformLimitReached, and the platform's figure is nowhere in the answer", async () => {
  const db = d1();
  const day = today();
  spend(db, "t-a", 1, day);
  spend(db, "t-other", 31.234567, day);
  const a = await token(db, { scope: "tenant", tenantId: "t-a" });
  const r = await get(env(db), "/provision/usage", `Bearer ${a}`);
  const enforced = await readDaySpend(db, "t-a", Date.now());
  must(enforced.platformUsd > 30 && !judge(enforced, limitsOf({})).admit, show(enforced));
  must(r.body.today.platformLimitReached === true && r.body.today.refusing === true && r.body.today.limitUsd === 5 && r.body.today.spentUsd < 5, show(r.body.today));
  for (const leak of ["31.23", "32.23", "t-other", "\"30\"", ":30,", ":30}"]) must(!r.text.includes(leak), `the answer carries ${leak}: ${r.text}`);
  const keys = new Set<string>();
  const walk = (v: unknown) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(r.body);
  must([...keys].filter((k) => /platform/i.test(k)).join() === "platformLimitReached", show([...keys]));
  // The control: the platform under its limit, the same tenant is not refused.
  const db2 = d1();
  spend(db2, "t-a", 1, today());
  spend(db2, "t-other", 20, today());
  const a2 = await token(db2, { scope: "tenant", tenantId: "t-a" });
  const r2 = await get(env(db2), "/provision/usage", `Bearer ${a2}`);
  must(r2.body.today.platformLimitReached === false && r2.body.today.refusing === false, show(r2.body.today));
  // An exempt tenant still sees the platform's state, and is still not refused (SpendGate admits it unread).
  const r3 = await get(env(db, { DAILY_LIMIT_EXEMPT_TENANTS: "t-a" }), "/provision/usage", `Bearer ${a}`);
  must(r3.body.today.platformLimitReached === true && r3.body.today.refusing === false && r3.body.today.exempt === true, show(r3.body.today));
});

// ---- the answer cache ----------------------------------------------------------------------------------------

await check("an answer is kept 15 s per tenant and normalised query, never across a UTC day, never across limits", async () => {
  const reads: string[] = [];
  // Read through a function: the compiler narrows a property it has just seen compared and calls the next comparison impossible.
  const count = () => reads.length;
  let usd = 1;
  const costs: OwnCosts = { total: 0, periods: [], agents: [] };
  const deps = (limits = limitsOf({}), cache = new UsageCache()): ProvisionUsage => ({
    limits, cache,
    today: async (tenantId, now) => { reads.push(`today ${tenantId}`); return { day: dayOf(now), tenantUsd: usd, platformUsd: usd, override: null }; },
    costs: async (tenantId, from, to, bucket) => { reads.push(`costs ${tenantId} ${from} ${to} ${bucket}`); return costs; },
  });
  const d = deps();
  const NOON = Date.parse("2026-10-12T12:00:00Z");
  const ask = async (q: string, now: number, dd = d, tenant = "t-a") => (await tenantUsage(tenant, new URLSearchParams(q), dd, now)) as any;
  must((await ask("", NOON)).today.spentUsd === 1 && count() === 2, show(reads));
  usd = 2;
  // The same window asked another way is the same entry; within 15 s nothing is read.
  must((await ask("bucket=day", NOON + USAGE_CACHE_MS - 1)).today.spentUsd === 1 && count() === 2, show(reads));
  // Another tenant, another window: their own entries.
  must((await ask("", NOON + 1, d, "t-b")).today.spentUsd === 2 && count() === 4, show(reads));
  must((await ask("bucket=month", NOON + 1)).today.spentUsd === 2 && count() === 6, show(reads));
  // At 15 s the entry is read again.
  must((await ask("", NOON + USAGE_CACHE_MS)).today.spentUsd === 2 && count() === 8, show(reads));
  // Across 00:00 UTC: an answer from 23:59:55 is not served at 00:00:01, though it is 6 s old.
  const LATE = Date.parse("2026-10-12T23:59:55Z");
  const late = deps();
  usd = 4.5;
  const before = await ask("from=2026-10-01&to=2026-10-20", LATE, late);
  must(before.today.day === "2026-10-12" && count() === 10, show(reads));
  usd = 0;
  const after = await ask("from=2026-10-01&to=2026-10-20", LATE + 6_000, late);
  must(after.today.day === "2026-10-13" && after.today.spentUsd === 0 && count() === 12, `${show(after.today)} ${show(reads)}`);
  // New limits (a new deployment's) are not answered from the old ones' entry.
  const shared = new UsageCache();
  const r1 = await ask("", NOON, deps(limitsOf({}), shared));
  const r2 = await ask("", NOON + 1, deps(limitsOf({ DAILY_LIMIT_USD: "9" }), shared));
  must(r1.today.limitUsd === 5 && r2.today.limitUsd === 9, `${show(r1.today)} ${show(r2.today)}`);
});

await check("the cache is bounded: expired entries are removed, the cap holds over 1000 keys, a 400-day window is not kept", async () => {
  const T = Date.parse("2026-10-12T12:00:00Z");
  // Read through functions: the compiler narrows a property it has just compared and calls the next comparison impossible.
  const size = (x: UsageCache) => x.size;
  const c = new UsageCache();
  for (let i = 0; i < 10; i++) c.set(`k${i}`, T, { i });
  must(size(c) === 10, `size ${c.size}`);
  // One set after they expire leaves only itself.
  c.set("late", T + USAGE_CACHE_MS, { late: true });
  must(size(c) === 1 && c.get("late", T + USAGE_CACHE_MS) !== null, `after expiry: size ${c.size}`);
  // 1000 distinct keys, all live: never more than the cap, and the oldest are the ones gone.
  const big = new UsageCache();
  let most = 0;
  for (let i = 0; i < 1000; i++) { big.set(`k${i}`, T + i, { i }); most = Math.max(most, big.size); }
  must(USAGE_CACHE_ENTRIES === 256 && most === 256 && big.size === 256, `most ${most}, size ${big.size}`);
  must(big.get("k999", T + 1000) !== null && big.get("k744", T + 1000) !== null && big.get("k743", T + 1000) === null && big.get("k0", T + 1000) === null, "not the oldest evicted");
  // A key set again moves to the end: it outlives keys set after its first set.
  const order = new UsageCache(3);
  order.set("a", T, {}); order.set("b", T, {}); order.set("a", T + 1, {}); order.set("c", T + 2, {}); order.set("d", T + 3, {});
  must(order.get("a", T + 3) !== null && order.get("b", T + 3) === null && order.size === 3, `size ${order.size}`);
  // Through tenantUsage: a 400-day window is read and not stored; a 30-day one is stored.
  const cache = new UsageCache();
  let reads = 0;
  const count = () => reads;
  const deps: ProvisionUsage = {
    limits: limitsOf({}), cache,
    today: async (_t, now) => { reads++; return { day: dayOf(now), tenantUsd: 0, platformUsd: 0, override: null }; },
    costs: async () => ({ total: 0, periods: [], agents: [] }),
  };
  await tenantUsage("t-a", new URLSearchParams("from=2025-09-08&to=2026-10-12"), deps, T);
  await tenantUsage("t-a", new URLSearchParams("from=2025-09-08&to=2026-10-12"), deps, T + 1);
  must(size(cache) === 0 && count() === 2, `400 days: size ${cache.size}, reads ${reads}`);
  await tenantUsage("t-a", new URLSearchParams("from=2026-08-11&to=2026-10-12"), deps, T);
  await tenantUsage("t-a", new URLSearchParams("from=2026-08-11&to=2026-10-12"), deps, T + 1);
  must(size(cache) === 1 && count() === 3, `62 days: size ${cache.size}, reads ${reads}`);
});

await check("the Worker keeps the answer: a second request within 15 s is the first one's, spend since notwithstanding", async () => {
  const db = d1();
  const day = today();
  spend(db, "t-a", 1, day);
  const a = await token(db, { scope: "tenant", tenantId: "t-a" });
  const e = env(db);
  const first = await get(e, "/provision/usage", `Bearer ${a}`);
  spend(db, "t-a", 2, day, "b");
  const second = await get(e, "/provision/usage", `Bearer ${a}`, true);
  must(first.status === 200 && second.text === first.text && Math.abs(second.body.today.spentUsd - 1) < 1e-5, `${first.text} / ${second.text}`);
  // The control: emptied, the same request reads the new spend.
  const fresh = await get(e, "/provision/usage", `Bearer ${a}`);
  must(Math.abs(fresh.body.today.spentUsd - 3) < 1e-5, fresh.text);
});

// ---- the window ----------------------------------------------------------------------------------------------

await check("the window: 30 days by day unless asked; month buckets; the answer names it, and is no-store", async () => {
  const db = d1();
  const day = today();
  spend(db, "t-a", 1, day, "raft_x");
  spend(db, "t-a", 2, day - 10 * DAY, "raft_y");
  spend(db, "t-a", 4, day - 40 * DAY, "raft_z");
  row(db, { tenant: "t-a", hour: day, agent: "raft_x", resource: "tool.call", key: "js.unpriced", unit: "calls", quantity: 3 });
  const a = await token(db, { scope: "tenant", tenantId: "t-a" });
  const e = env(db);
  const r = await get(e, "/provision/usage", `Bearer ${a}`);
  must(r.status === 200 && r.cache === "no-store", `${r.status} ${r.cache}`);
  must(r.body.currency === "USD" && r.body.estimated === true && r.body.bucket === "day", show(r.body));
  must(r.body.to === new Date(day + DAY).toISOString() && Date.parse(r.body.from) <= day - 29 * DAY && Date.parse(r.body.from) > day - 31 * DAY, `${r.body.from}..${r.body.to}`);
  must(Math.abs(r.body.totalUsd - 3) < 1e-5 && r.body.periods.length === 2 && show(r.body.agents.map((x: any) => x.providerAgentId)) === show(["raft_y", "raft_x"]), show(r.body));
  const todays = r.body.periods.at(-1);
  must(show(todays.unpriced) === show(["tool.call js.unpriced calls"]) && todays.resources.some((x: any) => x.resource === "tool.call" && x.costUsd === 0), show(todays));
  // The same figures as the reader under it, so the shape, not the arithmetic, is all this route adds.
  const own = await readTenantCosts(db, "t-a", Date.parse(r.body.from), Date.parse(r.body.to), "day");
  must(own.total === r.body.totalUsd && show(own.agents.map((x) => x.total)) === show(r.body.agents.map((x: any) => x.totalUsd)), `${show(own)} vs ${r.text}`);
  // `today` is today whatever the window: a window that ends before it still reports today's spend and limit.
  const past = await get(e, `/provision/usage?from=${new Date(day - 20 * DAY).toISOString().slice(0, 10)}&to=${new Date(day - 5 * DAY).toISOString().slice(0, 10)}`, `Bearer ${a}`);
  must(past.status === 200 && Math.abs(past.body.totalUsd - 2) < 1e-5 && show(past.body.agents.map((x: any) => x.providerAgentId)) === show(["raft_y"]), past.text);
  must(past.body.today.spentUsd === r.body.today.spentUsd && Math.abs(past.body.today.spentUsd - 1) < 1e-5 && past.body.today.day === r.body.today.day, show(past.body.today));
  const from = new Date(day - 60 * DAY).toISOString().slice(0, 10);
  const m = await get(e, `/provision/usage?bucket=month&from=${from}`, `Bearer ${a}`);
  must(m.status === 200 && m.body.bucket === "month" && Math.abs(m.body.totalUsd - 7) < 1e-5 && m.body.periods.every((p: any) => /-01T00:00:00\.000Z$/.test(p.start)), m.text);
});

await check("a bad query is 400 in the provider envelope", async () => {
  const db = d1();
  const a = await token(db, { scope: "tenant", tenantId: "t-a" });
  const e = env(db);
  for (const q of ["bucket=week", "from=yesterday", "from=2026-10-10&to=2026-10-01", "from=2025-01-01&to=2026-10-01", "to=2026-02-31", "to=2026-10-01T25:00Z"]) {
    const r = await get(e, `/provision/usage?${q}`, `Bearer ${a}`);
    must(r.status === 400 && r.body?.error?.code === "invalid" && typeof r.body.error.message === "string" && r.cache === "no-store", `${q}: ${r.status} ${r.text}`);
  }
  // The control: the 400-day window is the cap, not a refusal of every window.
  const ok = await get(e, "/provision/usage?from=2025-09-01&to=2026-10-01", `Bearer ${a}`);
  must(ok.status === 200, `${ok.status} ${ok.text}`);
});

await check("only GET: another method is not part of the binding", async () => {
  const db = d1();
  const a = await token(db, { scope: "tenant", tenantId: "t-a" });
  const r = await worker.fetch(new Request("https://antiproton.test/provision/usage", { method: "POST", headers: { authorization: `Bearer ${a}` }, body: "{}" }), env(db) as never);
  must(r.status === 404, `POST: ${r.status}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
