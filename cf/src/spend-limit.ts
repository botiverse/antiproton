/**
 * Daily spend limits (credits phase 2; docs/metering.md, "Daily limits").
 *
 * Three limits per UTC day, all in US dollars at the ledger's prices (cf/src/usage-d1.ts `priceFor`):
 *
 * - **per tenant**: an admin's override for that tenant (`spend_limits`, cf/migrations/0018_spend_limits.sql; NULL
 *   there is "no per-tenant limit"), else by the tenant's plan as Raft last said it (`tenant_plans`, 0021):
 *   FREE_DAILY_LIMIT_USD (default $3) for `free`, PRO_DAILY_LIMIT_USD (default $10) for `pro`, and DAILY_LIMIT_USD
 *   (default $5, the limit every tenant had before plans) for a tenant Raft has never given a plan, so no tenant's
 *   limit drops before Raft has said what its server is on;
 * - **platform**: PLATFORM_DAILY_LIMIT_USD (default $2000) over every tenant's spend, `bench` included;
 * - **onboarding**: ONBOARDING_DAILY_LIMIT_USD (default $30), or an admin's override (`spend_pool_limits`, 0021), over
 *   the spend of every agent created with `budget: "onboarding"` (`provisioned_agents.budget`), in any tenant;
 * - **a tenant's onboarding share**: ONBOARDING_TENANT_DAILY_LIMIT_USD (default $1), or an admin's override for that
 *   tenant (`spend_pool_limits` with its tenant id), over that tenant's onboarding agents alone. Without it one server's
 *   users could spend the whole pool and stop onboarding on every other server.
 *
 * The onboarding pool is a pool of its own: its agents' spend is in neither the tenant's figure nor the platform's,
 * and their calls are judged by the onboarding limits alone (the pool's, then the tenant's share). So an onboarding agent is not refused because its tenant or
 * the platform is out of money, and a run of onboardings cannot spend the platform's budget either. What the two pools
 * can spend together is the sum of their limits; there is no ceiling over both.
 *
 * A tenant in DAILY_LIMIT_EXEMPT_TENANTS (default `bench`) is refused by none: its spend still counts toward the
 * platform total (or the onboarding total, for its onboarding agents), which is what lets the platform limit see a
 * benchmark's spend.
 *
 * What is counted is what the ledger prices, so what costs us money and nothing else: a key paid with the
 * tenant's own credential (`own:`) is priced 0 by `priceFor`, and an unpriced key counts nothing, as in every
 * view. `model.tokens.unaccepted` is our cost and is in the platform total, but not in a tenant's.
 *
 * The check is made once per model call, in the queue consumer, after the job is taken and before the provider
 * is called (`admit` in cf/src/model-queue.ts): the one place every model call of both engines goes through.
 * A refused call is answered, not thrown, so the queue acks it and nothing retries it (`refusalAnswer`).
 */
import { UNACCEPTED_TOKENS } from "../../src/usage/outbox.ts";
import { errorMessage, SPEND_LIMIT_ERROR, type AnsweredMessage } from "../../src/model/pi-bridge.ts";
import { logEvent } from "../../src/core/log.ts";
import { DAY_MS, priceFor, usagePrices } from "./usage-d1.ts";

/** A tenant Raft has never given a plan: the limit every tenant had before plans. */
export const DEFAULT_DAILY_LIMIT_USD = 5;
/** A tenant on the `free` plan. */
export const DEFAULT_FREE_DAILY_LIMIT_USD = 3;
/** A tenant on the `pro` plan. */
export const DEFAULT_PRO_DAILY_LIMIT_USD = 10;
export const DEFAULT_PLATFORM_DAILY_LIMIT_USD = 2000;
export const DEFAULT_ONBOARDING_DAILY_LIMIT_USD = 30;
/** One tenant's share of the onboarding pool. */
export const DEFAULT_ONBOARDING_TENANT_DAILY_LIMIT_USD = 1;
export const DEFAULT_EXEMPT_TENANTS: readonly string[] = ["bench"];

/**
 * How long one isolate trusts a reading of today's spend. Far from both limits a reading is kept for
 * `SPEND_CACHE_MS`; within `NEAR_FRACTION` of either it is kept for `SPEND_CACHE_NEAR_MS`, so the calls that can
 * cross a limit are the ones read most often. Together with the ledger's own lag (an object sends its usage at
 * the end of an alarm pass, cf/src/usage-flush.ts) this is what bounds the overshoot (docs/metering.md).
 */
export const SPEND_CACHE_MS = 30_000;
export const SPEND_CACHE_NEAR_MS = 5_000;
export const NEAR_FRACTION = 0.8;

/** The refused answer's `errorMessage` (src/model/pi-bridge.ts says why it is fixed text, and why it lives there). */
export { SPEND_LIMIT_ERROR };
export const PLATFORM_LIMIT_TEXT = "Platform daily usage limit reached; resets at 00:00 UTC.";
export const ONBOARDING_LIMIT_TEXT = "Onboarding daily usage limit reached; resets at 00:00 UTC.";
export const onboardingTenantLimitText = (spentUsd: number, limitUsd: number) =>
  `This server's onboarding daily usage limit reached ($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}); resets at 00:00 UTC.`;
