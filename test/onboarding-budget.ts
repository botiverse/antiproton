/**
 * The onboarding budget and the server's plan (cf/src/spend-limit.ts; docs/metering.md "Daily limits";
 * docs/agent-surface.md "Which budget pays (`budget`)" and "The server's plan (`plan`)").
 *
 * - `budget` on POST /provision/agents: strictly validated, stored on the row, answered, and fixed (a replay must repeat it);
 * - `plan` on POST and `PUT /provision/servers/:id/plan`: strictly validated, the latest write wins, a replayed create
 *   writes none;
 * - the onboarding pool: its agents' spend is in neither their tenant's figure nor the platform's, and they are judged
 *   by the onboarding limit alone, through the real Worker's queue consumer;
 * - the plan picks the tenant's default ($3 free, $10 pro), an admin's override still wins;
 * - the admin's onboarding override (`/admin/spend-limits` with `pool`), and the onboarding line in the cost views.
 *
 * The real migrations on node:sqlite as D1 (as test/spend-limit.ts runs them), the real provision handler over the real
 * D1 registry with the agent's object faked, and the real Worker for the queue and the HTTP routes.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { handleProvision, type ProvisionDeps } from "../cf/src/provision/handlers.ts";
import { d1ProvisionedAgents, d1ProviderTokens } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import {
  adminSpendLimits, d1SpendLimits, d1TenantPlans, judge, limitsOf, ONBOARDING_LIMIT_TEXT, onboardingTenantLimitText, readAgentPool, readDaySpend,
  SPEND_LIMIT_ERROR, SpendGate, tenantLimitText,
} from "../cf/src/spend-limit.ts";
import { readUsageCosts } from "../cf/src/usage-d1.ts";
import { adminUsageCosts } from "../cf/src/admin-usage-costs.ts";
import { spendLimitsPanel, usageCostsPanel } from "../cf/src/ui.ts";
import { sharedUsageCache } from "../cf/src/provision/usage.ts";
import { setLogSink } from "../src/core/log.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-5;

/** D1 as node:sqlite, with every migration in cf/migrations applied (test/spend-limit.ts's). */
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
type Db = ReturnType<typeof d1>;

const H = 3_600_000;
const DAY = 24 * H;
const TODAY = Date.parse("2026-10-12T00:00:00Z");
const NOON = TODAY + 12 * H;
/** deepseek-flash output is $1.20 per 1M tokens (0016): this many tokens cost `usd`. */
const tokensFor = (usd: number) => Math.round(usd / 0.0000012);
function spend(db: Db, tenant: string, agent: string, usd: number, hour = TODAY + 3 * H, resource = "model.tokens") {
  db.raw.prepare("INSERT INTO usage_hourly(tenant_id, hour, agent_id, resource, key, unit, quantity) VALUES (?,?,?,?,?,?,?)")
    .run(tenant, hour, agent, resource, "deepseek-flash:output", "tokens", tokensFor(usd));
}
/** A provisioned agent's row, as a create writes it. */
async function agentRow(db: Db, tenantId: string, agentId: string, budget: "onboarding" | null) {
  await d1ProvisionedAgents(db).create({
    tenantId, raftAgentId: agentId, agentId, raftServerId: "srv", raftOrigin: "https://raft.example", name: agentId, instructions: "",
    credentialHash: null, budget, status: "active", pushRegistered: true, pushError: null,
  });
}
async function logged(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  setLogSink((l) => lines.push(l));
  try { await fn(); } finally { setLogSink(null); }
  return lines;
}

// ---- the provision contract -------------------------------------------------------------------------------------

const WHO = { label: "raft-prod", tenantId: "t-raft", raftOrigin: "https://api.raft.build", scope: "tenant" as const };
const PLATFORM = { label: "raft-deployment", raftOrigin: "https://api.raft.build", scope: "platform" as const };
const CRED = "sk_agent_" + "R".repeat(32);

/** The real handler over the real D1 registry and plan store; the agent's object answers every step. */
function provisionWorld(opts: { plans?: boolean } = {}) {
  const db = d1();
  let t = 1_800_000_000_000;
  const deps: ProvisionDeps = {
    now: () => (t += 1000),
    registry: d1ProvisionedAgents(db, () => t),
    ...(opts.plans === false ? {} : { plans: d1TenantPlans(db) }),
    agent: {
      adopt: async () => {},
      attachCredential: async () => ({ ok: true, account: "@cindy" }),
      removeCredential: async () => true,
      tool: async () => ({ ok: true, result: { enabled: true } }),
      pushStatus: async () => ({ enabled: true, registration: "active", lastReached: null }),
    },
  };
  const call = async (method: string, path: string, payload?: unknown, who: typeof WHO | typeof PLATFORM = WHO, credentialId = "tokhash") => {
    const r = await handleProvision(method, path, { idempotencyKey: null, raftServerId: null, credentialId }, payload, who, deps);
    if (!r) return { status: 0, body: null as any, text: "" };
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : null) as any, text };
  };
  const plan = (tenantId: string) => (db.raw.prepare("SELECT plan, set_by FROM tenant_plans WHERE tenant_id = ?").get(tenantId) as any) ?? null;
  const rows = () => Number((db.raw.prepare("SELECT COUNT(*) AS n FROM provisioned_agents").get() as any).n);
  return { db, deps, call, plan, rows };
}
const body = (over: Record<string, unknown> = {}) => ({
  raftAgentId: "01JCINDY", raftServerId: "srv-1", raftOrigin: WHO.raftOrigin, name: "Cindy", instructions: "onboard", credential: CRED, ...over,
});

