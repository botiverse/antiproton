/**
 * The tenant's hourly usage in D1: what agents send (`sendUsage`) and what the
 * dashboard reads (`readUsage`). The rows come from each agent's outbox
 * (src/usage/outbox.ts); migration 0005 made the tables.
 *
 * `usage_hourly` keeps the last `KEEP_HOURLY_DAYS` days. Past that, whole days
 * move into `usage_daily` (`foldUsage`, migration 0006) — the same quantities
 * under a bucket that says it is a day. Both tables are read together, so the
 * totals a page shows do not change when a day is folded; what is lost is the
 * hour a thing happened in, and only for days older than any window the page
 * offers.
 */
import { OWN_KEY_PREFIX, pendingUsage, pruneUsage, toHourly, UNACCEPTED_TOKENS, type OutboxRow } from "../../src/usage/outbox.ts";
import { logEvent } from "../../src/core/log.ts";
import { DAY_MS, USAGE_WINDOWS } from "./usage-windows.ts";

// Both live in usage-windows.ts so the page and this parser cannot hold
// different lists; re-exported because this is where their readers look.
export { DAY_MS, USAGE_WINDOWS };

/**
 * Send one agent's pending rows. Every statement runs only while the agent's
 * cursor still holds `expectedSeq`, and the last one moves it: a batch is one
 * D1 transaction, so either all of it counts or none does, and a send that
 * was retried or raced counts nothing twice. Whether this send was the one
 * that counted.
 */
export async function sendUsage(
  db: D1Database, tenantId: string, agentId: string, expectedSeq: number, rows: readonly OutboxRow[],
): Promise<boolean> {
  if (!rows.length) return true;
  const through = rows.reduce((m, r) => Math.max(m, r.seq), expectedSeq);
  const guard = "(SELECT last_seq FROM usage_cursor WHERE tenant_id = ? AND agent_id = ?) = ?";
  const stmts = [
    db.prepare("INSERT INTO usage_cursor(tenant_id, agent_id, last_seq) VALUES (?, ?, 0) ON CONFLICT DO NOTHING")
      .bind(tenantId, agentId),
    ...toHourly(rows.filter((r) => r.tenantId === tenantId && r.agentId === agentId)).map((h) =>
      db.prepare(
        "INSERT INTO usage_hourly(tenant_id, hour, agent_id, resource, key, unit, quantity) " +
        `SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard} ` +
        "ON CONFLICT(tenant_id, hour, agent_id, resource, key, unit) DO UPDATE SET quantity = quantity + excluded.quantity",
      ).bind(h.tenantId, h.hour, h.agentId, h.resource, h.key, h.unit, h.quantity, tenantId, agentId, expectedSeq)),
    db.prepare("UPDATE usage_cursor SET last_seq = ? WHERE tenant_id = ? AND agent_id = ? AND last_seq = ?")
      .bind(through, tenantId, agentId, expectedSeq),
  ];
  const results = await db.batch(stmts);
  return (results.at(-1)?.meta?.changes ?? 0) === 1;
}

/** How far this agent's outbox has been counted (0: nothing yet). */
export async function usageCursor(db: D1Database, tenantId: string, agentId: string): Promise<number> {
  const r: any = await db.prepare("SELECT last_seq FROM usage_cursor WHERE tenant_id = ? AND agent_id = ?")
    .bind(tenantId, agentId).first();
  return r ? Number(r.last_seq) : 0;
}

/**
 * How much of the ledger keeps its hours. Longer than the longest window the
 * page offers, and a test pins that: inside a window, every bucket must be
 * able to hold what it claims to hold, and a folded day placed in an hourly
 * bucket would sit at 00:00Z as if it had happened at midnight. Shortening
 * this below a window is therefore not a tuning change — it makes the hourly
 * chart say something untrue, and the page would have to say so first.
 */
export const KEEP_HOURLY_DAYS = 35;

