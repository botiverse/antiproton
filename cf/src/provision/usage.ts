/**
 * `GET /provision/usage?from=&to=&bucket=day|month`: what the token's tenant has spent, against its daily limit,
 * for Raft's panel ("today $x / $5", and a cost history). docs/agent-surface.md, "The tenant's spend".
 *
 * The tenant is the one `tenantFor` (cf/src/provision/handlers.ts) gives every provider route, and every read here
 * is scoped to it in its own query: nothing is read across tenants and then filtered. `today` is the enforcer's
 * own reading and rule (`readDaySpend` and `standing`, cf/src/spend-limit.ts), so the panel cannot say "under"
 * while the queue consumer refuses; of the platform's total only whether its limit is reached is given.
 * `?byAgent=1` adds each provisioned agent's spend per UTC day (`agentDays`), for Raft's daily telemetry.
 *
 * `GET /provision/budgets/onboarding` (`onboardingPool`) is the shared onboarding pool on one day, for a platform token.
 */
import { DAY_MS, type OwnCosts } from "../usage-d1.ts";
import { onTheCalendar, parseCostsQuery } from "../admin-usage-costs.ts";
import { dayOf, isExempt, judge, onboardingLimitOf, standing, type DaySpend, type SpendLimits } from "../spend-limit.ts";

export interface ProvisionUsage {
  limits: SpendLimits;
  /** `readDaySpend` over the control database. */
  today(tenantId: string, now: number): Promise<DaySpend>;
  /** `readTenantCosts` over the control database; `byAgent` adds its `agentDays`. */
  costs(tenantId: string, from: number, to: number, bucket: "day" | "month", byAgent: boolean): Promise<OwnCosts>;
  /**
   * `readDaySpend` of the UTC day `day` starts, for no tenant (only its pool-wide figures are used), `folded` for a
   * past day so a day already folded into usage_daily is still counted. Absent: `/provision/budgets/onboarding` is 404.
   */
  pool?(day: number, folded: boolean): Promise<DaySpend>;
  /** Answers kept for a while (`UsageCache`); absent, every request reads. */
  cache?: UsageCache;
}

/**
 * How long one isolate keeps an answer. A panel polled by many open browsers would otherwise be one read of every
 * tenant's hours today (`readDaySpend`) and a scan of up to 400 days of the tenant's ledger per poll. Kept short so
 * that, added to the enforcer's own `SPEND_CACHE_MS` (30 s), what the panel says lags what the consumer does by
 * under a minute.
 */
export const USAGE_CACHE_MS = 15_000;

/**
 * The most answers one isolate keeps, and the longest window it keeps one for. An answer is about 236 KB at a
 * 400-day window (measured in review), and an isolate has about 128 MB: an answer is kept only for a window of at
 * most `USAGE_CACHE_WINDOW_MAX_MS` (what a panel polls; a longer history is asked for rarely, and read afresh), and
 * at most `USAGE_CACHE_ENTRIES` of them, so the cache stays a few MB however many windows a caller steps through.
 */
export const USAGE_CACHE_ENTRIES = 256;
export const USAGE_CACHE_WINDOW_MAX_MS = 62 * DAY_MS;

/**
 * The whole answer per tenant and normalised query (the window as `parseCostsQuery` widened it, so `?bucket=day`
 * and no query share one entry), in this isolate's memory. An answer computed on an earlier UTC day is never
 * served: its `today` is yesterday, and at 00:00 UTC the limit resets for everyone.
 *
 * Every `set` first drops what has expired, then, if still full, the oldest entries (a Map iterates in insertion
 * order, and a key set again is moved to the end): memory is bounded by the cap, not by how long an isolate lives.
 */