await check("budget on POST: only \"onboarding\", or absent/null; anything else is 422 naming budget, and nothing is made", async () => {
  const w = provisionWorld();
  for (const bad of ["Onboarding", "tenant", "", 1, true, {}, ["onboarding"]]) {
    const r = await w.call("POST", "/agents", body({ budget: bad }));
    must(r.status === 422 && r.body?.error?.code === "invalid" && r.body?.error?.param === "budget", `budget ${show(bad)}: ${r.status} ${r.text}`);
  }
  must(w.rows() === 0, `${w.rows()} rows made by refused creates`);
  // The control: the one value there is, and absent, are made.
  must((await w.call("POST", "/agents", body({ budget: "onboarding" }))).status === 201, "onboarding refused");
  must((await w.call("POST", "/agents", body({ raftAgentId: "01JPLAIN", budget: null }))).status === 201, "null refused");
});

await check("budget is stored on the row, answered, and fixed: the same replay is 200, another (absent included) is 409 naming budget", async () => {
  const w = provisionWorld();
  const made = await w.call("POST", "/agents", body({ budget: "onboarding" }));
  must(made.status === 201 && made.body.budget === "onboarding", `${made.status} ${made.text}`);
  const stored = w.db.raw.prepare("SELECT budget FROM provisioned_agents WHERE raft_agent_id = ?").get("01JCINDY") as any;
  must(stored?.budget === "onboarding", show(stored));
  must((await readAgentPool(w.db, "t-raft", made.body.providerAgentId)) === "onboarding", "the gate's read does not see it");
  const same = await w.call("POST", "/agents", body({ budget: "onboarding" }));
  must(same.status === 200 && same.body.budget === "onboarding", `the same replay: ${same.status} ${same.text}`);
  for (const other of [{}, { budget: null }]) {
    const r = await w.call("POST", "/agents", body(other));
    must(r.status === 409 && r.body.error.code === "idempotency_conflict" && /budget/.test(r.body.error.message), `${show(other)}: ${r.status} ${r.text}`);
  }
  // The other way round: an agent made on its tenant's budget cannot be moved to onboarding by a replay; absent and
  // null are one value, so either replays it.
  const plain = await w.call("POST", "/agents", body({ raftAgentId: "01JPLAIN" }));
  must(plain.status === 201 && !("budget" in plain.body), plain.text);
  must((await w.call("POST", "/agents", body({ raftAgentId: "01JPLAIN", budget: null }))).status === 200, "null did not replay absent");
  const moved = await w.call("POST", "/agents", body({ raftAgentId: "01JPLAIN", budget: "onboarding" }));
  must(moved.status === 409 && /budget/.test(moved.body.error.message), `${moved.status} ${moved.text}`);
  must((await readAgentPool(w.db, "t-raft", plain.body.providerAgentId)) === "tenant", "the refused replay moved the agent");
  // A PATCH has no budget to change: the registry's patch type has no such key, and the row is unchanged by one.
  await w.call("PATCH", `/agents/${made.body.providerAgentId}`, { name: "Cindy 2" });
  must((w.db.raw.prepare("SELECT budget FROM provisioned_agents WHERE raft_agent_id = ?").get("01JCINDY") as any).budget === "onboarding", "a PATCH changed it");
});

