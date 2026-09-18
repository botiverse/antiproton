/**
 * Usage, as it happens, on its way to the tenant's hourly table.
 *
 * Each agent's object appends a row to its own outbox next to the work it
 * describes (a model reply, a tool call, a run_js), and once per turn sends
 * everything new to D1 in one batch (`cf/src/usage-d1.ts`). The per-call detail
 * stays where it already lives; the outbox holds only what the hourly table
 * needs, and is pruned once D1 has it.
 *
 * Design: Nova, approved by tygg 2026-09-17 (#design). A resource is named
 * once (`resource`), a row says how much of what (`key`, `quantity`, `unit`),
 * and a price, when there is one, is applied at read time.
 */
import type { SqlHost } from "../store/pi-storage.ts";

type Sql = SqlHost["sql"];

export interface UsageRow {
  /** ms since the epoch: when the work happened. */
  at: number;
  tenantId: string;
  agentId: string;
  /** What kind of thing: `model.tokens`, `tool.call`, `js.run`, … */
  resource: string;
  /** Which one, within the resource: `deepseek-chat:input`, `github.issue_list`, `run_js`, … */
  key: string;
  quantity: number;
  /** What `quantity` counts: `tokens`, `calls`, `ms`, `runs`, … */
  unit: string;
}

export interface OutboxRow extends UsageRow { seq: number }

const TABLE = `CREATE TABLE IF NOT EXISTS usage_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  resource TEXT NOT NULL, key TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL)`;

export function ensureUsageOutbox(sql: Sql) {
  sql.exec(TABLE);
}

/** The longest a key may be; anything longer is cut, so a strange tool name cannot bloat the table. */
export const USAGE_KEY_MAX = 200;

/**
 * Append rows. Zero and non-finite quantities are dropped: a zero changes
 * nothing a reader sums, and a NaN would poison every sum after it. A negative
 * one is kept: a provider's correction of an earlier count is a real delta.
 */
export function appendUsage(sql: Sql, rows: readonly UsageRow[]) {
  if (!rows.length) return;
  ensureUsageOutbox(sql);
  for (const r of rows) {
    if (!Number.isFinite(r.quantity) || r.quantity === 0) continue;
    sql.exec(
      "INSERT INTO usage_outbox(at, tenant_id, agent_id, resource, key, quantity, unit) VALUES (?, ?, ?, ?, ?, ?, ?)",
      Math.floor(r.at), r.tenantId, r.agentId, r.resource, r.key.slice(0, USAGE_KEY_MAX), r.quantity, r.unit,
    );
  }
}

/** Rows after `afterSeq`, oldest first, at most `limit`. */
export function pendingUsage(sql: Sql, afterSeq: number, limit = 1000): OutboxRow[] {
  ensureUsageOutbox(sql);
  return sql.exec(
    "SELECT seq, at, tenant_id, agent_id, resource, key, quantity, unit FROM usage_outbox WHERE seq > ? ORDER BY seq LIMIT ?",
    afterSeq, limit,
  ).toArray().map((r: any) => ({
    seq: Number(r.seq), at: Number(r.at), tenantId: String(r.tenant_id), agentId: String(r.agent_id),
    resource: String(r.resource), key: String(r.key), quantity: Number(r.quantity), unit: String(r.unit),
  }));
}

/** Forget rows D1 already has. */
export function pruneUsage(sql: Sql, throughSeq: number) {
  ensureUsageOutbox(sql);
  sql.exec("DELETE FROM usage_outbox WHERE seq <= ?", throughSeq);
}

export const HOUR_MS = 3_600_000;

export interface HourlyRow {
  tenantId: string; agentId: string;
  /** Start of the hour, ms since the epoch (UTC). */
  hour: number;
  resource: string; key: string; unit: string;
  quantity: number;
}

/**
 * One interval cut at hour boundaries: the part of it that falls in each hour,
 * oldest first. Time an agent is charged for is measured as an interval and
 * recorded by the hour, and every resource that does so cuts it the same way —
 * the object's own busy spans (src/usage/active.ts) and a container's life
 * (src/usage/container.ts). Empty when the interval is empty or backwards.
 */
export function msByHour(start: number, end: number): Array<{ hour: number; ms: number }> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const out: Array<{ hour: number; ms: number }> = [];
  for (let h = Math.floor(start / HOUR_MS) * HOUR_MS; h < end; h += HOUR_MS) {
    const ms = Math.min(end, h + HOUR_MS) - Math.max(start, h);
    if (ms > 0) out.push({ hour: h, ms });
  }
  return out;
}

/** Sum rows into (tenant, agent, hour, resource, key, unit). Order-independent. */
export function toHourly(rows: readonly UsageRow[]): HourlyRow[] {
  const out = new Map<string, HourlyRow>();
  for (const r of rows) {
    const hour = Math.floor(r.at / HOUR_MS) * HOUR_MS;
    const id = JSON.stringify([r.tenantId, r.agentId, hour, r.resource, r.key, r.unit]);
    const have = out.get(id);
    if (have) have.quantity += r.quantity;
    else out.set(id, { tenantId: r.tenantId, agentId: r.agentId, hour, resource: r.resource, key: r.key, unit: r.unit, quantity: r.quantity });
  }
  return [...out.values()];
}

/** A model reply's usage, one row per kind of token it counted. */
export function modelTokenRows(
  base: { at: number; tenantId: string; agentId: string },
  model: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number },
): UsageRow[] {
  const kinds: Array<[string, number | undefined]> = [
    ["input", usage.input], ["output", usage.output], ["cache_read", usage.cacheRead],
    ["cache_write", usage.cacheWrite], ["reasoning", usage.reasoning],
  ];
  return kinds
    .filter(([, n]) => typeof n === "number" && n !== 0)
    .map(([kind, n]) => ({ ...base, resource: "model.tokens", key: `${model || "unknown"}:${kind}`, quantity: n!, unit: "tokens" }));
}

/**
 * A tool call through a mount: one call, one more failure if it failed, and
 * how long it took. The key is the tool alone; `failed` is a unit, so a
 * reader sums calls and failures for one tool without joining two keys.
 */
export function toolCallRows(
  base: { at: number; tenantId: string; agentId: string },
  tool: string, outcome: "ok" | "failed", ms: number,
): UsageRow[] {
  return [
    { ...base, resource: "tool.call", key: tool, quantity: 1, unit: "calls" },
    ...(outcome === "failed" ? [{ ...base, resource: "tool.call", key: tool, quantity: 1, unit: "failed" }] : []),
    { ...base, resource: "tool.call", key: tool, quantity: Math.max(0, Math.round(ms)), unit: "ms" },
  ];
}

/** One run_js: the run, a failure if it failed, its time, and how many tools it called. */
export function jsRunRows(
  base: { at: number; tenantId: string; agentId: string },
  outcome: "ok" | "failed", ms: number, toolCalls: number,
): UsageRow[] {
  return [
    { ...base, resource: "js.run", key: "run_js", quantity: 1, unit: "runs" },
    ...(outcome === "failed" ? [{ ...base, resource: "js.run", key: "run_js", quantity: 1, unit: "failed" }] : []),
    { ...base, resource: "js.run", key: "run_js", quantity: Math.max(0, Math.round(ms)), unit: "ms" },
    { ...base, resource: "js.run", key: "run_js", quantity: toolCalls, unit: "tool_calls" },
  ];
}
