/**
 * An evaluation's two read-only exports (cf/src/provision/handlers.ts, behind EVAL_SEED_ROUTES): an agent's whole
 * conversation, and its trace rows over a bounded window. Both are reads of what already exists, through the readers
 * that already exist, so neither is a second derivation that could drift from the first:
 *
 * - the transcript is `readTranscript` (cf/src/transcript-read.ts), the operator's `/admin/transcript` reader, which
 *   issues SELECTs and nothing else; this adds which main conversation (`main`, `main.<n>`, cf/src/fresh-context.ts)
 *   and a page of it;
 * - the trace is the agent's `trace_outbox` (`pendingTrace`, src/trace/outbox.ts) for rows not yet exported and
 *   pruned, and the R2 batches `flushTrace` wrote (`trace/<tenant>/<agent>/<from>-<to>.ndjson`, cf/src/trace-r2.ts)
 *   for the rest. The object is read FIRST and the bucket second: a flush between the two puts its batch before it
 *   prunes, so the bucket then holds every row the object no longer does. The other order could miss that batch.
 *
 * Whatever either returns is walked whole before it leaves (`redactCredentials`): every string, at any depth, and
 * every key, is checked against the credential shapes the console refuses (cf/src/secret-shape.ts), because a tool
 * result is whatever the tool returned and nothing about its path says where a key may sit.
 */
import { secretShape } from "./secret-shape.ts";
import { hasTable, readTranscript, type TranscriptEvents } from "./transcript-read.ts";
import { currentMainId } from "./fresh-context.ts";
import { pendingTrace, type TraceOutboxRow } from "../../src/trace/outbox.ts";
import { tracePrefix, traceKeyRange } from "./trace-r2.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

/**
 * `value` with every string that looks like a credential, and every key that does, replaced by `<redacted:KIND>`, and
 * how many were. Walked, never addressed by path: a credential nested in a tool's result is found where it is.
 */
export function redactCredentials(value: unknown): { value: unknown; redactions: number } {
  let redactions = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const kind = secretShape(v);
      if (kind === null) return v;
      redactions++;
      return `<redacted:${kind}>`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(v as Record<string, unknown>)) {
        const kind = secretShape(key);
        let name = key;
        if (kind !== null) {
          redactions++;
          name = `<redacted:${kind}>`;
          for (let i = 2; name in out; i++) name = `<redacted:${kind}>#${i}`;
        }
        out[name] = walk(inner);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value), redactions };
}

export const TRANSCRIPT_LIMIT_DEFAULT = 500;
export const TRANSCRIPT_LIMIT_MAX = 2000;

export interface EvalTranscript {
  agentId: string;
  /** The conversation read: `main`, `main.<n>`, or another conversation of the agent named as /admin/transcript names it. */
  sessionId: string;
  current: boolean;
  total: number;
  shown: number;
  cursor: string;
  nextCursor: string | null;
  events: TranscriptEvents["events"];
  byOp: TranscriptEvents["byOp"];
}

/**
 * One page of conversation `session` (null: the current main one), as `/admin/transcript` reads it. The current main
 * conversation goes to that reader as `t_<agentId>`, the console's id for it: its own id `main` reads as no
 * conversation while it is current (`sessionFor`). The cursor is an offset into the reader's list, which is in
 * sequence order and only grows at its end. Null when the object holds no such agent or the agent no such conversation.
 */
export function evalTranscript(
  sql: Sql, tenantId: string, agentId: string, session: string | null, offset: number, limit: number,
): EvalTranscript | null {
  const current = currentMainId(sql);
  const sessionId = session ?? current;
  const all = readTranscript(sql as never, tenantId, agentId, sessionId === current ? `t_${agentId}` : sessionId);
  if (all === null) return null;
  const events = all.events.slice(offset, offset + limit);
  const end = offset + events.length;
  return {
    agentId, sessionId, current: sessionId === current, total: all.total, shown: events.length,
    cursor: String(offset), nextCursor: end < all.total ? String(end) : null, events, byOp: all.byOp,
  };
}

/** The object's own trace rows after `afterSeq`, oldest first, at most `limit`. A table never made reads as none and is not made. */
export function localTrace(sql: Sql, tenantId: string, agentId: string, afterSeq: number, limit: number): TraceOutboxRow[] {
  if (!hasTable(sql as never, "trace_outbox")) return [];
  return pendingTrace(sql as never, afterSeq, limit).rows.filter((r) => r.tenantId === tenantId && r.agentId === agentId);
}