await check("plan on POST: only free or pro; written by a create, never by a replay, and not part of what a replay is compared with", async () => {
  const w = provisionWorld();
  for (const bad of ["Pro", "enterprise", "", 1, {}]) {
    const r = await w.call("POST", "/agents", body({ plan: bad }));
    must(r.status === 422 && r.body?.error?.param === "plan", `plan ${show(bad)}: ${r.status} ${r.text}`);
  }
  must(w.rows() === 0 && w.plan("t-raft") === null, "a refused create wrote something");
  must((await w.call("POST", "/agents", body({ plan: "pro" }))).status === 201, "create");
  must(w.plan("t-raft")?.plan === "pro" && w.plan("t-raft")?.set_by === "tokhash", show(w.plan("t-raft")));
  // An upgrade's opposite, said through the route (the token's tenant has an agent for srv-1 now): then the create's late retry, still saying pro, must not undo it.
  must((await w.call("PUT", "/servers/srv-1/plan", { plan: "free" })).status === 200, "PUT");
  const replay = await w.call("POST", "/agents", body({ plan: "pro" }));
  must(replay.status === 200 && w.plan("t-raft")?.plan === "free", `replay ${replay.status}, plan ${show(w.plan("t-raft"))}`);
  // Any plan, or none, replays the same create: it is the server's, not the agent's.
  must((await w.call("POST", "/agents", body())).status === 200 && (await w.call("POST", "/agents", body({ plan: "free" }))).status === 200, "a replay was compared on plan");
  // A new create says the plan as it is now: the latest write wins.
  must((await w.call("POST", "/agents", body({ raftAgentId: "01JNEXT", plan: "pro" }))).status === 201 && w.plan("t-raft")?.plan === "pro", show(w.plan("t-raft")));
  // A create without plan leaves the recorded one.
  must((await w.call("POST", "/agents", body({ raftAgentId: "01JNONE" }))).status === 201 && w.plan("t-raft")?.plan === "pro", show(w.plan("t-raft")));
});

await check("PUT /servers/:raftServerId/plan: the tenant the token gives, a body of exactly { plan }, the latest write wins", async () => {
  const w = provisionWorld();
  // A platform token: the tenant is the one the path's server names, as for every other provider route.
  let r = await w.call("PUT", "/servers/srv-9/plan", { plan: "pro" }, PLATFORM);
  must(r.status === 200 && r.body.plan === "pro" && r.body.raftServerId === "srv-9" && typeof r.body.updatedAt === "string", r.text);
  must(w.plan("raft_srv-9")?.plan === "pro" && w.plan("t-raft") === null, "another tenant was written");
  r = await w.call("PUT", "/servers/srv-9/plan", { plan: "free" }, PLATFORM);
  must(r.status === 200 && w.plan("raft_srv-9")?.plan === "free", "a downgrade did not land");
  // A tenant token names no server: the path's is taken only once the tenant has an agent made for it, else 403 and
  // nothing written; then the answer's raftServerId is that server's.
  let t = await w.call("PUT", "/servers/srv-1/plan", { plan: "pro" });
  must(t.status === 403 && t.body.error.code === "server_mismatch" && w.plan("t-raft") === null, `no agent yet: ${t.status} ${t.text}`);
  must((await w.call("POST", "/agents", body())).status === 201, "create");
  t = await w.call("PUT", "/servers/srv-2/plan", { plan: "pro" });
  must(t.status === 403 && w.plan("t-raft") === null, `another server's id: ${t.status} ${t.text}`);
  t = await w.call("PUT", "/servers/srv-1/plan", { plan: "pro" });
  must(t.status === 200 && t.body.raftServerId === "srv-1" && w.plan("t-raft")?.plan === "pro", `its own server: ${t.status} ${t.text}`);
  for (const [bad, param] of [[{}, "plan"], [{ plan: "gold" }, "plan"], [{ plan: null }, "plan"], [{ plan: "pro", tier: 1 }, "tier"]] as const) {
    const b = await w.call("PUT", "/servers/srv-9/plan", bad, PLATFORM);
    must(b.status === 422 && b.body.error.param === param, `${show(bad)}: ${b.status} ${b.text}`);
  }
  must(w.plan("raft_srv-9")?.plan === "free", "a refused PUT wrote");
  must((await w.call("PUT", "/servers/bad id/plan", { plan: "pro" }, PLATFORM)).status === 422, "a server id outside RAFT_ID");
  // Only PUT, and only where a plan store is wired.
  must((await w.call("GET", "/servers/srv-9/plan", undefined, PLATFORM)).status === 0, "GET answered");
  const bare = provisionWorld({ plans: false });
  must((await bare.call("PUT", "/servers/srv-9/plan", { plan: "pro" }, PLATFORM)).status === 0, "answered without a store");
  const create = await bare.call("POST", "/agents", body({ plan: "pro" }));
  must(create.status === 503 && create.body.error.param === "plan" && bare.rows() === 0, `a plan it cannot keep: ${create.status} ${create.text}`);
});

// ---- the pools --------------------------------------------------------------------------------------------------

const AT = limitsOf({});

await check("today's spend: an onboarding agent's is in the onboarding total, in neither its tenant's nor the platform's", async () => {
  const db = d1();
  await agentRow(db, "t", "cindy", "onboarding");
  await agentRow(db, "t", "own", null);
  await agentRow(db, "u", "cindy-u", "onboarding");
  spend(db, "t", "cindy", 2.5);
  spend(db, "t", "own", 1);
  spend(db, "t", "console", 0.25);                       // no provisioned row: the tenant's
  spend(db, "u", "cindy-u", 4);
  spend(db, "u", "other", 7);
  spend(db, "t", "cindy", 0.5, TODAY + 4 * H, "model.tokens.unaccepted");
  const s = await readDaySpend(db, "t", NOON);
  must(near(s.tenantUsd, 1.25) && near(s.platformUsd, 8.25), `tenant/platform ${show(s)}`);
  must(near(s.onboardingUsd, 7) && near(s.tenantOnboardingUsd, 2.5), `onboarding ${show(s)}`);
  // The control: the same spend with no onboarding row is the tenant's and the platform's.
  const plain = d1();
  spend(plain, "t", "cindy", 2.5);
  const p = await readDaySpend(plain, "t", NOON);
  must(near(p.tenantUsd, 2.5) && near(p.platformUsd, 2.5) && p.onboardingUsd === 0, show(p));
});

