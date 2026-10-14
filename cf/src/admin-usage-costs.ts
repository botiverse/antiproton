/**
 * `GET /admin/usage-costs?from=&to=&bucket=day|month`: what every tenant's usage cost us, estimated, by
 * period and resource (docs/metering.md, "Prices"). The operator's view: it reads across tenants and keeps
 * the unaccepted model answers the tenant's views leave out (`readUsageCosts`, cf/src/usage-d1.ts).
 *
 * The operator's header, closed when no token is configured, as /admin/identity is: a route that shows every
 * tenant's spending does not open for a local dev server that forgot to set one. Or a signed-in admin, decided
 * by the caller (cf/src/index.ts, auth.ts isAdmin), as /admin/spend-limits is, so the admin host's page can read it.
 */
import { isOperator } from "./auth.ts";
import { DAY_MS } from "./usage-windows.ts";
import { periodStart, type TenantCosts } from "./usage-d1.ts";

const answer = (body: unknown, status = 200, allow?: string) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...(allow ? { allow } : {}) } });

/** The widest window one read may cover: a year and a bit, so twelve whole months always fit. */
export const COSTS_WINDOW_MAX_MS = 400 * DAY_MS;
/** With no `from`, the read covers the last this many days. */
export const COSTS_DEFAULT_DAYS = 30;

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The window and period from the query, widened to whole periods; a string says what is wrong. A date alone
 * (`2026-10-01`) is that day's 00:00Z.
 */
export function parseCostsQuery(q: URLSearchParams, now: number): { from: number; to: number; bucket: "day" | "month" } | string {
  const bucket = q.get("bucket") ?? "day";
  if (bucket !== "day" && bucket !== "month") return "bucket is day or month";
  const time = (name: string, fallback: number): number | string => {
    const v = q.get(name);
    if (v === null || v === "") return fallback;
    const given = v.replace(/ (\d{2}:\d{2})$/, "+$1");
    const t = ISO.test(given) && onTheCalendar(given) ? Date.parse(given) : NaN;
    return Number.isFinite(t) ? t : `${name} is an ISO 8601 date or time with a zone, e.g. 2026-10-01 or 2026-10-01T00:00:00Z`;
  };
  const to = time("to", now);
  if (typeof to === "string") return to;
  const from = time("from", to - COSTS_DEFAULT_DAYS * DAY_MS);
  if (typeof from === "string") return from;
  if (to <= from) return "to must be later than from";
  if (to - from > COSTS_WINDOW_MAX_MS) return `the window from..to is at most ${COSTS_WINDOW_MAX_MS / DAY_MS} days`;
  const start = periodStart(from, bucket);
  // `to` up to the next period boundary, unless it is on one already.
  const end = periodStart(to, bucket) === to ? to : bucket === "day" ? periodStart(to, "day") + DAY_MS : nextMonth(to);
  return { from: start, to: end, bucket };
}

/**
 * The form names days a reader counts, closed interval. parseCostsQuery reads a bare date as that
 * day's 00:00, so a `to` taken straight from the form would stand the last day outside the window
 * (applying an unchanged form walks the window back a day each time). A date-only `to` is moved to
 * the next day's 00:00, so the named day counts whole; a `to` with a time is a half-open boundary
 * already and is left alone.
 */
export function closedCostsTo(q: URLSearchParams): URLSearchParams {
  const to = q.get("to");
  if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return q;
  // A date the calendar does not have is left for parseCostsQuery to refuse: Date.parse rolls
  // 2026-02-31 over to 03-03 and turns 2026-13-01 into a throw, and a hand-edited URL should
  // read as the refusal it is, not as a nearby date or a 500.
  if (!onTheCalendar(`${to}T00:00:00Z`)) return q;
  const next = new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS);
  const out = new URLSearchParams(q);
  out.set("to", next.toISOString().slice(0, 10));
  return out;
}

/**
 * Whether the date and time written are ones the calendar has. `Date.parse` rolls an impossible one over rather
 * than refusing it — 2026-02-31 reads as 2026-03-03, T24:00 as the next day's midnight — so a window asked for in
 * a typo would answer for days nobody asked about. The fields are checked as written, before any zone applies.
 */
export function onTheCalendar(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (!m) return false;
  const [y, mo, d, h = "0", mi = "0", sec = "0"] = m.slice(1) as string[];
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return day.getUTCFullYear() === Number(y) && day.getUTCMonth() === Number(mo) - 1 && day.getUTCDate() === Number(d)
    && Number(h) <= 23 && Number(mi) <= 59 && Number(sec) <= 59;
}

function nextMonth(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export async function adminUsageCosts(
  request: Request, token: string | undefined, read: (from: number, to: number, bucket: "day" | "month") => Promise<TenantCosts[]>,
  url: URL, now = Date.now(), admin = false,
): Promise<Response> {
  if (!admin && !isOperator(token, request.headers.get("x-harness-token"))) return answer({ error: "unauthorized" }, 401);
  if (request.method !== "GET") return answer({ error: "GET only" }, 405, "GET");
  const q = parseCostsQuery(url.searchParams, now);
  if (typeof q === "string") return answer({ error: q }, 400);
  const tenants = await read(q.from, q.to, q.bucket);
  return answer({
    // Every figure is an estimate from rough prices (cf/migrations/0016_usage_prices_seed.sql): said in the
    // body, so a figure copied out of it does not lose that.
    currency: "USD", estimated: true,
    from: iso(q.from), to: iso(q.to), bucket: q.bucket,
    total: Math.round(tenants.reduce((a, t) => a + t.total, 0) * 1e10) / 1e10,
    // The onboarding agents' part of `total` (cf/src/spend-limit.ts, its own daily pool, paid by the platform), so
    // their spend is a line of its own rather than lost inside each tenant's.
    onboarding: { total: Math.round(tenants.reduce((a, t) => a + (t.onboarding?.total ?? 0), 0) * 1e10) / 1e10 },
    tenants: tenants.map((t) => ({
      ...t, periods: t.periods.map((p) => ({ ...p, start: iso(p.start) })),
      ...(t.onboarding ? { onboarding: { ...t.onboarding, periods: t.onboarding.periods.map((p) => ({ ...p, start: iso(p.start) })) } } : {}),
    })),
  });
}
