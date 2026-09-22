/**
 * trace_outbox: what happened, in the shape an export can carry.
 *
 * One row per ended span, appended where the work commits, drained on the
 * alarm pass — the same transport the usage ledger uses
 * (src/usage/outbox.ts), because that shape has already answered "the object
 * was evicted mid-send" and "the same pass ran twice": a row's identity is
 * (tenant, agent, seq), seq is AUTOINCREMENT and never reused, so a retried
 * batch is recognizable downstream without anyone bookkeeping sends.
 *
 * What a row means, settled in the trace design (docs live with the plan;
 * #o11y 2026-09-22): only ENDED spans are written — an open call has no row
 * here, it has its live surface (unanswered pi_model_jobs, activity.live,
 * parked approvals). A row without its span id is an orphan by definition —
 * the seam that produced it has a bug — so append drops it rather than store
 * it; the drop is the visible half of that contract, the seams' join tests
 * are the other half.
 *
 * `status` is what the seam said, verbatim (an operation status, a
 * stopReason, an inbound outcome); `verdict` is the normalized reading of it,
 * decided HERE at append time, both written in the same row. The raw value
 * never changes; the normalizing rule will — that is why the normalized form
 * is stored, not recomputed by every reader (the rawStopReason/stopReason
 * precedent in src/model/pi-bridge.ts).
 *
 * Two kinds of silence are documented, not accidental: a live container has
 * no row (no observable close event exists to end its span), and a stall has
 * no row (no detector exists yet) — "no row" must not be read as "nothing
 * happened" for either.
 */
import type { SqlHost } from "../store/pi-storage.ts";

type Sql = SqlHost["sql"];

const TABLE = "CREATE TABLE IF NOT EXISTS trace_outbox(" +
  "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
  "at INTEGER NOT NULL, " +
  "tenant_id TEXT NOT NULL, " +
  "agent_id TEXT NOT NULL, " +
  "kind TEXT NOT NULL, " +
  "span_id TEXT NOT NULL, " +
  "parent_id TEXT, " +
  "status TEXT NOT NULL, " +
  "verdict TEXT NOT NULL, " +
  "ms INTEGER, " +
  "attrs TEXT NOT NULL)";

export const TRACE_KINDS = ["model.call", "tool.call", "approval.wait", "container.lease", "inbound"] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

export const TRACE_VERDICTS = ["ok", "failed", "blocked", "cancelled"] as const;
export type TraceVerdict = (typeof TRACE_VERDICTS)[number];

/** The longest a single field may be; anything longer is cut, like USAGE_KEY_MAX. */
export const TRACE_FIELD_MAX = 200;
/** The longest serialized `attrs` may be; whole keys are dropped to fit. */
export const TRACE_ATTRS_MAX = 4_000;

export interface TraceRow {
  /** ms since the epoch: when the span closed. */
  at: number;
  tenantId: string;
  agentId: string;
  kind: TraceKind;
  /** The durable id the row joins back to: mj_…, op_…, a hookId, a boxId. */
  spanId: string;
  /** The enclosing span's id, on the rare write site that genuinely knows it. */
  parentId?: string;
  /** What the seam said, verbatim. */
  status: string;
  /** The normalized reading of `status`, decided at append. */
  verdict: TraceVerdict;
  /** What the span measured, when the seam knows it. */
  ms?: number;
  /** Small JSON-able facts; whole keys drop to fit TRACE_ATTRS_MAX. */
  attrs: Record<string, unknown>;
}

export interface TraceOutboxRow extends Omit<TraceRow, "attrs"> {
  seq: number;
  attrs: Record<string, unknown>;
}

export function ensureTraceOutbox(sql: Sql) {
  sql.exec(TABLE);
}

const cut = (s: string) => s.slice(0, TRACE_FIELD_MAX);

/**
 * What one row becomes on the wire. Keys drop whole, last-written first, so
 * what survives is predictable and a seam writes the facts it cares about
 * first; a dropped key is announced rather than discovered.
 */