/** A gate over real D1, as sharedSpendGate builds it, on a clock the test moves, counting each read. */
function gateOn(db: Db, limits = AT) {
  const clock = { now: NOON };
  const seen = { spend: 0, pool: 0 };
  const gate = new SpendGate(
    (t, now) => { seen.spend++; return readDaySpend(db, t, now); }, limits, () => clock.now,
    (t, a) => { seen.pool++; return readAgentPool(db, t, a); });
  return { gate, clock, seen };
}

await check("an onboarding agent is judged by the onboarding limit alone: admitted with its tenant and the platform over theirs, refused at its own", async () => {
  const db = d1();
  await agentRow(db, "t", "cindy", "onboarding");
  spend(db, "t", "own", 4);                              // the tenant over its $3
  spend(db, "big", "x", 2000);                           // the platform at its $2000
  const { gate } = gateOn(db);
  const own = await gate.admit("t", "own");
  must(!own.admit && own.limit === "platform", `the tenant's own agent: ${show(own)}`);
  const cindy = await gate.admit("t", "cindy");
  must(cindy.admit, `the onboarding agent: ${show(cindy)}`);
  // Its pool at $30, in other tenants' onboarding agents as much as its own: refused, with its own sentence.
  const full = d1();
  await agentRow(full, "t", "cindy", "onboarding");
  await agentRow(full, "u", "cindy-u", "onboarding");
  spend(full, "t", "cindy", 10);
  spend(full, "u", "cindy-u", 20.5);
  const g2 = gateOn(full).gate;
  const lines: string[] = await logged(async () => {
    const v = await g2.admit("t", "cindy");
    must(!v.admit && v.limit === "onboarding" && v.text === ONBOARDING_LIMIT_TEXT, show(v));
  });
  must(lines.some((l) => l.includes("spend_limit.refused") && l.includes('"limit":"onboarding"') && l.includes('"agentId":"cindy"')), show(lines));
  // ... while the tenant's own agents, under their limits, are admitted: the pools do not touch.
  must((await g2.admit("t", "own")).admit, "the tenant's agent was refused by the onboarding pool");
  must(ONBOARDING_LIMIT_TEXT === "Onboarding daily usage limit reached; resets at 00:00 UTC.", ONBOARDING_LIMIT_TEXT);
});

await check("the tenant's limit is not charged with its onboarding agent's spend: its own agents are admitted, where the same spend on them is refused", async () => {
  const db = d1();
  await agentRow(db, "t", "cindy", "onboarding");
  spend(db, "t", "cindy", 25);
  const v = await gateOn(db).gate.admit("t", "own");
  must(v.admit, `refused by spend that is not the tenant's: ${show(v)}`);
  const control = d1();
  spend(control, "t", "cindy", 25);                      // no onboarding row: the same agent is the tenant's
  const c = await gateOn(control).gate.admit("t", "own");
  must(!c.admit && c.limit === "tenant" && c.text === tenantLimitText(25, 5), show(c));
});

await check("the plan picks the tenant's default: never said $5 (as before plans), free $3, pro $10; an admin's override wins over each", async () => {
  const db = d1();
  spend(db, "t", "a", 4);
  const plans = d1TenantPlans(db);
  let v = judge(await readDaySpend(db, "t", NOON), AT);
  must(v.admit, `no plan at $4: ${show(v)}`);
  spend(db, "t", "a", 1.01, TODAY + 2 * H);
  const s0 = await readDaySpend(db, "t", NOON);
  v = judge(s0, AT);
  must(!v.admit && v.limit === "tenant" && v.text === tenantLimitText(s0.tenantUsd, 5) && s0.plan === null, `no plan at $5.01: ${show(v)}`);
  await plans.set("t", "free", "h", 1);
  v = judge(await readDaySpend(db, "t", NOON), AT);
  must(!v.admit && v.text === tenantLimitText(s0.tenantUsd, 3), `free: ${show(v)}`);
  await plans.set("t", "pro", "h", 2);
  v = judge(await readDaySpend(db, "t", NOON), AT);
  must(v.admit, `pro at $5: ${show(v)}`);
  spend(db, "t", "a", 5.49, TODAY + 4 * H);
  const s = await readDaySpend(db, "t", NOON);
  void s0;
  v = judge(s, AT);
  must(!v.admit && v.text === tenantLimitText(s.tenantUsd, 10) && near(s.tenantUsd, 10.5), `pro at $10.50: ${show(v)}`);
  await d1SpendLimits(db).set("t", 20, "op", 3);
  must(judge(await readDaySpend(db, "t", NOON), AT).admit, "the override did not win over the plan");
  await d1SpendLimits(db).set("t", 1, "op", 4);
  must(!judge(await readDaySpend(db, "t", NOON), AT).admit, "a lower override did not win over pro");
  for (const plan of ["free", null] as const) {
    if (plan) await plans.set("t", plan, "h", 5); else db.raw.prepare("DELETE FROM tenant_plans").run();
    must(judge(await readDaySpend(db, "t", NOON), limitsOf({})).admit === false, `override with ${plan}`);
  }
  // A plan stored as something this code does not know reads as none.
  db.raw.prepare("UPDATE tenant_plans SET plan = 'gold' WHERE tenant_id = 't'").run();
  must((await readDaySpend(db, "t", NOON)).plan === null && (await plans.list()).length === 0, "an unknown plan was read");
});