/**
 * Move whole days out of the hours and into the days, oldest first.
 *
 * Each day is one `db.batch`, so its insert and its delete are one
 * transaction: after it, the hours it summed are gone. That is what makes a
 * second run a no-op rather than a doubling — not a marker saying "already
 * folded", which would have to be written somewhere and would be wrong the
 * moment a row arrived late. **The fold is idempotent because it moves rows
 * rather than copying them**, and a run that is interrupted between two days
 * leaves the rest for the next one.
 *
 * A row that arrives for an already folded day is not lost: it lands in
 * `usage_hourly` as any row does, and the next fold adds it to the day that is
 * already there (`DO UPDATE SET quantity = quantity + excluded.quantity`).
 * Reads sum both tables in the meantime, so it counts before it is folded too.
 * The two halves of that are one mechanism: the day list is whatever is still
 * in `usage_hourly` below the cutoff, so a late row puts its own old day back
 * on the list by existing — nothing has to notice that the day was reopened
 * (Vera read this out of the code, 2026-09-19).
 *
 * `maxDays` bounds one run: the first fold of a long-lived ledger would
 * otherwise be one very long invocation. What it did, so a caller can log it
 * and a test can see it.
 */
export async function foldUsage(
  db: D1Database, now: number, keepDays = KEEP_HOURLY_DAYS, maxDays = 31,
): Promise<{ days: number[]; hours: number }> {
  const cutoff = Math.floor(now / DAY_MS) * DAY_MS - keepDays * DAY_MS;
  // The day a row belongs to, by integer division: `hour` is INTEGER and so is
  // the literal, where a bound JS number would arrive as REAL and not divide
  // down to the bucket (the same trap readUsage's CAST is about).
  const { results } = await db.prepare(
    "SELECT DISTINCT (hour / 86400000) * 86400000 AS day FROM usage_hourly WHERE hour < ? ORDER BY day LIMIT ?",
  ).bind(cutoff, maxDays).all();
  const days = (results as any[]).map((r) => Number(r.day));
  let hours = 0;
  for (const day of days) {
    const end = day + DAY_MS;
    const done = await db.batch([
      db.prepare(
        "INSERT INTO usage_daily(tenant_id, day, agent_id, resource, key, unit, quantity) " +
        "SELECT tenant_id, ?, agent_id, resource, key, unit, SUM(quantity) FROM usage_hourly " +
        "WHERE hour >= ? AND hour < ? GROUP BY tenant_id, agent_id, resource, key, unit " +
        "ON CONFLICT(tenant_id, day, agent_id, resource, key, unit) DO UPDATE SET quantity = quantity + excluded.quantity",
      ).bind(day, day, end),
      db.prepare("DELETE FROM usage_hourly WHERE hour >= ? AND hour < ?").bind(day, end),
    ]);
    hours += Number(done.at(-1)?.meta?.changes ?? 0);
  }
  return { days, hours };
}

/**
 * The Worker's daily Cron Trigger (`scheduled` in cf/src/index.ts, `triggers.crons` in cf/wrangler.jsonc):
 * one fold at the trigger's own time. Hours are kept for `KEEP_HOURLY_DAYS`, not less, because that is what
 * the views were promised (the hourly-detail guard in test/spec/usage-spec.ts, `HOURLY_KEPT_MS` in
 * cf/src/agent-surface/usage.ts). A run that leaves days behind (`maxDays`) is finished by the next one; a
 * run that repeats one finds nothing to move (`foldUsage`).
 */
export async function retainUsage(db: D1Database, now: number): Promise<{ days: number[]; hours: number }> {
  const done = await foldUsage(db, now);
  logEvent("usage.fold", { days: done.days.length, hours: done.hours, first: done.days[0] ?? null });
  return done;
}

export type UsageGroupBy = "total" | "agent" | "model" | "tool";

export interface UsageReadRow {
  /** Start of the bucket, ms since the epoch (UTC). */
  bucket: number;
  /** The agent, model or tool for that grouping; "" where it does not apply; "total" for by=total. */
  group: string;
  resource: string;
  key: string;
  quantity: number;
  unit: string;
  /** Credits — US dollars, 1 credit = $1 (migration 0016) — once any price exists; absent before. */
  cost?: number | null;
}

