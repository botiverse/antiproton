/**
 * How long an agent's object was actually active, by the hour.
 *
 * A Durable Object is single-threaded but interleaves at await points, so two
 * handlers overlap and the sum of their durations is not the time the object
 * was busy: an early run reported 262s of "active" inside a 241s window.
 * Cloudflare bills the wall clock during which the object is active, so the
 * honest measure is the UNION of the busy spans. The union is why this resource
 * cannot be accumulated where the work happens, the way a token count or a tool
 * call can: adding a span's duration to a running total would count the overlap
 * twice. It is derived from the object's own `do_activity` rows instead, and a
 * watermark per hour keeps a second pass from counting an hour again.
 *
 * `/ui/diagnose` and the usage ledger read the same union from here. They are
 * two numbers a person can put side by side, so they must not be two
 * implementations.
 */

import { appendUsage } from "./outbox.ts";
import type { SqlHost } from "../store/pi-storage.ts";

type Sql = SqlHost["sql"];

export const HOUR_MS = 3_600_000;

/** One measured span: when it started and how long the object was in it. */
export interface ActivitySpan { at: number; ms: number; kind: string }

/**
 * `offload_*` spans measure time spent OUTSIDE the object (the model call the
 * queue is holding). Counting them as busy would report exactly the cost that
 * offloading removes.
 */
export const isBusyKind = (kind: string) => !String(kind).startsWith("offload_");

/** The spans that count as the object being busy. */
export function busySpans(all: readonly ActivitySpan[]): ActivitySpan[] {
  return all.filter((s) => isBusyKind(s.kind));
}

/** Merged, ordered intervals from spans that may overlap or nest. */
function merged(spans: readonly ActivitySpan[]): Array<[start: number, end: number]> {
  const iv = spans
    .map((s) => [Number(s.at), Number(s.at) + Math.max(0, Number(s.ms))] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of iv) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The time covered by these spans, counting an overlap once. */
export function unionMs(spans: readonly ActivitySpan[]): number {
  return merged(spans).reduce((a, [s, e]) => a + (e - s), 0);
}

/**
 * The same union, cut at hour boundaries: a span crossing an hour belongs to
 * both hours, for the part in each. Ordered by hour, so the totals add up to
 * `unionMs` of the same spans.
 */
export function unionMsByHour(spans: readonly ActivitySpan[]): Array<{ hour: number; ms: number }> {
  const out = new Map<number, number>();
  for (const [start, end] of merged(spans)) {
    for (let h = Math.floor(start / HOUR_MS) * HOUR_MS; h < end; h += HOUR_MS) {
      const ms = Math.min(end, h + HOUR_MS) - Math.max(start, h);
      if (ms > 0) out.set(h, (out.get(h) ?? 0) + ms);
    }
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([hour, ms]) => ({ hour, ms }));
}

/**
 * What is new since the last pass, hour by hour.
 *
 * `counted` is what was already sent for each hour. An hour whose union has
 * grown contributes the difference; an hour that has not changed contributes
 * nothing. An hour whose union came out SMALLER than what was counted returns
 * nothing and keeps its watermark: that happens when the object's activity
 * table was cleared, and the rows already in the ledger are the truth about
 * what was billed. Counting cannot run backwards.
 */
export function newActiveMs(
  byHour: ReadonlyArray<{ hour: number; ms: number }>,
  counted: ReadonlyMap<number, number>,
): Array<{ hour: number; ms: number; total: number }> {
  const out: Array<{ hour: number; ms: number; total: number }> = [];
  for (const { hour, ms } of byHour) {
    const had = counted.get(hour) ?? 0;
    const add = Math.round(ms) - Math.round(had);
    if (add > 0) out.push({ hour, ms: add, total: Math.round(ms) });
  }
  return out;
}

const WATERMARK = "CREATE TABLE IF NOT EXISTS usage_active(hour INTEGER PRIMARY KEY, ms INTEGER NOT NULL)";

/**
 * Append what the object has been billed for since the last pass, and remember
 * it. Returns the rows appended, so a caller can say nothing happened.
 *
 * Three clocks get confused here, so each is named. A span is WRITTEN when its
 * handler ends (#busy's `finally`), it STARTED at `at`, and it ENDED at
 * `at + ms`. Only spans that reach into the last two hours are read, and the
 * bound is on the END: a handler that began three hours ago and returned a
 * minute ago is entirely inside the window it must be counted for and entirely
 * outside a bound on `at` — it would be dropped without a trace, which is a
 * missing number rather than a wrong one (Rex, reviewing #400). Provider waits
 * of hundreds of seconds are ordinary here, so this is not a hypothetical.
 *
 * Because such a span can reach hours older than that bound, the watermarks are
 * read from the oldest hour the spans actually touch, not from the bound: a
 * watermark that was not loaded reads as zero, and the hour would be counted a
 * second time in full.
 *
 * The pass calling this is not in `do_activity` yet, so each pass counts the one
 * before it, and the last pass before an agent goes quiet leaves its own span
 * for the next wake.
 */
export function countActiveTime(
  sql: Sql, who: { tenantId: string; agentId: string }, now = Date.now(),
): Array<{ hour: number; ms: number }> {
  sql.exec(WATERMARK);
  const since = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
  const spans: ActivitySpan[] = sql
    .exec("SELECT at, ms, kind FROM do_activity WHERE at + ms >= ?", since).toArray()
    .map((r: any) => ({ at: Number(r.at), ms: Number(r.ms), kind: String(r.kind) }));
  const byHour = unionMsByHour(busySpans(spans));
  if (!byHour.length) return [];
  const oldest = byHour[0]!.hour;
  const counted = new Map<number, number>(sql
    .exec("SELECT hour, ms FROM usage_active WHERE hour >= ?", oldest).toArray()
    .map((r: any) => [Number(r.hour), Number(r.ms)]));
  const fresh = newActiveMs(byHour, counted);
  if (!fresh.length) return [];
  // `at` is the hour itself: a row belongs to the hour it measures, not to the
  // pass that noticed it.
  appendUsage(sql, fresh.map((f) => ({
    at: f.hour, tenantId: who.tenantId, agentId: who.agentId,
    resource: "object.active", key: "", quantity: f.ms, unit: "ms",
  })));
  for (const f of fresh) {
    sql.exec("INSERT INTO usage_active(hour, ms) VALUES (?, ?) ON CONFLICT(hour) DO UPDATE SET ms = excluded.ms",
      f.hour, f.total);
  }
  return fresh.map((f) => ({ hour: f.hour, ms: f.ms }));
}