await check("an agent's pool is read once per isolate; a pool read that fails admits the call and is read again", async () => {
  const db = d1();
  await agentRow(db, "t", "cindy", "onboarding");
  const { gate, clock, seen } = gateOn(db);
  // Read through a function: the compiler narrows a property it has just compared and calls the next comparison impossible.
  const counts = () => [seen.pool, seen.spend];
  await gate.admit("t", "cindy");
  await gate.admit("t", "own");
  must(show(counts()) === show([2, 1]), `first calls: ${show(seen)}`);
  clock.now += 60_000;
  await gate.admit("t", "cindy");
  await gate.admit("t", "own");
  must(show(counts()) === show([2, 2]), `after a minute: ${show(seen)}`);
  let fail = true;
  const g = new SpendGate((t, now) => readDaySpend(db, t, now), AT, () => NOON,
    async (t, a) => { if (fail) throw new Error("D1 away"); return readAgentPool(db, t, a); });
  const lines = await logged(async () => { const v = await g.admit("t", "cindy"); must(v.admit && v.why === "read_failed", show(v)); });
  must(lines.some((l) => l.includes("spend_limit.read_failed") && l.includes("D1 away")), show(lines));
  fail = false;
  spend(db, "t", "cindy", 31);
  const v = await g.admit("t", "cindy");
  must(!v.admit && v.limit === "onboarding", `the next read: ${show(v)}`);
});

await check("a tenant's onboarding share: one server's Cindy at its $1 is refused, with the share's sentence, while another server's is admitted", async () => {
  const db = d1();
  await agentRow(db, "a", "cindy-a", "onboarding");
  await agentRow(db, "b", "cindy-b", "onboarding");
  spend(db, "a", "cindy-a", 0.9);
  spend(db, "b", "cindy-b", 0.5);
  const { gate, clock } = gateOn(db);
  must((await gate.admit("a", "cindy-a")).admit && (await gate.admit("b", "cindy-b")).admit, "refused under $1");
  spend(db, "a", "cindy-a", 0.15, TODAY + 4 * H);
  clock.now += 60_000;
  const s = await readDaySpend(db, "a", clock.now);
  const va = await gate.admit("a", "cindy-a");
  must(!va.admit && va.limit === "onboarding_tenant" && va.text === onboardingTenantLimitText(s.tenantOnboardingUsd, 1), show(va));
  must(va.text.startsWith("This server's onboarding daily usage limit reached ($1.05 of $1.00)"), va.text);
  must((await gate.admit("b", "cindy-b")).admit, "another server's onboarding agent was refused");
  // The pool is far from its $30, so it is the share alone; and the share is not the tenant's own limit: a's own agents work.
  must(near(s.onboardingUsd, 1.55) && (await gate.admit("a", "own")).admit, show(s));
  // Unaccepted answers are ours, not the share's, as for the tenant's own limit.
  const u = d1();
  await agentRow(u, "a", "cindy-a", "onboarding");
  spend(u, "a", "cindy-a", 5, TODAY + H, "model.tokens.unaccepted");
  must((await gateOn(u).gate.admit("a", "cindy-a")).admit, "unaccepted spend counted against the share");
  // The pool still asked first: spent, its own sentence, whatever the share says.
  const p = d1();
  await agentRow(p, "a", "cindy-a", "onboarding");
  spend(p, "z", "cindy-z", 30);
  await agentRow(p, "z", "cindy-z", "onboarding");
  const vp = await gateOn(p).gate.admit("a", "cindy-a");
  must(!vp.admit && vp.limit === "onboarding" && vp.text === ONBOARDING_LIMIT_TEXT, show(vp));
});