function attrsOf(attrs: Record<string, unknown>): string {
  const body: Record<string, unknown> = { ...attrs };
  let text = JSON.stringify(body);
  const keys = Object.keys(body);
  while (text.length > TRACE_ATTRS_MAX && keys.length) {
    delete body[keys.pop()!];
    body.truncated = true;
    text = JSON.stringify(body);
  }
  return text;
}

export function appendTrace(sql: Sql, rows: readonly TraceRow[]) {
  ensureTraceOutbox(sql);
  for (const row of rows) {
    // A row without its join key or its time is an orphan by definition; so
    // is a row whose vocabulary is not the contract's — the drain dispatches
    // on kind and verdict, and a wrong value would not redden there, it
    // would just take the wrong branch. The seam has a bug and the test at
    // that seam is the place it shows.
    if (!Number.isFinite(row.at) || !row.kind || !row.spanId) continue;
    if (!isKind(row.kind) || !isVerdict(row.verdict)) continue;
    sql.exec(
      "INSERT INTO trace_outbox(at, tenant_id, agent_id, kind, span_id, parent_id, status, verdict, ms, attrs) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?)",
      Math.floor(row.at), row.tenantId, row.agentId, cut(row.kind), cut(row.spanId),
      row.parentId === undefined ? null : cut(row.parentId), cut(row.status), cut(row.verdict),
      row.ms === undefined ? null : Math.round(row.ms), attrsOf(row.attrs ?? {}),
    );
  }
}

export interface PendingTrace {
  rows: TraceOutboxRow[];
  /** Rows read but left out because kind or verdict was not the contract's vocabulary. */
  dropped: number;
}

const isMember = <T extends string>(table: readonly T[], s: string): s is T =>
  (table as readonly string[]).includes(s);
const isKind = (s: string): s is TraceKind => isMember(TRACE_KINDS, s);
const isVerdict = (s: string): s is TraceVerdict => isMember(TRACE_VERDICTS, s);

/** Rows after `afterSeq`, oldest first, at most `limit`. */
export function pendingTrace(sql: Sql, afterSeq: number, limit = 1000): PendingTrace {
  ensureTraceOutbox(sql);
  let dropped = 0;
  const rows = sql.exec(
    "SELECT seq, at, tenant_id, agent_id, kind, span_id, parent_id, status, verdict, ms, attrs " +
    "FROM trace_outbox WHERE seq > ? ORDER BY seq LIMIT ?",
    afterSeq, limit,
  ).toArray().flatMap((r: any) => {
    // No `as` on the way back: the type is the contract, and the contract is
    // checked against the stored string, or a wrong value rides into the
    // drain's dispatch as a "valid" one.
    const kind = String(r.kind);
    const verdict = String(r.verdict);
    if (!isKind(kind) || !isVerdict(verdict)) { dropped++; return []; }
    const parsed = (() => { try { return JSON.parse(String(r.attrs)); } catch { return undefined; } })();
    return [{
      seq: Number(r.seq),
      at: Number(r.at),
      tenantId: String(r.tenant_id),
      agentId: String(r.agent_id),
      kind,
      spanId: String(r.span_id),
      parentId: r.parent_id === null ? undefined : String(r.parent_id),
      status: String(r.status),
      verdict,
      ms: r.ms === null ? undefined : Number(r.ms),
      // Written only by appendTrace, so a wrong shape means storage damage.
      // One shape catches the class — unparsable or not-an-object — so a
      // damaged row is visible without inventing a second taxonomy for it.
      attrs: (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : { unparseable: true },
    }];
  });
  return { rows, dropped };
}

/** Forget rows the drain already took. */
export function pruneTrace(sql: Sql, throughSeq: number) {
  ensureTraceOutbox(sql);
  sql.exec("DELETE FROM trace_outbox WHERE seq <= ?", throughSeq);
}