export interface UsageQuery { window: string; from: number; to: number; bucket: "1h" | "1d"; by: UsageGroupBy }

/** What a read asks for, from the query string; a string says what is wrong. */
export function parseUsageQuery(q: URLSearchParams, now: number): UsageQuery | string {
  const window = q.get("window") ?? "24h";
  const span = USAGE_WINDOWS[window];
  if (!span) return `window is one of ${Object.keys(USAGE_WINDOWS).join(", ")}`;
  const bucket = q.get("bucket") ?? (window.endsWith("d") ? "1d" : "1h");
  if (bucket !== "1h" && bucket !== "1d") return "bucket is 1h or 1d";
  const by = q.get("by") ?? "total";
  if (by !== "total" && by !== "agent" && by !== "model" && by !== "tool") return "by is total, agent, model or tool";
  return { window, from: now - span, to: now, bucket, by };
}

/**
 * The group a row belongs to under `by`. Keys are `<model>:<kind>` for model
 * tokens and the tool, run_js or plugin for the rest (cf/src/usage.ts).
 */
export function usageGroup(by: UsageGroupBy, row: { agentId: string; resource: string; key: string }): string {
  if (by === "total") return "total";
  if (by === "agent") return row.agentId;
  if (by === "model") return row.resource === "model.tokens" ? row.key.slice(0, Math.max(0, row.key.lastIndexOf(":"))) : "";
  return row.resource === "tool.call" || row.resource === "js.run" || row.resource === "sandbox.container" ? row.key : "";
}

export interface UsagePrice { resource: string; key: string; unit: string; creditsPerUnit: number; effectiveFrom: number }

export async function usagePrices(db: D1Database): Promise<UsagePrice[]> {
  const { results } = await db.prepare("SELECT resource, key, unit, credits_per_unit, effective_from FROM usage_prices").all();
  return (results as any[]).map((r) => ({
    resource: String(r.resource), key: String(r.key), unit: String(r.unit),
    creditsPerUnit: Number(r.credits_per_unit), effectiveFrom: Number(r.effective_from),
  }));
}

/**
 * The price that applied to a row, in credits (US dollars) per unit: the newest
 * one in effect at the start of its bucket, for its exact key before the
 * resource's `*`. Null: nobody priced it — which a reader must keep apart from
 * 0, "priced, and free". A bucket straddling a price change is priced at its start.
 *
 * A key marked as paid by the tenant's own credential (`OWN_KEY_PREFIX`) is 0
 * whatever the table holds: the provider billed the tenant for it already, and
 * a `*` row written for our own account must not reach it.
 */
export function priceFor(prices: readonly UsagePrice[], row: { bucket: number; resource: string; key: string; unit: string }): number | null {
  if (row.key.startsWith(OWN_KEY_PREFIX)) return 0;
  const newest = (key: string) => prices
    .filter((p) => p.resource === row.resource && p.key === key && p.unit === row.unit && p.effectiveFrom <= row.bucket)
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
  const p = newest(row.key) ?? newest("*");
  return p ? p.creditsPerUnit : null;
}

/**
 * The first hour the ledger has anything for each resource, over all time.
 *
 * A resource that started being recorded in the middle of a window would
 * otherwise show a small number that reads as a complete one. This is the
 * earliest hour the record can speak for; before it the ledger says nothing,
 * whether because nothing happened or because nothing was counted yet — the
 * page says which of those it is not able to tell.
 */