export const tenantLimitText = (spentUsd: number, limitUsd: number) =>
  `Daily usage limit reached ($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}); resets at 00:00 UTC.`;

export interface SpendLimitEnv {
  DAILY_LIMIT_USD?: string; FREE_DAILY_LIMIT_USD?: string; PRO_DAILY_LIMIT_USD?: string; PLATFORM_DAILY_LIMIT_USD?: string; ONBOARDING_DAILY_LIMIT_USD?: string;
  ONBOARDING_TENANT_DAILY_LIMIT_USD?: string; DAILY_LIMIT_EXEMPT_TENANTS?: string;
}
/**
 * `tenantUsd` is the default of a tenant with no plan, `freeUsd` a free tenant's, `proUsd` a pro tenant's; `onboardingUsd` the pool's and
 * `onboardingTenantUsd` one tenant's share of it, each before an admin's override.
 */
export interface SpendLimits {
  tenantUsd: number | null; freeUsd: number | null; proUsd: number | null; platformUsd: number | null; onboardingUsd: number | null; onboardingTenantUsd: number | null;
  exempt: ReadonlySet<string>;
}

/** A Raft server's plan (`plan` on POST /provision/agents, PUT /provision/servers/:id/plan). No plan is its own case. */
export const PLANS = ["free", "pro"] as const;
export type Plan = (typeof PLANS)[number];
/** Which limit judges an agent's calls: its tenant's (with the platform's), or the onboarding pool's. */
export type Pool = "tenant" | "onboarding";
/** The pools an admin may set a limit for (`/admin/spend-limits`, `pool`). */
export const POOLS: readonly Exclude<Pool, "tenant">[] = ["onboarding"];

/**
 * A dollar var: unset or empty is the default, `off` is no limit, a number at or above 0 is that. Anything else
 * is logged and read as the default: a typo must not lift a cap on money.
 */
function usdVar(name: string, v: unknown, fallback: number): number | null {
  const s = v === undefined || v === null ? "" : String(v).trim().toLowerCase();
  if (s === "") return fallback;
  if (s === "off") return null;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) return n;
  logEvent("spend_limit.bad_config", { name, value: s.slice(0, 40) });
  return fallback;
}

export function limitsOf(env: SpendLimitEnv): SpendLimits {
  const exempt = env.DAILY_LIMIT_EXEMPT_TENANTS === undefined
    ? DEFAULT_EXEMPT_TENANTS
    : String(env.DAILY_LIMIT_EXEMPT_TENANTS).split(",").map((t) => t.trim()).filter(Boolean);
  return {
    tenantUsd: usdVar("DAILY_LIMIT_USD", env.DAILY_LIMIT_USD, DEFAULT_DAILY_LIMIT_USD),
    freeUsd: usdVar("FREE_DAILY_LIMIT_USD", env.FREE_DAILY_LIMIT_USD, DEFAULT_FREE_DAILY_LIMIT_USD),
    proUsd: usdVar("PRO_DAILY_LIMIT_USD", env.PRO_DAILY_LIMIT_USD, DEFAULT_PRO_DAILY_LIMIT_USD),
    platformUsd: usdVar("PLATFORM_DAILY_LIMIT_USD", env.PLATFORM_DAILY_LIMIT_USD, DEFAULT_PLATFORM_DAILY_LIMIT_USD),
    onboardingUsd: usdVar("ONBOARDING_DAILY_LIMIT_USD", env.ONBOARDING_DAILY_LIMIT_USD, DEFAULT_ONBOARDING_DAILY_LIMIT_USD),
    onboardingTenantUsd: usdVar("ONBOARDING_TENANT_DAILY_LIMIT_USD", env.ONBOARDING_TENANT_DAILY_LIMIT_USD, DEFAULT_ONBOARDING_TENANT_DAILY_LIMIT_USD),
    exempt: new Set(exempt),
  };
}

export const dayOf = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;

/**
 * Today's spend so far, as one read of the ledger sees it. An override null: no row; `{ limitUsd: null }`: unlimited.
 *
 * - `tenantUsd`: the tenant's agents on its own budget, `model.tokens.unaccepted` left out;
 * - `platformUsd`: every tenant's agents on their own budget, unaccepted included;
 * - `onboardingUsd`: every agent on the onboarding budget, in any tenant, unaccepted included;
 * - `tenantOnboardingUsd`: this tenant's share of that, unaccepted left out (as in `tenantUsd`) — what the tenant's
 *   onboarding share is judged on, and in neither of the tenant's other figures;
 * - `plan`: the tenant's plan as Raft last said it, null when it never did;
 * - `onboardingOverride` the pool's override, `onboardingTenantOverride` the admin's override of this tenant's share.
 */
export interface DaySpend {
  day: number; tenantUsd: number; platformUsd: number; onboardingUsd: number; tenantOnboardingUsd: number;
  override: { limitUsd: number | null } | null; plan: Plan | null; onboardingOverride: { limitUsd: number | null } | null;
  onboardingTenantOverride: { limitUsd: number | null } | null;
}

const limitRow = (r: any) => r ? { limitUsd: r.limit_usd === null || r.limit_usd === undefined ? null : Number(r.limit_usd) } : null;

