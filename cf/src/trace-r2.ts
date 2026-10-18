/**
 * The trace outbox's drain: what this object's trace_outbox holds past what
 * has been exported, written to R2 as newline-delimited JSON and then
 * forgotten. Runs on the alarm pass beside the usage flush, one batch per
 * pass.
 *
 * No remote cursor and no compare-and-set, unlike the usage flush
 * (cf/src/usage-d1.ts). That one keeps a copy of its cursor in D1 because the
 * local copy and D1's rows are two records that can disagree, so a send has
 * to be reconciled. Here the cursor (`trace_sent`) and the outbox
 * (`trace_outbox`) live in the same SQLite of the same object: they can only
 * be lost together, and when they are there is nothing to replay and nothing
 * to reconcile. Replay is a separate question, and it is safe because the
 * object key carries the seq range and the body is serialised the same way
 * each time: a put that succeeded but whose cursor was never written is
 * written again under the same key with the same bytes (the parked-result
 * path in cf/src/runtime.ts already relies on a same-key retry).
 *
 * The order is put, then cursor, then prune. A put that throws moves nothing,
 * so the only possible outcome of a failure is a replay, never a loss.
 *
 * The sink is the private ARTIFACTS bucket under `trace/…` — a new bucket
 * would be a new resource, and the public runs bucket must never carry this.
 * Artifact references are scoped to `t/<tenant>/<agent>/` (src/store/refs.ts),
 * so a trace key is never mistaken for one. The one reader lists a single
 * agent's prefix (`tracePrefix`) for an evaluation's trace route
 * (cf/src/eval-read.ts), never the bucket at large and never on the agent's own
 * behalf.
 *
 * A row the outbox read but refused (`dropped`: kind or verdict outside the
 * contract's vocabulary) is not carried and not silent: the pass warns, and
 * `trace_drops` keeps one line per pass that /admin/diagnose shows beside
 * `alarm_errors` — the number has a place that changes because of it, not
 * only a place that reads it.
 *
 * Not here, each with what is already waiting on it:
 * - a retention scheme for the objects: they accumulate under `trace/` with
 *   nothing deleting them. The usage ledger's is the daily Cron Trigger
 *   (`scheduled` in cf/src/index.ts, `retainUsage` in cf/src/usage-d1.ts);
 *   that handler is where a trace sweep would run too.
 * - reads across tenants by seq: the one reader (cf/src/eval-read.ts)
 *   lists one agent's prefix and orders by the seq range in each key, so a
 *   change to the key scheme must change `traceKeyRange` with it. Which
 *   agents had rows on a given UTC day is the day index's question
 *   (`noteTraceDays`, read by cf/src/friction-scan.ts), not a listing's.
 * - a stall detector: a run that stops silently leaves no row here, so "no
 *   row" must not be read as "nothing stalled" until one exists.
 */
import { pendingTrace, pruneTrace, type TraceOutboxRow } from "../../src/trace/outbox.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
/** The one thing this needs from a bucket. */
export type TraceSink = { put(key: string, body: Uint8Array): Promise<unknown> };

const LOCAL = "CREATE TABLE IF NOT EXISTS trace_sent (id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL)";
const DROPS = "CREATE TABLE IF NOT EXISTS trace_drops (at INTEGER NOT NULL, dropped INTEGER NOT NULL)";
/**
 * How long a drop stays on record. A put that keeps failing refuses the same
 * batch on every pass and writes a line each time — honest, and unbounded
 * without this: the table only ever grew. Seven days is the inbound log's
 * horizon too (src/runtime/inbound.ts), and diagnose shows the last three.
 */
export const TRACE_DROPS_KEEP_MS = 7 * 24 * 60 * 60_000;

/** Every batch of one agent's lands under this. */
export function tracePrefix(tenantId: string, agentId: string): string {
  return `trace/${tenantId}/${agentId}/`;
}

/** Where a batch lands: the owner and the seq range, so a replay is the same key. */
export function traceKey(tenantId: string, agentId: string, fromSeq: number, toSeq: number): string {
  return `${tracePrefix(tenantId, agentId)}${fromSeq}-${toSeq}.ndjson`;
}

/** The seq range `traceKey` put in a key under `prefix`, or null for a key it did not make. */
export function traceKeyRange(prefix: string, key: string): { fromSeq: number; toSeq: number } | null {
  if (!key.startsWith(prefix)) return null;
  const m = /^(\d+)-(\d+)\.ndjson$/.exec(key.slice(prefix.length));
  return m ? { fromSeq: Number(m[1]), toSeq: Number(m[2]) } : null;
}