export async function usageFirstHours(db: D1Database, tenantId: string): Promise<Record<string, number>> {
  // Both tables, because folding moves the oldest rows out of the hours first:
  // asking usage_hourly alone would report a record that begins later every
  // time a fold runs, and the page would tell a reader that a resource started
  // being counted on a day it was in fact already counted.
  // Unaccepted model answers are left out, as `readUsage` leaves them out: they are not the tenant's usage.
  const { results } = await db.prepare(
    `SELECT resource, MIN(first) AS first FROM (
       SELECT resource, MIN(hour) AS first FROM usage_hourly WHERE tenant_id = ? GROUP BY resource
       UNION ALL
       SELECT resource, MIN(day) AS first FROM usage_daily WHERE tenant_id = ? GROUP BY resource
     ) WHERE resource <> ? GROUP BY resource`,
  ).bind(tenantId, tenantId, UNACCEPTED_TOKENS).all();
  return Object.fromEntries((results as any[]).map((r) => [String(r.resource), Number(r.first)]));
}

/**
 * The tenant's usage over a window. Unaccepted model answers (`UNACCEPTED_TOKENS`) are left out: they are our cost, not
 * the tenant's usage (docs/metering.md), and stay in the tables for the operator.
 */
export async function readUsage(db: D1Database, tenantId: string, q: UsageQuery):
  Promise<{ rows: UsageReadRow[]; priced: boolean; firstHours: Record<string, number>; partial?: true }> {
  const size = q.bucket === "1d" ? DAY_MS : 3_600_000;
  const withAgent = q.by === "agent";
  const from = Math.floor(q.from / size) * size;
  const { results } = await db.prepare(
    // Both tables: a folded day answers the same question its hours did, and a
    // window that reaches past the fold must not lose them. Nothing is counted
    // twice — a fold moves rows, so an hour is in one table or the other.
    //
    // D1 binds a JS number as REAL, and REAL division would not round down to
    // the bucket, hence the CASTs.
    `SELECT bucket, ${withAgent ? "agent_id" : "'' AS agent_id"}, resource, key, unit, SUM(quantity) AS quantity
     FROM (
       SELECT (hour / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket, agent_id, resource, key, unit, quantity
         FROM usage_hourly WHERE tenant_id = ? AND hour >= ? AND hour < ?
       UNION ALL
       SELECT (day / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket, agent_id, resource, key, unit, quantity
         FROM usage_daily WHERE tenant_id = ? AND day >= ? AND day < ?
     )
     WHERE resource <> ?
     GROUP BY bucket, ${withAgent ? "agent_id, " : ""}resource, key, unit
     ORDER BY bucket, resource, key, unit`,
  ).bind(size, size, tenantId, from, q.to, size, size, tenantId, from, q.to, UNACCEPTED_TOKENS).all();
  const prices = await usagePrices(db);
  const priced = prices.length > 0;
  const firstHours = await usageFirstHours(db, tenantId);
  // A window the record could not fully read is a lower bound, and says so.
  // The flag is computed from the same tables and bounds as the rows, because
  // damage is recorded where the seconds are recorded (unit "unreadable",
  // written by the pass that could not read): a flag describing "now" would
  // certify historical windows it knows nothing about — a window that was
  // damaged and later healed would read as complete. Absent means no marker
  // in the window, which is the only honest shape a true/false has here.
  //
  // The predicate is not filtered by resource: a marker from any resource in
  // the window sets it. That scope decides how strong a sentence may read it.
  // As long as it is window-wide, the page may only say the figures may be
  // incomplete, once for the whole page, never beside one number — a single
  // figure may be whole while another resource's record was the damaged one.
  // Narrowing this query by resource is what would allow a definite "lower
  // bound" beside that resource's figure; the two must move together, and the
  // page's sentence points here rather than restating this.
  const damaged = await db.prepare(
    `SELECT 1 AS x FROM usage_hourly WHERE tenant_id = ? AND hour >= ? AND hour < ? AND unit = 'unreadable'
     UNION ALL
     SELECT 1 FROM usage_daily WHERE tenant_id = ? AND day >= ? AND day < ? AND unit = 'unreadable' LIMIT 1`,
  ).bind(tenantId, from, q.to, tenantId, from, q.to).all();
  const partial = (damaged.results as any[]).length ? true : undefined;
  const rows = (results as any[]).map((r) => {
    const row: UsageReadRow = {
      bucket: Number(r.bucket),
      group: usageGroup(q.by, { agentId: String(r.agent_id), resource: String(r.resource), key: String(r.key) }),
      resource: String(r.resource), key: String(r.key), quantity: Number(r.quantity), unit: String(r.unit),
    };
    if (priced) {
      const p = priceFor(prices, row);
      row.cost = p === null ? null : p * row.quantity;
    }
    return row;
  });
  return { rows, priced, firstHours, ...(partial ? { partial } : {}) };
}