/**
 * Today's (UTC) priced spend for `tenantId` and for every tenant, from `usage_hourly` (today is never folded:
 * KEEP_HOURLY_DAYS), split by the budget each row's agent was created on (`provisioned_agents.budget`; an agent with no
 * row there — the console's, the Agents API's — is on its tenant's), with the tenant's override and plan and the
 * onboarding pool's overrides (its own, and this tenant's share). Five reads in parallel, one round trip's wait.
 * `folded` reads a past day that may already be in usage_daily (`GET /provision/budgets/onboarding?date=`).
 */
export async function readDaySpend(db: D1Database, tenantId: string, now: number, folded = false): Promise<DaySpend> {
  const day = dayOf(now);
  // A past day may have been folded into usage_daily (foldUsage, cf/src/usage-d1.ts), and is read from both tables:
  // the fold moves a day in one batch, so no row is in both. Today never is (KEEP_HOURLY_DAYS), and usage_daily has
  // no index on `day` alone, so the enforcer's reading of today leaves it out rather than scan it every 30 s.
  const ledger = folded
    ? `(SELECT tenant_id, agent_id, hour, resource, key, unit, quantity FROM usage_hourly WHERE hour >= ?2 AND hour < ?3
        UNION ALL SELECT tenant_id, agent_id, day AS hour, resource, key, unit, quantity FROM usage_daily WHERE day >= ?2 AND day < ?3)`
    : "usage_hourly";
  const [rows, prices, override, plan, poolRows] = await Promise.all([
    // The join is on provisioned_agents' unique (tenant_id, agent_id), so it never multiplies a ledger row.
    db.prepare(
      `SELECT u.tenant_id = ?1 AS mine, COALESCE(p.budget = 'onboarding', 0) AS onboarding, u.hour, u.resource, u.key, u.unit,
              SUM(u.quantity) AS quantity
       FROM ${ledger} u LEFT JOIN provisioned_agents p ON p.tenant_id = u.tenant_id AND p.agent_id = u.agent_id
       WHERE u.hour >= ?2 AND u.hour < ?3 GROUP BY mine, onboarding, u.hour, u.resource, u.key, u.unit`,
    ).bind(tenantId, day, day + DAY_MS).all(),
    usagePrices(db),
    db.prepare("SELECT limit_usd FROM spend_limits WHERE tenant_id = ?").bind(tenantId).first() as Promise<any>,
    db.prepare("SELECT plan FROM tenant_plans WHERE tenant_id = ?").bind(tenantId).first() as Promise<any>,
    db.prepare("SELECT tenant_id, limit_usd FROM spend_pool_limits WHERE pool = 'onboarding' AND tenant_id IN ('', ?)").bind(tenantId).all(),
  ]);
  let tenantUsd = 0;
  let platformUsd = 0;
  let onboardingUsd = 0;
  let tenantOnboardingUsd = 0;
  for (const r of (rows.results ?? []) as any[]) {
    const row = { bucket: Number(r.hour), resource: String(r.resource), key: String(r.key), unit: String(r.unit) };
    const p = priceFor(prices, row);
    const mine = Number(r.mine) === 1;
    if (p === null) { noteUnpriced(day, row, mine ? tenantId : null); continue; }
    const cost = p * Number(r.quantity);
    const ours = row.resource !== UNACCEPTED_TOKENS;
    if (Number(r.onboarding) === 1) {
      onboardingUsd += cost;
      if (mine && ours) tenantOnboardingUsd += cost;
    } else {
      platformUsd += cost;
      if (mine && ours) tenantUsd += cost;
    }
  }
  return {
    day, tenantUsd, platformUsd, onboardingUsd, tenantOnboardingUsd,
    override: limitRow(override),
    plan: plan && (PLANS as readonly string[]).includes(String(plan.plan)) ? String(plan.plan) as Plan : null,
    onboardingOverride: limitRow(((poolRows.results ?? []) as any[]).find((r) => r.tenant_id === "")),
    onboardingTenantOverride: limitRow(((poolRows.results ?? []) as any[]).find((r) => r.tenant_id === tenantId)),
  };
}

/** The budget an agent's calls are judged by: its `provisioned_agents.budget`, its tenant's when it has no row. */
export async function readAgentPool(db: D1Database, tenantId: string, agentId: string): Promise<Pool> {
  const r: any = await db.prepare("SELECT budget FROM provisioned_agents WHERE tenant_id = ? AND agent_id = ?").bind(tenantId, agentId).first();
  return r && r.budget === "onboarding" ? "onboarding" : "tenant";
}

/**
 * An unpriced key counts nothing toward either limit, as in every view, so spend on it is not limited at all: an
 * admin's choice of a model with no price row, say. Said once per key per isolate per UTC day (`spend_limit.unpriced`),
 * so it is seen where an operator looks, without a line per call.
 */
const unpricedSeen = { day: 0, keys: new Set<string>() };
function noteUnpriced(day: number, row: { resource: string; key: string; unit: string }, tenantId: string | null) {
  if (unpricedSeen.day !== day) { unpricedSeen.day = day; unpricedSeen.keys.clear(); }
  const k = `${row.resource}\u0000${row.key}\u0000${row.unit}`;
  if (unpricedSeen.keys.has(k)) return;
  unpricedSeen.keys.add(k);
  logEvent("spend_limit.unpriced", { resource: row.resource, key: row.key, unit: row.unit, day: new Date(day).toISOString().slice(0, 10), tenantId });
}