/** One line per row, keys in the order pendingTrace produced them, so a replay is the same bytes. */
export function traceBody(rows: readonly TraceOutboxRow[]): Uint8Array {
  return new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/**
 * `holdThrough`: another reader of the outbox (cf/src/activity-raft.ts, and
 * the `github.refresh` forward's stage in cf/src/github-refresh-forward.ts) has
 * consumed rows only up to this seq; rows past it are exported but not pruned,
 * so that reader still finds them on its next pass. Absent means no other
 * reader is holding anything.
 */
export async function flushTrace(
  sink: TraceSink, sql: Sql, tenantId: string, agentId: string, limit = 500,
  now: () => number = Date.now, holdThrough: number | null = null,
): Promise<{ rows: number; dropped: number; key: string | null; days: string[] }> {
  sql.exec(LOCAL);
  const known = sql.exec("SELECT through_seq FROM trace_sent WHERE id = 1").toArray()[0];
  const sent = known ? Number(known.through_seq) : 0;
  const { rows, dropped, through } = pendingTrace(sql, sent, limit);
  if (dropped > 0) {
    console.warn(`trace outbox for ${tenantId}/${agentId}: ${dropped} row(s) outside the contract's vocabulary were dropped`);
    sql.exec(DROPS);
    const at = now();
    sql.exec("DELETE FROM trace_drops WHERE at < ?", at - TRACE_DROPS_KEEP_MS);
    sql.exec("INSERT INTO trace_drops(at, dropped) VALUES (?, ?)", at, dropped);
  }
  let key: string | null = null;
  if (rows.length) {
    key = traceKey(tenantId, agentId, rows[0]!.seq, rows[rows.length - 1]!.seq);
    // Throws stay thrown: the caller keeps the rows and comes back.
    await sink.put(key, traceBody(rows));
  }
  if (through > sent) {
    sql.exec("INSERT INTO trace_sent(id, through_seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET through_seq = excluded.through_seq", through);
  }
  // Pruned through what BOTH readers have consumed; the cursor above records the export alone.
  const exported = Math.max(sent, through);
  const prunable = holdThrough === null ? exported : Math.min(exported, holdThrough);
  // A read before the write: an idle pass used to issue a DELETE that deleted nothing.
  if (prunable > 0 && sql.exec("SELECT 1 AS hit FROM trace_outbox WHERE seq <= ? LIMIT 1", prunable).toArray().length) pruneTrace(sql, prunable);
  return { rows: rows.length, dropped, key, days: [...new Set(rows.map((r) => utcDay(r.at)))].sort() };
}

/** The UTC day of a time, `YYYY-MM-DD`. */
export const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

/**
 * The day index: one empty object per agent per UTC day it exported rows for, so a reader asking "who was active on
 * that day" lists `trace-index/<day>/` (a few hundred keys) instead of `trace/` (every batch ever written: 33k objects
 * measured 2026-10-18, and nothing deletes them). The key is the whole record; there is no body to merge, so two
 * passes writing the same marker cannot race.
 */
export const TRACE_INDEX_PREFIX = "trace-index/";
export function traceIndexKey(day: string, tenantId: string, agentId: string): string {
  return `${TRACE_INDEX_PREFIX}${day}/${tenantId}/${agentId}`;
}
const INDEXED = "CREATE TABLE IF NOT EXISTS trace_index_days (day TEXT PRIMARY KEY)";
/** How many days this object remembers having indexed: a batch's rows are minutes old, so two would do. */
const INDEXED_KEEP_DAYS = 7;

/**
 * Write the day index for `days` this object has not written yet, and remember each one that landed. A put that
 * throws is left unremembered, so the next pass writes it again; the caller treats a failure as costing the reader a
 * listing, never as costing a row.
 */
export async function noteTraceDays(sink: TraceSink, sql: Sql, tenantId: string, agentId: string, days: readonly string[]): Promise<number> {
  if (!days.length) return 0;
  sql.exec(INDEXED);
  let wrote = 0;
  for (const day of days) {
    if (sql.exec("SELECT 1 AS hit FROM trace_index_days WHERE day = ?", day).toArray().length) continue;
    await sink.put(traceIndexKey(day, tenantId, agentId), new Uint8Array(0));
    sql.exec("INSERT OR IGNORE INTO trace_index_days(day) VALUES (?)", day);
    wrote++;
  }
  const horizon = utcDay(Date.parse(days[days.length - 1]! + "T00:00:00Z") - INDEXED_KEEP_DAYS * 86_400_000);
  sql.exec("DELETE FROM trace_index_days WHERE day < ?", horizon);
  return wrote;
}
