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
 * so a trace key is never mistaken for one, and nothing lists the bucket by
 * prefix on an agent's behalf.
 *
 * A row the outbox read but refused (`dropped`: kind or verdict outside the
 * contract's vocabulary) is not carried and not silent: the pass warns, and
 * `trace_drops` keeps one line per pass that /admin/diagnose shows beside
 * `alarm_errors` — the number has a place that changes because of it, not
 * only a place that reads it.
 *
 * Not here, each with what is already waiting on it:
 * - a retention scheme for the objects: they accumulate under `trace/` with
 *   nothing deleting them. The usage ledger has the same unpaid item —
 *   `foldUsage` (cf/src/usage-d1.ts) is defined and has no caller — so the
 *   two are one job, and doing one without the other leaves the pattern.
 * - reads across tenants: nothing consumes these objects yet; the first
 *   reader decides the layout it needs and this key scheme may move.
 * - a stall detector: a run that stops silently leaves no row here, so "no
 *   row" must not be read as "nothing stalled" until one exists.
 */
import { pendingTrace, pruneTrace, type TraceOutboxRow } from "../../src/trace/outbox.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
/** The one thing this needs from a bucket. */
export type TraceSink = { put(key: string, body: Uint8Array): Promise<unknown> };

const LOCAL = "CREATE TABLE IF NOT EXISTS trace_sent (id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL)";
const DROPS = "CREATE TABLE IF NOT EXISTS trace_drops (at INTEGER NOT NULL, dropped INTEGER NOT NULL)";

/** Where a batch lands: the owner and the seq range, so a replay is the same key. */
export function traceKey(tenantId: string, agentId: string, fromSeq: number, toSeq: number): string {
  return `trace/${tenantId}/${agentId}/${fromSeq}-${toSeq}.ndjson`;
}

/** One line per row, keys in the order pendingTrace produced them, so a replay is the same bytes. */
export function traceBody(rows: readonly TraceOutboxRow[]): Uint8Array {
  return new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export async function flushTrace(
  sink: TraceSink, sql: Sql, tenantId: string, agentId: string, limit = 500,
  now: () => number = Date.now,
): Promise<{ rows: number; dropped: number; key: string | null }> {
  sql.exec(LOCAL);
  const known = sql.exec("SELECT through_seq FROM trace_sent WHERE id = 1").toArray()[0];
  const sent = known ? Number(known.through_seq) : 0;
  const { rows, dropped, through } = pendingTrace(sql, sent, limit);
  if (dropped > 0) {
    console.warn(`trace outbox for ${tenantId}/${agentId}: ${dropped} row(s) outside the contract's vocabulary were dropped`);
    sql.exec(DROPS);
    sql.exec("INSERT INTO trace_drops(at, dropped) VALUES (?, ?)", now(), dropped);
  }
  let key: string | null = null;
  if (rows.length) {
    key = traceKey(tenantId, agentId, rows[0]!.seq, rows[rows.length - 1]!.seq);
    // Throws stay thrown: the caller keeps the rows and comes back.
    await sink.put(key, traceBody(rows));
  }
  if (through > sent) {
    sql.exec("INSERT INTO trace_sent(id, through_seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET through_seq = excluded.through_seq", through);
    pruneTrace(sql, through);
  }
  return { rows: rows.length, dropped, key };
}