export type Admission =
  | { admit: true; why: "exempt" | "under" | "read_failed" }
  | { admit: false; limit: "platform" | "tenant" | "onboarding" | "onboarding_tenant"; text: string };

/**
 * The tenant's limit today: an admin's override when there is one (null there is none), else its plan's default, and
 * with no plan ever said the default every tenant had before plans.
 */
export function tenantLimitOf(spend: DaySpend, limits: SpendLimits): number | null {
  if (spend.override) return spend.override.limitUsd;
  return spend.plan === "pro" ? limits.proUsd : spend.plan === "free" ? limits.freeUsd : limits.tenantUsd;
}

/** The onboarding pool's limit today: an admin's override when there is one (null there is none), else the deployment's. */
export function onboardingLimitOf(spend: DaySpend, limits: SpendLimits): number | null {
  return spend.onboardingOverride ? spend.onboardingOverride.limitUsd : limits.onboardingUsd;
}

/** The tenant's share of the onboarding pool today: an admin's override for it (null there is none), else the deployment's. */
export function onboardingTenantLimitOf(spend: DaySpend, limits: SpendLimits): number | null {
  return spend.onboardingTenantOverride ? spend.onboardingTenantOverride.limitUsd : limits.onboardingTenantUsd;
}

/** Whether the platform's limit is reached: then nobody but an exempt tenant works. */
export function platformReached(spend: DaySpend, limits: SpendLimits): boolean {
  return limits.platformUsd !== null && spend.platformUsd >= limits.platformUsd;
}

export const isExempt = (tenantId: string, limits: SpendLimits) => limits.exempt.has(tenantId);

/**
 * What today's spend says for an agent of a tenant that is not exempt. An onboarding agent is judged by the onboarding
 * limits alone: the pool's first (when it is reached no onboarding agent works), then its tenant's share. Any other:
 * the platform limit first, since when it is reached nobody works, then the tenant's.
 */
export function judge(spend: DaySpend, limits: SpendLimits, pool: Pool = "tenant"): Admission {
  if (pool === "onboarding") {
    const limit = onboardingLimitOf(spend, limits);
    if (limit !== null && spend.onboardingUsd >= limit) return { admit: false, limit: "onboarding", text: ONBOARDING_LIMIT_TEXT };
    const share = onboardingTenantLimitOf(spend, limits);
    if (share !== null && spend.tenantOnboardingUsd >= share) {
      return { admit: false, limit: "onboarding_tenant", text: onboardingTenantLimitText(spend.tenantOnboardingUsd, share) };
    }
    return { admit: true, why: "under" };
  }
  if (platformReached(spend, limits)) return { admit: false, limit: "platform", text: PLATFORM_LIMIT_TEXT };
  const tenantLimit = tenantLimitOf(spend, limits);
  if (tenantLimit !== null && spend.tenantUsd >= tenantLimit) return { admit: false, limit: "tenant", text: tenantLimitText(spend.tenantUsd, tenantLimit) };
  return { admit: true, why: "under" };
}

/**
 * Where a tenant stands today, for the tenant to see (`GET /provision/usage`, cf/src/provision/usage.ts): the
 * figures `judge` decides on and its verdict, so what a panel shows and what the queue consumer does are one
 * rule. The platform's own figures are not in it, only whether its limit is reached: they are every tenant's
 * spend added up, and another tenant's numbers are not this tenant's to read.
 *
 * `refusing` is the verdict on this reading; the consumer may be acting on a reading up to `SPEND_CACHE_MS` old
 * (`SpendGate`), and admits a call when its own read fails.
 */
export interface Standing {
  spentUsd: number; limitUsd: number | null; /** null: Raft has never said. */ plan: Plan | null; exempt: boolean; platformLimitReached: boolean; refusing: boolean;
  /** The tenant's onboarding agents' spend today: paid by the platform, in neither `spentUsd` nor `limitUsd`. */
  onboardingUsd: number;
  /** The tenant's share of the onboarding pool (null: none, or exempt), and whether its onboarding agents' next call would be refused. */
  onboardingLimitUsd: number | null;
  onboardingRefusing: boolean;
}
export function standing(tenantId: string, spend: DaySpend, limits: SpendLimits): Standing {
  const exempt = isExempt(tenantId, limits);
  return {
    spentUsd: spend.tenantUsd,
    limitUsd: exempt ? null : tenantLimitOf(spend, limits),
    plan: spend.plan,
    onboardingUsd: spend.tenantOnboardingUsd,
    onboardingLimitUsd: exempt ? null : onboardingTenantLimitOf(spend, limits),
    onboardingRefusing: exempt ? false : !judge(spend, limits, "onboarding").admit,
    exempt,
    platformLimitReached: platformReached(spend, limits),
    // As `SpendGate.admit`: an exempt tenant is admitted before anything is judged.
    refusing: exempt ? false : !judge(spend, limits).admit,
  };
}