await check("/admin/spend-limits with pool and tenantId: one tenant's share is set, lifted and cleared, audited, and touches no other tenant", async () => {
  const db = d1();
  await agentRow(db, "a", "cindy-a", "onboarding");
  await agentRow(db, "b", "cindy-b", "onboarding");
  spend(db, "a", "cindy-a", 2);
  spend(db, "b", "cindy-b", 2);
  const store = d1SpendLimits(db);
  let now = NOON;
  const call = (method: string, b?: unknown) => adminSpendLimits(method, b, "github:1", { store, limits: AT, now: () => now });
  const admitted = async (t: string) => (await gateOn(db).gate.admit(t, `cindy-${t}`)).admit;
  must(!(await admitted("a")) && !(await admitted("b")), "the $1 default did not refuse $2");
  const r = await call("PUT", { pool: "onboarding", tenantId: "a", limitUsd: 3 });
  must(r.status === 200 && show(await r.json()) === show({ pool: "onboarding", tenantId: "a", limitUsd: 3, setBy: "github:1", setAt: NOON }), "set");
  must(await admitted("a") && !(await admitted("b")), "the share applied to the wrong tenant");
  must((await readDaySpend(db, "a", NOON)).onboardingOverride === null, "the share read as the pool's override");
  now += 1;
  must((await call("PUT", { pool: "onboarding", tenantId: "b", limitUsd: null })).status === 200 && await admitted("b"), "null: no share limit");
  now += 1;
  must((await call("DELETE", { pool: "onboarding", tenantId: "a" })).status === 204 && !(await admitted("a")) && await admitted("b"), "clear");
  must((await call("DELETE", { pool: "onboarding", tenantId: "a" })).status === 404, "a second clear");
  must((await call("DELETE", { pool: "onboarding" })).status === 404, "the pool's own row was made by a share");
  const got = await (await call("GET")).json() as any;
  must(show(got.pools.map((p: any) => [p.pool, p.tenantId, p.limitUsd])) === show([["onboarding", "b", null]]), show(got.pools));
  must(show(got.poolEvents.map((e: any) => [e.tenantId, e.action, e.limitUsd])) === show([["a", "clear", null], ["b", "set", null], ["a", "set", 3]]), show(got.poolEvents));
  must(got.overrides.length === 0 && got.events.length === 0, "the tenant's own limit was written");
});

// ---- the admin's onboarding limit ---------------------------------------------------------------------------------

await check("/admin/spend-limits with pool: set, set to none, clear; audited apart from tenants; the gate's reading picks it up; bad input refused", async () => {
  const db = d1();
  await agentRow(db, "t", "cindy", "onboarding");
  spend(db, "t", "cindy", 31);
  const store = d1SpendLimits(db);
  let now = NOON;
  const call = (method: string, b?: unknown) => adminSpendLimits(method, b, "github:1", { store, limits: AT, now: () => now, plans: d1TenantPlans(db) });
  // The pool's own limit alone: the tenant's share is off here, and has its own check below.
  const admitted = async () => (await gateOn(db, limitsOf({ ONBOARDING_TENANT_DAILY_LIMIT_USD: "off" })).gate.admit("t", "cindy")).admit;
  must(!(await admitted()), "the $30 default did not refuse $31");
  let r = await call("PUT", { pool: "onboarding", limitUsd: 50 });
  must(r.status === 200 && show(await r.json()) === show({ pool: "onboarding", limitUsd: 50, setBy: "github:1", setAt: NOON }), "set");
  must((await readDaySpend(db, "t", NOON)).onboardingOverride?.limitUsd === 50 && await admitted(), "the override was not applied");
  now += 1;
  must((await call("PUT", { pool: "onboarding", limitUsd: null })).status === 200 && await admitted(), "null is no limit");
  now += 1;
  must((await call("DELETE", { pool: "onboarding" })).status === 204 && !(await admitted()), "clear: the default applies again");
  must((await call("DELETE", { pool: "onboarding" })).status === 404, "a second clear");
  for (const [bad, status] of [
    [{ pool: "tenant", limitUsd: 1 }, 422], [{ pool: "Onboarding", limitUsd: 1 }, 422], [{ pool: "onboarding", limitUsd: -1 }, 422],
    [{ pool: "onboarding", limitUsd: "5" }, 422], [{ pool: "onboarding" }, 422], [{ pool: "onboarding", tenantId: "", limitUsd: 1 }, 422],
    [{ pool: "onboarding", scope: "tenant", limitUsd: 1 }, 400],
  ] as const) {
    const b = await call("PUT", bad);
    must(b.status === status, `${show(bad)}: ${b.status}`);
  }
  await d1TenantPlans(db).set("t", "pro", "h", 7);
  const got = await (await call("GET")).json() as any;
  must(got.defaults.onboardingUsd === 30 && got.defaults.onboardingTenantUsd === 1 && got.defaults.proUsd === 10 && got.defaults.freeUsd === 3
    && got.defaults.tenantUsd === 5 && got.defaults.platformUsd === 2000, show(got.defaults));
  must(got.pools.length === 0 && got.overrides.length === 0 && got.events.length === 0, `tenant audit touched: ${show(got)}`);
  must(show(got.plans) === show([{ tenantId: "t", plan: "pro", setBy: "h", setAt: 7 }]), show(got.plans));
  must(show(got.poolEvents.map((e: any) => [e.pool, e.tenantId, e.action, e.limitUsd, e.previous, e.at])) === show([
    ["onboarding", null, "clear", null, { limitUsd: null }, NOON + 2],
    ["onboarding", null, "set", null, { limitUsd: 50 }, NOON + 1],
    ["onboarding", null, "set", 50, {}, NOON],
  ]), show(got.poolEvents));
  // The tenant form of the same route still works beside it.
  must((await call("PUT", { tenantId: "t", limitUsd: 9 })).status === 200, "the tenant override");
});

