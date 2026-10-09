/**
 * `GET /admin/usage-costs?from=&to=&bucket=day|month`: what every tenant's usage cost us, estimated, by
 * period and resource (docs/metering.md, "Prices"). The operator's view: it reads across tenants and keeps
 * the unaccepted model answers the tenant's views leave out (`readUsageCosts`, cf/src/usage-d1.ts).
 *
 * Operator header only, and closed when no token is configured, as /admin/identity is: a route that shows
 * every tenant's spending does not open for a local dev server that forgot to set one.
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
    const t = ISO.test(given) ? Date.parse(given) : NaN;
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

function nextMonth(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export async function adminUsageCosts(
  request: Request, token: string | undefined, read: (from: number, to: number, bucket: "day" | "month") => Promise<TenantCosts[]>,
  url: URL, now = Date.now(),
): Promise<Response> {
  if (!isOperator(token, request.headers.get("x-harness-token"))) return answer({ error: "unauthorized" }, 401);
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
    tenants: tenants.map((t) => ({ ...t, periods: t.periods.map((p) => ({ ...p, start: iso(p.start) })) })),
  });
}