/** Whether a reading is within `NEAR_FRACTION` of a limit that judges `pool`; undefined (not known yet) asks both. */
function near(spend: DaySpend, limits: SpendLimits, pool: Pool | undefined): boolean {
  if (pool === undefined) return near(spend, limits, "tenant") || near(spend, limits, "onboarding");
  if (pool === "onboarding") {
    const limit = onboardingLimitOf(spend, limits);
    const share = onboardingTenantLimitOf(spend, limits);
    return (limit !== null && spend.onboardingUsd >= limit * NEAR_FRACTION)
      || (share !== null && spend.tenantOnboardingUsd >= share * NEAR_FRACTION);
  }
  const tenantLimit = tenantLimitOf(spend, limits);
  return (limits.platformUsd !== null && spend.platformUsd >= limits.platformUsd * NEAR_FRACTION)
    || (tenantLimit !== null && spend.tenantUsd >= tenantLimit * NEAR_FRACTION);
}

/**
 * The check, with each tenant's last reading kept in this isolate's memory for `SPEND_CACHE_MS` (or
 * `SPEND_CACHE_NEAR_MS` near a limit), so a busy agent costs one D1 read per window rather than one per call.
 * A reading from an earlier UTC day is never used: at 00:00 UTC every tenant is read afresh, which is the reset.
 *
 * A read that fails admits the call and logs `spend_limit.read_failed`: availability is worth more than a cap of a
 * few dollars, and the ledger is unchanged, so the next read that works refuses as it should. A failure is not
 * kept, so the next call reads again.
 *
 * Which pool an agent is in (`poolOf`, its `provisioned_agents.budget`) is read once per agent and kept for the life of
 * the isolate: it is fixed when the agent is created, and the row is written before the agent exists to make a call.
 * When neither is known yet the two reads are made together. Without an agent id a call is judged as its tenant's.
 */
export class SpendGate {
  readonly #cache = new Map<string, { at: number; spend: DaySpend }>();
  readonly #pools = new Map<string, Pool>();
  readonly #read: (tenantId: string, now: number) => Promise<DaySpend>;
  readonly #poolOf: (tenantId: string, agentId: string) => Promise<Pool>;
  readonly #limits: SpendLimits;
  readonly #now: () => number;

  constructor(
    read: (tenantId: string, now: number) => Promise<DaySpend>, limits: SpendLimits, now: () => number = Date.now,
    poolOf: (tenantId: string, agentId: string) => Promise<Pool> = async () => "tenant",
  ) {
    this.#read = read;
    this.#poolOf = poolOf;
    this.#limits = limits;
    this.#now = now;
  }