/** One tenant's estimated cost of one resource over one period (`readUsageCosts`). */
export interface ResourceCost {
  resource: string;
  /** Dollars, summed over the rows that had a price. */
  cost: number;
  /** `key unit` of every row with no price, so a total that leaves something out says what. */
  unpriced: string[];
}
export interface TenantCosts { tenantId: string; total: number; periods: Array<{ start: number; total: number; resources: ResourceCost[] }> }

/** The start of the UTC day or month `t` falls in. */
export function periodStart(t: number, bucket: "day" | "month"): number {
  if (bucket === "day") return Math.floor(t / DAY_MS) * DAY_MS;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Every tenant's estimated cost over `from <= t < to`, by day or UTC month and resource: the operator's view
 * (/admin/usage-costs, cf/src/admin-usage-costs.ts), never a tenant's.
 *
 * Unlike `readUsage` this keeps `UNACCEPTED_TOKENS`: an answer no job accepted is our cost, and this is where
 * our cost is read. Rows are priced at their own granularity — an hourly row at its hour, a folded day at its
 * day — and only then summed into the period, so a price change inside a day prices this view exactly as the
 * tenant's hourly view prices it, and a fold does not move a total.
 */
export async function readUsageCosts(db: D1Database, from: number, to: number, bucket: "day" | "month"): Promise<TenantCosts[]> {
  const { results } = await db.prepare(
    `SELECT tenant_id, at, resource, key, unit, SUM(quantity) AS quantity FROM (
       SELECT tenant_id, hour AS at, resource, key, unit, quantity FROM usage_hourly WHERE hour >= ? AND hour < ?
       UNION ALL
       SELECT tenant_id, day AS at, resource, key, unit, quantity FROM usage_daily WHERE day >= ? AND day < ?
     ) GROUP BY tenant_id, at, resource, key, unit ORDER BY tenant_id, at, resource, key, unit`,
  ).bind(from, to, from, to).all();
  const prices = await usagePrices(db);
  const tenants = new Map<string, Map<number, Map<string, { cost: number; unpriced: Set<string> }>>>();
  for (const r of results as any[]) {
    const row = { bucket: Number(r.at), resource: String(r.resource), key: String(r.key), unit: String(r.unit) };
    const p = priceFor(prices, row);
    const periods = tenants.get(String(r.tenant_id)) ?? new Map();
    tenants.set(String(r.tenant_id), periods);
    const start = periodStart(row.bucket, bucket);
    const resources = periods.get(start) ?? new Map();
    periods.set(start, resources);
    const c = resources.get(row.resource) ?? { cost: 0, unpriced: new Set<string>() };
    resources.set(row.resource, c);
    if (p === null) c.unpriced.add(`${row.key} ${row.unit}`);
    else c.cost += p * Number(r.quantity);
  }
  // Float sums of per-row products carry noise past the tenth decimal; a dollar figure does not need it.
  const tidy = (n: number) => Math.round(n * 1e10) / 1e10;
  return [...tenants.entries()].map(([tenantId, periods]) => {
    const list = [...periods.entries()].sort(([a], [b]) => a - b).map(([start, resources]) => {
      const rs = [...resources.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([resource, c]) => ({ resource, cost: tidy(c.cost), unpriced: [...c.unpriced].sort() }));
      return { start, total: tidy(rs.reduce((a, r) => a + r.cost, 0)), resources: rs };
    });
    return { tenantId, total: tidy(list.reduce((a, p) => a + p.total, 0)), periods: list };
  });
}

const LOCAL = "CREATE TABLE IF NOT EXISTS usage_sent (id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL)";

/**
 * Send what this object's outbox holds past what D1 has, then forget it.
 * The object keeps its own copy of the cursor so a send costs one batch, not
 * a read first; when the copy is wrong (another send won, or this object is
 * new), D1's cursor is read and taken as the truth. What was sent: rows, and
 * whether D1 took them.
 */
export async function flushUsage(
  db: D1Database, sql: { exec(q: string, ...b: unknown[]): { toArray(): any[] } },
  tenantId: string, agentId: string, limit = 500,
): Promise<{ rows: number; counted: boolean }> {
  sql.exec(LOCAL);
  const known = sql.exec("SELECT through_seq FROM usage_sent WHERE id = 1").toArray()[0];
  const remember = (seq: number) =>
    sql.exec("INSERT INTO usage_sent(id, through_seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET through_seq = excluded.through_seq", seq);
  let expected = known ? Number(known.through_seq) : await usageCursor(db, tenantId, agentId);
  if (!known) { remember(expected); pruneUsage(sql as any, expected); }
  const rows = pendingUsage(sql as any, expected, limit);
  if (!rows.length) return { rows: 0, counted: true };
  const counted = await sendUsage(db, tenantId, agentId, expected, rows);
  expected = counted ? rows.at(-1)!.seq : await usageCursor(db, tenantId, agentId);
  remember(expected);
  pruneUsage(sql as any, expected);
  return { rows: rows.length, counted };
}

/**
 * One agent's ledger rows with `from <= hour < to`, summed into buckets of `size` ms (UTC), both
 * tables (cf/src/agent-surface/usage.ts reads it; the CASTs are readUsage's, for the same reason).
 * Unaccepted model answers are left out, as `readUsage` leaves them out.
 */
export async function readAgentLedger(db: D1Database, tenantId: string, agentId: string, from: number, to: number, size: number):
  Promise<Array<{ bucket: number; resource: string; key: string; unit: string; quantity: number }>> {
  const { results } = await db.prepare(
    `SELECT bucket, resource, key, unit, SUM(quantity) AS quantity
     FROM (
       SELECT (hour / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket, resource, key, unit, quantity
         FROM usage_hourly WHERE tenant_id = ? AND agent_id = ? AND hour >= ? AND hour < ?
       UNION ALL
       SELECT (day / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket, resource, key, unit, quantity
         FROM usage_daily WHERE tenant_id = ? AND agent_id = ? AND day >= ? AND day < ?
     )
     WHERE resource <> ?
     GROUP BY bucket, resource, key, unit
     ORDER BY bucket, resource, key, unit`,
  ).bind(size, size, tenantId, agentId, from, to, size, size, tenantId, agentId, from, to, UNACCEPTED_TOKENS).all();
  return (results as any[]).map((r) => ({
    bucket: Number(r.bucket), resource: String(r.resource), key: String(r.key), unit: String(r.unit), quantity: Number(r.quantity),
  }));
}

/**
 * When the oldest row this object holds and has not yet sent happened; null when it has sent
 * everything. Only reads: an object that never kept usage has neither table and answers null, rather
 * than having them made by a look.
 */
export function usageBacklogSince(sql: { exec(q: string, ...b: unknown[]): { toArray(): any[] } }): number | null {
  const first = (q: string, ...b: unknown[]): any => {
    try { return sql.exec(q, ...b).toArray()[0]; }
    catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return undefined; throw e; }
  };
  const sent = first("SELECT through_seq FROM usage_sent WHERE id = 1");
  const r = first("SELECT MIN(at) AS at FROM usage_outbox WHERE seq > ?", sent ? Number(sent.through_seq) : 0);
  return r && r.at !== null && r.at !== undefined ? Number(r.at) : null;
}