// ---- what the operator and the tenant see -------------------------------------------------------------------------

await check("the cost views: onboarding spend is its own line (API, usage-costs page, spend-limits page), and the tenant's today leaves it out", async () => {
  const db = d1();
  await agentRow(db, "t", "cindy", "onboarding");
  spend(db, "t", "cindy", 2);
  spend(db, "t", "own", 1);
  spend(db, "u", "x", 4);
  const costs = await readUsageCosts(db, TODAY, TODAY + DAY, "day");
  const t = costs.find((c) => c.tenantId === "t")!;
  must(near(t.total, 3) && t.onboarding && near(t.onboarding.total, 2) && !costs.find((c) => c.tenantId === "u")!.onboarding, show(costs));
  const api = await (await adminUsageCosts(new Request("https://x/admin/usage-costs?from=2026-10-12&to=2026-10-13"), "tok",
    (from, to, bucket) => readUsageCosts(db, from, to, bucket), new URL("https://x/admin/usage-costs?from=2026-10-12&to=2026-10-13"), NOON, true)).json() as any;
  must(near(api.total, 7) && near(api.onboarding.total, 2) && api.tenants.find((x: any) => x.tenantId === "t").onboarding.periods[0].start === "2026-10-12T00:00:00.000Z", show(api));
  const page = usageCostsPanel({ from: TODAY, to: TODAY + DAY, bucket: "day", tenants: costs, unpriced: [] });
  must(/<b>onboarding pool<\/b>[\s\S]*?\$2\.00/.test(page) && /incl\. \$2\.00 onboarding/.test(page), "the usage-costs page has no onboarding line");
  const limits = spendLimitsPanel({
    defaults: { tenantUsd: 5, freeUsd: 3, proUsd: 10, platformUsd: 2000, onboardingUsd: 30, onboardingTenantUsd: 1, exempt: [] }, overrides: [], events: [],
    pools: [{ pool: "onboarding", tenantId: null, limitUsd: 40, setBy: "op", setAt: NOON }, { pool: "onboarding", tenantId: "t", limitUsd: 2.5, setBy: "op", setAt: NOON }],
    poolEvents: [], plans: [{ tenantId: "t", plan: "pro" }],
    today: [{ tenantId: "t", usd: 1, onboarding: 2 }], platformToday: 5, onboardingToday: 2,
  });
  must(/onboarding pool — \$2\.00 today of \$40\.00/.test(limits), "the pool's line against its override");
  must(/<code>t<\/code> <span class="tag">pro<\/span>[\s\S]*?\$1\.00[\s\S]*?\+\$2\.00 onboarding of \$2\.50[\s\S]*?\$10\.00 <span class="hint-inline">default/.test(limits), "the tenant row: own spend, onboarding beside it, the pro default");
  must(/name="pool" value="onboarding"/.test(limits), "no form to set the onboarding limit");
  must(/<code>t<\/code>'s share:\s*\$2\.50/.test(limits) && /name="tenantId" value="t"/.test(limits), "the tenant's share override and its clear form");
});

// ---- the real Worker: the queue consumer, the routes ----------------------------------------------------------------

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { default: worker } = await import("../cf/src/index.ts");

await check("the Worker's queue handler: an onboarding agent is called while its tenant is over, and refused like any limit once its pool is spent", async () => {
  const db = d1();
  const hour = Math.floor(Date.now() / H) * H;
  if (Math.floor((Date.now() + 5_000) / DAY) !== Math.floor(Date.now() / DAY)) throw new Error("too close to 00:00 UTC; run again");
  // Tenants of their own: the Worker's gate is the isolate's, and keeps its readings.
  await agentRow(db, "q-t", "q-cindy", "onboarding");
  spend(db, "q-t", "q-own", 6, hour);
  const delivered: Array<{ agentId: string; answer: any }> = [];
  const stub = {
    takeJob: async () => ({ context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, model: { api: "offloaded", provider: "openai-compatible" } }),
    releaseJob: async () => true,
    deliverAnswer: async (_t: string, agentId: string, _j: string, answer: unknown) => { delivered.push({ agentId, answer }); return true; },
    recordImageAttempt: async () => true,
  };
  const env = {
    AGENT: { idFromString: (s: string) => s, get: () => stub }, CONTROL_DB: db, ARTIFACTS: {},
    HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key",
  };
  const batch = (tenantId: string, agentId: string) => ({
    queue: "model-calls",
    messages: [{ body: { doId: "do-1", tenantId, agentId, jobId: `j-${agentId}-${delivered.length}` }, ack() {}, retry() {} }],
  });
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: "Hi!" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 }); }) as typeof fetch;
  try {
    await worker.queue(batch("q-t", "q-own") as never, env as never);
    must(calls === 0 && delivered[0]!.answer.errorMessage === SPEND_LIMIT_ERROR && delivered[0]!.answer.providerError === tenantLimitText(6, 5), `own: ${show(delivered[0])}`);
    await worker.queue(batch("q-t", "q-cindy") as never, env as never);
    must(Number(calls) === 1 && delivered[1]!.answer.stopReason === "stop", `onboarding: provider ${calls}, ${show(delivered[1])}`);
    // Its pool spent, in a tenant of its own, so the isolate's readings of q-t do not stand in the way.
    await agentRow(db, "q-u", "q-cindy2", "onboarding");
    spend(db, "q-u", "q-cindy2", 30, hour);
    // q-u's share is lifted, so it is the pool that refuses (the share's own sentence has its own check).
    await d1SpendLimits(db).setPool("onboarding", "q-u", null, "op", 0);
    await worker.queue(batch("q-u", "q-cindy2") as never, env as never);
    must(Number(calls) === 1 && delivered[2]!.answer.errorMessage === SPEND_LIMIT_ERROR && delivered[2]!.answer.providerError === ONBOARDING_LIMIT_TEXT
      && delivered[2]!.answer.stopReason === "error", `pool spent: ${show(delivered[2])}`);
  } finally { globalThis.fetch = real; }
});