/** The widest window one request may ask for. */
export const TRACE_WINDOW_MAX_MS = 24 * 60 * 60_000;
export const TRACE_LIMIT_DEFAULT = 200;
export const TRACE_LIMIT_MAX = 1000;
/** The most rows read from the object, and batches from the bucket, in one request; past them the answer pages. */
export const TRACE_LOCAL_SCAN = 5000;
export const TRACE_OBJECTS_SCAN = 20;
/** Listing pages read before the request is refused rather than ordered on a partial list. */
const TRACE_LIST_PAGES = 20;
/**
 * A batch uploaded this long before the window opens holds no row in it: it was written after every row in it ended.
 * The margin is for the two clocks (the object's and the bucket's).
 */
const UPLOAD_SLACK_MS = 60 * 60_000;

export interface TraceSource {
  /** Null when the object holds no such agent. Called before the bucket is listed (see the file's header). */
  local(afterSeq: number, limit: number): Promise<TraceOutboxRow[] | null>;
  list(prefix: string, cursor: string | undefined): Promise<{ objects: Array<{ key: string; uploaded: Date }>; truncated: boolean; cursor?: string }>;
  /** The batch's body, or null when it has gone. */
  get(key: string): Promise<string | null>;
}

export interface TraceQuery { from: number; to: number; afterSeq: number; limit: number }

export type TraceWindow =
  | { ok: true; rows: TraceOutboxRow[]; nextCursor: string | null; scanned: { local: number; objects: number } }
  | { ok: false; status: 404 | 502; message: string };

/**
 * The agent's trace rows with `from <= at < to` and `seq > afterSeq`, in seq order, at most `limit`. The scan is
 * bounded (TRACE_LOCAL_SCAN rows, TRACE_OBJECTS_SCAN batches): a page that stopped at a bound, or at `limit`, says
 * where to go on in `nextCursor` (a seq), and may hold fewer than `limit` rows, none even; null means nothing is left.
 */
export async function readTraceWindow(src: TraceSource, tenantId: string, agentId: string, q: TraceQuery): Promise<TraceWindow> {
  const local = await src.local(q.afterSeq, TRACE_LOCAL_SCAN);
  if (local === null) return { ok: false, status: 404, message: `no agent ${agentId}` };
  const prefix = tracePrefix(tenantId, agentId);
  const batches: Array<{ key: string; fromSeq: number; toSeq: number; uploaded: number }> = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page === TRACE_LIST_PAGES) return { ok: false, status: 502, message: `more than ${TRACE_LIST_PAGES} pages of trace batches for ${agentId}` };
    const listed = await src.list(prefix, cursor);
    for (const o of listed.objects) {
      const range = traceKeyRange(prefix, o.key);
      if (range) batches.push({ key: o.key, ...range, uploaded: new Date(o.uploaded).getTime() });
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  // Keys sort as text ("10-…" before "9-…"); the seq range is the order.
  const due = batches.filter((b) => b.toSeq > q.afterSeq && !(b.uploaded < q.from - UPLOAD_SLACK_MS)).sort((a, b) => a.fromSeq - b.fromSeq);
  const bySeq = new Map<number, TraceOutboxRow>();
  // Past this seq nothing has been looked at yet: rows beyond it wait for the next page, so none is skipped.
  let frontier = local.length === TRACE_LOCAL_SCAN ? local[local.length - 1]!.seq : Infinity;
  let objects = 0;
  let inWindow = 0;
  // The highest seq a batch read so far covers; a stop is never placed below it, so a page always moves on.
  let readThrough = q.afterSeq;
  for (const b of due) {
    if (objects === TRACE_OBJECTS_SCAN || inWindow >= q.limit) { frontier = Math.min(frontier, Math.max(b.fromSeq - 1, readThrough)); break; }
    const body = await src.get(b.key);
    objects++;
    readThrough = Math.max(readThrough, b.toSeq);
    if (body === null) continue;
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as TraceOutboxRow;
      if (row.tenantId !== tenantId || row.agentId !== agentId || !(row.seq > q.afterSeq)) continue;
      if (!bySeq.has(row.seq) && row.at >= q.from && row.at < q.to) inWindow++;
      bySeq.set(row.seq, row);
    }
  }
  for (const row of local) if (!bySeq.has(row.seq)) bySeq.set(row.seq, row);
  const ordered = [...bySeq.values()].filter((r) => r.seq <= frontier).sort((a, b) => a.seq - b.seq);
  const rows = ordered.filter((r) => r.at >= q.from && r.at < q.to).slice(0, q.limit);
  const nextCursor = rows.length === q.limit ? String(rows[rows.length - 1]!.seq)
    : Number.isFinite(frontier) ? String(frontier) : null;
  return { ok: true, rows, nextCursor, scanned: { local: local.length, objects } };
}