  async admit(tenantId: string, agentId?: string): Promise<Admission> {
    if (isExempt(tenantId, this.#limits)) return { admit: true, why: "exempt" };
    const now = this.#now();
    const poolKey = agentId === undefined ? null : `${tenantId}\u0000${agentId}`;
    let pool: Pool | undefined = poolKey === null ? "tenant" : this.#pools.get(poolKey);
    let hit = this.#cache.get(tenantId);
    const fresh = hit && hit.spend.day === dayOf(now)
      && now - hit.at < (near(hit.spend, this.#limits, pool) ? SPEND_CACHE_NEAR_MS : SPEND_CACHE_MS);
    if (!fresh || pool === undefined) {
      try {
        const [p, spend] = await Promise.all([
          pool ?? this.#poolOf(tenantId, agentId!),
          fresh ? null : this.#read(tenantId, now),
        ]);
        pool = p;
        if (spend) hit = { at: now, spend };
      } catch (e) {
        logEvent("spend_limit.read_failed", { tenantId, agentId, error: String((e as Error)?.message ?? e).slice(0, 200) });
        return { admit: true, why: "read_failed" };
      }
      // Tenants and agents come and go; an isolate that has seen many starts over rather than keeping them all.
      if (this.#cache.size >= 10_000) this.#cache.clear();
      if (this.#pools.size >= 10_000) this.#pools.clear();
      if (!fresh) this.#cache.set(tenantId, hit!);
      if (poolKey !== null) this.#pools.set(poolKey, pool);
    }
    const verdict = judge(hit!.spend, this.#limits, pool);
    if (!verdict.admit) {
      logEvent("spend_limit.refused", {
        tenantId, agentId, limit: verdict.limit, tenantUsd: round(hit!.spend.tenantUsd), platformUsd: round(hit!.spend.platformUsd),
        onboardingUsd: round(hit!.spend.onboardingUsd), tenantOnboardingUsd: round(hit!.spend.tenantOnboardingUsd),
      });
    }
    return verdict;
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The answer a refused call is delivered: a failed turn, with no usage (so the ledger writes nothing for it,
 * docs/metering.md "Verdicts"), the fixed `SPEND_LIMIT_ERROR`, and the sentence in `providerError`. The sentence is in
 * the stored transcript, which the console and the Agents API show, and goes to Raft as the turn's `BridgeFatal` and
 * the agent's status detail (src/runtime/activity.ts, src/runtime/status.ts). It never reaches the model: both engines
 * leave a failed turn out of the next request. Named for the model the job would have called, like any answer to it.
 */
export function refusalAnswer(text: string, jobId: string, model: { api: string; provider: string; id: string }): AnsweredMessage {
  return { ...errorMessage(SPEND_LIMIT_ERROR, model), providerError: text, jobId };
}

// ---- the admin's per-tenant overrides ---------------------------------------------------------------------------

export interface SpendLimitRow { tenantId: string; limitUsd: number | null; setBy: string; setAt: number }
export interface SpendLimitEvent { tenantId: string; action: "set" | "clear"; limitUsd: number | null; previous: { limitUsd?: number | null }; by: string; at: number }

/** A pool's override: `tenantId` null is the pool's own limit, a tenant's id that tenant's share of it. */
export interface SpendPoolRow { pool: string; tenantId: string | null; limitUsd: number | null; setBy: string; setAt: number }
export interface SpendPoolEvent {
  pool: string; tenantId: string | null; action: "set" | "clear"; limitUsd: number | null; previous: { limitUsd?: number | null }; by: string; at: number;
}

export interface SpendLimitStore {
  list(): Promise<SpendLimitRow[]>;
  events(limit: number): Promise<SpendLimitEvent[]>;
  /** Writes the row and its audit event in one batch. */
  set(tenantId: string, limitUsd: number | null, by: string, at: number): Promise<void>;
  /** Removes the row and records it; false when there was none (nothing is recorded then). */
  clear(tenantId: string, by: string, at: number): Promise<boolean>;
  /** A pool's override (`spend_pool_limits`, 0021), kept and audited as a tenant's is. */
  listPools(): Promise<SpendPoolRow[]>;
  poolEvents(limit: number): Promise<SpendPoolEvent[]>;
  /** `tenantId` null: the pool's own limit; a tenant's id: that tenant's share. */
  setPool(pool: string, tenantId: string | null, limitUsd: number | null, by: string, at: number): Promise<void>;
  clearPool(pool: string, tenantId: string | null, by: string, at: number): Promise<boolean>;
}

export function d1SpendLimits(db: D1Database): SpendLimitStore {
  const current = async (tenantId: string) => {
    const r: any = await db.prepare("SELECT limit_usd FROM spend_limits WHERE tenant_id = ?").bind(tenantId).first();
    return r ? { limitUsd: r.limit_usd === null ? null : Number(r.limit_usd) } : null;
  };
  const event = (tenantId: string, action: "set" | "clear", limitUsd: number | null, previous: object, by: string, at: number) =>
    db.prepare("INSERT INTO spend_limit_events (tenant_id, action, limit_usd, previous, by, at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(tenantId, action, limitUsd, JSON.stringify(previous), by, at);
  // '' in the table is the pool's own row (a primary key column cannot be NULL); null everywhere else.
  const key = (tenantId: string | null) => tenantId ?? "";
  const tenantOf = (v: unknown) => v === "" || v === null || v === undefined ? null : String(v);
  const currentPool = async (pool: string, tenantId: string | null) =>
    limitRow(await db.prepare("SELECT limit_usd FROM spend_pool_limits WHERE pool = ? AND tenant_id = ?").bind(pool, key(tenantId)).first());
  const poolEvent = (pool: string, tenantId: string | null, action: "set" | "clear", limitUsd: number | null, previous: object, by: string, at: number) =>
    db.prepare("INSERT INTO spend_pool_limit_events (pool, tenant_id, action, limit_usd, previous, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(pool, key(tenantId), action, limitUsd, JSON.stringify(previous), by, at);
  return {
    async listPools() {
      const { results } = await db.prepare("SELECT pool, tenant_id, limit_usd, set_by, set_at FROM spend_pool_limits ORDER BY pool, tenant_id").all();
      return ((results ?? []) as any[]).map((r) => ({
        pool: String(r.pool), tenantId: tenantOf(r.tenant_id), limitUsd: r.limit_usd === null ? null : Number(r.limit_usd), setBy: String(r.set_by), setAt: Number(r.set_at),
      }));
    },
    async poolEvents(limit) {
      const { results } = await db.prepare(
        "SELECT pool, tenant_id, action, limit_usd, previous, by, at FROM spend_pool_limit_events ORDER BY id DESC LIMIT ?").bind(limit).all();
      return ((results ?? []) as any[]).map((r) => ({
        pool: String(r.pool), tenantId: tenantOf(r.tenant_id), action: r.action === "clear" ? "clear" as const : "set" as const,
        limitUsd: r.limit_usd === null ? null : Number(r.limit_usd), previous: JSON.parse(String(r.previous || "{}")), by: String(r.by), at: Number(r.at),
      }));
    },
    async setPool(pool, tenantId, limitUsd, by, at) {
      const previous = await currentPool(pool, tenantId);
      await db.batch([
        db.prepare(
          `INSERT INTO spend_pool_limits (pool, tenant_id, limit_usd, set_by, set_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(pool, tenant_id) DO UPDATE SET limit_usd = excluded.limit_usd, set_by = excluded.set_by, set_at = excluded.set_at`,
        ).bind(pool, key(tenantId), limitUsd, by, at),
        poolEvent(pool, tenantId, "set", limitUsd, previous ?? {}, by, at),
      ]);
    },
    async clearPool(pool, tenantId, by, at) {
      const previous = await currentPool(pool, tenantId);
      if (!previous) return false;
      await db.batch([
        db.prepare("DELETE FROM spend_pool_limits WHERE pool = ? AND tenant_id = ?").bind(pool, key(tenantId)),
        poolEvent(pool, tenantId, "clear", null, previous, by, at),
      ]);
      return true;
    },
    async list() {
      const { results } = await db.prepare("SELECT tenant_id, limit_usd, set_by, set_at FROM spend_limits ORDER BY tenant_id").all();
      return ((results ?? []) as any[]).map((r) => ({
        tenantId: String(r.tenant_id), limitUsd: r.limit_usd === null ? null : Number(r.limit_usd), setBy: String(r.set_by), setAt: Number(r.set_at),
      }));
    },
    async events(limit) {
      const { results } = await db.prepare(
        "SELECT tenant_id, action, limit_usd, previous, by, at FROM spend_limit_events ORDER BY id DESC LIMIT ?").bind(limit).all();
      return ((results ?? []) as any[]).map((r) => ({
        tenantId: String(r.tenant_id), action: r.action === "clear" ? "clear" as const : "set" as const,
        limitUsd: r.limit_usd === null ? null : Number(r.limit_usd), previous: JSON.parse(String(r.previous || "{}")), by: String(r.by), at: Number(r.at),
      }));
    },
    async set(tenantId, limitUsd, by, at) {
      const previous = await current(tenantId);
      await db.batch([
        db.prepare(
          `INSERT INTO spend_limits (tenant_id, limit_usd, set_by, set_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(tenant_id) DO UPDATE SET limit_usd = excluded.limit_usd, set_by = excluded.set_by, set_at = excluded.set_at`,
        ).bind(tenantId, limitUsd, by, at),
        event(tenantId, "set", limitUsd, previous ?? {}, by, at),
      ]);
    },
    async clear(tenantId, by, at) {
      const previous = await current(tenantId);
      if (!previous) return false;
      await db.batch([
        db.prepare("DELETE FROM spend_limits WHERE tenant_id = ?").bind(tenantId),
        event(tenantId, "clear", null, previous, by, at),
      ]);
      return true;
    },
  };
}

// ---- a tenant's plan, as Raft says it ----------------------------------------------------------------------------

export interface TenantPlanRow { tenantId: string; plan: Plan; setBy: string; setAt: number }
export interface TenantPlanStore {
  /** The latest write wins: a plan is the server's current one, not a fact fixed at some create. */
  set(tenantId: string, plan: Plan, by: string, at: number): Promise<void>;
  list(): Promise<TenantPlanRow[]>;
}

export function d1TenantPlans(db: D1Database): TenantPlanStore {
  return {
    async set(tenantId, plan, by, at) {
      await db.prepare(
        `INSERT INTO tenant_plans (tenant_id, plan, set_by, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET plan = excluded.plan, set_by = excluded.set_by, set_at = excluded.set_at`,
      ).bind(tenantId, plan, by, at).run();
    },
    async list() {
      const { results } = await db.prepare("SELECT tenant_id, plan, set_by, set_at FROM tenant_plans ORDER BY tenant_id").all();
      return ((results ?? []) as any[]).filter((r) => (PLANS as readonly string[]).includes(String(r.plan))).map((r) => ({
        tenantId: String(r.tenant_id), plan: String(r.plan) as Plan, setBy: String(r.set_by), setAt: Number(r.set_at),
      }));
    },
  };
}

const TENANT = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * `/admin/spend-limits`, for an admin (auth.ts isAdmin, checked by the caller, as for /admin/models):
 *
 *   GET                                        → { defaults: { tenantUsd, freeUsd, proUsd, platformUsd, onboardingUsd,
 *                                                  onboardingTenantUsd, exempt }, overrides, events, pools, poolEvents, plans }
 *   PUT    { tenantId, limitUsd: number|null } → the row as kept; null is "no per-tenant limit"
 *   DELETE { tenantId }                        → 204, or 404 when the tenant had no override
 *   PUT    { pool, limitUsd: number|null }     → a pool's own override (`pool`: "onboarding"); null is "no limit for it"
 *   DELETE { pool }                            → 204, or 404 when the pool had no override
 *   PUT    { pool, tenantId, limitUsd }        → one tenant's share of the pool; null is "no share limit for it"
 *   DELETE { pool, tenantId }                  → 204, or 404 when that tenant's share had no override
 *
 * The body's keys say what is set: `pool` a pool's limit, `tenantId` a tenant's, both together the tenant's share of
 * the pool.
 *
 * Every PUT and DELETE writes an audit row (`spend_limit_events`, `spend_pool_limit_events`). A change reaches a
 * running isolate within `SPEND_CACHE_MS`, the life of its last reading. `plans` is what Raft said, read only here.
 */
export async function adminSpendLimits(
  method: string, body: unknown, actor: string,
  deps: { store: SpendLimitStore; limits: SpendLimits; now(): number; plans?: Pick<TenantPlanStore, "list"> },
): Promise<Response> {
  if (method === "GET") {
    const l = deps.limits;
    return json({
      currency: "USD",
      defaults: {
        tenantUsd: l.tenantUsd, freeUsd: l.freeUsd, proUsd: l.proUsd, platformUsd: l.platformUsd, onboardingUsd: l.onboardingUsd,
        onboardingTenantUsd: l.onboardingTenantUsd, exempt: [...l.exempt].sort(),
      },
      overrides: await deps.store.list(),
      events: await deps.store.events(50),
      pools: await deps.store.listPools(),
      poolEvents: await deps.store.poolEvents(50),
      plans: deps.plans ? await deps.plans.list() : [],
    });
  }
  if (method !== "PUT" && method !== "DELETE") return refuse(405, "method", "GET, PUT or DELETE");
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  // What is set is named by the keys the body has: `pool` alone, `tenantId` alone, or both (the tenant's share of the pool).
  const isPool = "pool" in b;
  const allowed = [...(isPool ? ["pool"] : []), "tenantId", ...(method === "PUT" ? ["limitUsd"] : [])];
  const unknown = Object.keys(b).find((k) => !allowed.includes(k));
  if (unknown) return refuse(400, "unknown_field", `unknown field ${unknown}`);
  const at = deps.now();
  if (isPool && (typeof b.pool !== "string" || !(POOLS as readonly string[]).includes(b.pool))) return refuse(422, "invalid", `pool is one of ${POOLS.join(", ")}`);
  const hasTenant = "tenantId" in b;
  if ((hasTenant || !isPool) && (typeof b.tenantId !== "string" || !TENANT.test(b.tenantId))) return refuse(422, "invalid", "tenantId is a tenant's id");
  const pool = isPool ? String(b.pool) : null;
  const tenantId = hasTenant ? String(b.tenantId) : null;
  const what = pool === null ? "tenant" : tenantId === null ? "pool" : "tenant's share of the pool";
  const noLimit = pool === null ? "no per-tenant limit" : tenantId === null ? "no limit for the pool" : "no limit on the tenant's share";
  if (method === "DELETE") {
    const cleared = pool === null ? await deps.store.clear(tenantId!, actor, at) : await deps.store.clearPool(pool, tenantId, actor, at);
    return cleared ? new Response(null, { status: 204 }) : refuse(404, "not_found", `that ${what} has no override`);
  }
  if (!("limitUsd" in b)) return refuse(422, "invalid", `limitUsd is a number of dollars at or above 0, or null for ${noLimit}`);
  const limitUsd = b.limitUsd;
  if (limitUsd !== null && !(typeof limitUsd === "number" && Number.isFinite(limitUsd) && limitUsd >= 0)) {
    return refuse(422, "invalid", `limitUsd is a number of dollars at or above 0, or null for ${noLimit}`);
  }
  if (pool !== null) {
    await deps.store.setPool(pool, tenantId, limitUsd as number | null, actor, at);
    return json({ pool, ...(tenantId !== null ? { tenantId } : {}), limitUsd, setBy: actor, setAt: at });
  }
  await deps.store.set(tenantId!, limitUsd as number | null, actor, at);
  return json({ tenantId, limitUsd, setBy: actor, setAt: at });
}

const json = (v: unknown) => Response.json(v, { headers: { "cache-control": "no-store" } });
function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * The queue consumer's `admit` (cf/src/model-queue.ts): null to call the provider, or the refusal to deliver. The
 * refusal names the model the call would have reached, as `callQueuedModel` (cf/src/model-request.ts) would.
 */
export function spendAdmit(gate: Pick<SpendGate, "admit">, defaultModel: string) {
  return async (job: unknown, m: { tenantId: string; agentId: string; jobId: string }): Promise<AnsweredMessage | null> => {
    const verdict = await gate.admit(m.tenantId, m.agentId);
    if (verdict.admit) return null;
    const j = job as { model?: { api?: unknown; provider?: unknown }; operatorModel?: unknown } | null;
    return refusalAnswer(verdict.text, m.jobId, {
      api: String(j?.model?.api ?? "offloaded"), provider: String(j?.model?.provider ?? "openai-compatible"), id: String(j?.operatorModel ?? defaultModel),
    });
  };
}

/**
 * One gate per isolate, so its readings outlive a single queue batch. Rebuilt when the limits' vars differ (a new
 * deployment's isolate has new ones anyway); the D1 binding is taken from the latest environment on every read.
 */
let shared: { key: string; gate: SpendGate; db: { current: D1Database | undefined } } | null = null;
export function sharedSpendGate(env: SpendLimitEnv & { CONTROL_DB?: D1Database }): SpendGate {
  const key = JSON.stringify([env.DAILY_LIMIT_USD, env.FREE_DAILY_LIMIT_USD, env.PRO_DAILY_LIMIT_USD, env.PLATFORM_DAILY_LIMIT_USD, env.ONBOARDING_DAILY_LIMIT_USD,
    env.ONBOARDING_TENANT_DAILY_LIMIT_USD, env.DAILY_LIMIT_EXEMPT_TENANTS]);
  if (!shared || shared.key !== key) {
    const db = { current: env.CONTROL_DB };
    const bound = () => { if (!db.current) throw new Error("no CONTROL_DB binding"); return db.current; };
    shared = {
      key, db,
      gate: new SpendGate((tenantId, now) => readDaySpend(bound(), tenantId, now), limitsOf(env), Date.now,
        (tenantId, agentId) => readAgentPool(bound(), tenantId, agentId)),
    };
  }
  shared.db.current = env.CONTROL_DB;
  return shared.gate;
}