export class UsageCache {
  readonly #entries = new Map<string, { at: number; day: number; answer: object }>();
  readonly #max: number;
  constructor(max = USAGE_CACHE_ENTRIES) { this.#max = max; }
  get size(): number { return this.#entries.size; }
  get(key: string, now: number): object | null {
    const hit = this.#entries.get(key);
    return hit && live(hit, now) ? hit.answer : null;
  }
  set(key: string, now: number, answer: object): void {
    for (const [k, e] of this.#entries) if (!live(e, now)) this.#entries.delete(k);
    this.#entries.delete(key);
    while (this.#entries.size >= this.#max) this.#entries.delete(this.#entries.keys().next().value!);
    this.#entries.set(key, { at: now, day: dayOf(now), answer });
  }
  clear(): void { this.#entries.clear(); }
}
const live = (e: { at: number; day: number }, now: number) => e.day === dayOf(now) && now - e.at < USAGE_CACHE_MS;

/** The one cache of this isolate, which cf/src/index.ts gives every request's deps. */
export const sharedUsageCache = new UsageCache();

/** The answer, or the query's problem as a sentence (a 400 in the provider envelope). */
export async function tenantUsage(tenantId: string, query: URLSearchParams, deps: ProvisionUsage, now: number): Promise<object | string> {
  const q = parseCostsQuery(query, now);
  if (typeof q === "string") return q;
  const by = query.get("byAgent");
  if (by !== null && by !== "" && by !== "0" && by !== "1") return "byAgent is 1 or 0";
  const byAgent = by === "1";
  // Its days are UTC days whatever the periods are, and a month bucket beside them would read as a monthly breakdown.
  if (byAgent && q.bucket !== "day") return "byAgent=1 is per UTC day: use bucket=day";
  // The limits are in the key, so a deployment's new limits are never answered with the old ones; `byAgent` too, so
  // an answer without the breakdown is never served to a caller that asked for it, nor the other way.
  const key = JSON.stringify([tenantId, q.from, q.to, q.bucket, byAgent, deps.limits.tenantUsd, deps.limits.freeUsd, deps.limits.proUsd, deps.limits.platformUsd,
    deps.limits.onboardingUsd, deps.limits.onboardingTenantUsd,
    isExempt(tenantId, deps.limits)]);
  // A window longer than a panel polls is read afresh and not kept (`USAGE_CACHE_WINDOW_MAX_MS`).
  const cache = q.to - q.from <= USAGE_CACHE_WINDOW_MAX_MS ? deps.cache : undefined;
  const kept = cache?.get(key, now);
  if (kept) return kept;
  const answer = await read(tenantId, q, byAgent, deps, now);
  cache?.set(key, now, answer);
  return answer;
}

async function read(
  tenantId: string, q: { from: number; to: number; bucket: "day" | "month" }, byAgent: boolean, deps: ProvisionUsage, now: number,
): Promise<object> {
  const [spend, costs] = await Promise.all([deps.today(tenantId, now), deps.costs(tenantId, q.from, q.to, q.bucket, byAgent)]);
  const s = standing(tenantId, spend, deps.limits);
  return {
    // Every figure is an estimate from rough prices (docs/metering.md, "Prices"); said in the body so a figure
    // copied out of it keeps that.
    currency: "USD", estimated: true, tenantId,
    today: {
      day: iso(spend.day).slice(0, 10),
      spentUsd: tidy(s.spentUsd),
      limitUsd: s.limitUsd,
      plan: s.plan,
      // Paid by the platform (`budget: "onboarding"`), so in neither figure above; given so the panel can say why the
      // history's total for today is larger than `spentUsd`.
      onboardingUsd: tidy(s.onboardingUsd),
      // The tenant's share of the onboarding pool, and whether its onboarding agents' next call would be refused (by the
      // share, or by the pool as a whole being spent: only that boolean is said of the pool, as of the platform).
      onboardingLimitUsd: s.onboardingLimitUsd,
      onboardingRefusing: s.onboardingRefusing,
      exempt: s.exempt,
      platformLimitReached: s.platformLimitReached,
      refusing: s.refusing,
      resetsAt: iso(spend.day + DAY_MS),
    },
    from: iso(q.from), to: iso(q.to), bucket: q.bucket,
    totalUsd: costs.total,
    periods: costs.periods.map((p) => ({
      start: iso(p.start),
      totalUsd: p.total,
      resources: p.resources.map((r) => ({ resource: r.resource, costUsd: r.cost })),
      unpriced: p.resources.flatMap((r) => r.unpriced.map((k) => `${r.resource} ${k}`)),
    })),
    // Named as the provider's agent view names it (`view` in ./handlers.ts): the ledger's agent id is the providerAgentId.
    agents: costs.agents.map((a) => ({ providerAgentId: a.agentId, totalUsd: a.total })),
    // A key of its own rather than a second shape of `agents`, which a reader of the plain answer already relies on.
    ...(byAgent ? {
      agentDays: (costs.agentDays ?? []).map((a) => ({
        raftAgentId: a.raftAgentId, budget: a.budget, days: a.days.map((d) => ({ day: iso(d.start).slice(0, 10), usd: d.total })),
      })),
    } : {}),
  };
}

/**
 * `GET /provision/budgets/onboarding?date=YYYY-MM-DD`: the shared onboarding pool on one UTC day (default today), for
 * a platform-scoped token only; a figure summed over every tenant is not one tenant's to read (the caller refuses a
 * tenant-scoped token). The reading is the enforcer's (`readDaySpend`) and so is the verdict (`judge`): `capped` is
 * exactly "an onboarding agent's next call is refused by the pool", so it cannot say "under" while calls are refused.
 *
 * A past day is read from the ledger, folded days included; its `limitUsd` is the limit as it stands now, since an
 * admin's override is kept as its current value only. A day after today has no spend to read and is refused.
 */
export async function onboardingPool(query: URLSearchParams, deps: ProvisionUsage & { pool(day: number, folded: boolean): Promise<DaySpend> }, now: number): Promise<object | string> {
  const extra = [...query.keys()].find((k) => k !== "date" && k !== "raftServerId");
  if (extra) return `unknown parameter ${extra}; the query is ?date=YYYY-MM-DD`;
  const given = query.get("date");
  const today = dayOf(now);
  let day = today;
  if (given !== null) {
    // An empty `date=` is refused rather than read as today: a caller that meant a day and sent none should hear so.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(given) || !onTheCalendar(given)) return "date is a UTC day, YYYY-MM-DD";
    day = Date.parse(`${given}T00:00:00Z`);
    if (day > today) return `date is today (${iso(today).slice(0, 10)}) or earlier`;
  }
  const spend = await deps.pool(day, day < today);
  const verdict = judge(spend, deps.limits, "onboarding");
  return {
    date: iso(day).slice(0, 10),
    limitUsd: onboardingLimitOf(spend, deps.limits),
    spentUsd: tidy(spend.onboardingUsd),
    // The pool's refusal only. `judge` asks the pool first and then a tenant's share, and this reading is no tenant's:
    // a share of $0 (ONBOARDING_TENANT_DAILY_LIMIT_USD=0) refuses with "onboarding_tenant" while the pool is under.
    capped: !verdict.admit && verdict.limit === "onboarding",
  };
}

const iso = (t: number) => new Date(t).toISOString();

const tidy = (n: number) => Math.round(n * 1e10) / 1e10;