await check("GET /provision/usage and PUT /provision/servers/:id/plan through the Worker: today's plan and limit follow the PUT; onboarding spend is beside, not in, spentUsd", async () => {
  const db = d1();
  const day = Math.floor(Date.now() / DAY) * DAY;
  if (Math.floor((Date.now() + 5_000) / DAY) !== Math.floor(Date.now() / DAY)) throw new Error("too close to 00:00 UTC; run again");
  await agentRow(db, "raft_srv-7", "raft_cindy", "onboarding");
  spend(db, "raft_srv-7", "raft_cindy", 2, day);
  spend(db, "raft_srv-7", "raft_own", 6, day);
  const tok = newProviderToken();
  await d1ProviderTokens(db).issue({ hash: await hashProviderToken(tok), label: "raft-test", raftOrigin: "https://raft.example", scope: "platform" } as never);
  const env = { CONTROL_DB: db, AGENT: { idFromName: (s: string) => s, get: () => ({}) }, ARTIFACTS: {}, HARNESS_MODEL: "deepseek-flash" };
  const req = async (method: string, path: string, b?: unknown) => {
    sharedUsageCache.clear();
    const r = await worker.fetch(new Request(`https://antiproton.test${path}`, {
      method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    }), env as never);
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, text };
  };
  let u = await req("GET", "/provision/usage?raftServerId=srv-7");
  must(u.status === 200 && u.body.today.plan === null && u.body.today.limitUsd === 5 && near(u.body.today.spentUsd, 6) && near(u.body.today.onboardingUsd, 2)
    && u.body.today.refusing === true && u.body.today.onboardingLimitUsd === 1 && u.body.today.onboardingRefusing === true, show(u.body.today));
  const p = await req("PUT", "/provision/servers/srv-7/plan", { plan: "pro" });
  must(p.status === 200 && p.body.plan === "pro", `${p.status} ${p.text}`);
  u = await req("GET", "/provision/usage?raftServerId=srv-7");
  must(u.body.today.plan === "pro" && u.body.today.limitUsd === 10 && u.body.today.refusing === false, show(u.body.today));
  must((await req("PUT", "/provision/servers/srv-7/plan", { plan: "free" })).status === 200, "downgrade");
  u = await req("GET", "/provision/usage?raftServerId=srv-7");
  must(u.body.today.plan === "free" && u.body.today.limitUsd === 3 && u.body.today.refusing === true, show(u.body.today));
  // The tenant's share raised by an admin: its onboarding agents are no longer refused, and the panel says so.
  await d1SpendLimits(db).setPool("onboarding", "raft_srv-7", 5, "op", 0);
  u = await req("GET", "/provision/usage?raftServerId=srv-7");
  must(u.body.today.onboardingLimitUsd === 5 && u.body.today.onboardingRefusing === false, show(u.body.today));
  const bad = await req("PUT", "/provision/servers/srv-7/plan", { plan: "gold" });
  must(bad.status === 422 && bad.body.error.param === "plan", bad.text);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
