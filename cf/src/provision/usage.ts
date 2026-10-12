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
import { standing, type DaySpend, type SpendLimits } from "../spend-limit.ts";

export interface ProvisionUsage {
  limits: SpendLimits;
  /** `readDaySpend` over the control database. */
  today(tenantId: string, now: number): Promise<DaySpend>;
  /** `readTenantCosts` over the control database. */
  costs(tenantId: string, from: number, to: number, bucket: "day" | "month"): Promise<OwnCosts>;
}

/** The answer, or the query's problem as a sentence (a 400 in the provider envelope). */
export async function tenantUsage(tenantId: string, query: URLSearchParams, deps: ProvisionUsage, now: number): Promise<object | string> {
  const q = parseCostsQuery(query, now);
  if (typeof q === "string") return q;
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
    agents: costs.agents.map((a) => ({ agentId: a.agentId, totalUsd: a.total })),
  };
}

const tidy = (n: number) => Math.round(n * 1e10) / 1e10;
