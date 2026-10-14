/**
 * `GET /provision/usage?from=&to=&bucket=day|month`: what the token's tenant has spent, against its daily limit,
 * for Raft's panel ("today $x / $5", and a cost history). docs/agent-surface.md, "The tenant's spend".
 *
 * The tenant is the one `tenantFor` (cf/src/provision/handlers.ts) gives every provider route, and every read here
 * is scoped to it in its own query: nothing is read across tenants and then filtered. `today` is the enforcer's
 * own reading and rule (`readDaySpend` and `standing`, cf/src/spend-limit.ts), so the panel cannot say "under"
 * while the queue consumer refuses; of the platform's total only whether its limit is reached is given.
 */
import { DAY_MS, type OwnCosts } from "../usage-d1.ts";
import { parseCostsQuery } from "../admin-usage-costs.ts";
import { dayOf, isExempt, standing, type DaySpend, type SpendLimits } from "../spend-limit.ts";

export interface ProvisionUsage {
  limits: SpendLimits;
  /** `readDaySpend` over the control database. */
  today(tenantId: string, now: number): Promise<DaySpend>;
  /** `readTenantCosts` over the control database. */
  costs(tenantId: string, from: number, to: number, bucket: "day" | "month"): Promise<OwnCosts>;
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
  // The limits are in the key, so a deployment's new limits are never answered with the old ones.
  const key = JSON.stringify([tenantId, q.from, q.to, q.bucket, deps.limits.tenantUsd, deps.limits.freeUsd, deps.limits.proUsd, deps.limits.platformUsd,
    deps.limits.onboardingUsd, deps.limits.onboardingTenantUsd,
    isExempt(tenantId, deps.limits)]);
  // A window longer than a panel polls is read afresh and not kept (`USAGE_CACHE_WINDOW_MAX_MS`).
  const cache = q.to - q.from <= USAGE_CACHE_WINDOW_MAX_MS ? deps.cache : undefined;
  const kept = cache?.get(key, now);
  if (kept) return kept;
  const answer = await read(tenantId, q, deps, now);
  cache?.set(key, now, answer);
  return answer;
}

async function read(tenantId: string, q: { from: number; to: number; bucket: "day" | "month" }, deps: ProvisionUsage, now: number): Promise<object> {
  const [spend, costs] = await Promise.all([deps.today(tenantId, now), deps.costs(tenantId, q.from, q.to, q.bucket)]);
  const s = standing(tenantId, spend, deps.limits);
  const iso = (t: number) => new Date(t).toISOString();
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
  };
}

const tidy = (n: number) => Math.round(n * 1e10) / 1e10;
