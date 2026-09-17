/**
 * The tenant's hourly usage in D1: what agents send (`sendUsage`) and what the
 * dashboard reads (`readUsage`). The rows come from each agent's outbox
 * (src/usage/outbox.ts); migration 0005 made the tables.
 *
 * `usage_hourly` is never trimmed here. The outbox side is pruned on every
 * send, bounded by the cursor; this side has no retention at all, and that is
 * a gap rather than a decision — README's "What is not done" carries it, and
 * folding whole hours into days past a cutoff is the intended fix.
 */
import { pendingUsage, pruneUsage, toHourly, type OutboxRow } from "../../src/usage/outbox.ts";

export const DAY_MS = 86_400_000;

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
  /** Credits, once any price exists; absent before. */
  cost?: number | null;
}

/** The windows the page offers (cf/src/usage.ts), and how long each is. */
export const USAGE_WINDOWS: Record<string, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };

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
 * The price that applied to a row: the newest one in effect at the start of
 * its bucket, for its exact key before the resource's `*`. Null: free.
 * A bucket straddling a price change is priced at its start.
 */
export function priceFor(prices: readonly UsagePrice[], row: { bucket: number; resource: string; key: string; unit: string }): number | null {
  const newest = (key: string) => prices
    .filter((p) => p.resource === row.resource && p.key === key && p.unit === row.unit && p.effectiveFrom <= row.bucket)
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
  const p = newest(row.key) ?? newest("*");
  return p ? p.creditsPerUnit : null;
}

export async function readUsage(db: D1Database, tenantId: string, q: UsageQuery):
  Promise<{ rows: UsageReadRow[]; priced: boolean }> {
  const size = q.bucket === "1d" ? DAY_MS : 3_600_000;
  const withAgent = q.by === "agent";
  const { results } = await db.prepare(
    // D1 binds a JS number as REAL, and REAL division would not round down to the bucket.
    `SELECT (hour / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket, ${withAgent ? "agent_id" : "'' AS agent_id"},
       resource, key, unit, SUM(quantity) AS quantity
     FROM usage_hourly WHERE tenant_id = ? AND hour >= ? AND hour < ?
     GROUP BY bucket, ${withAgent ? "agent_id, " : ""}resource, key, unit
     ORDER BY bucket, resource, key, unit`,
  ).bind(size, size, tenantId, Math.floor(q.from / size) * size, q.to).all();
  const prices = await usagePrices(db);
  const priced = prices.length > 0;
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
  return { rows, priced };
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
