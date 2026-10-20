/**
 * The activity drain: the trace outbox's rows past what the agent's service has
 * been told, mapped (src/runtime/activity.ts) and sent through the gateway to
 * the mounts that report activity (the raft plugin), on the alarm pass beside
 * the usage and trace flushes.
 *
 * A second reader of one outbox. Its cursor (`activity_sent`) lives in the same
 * SQLite as the rows, like `trace_sent`; the trace flush prunes only through
 * the lower of the two cursors (flushTrace's `holdThrough`), so a service that
 * is down keeps its rows until it is back — the same terms the export has with
 * R2, and no second policy on top: a service that is merely not listening
 * (push off, no account) answers `skipped`, the cursor advances, and nothing is
 * held on its account. What can hold rows is a service that errors, for as
 * long as it errors, and the rows are a few per turn.
 *
 * Send, then cursor: a send that throws moves nothing and the pass comes back
 * (usagePending); the event ids are the rows' seqs, so the resend is the same
 * events and the service dedupes.
 */
import { pendingTrace } from "../../src/trace/outbox.ts";
import { flushTrace, noteTraceDays, type TraceSink } from "./trace-r2.ts";
import { ACTIVITY_BATCH_MAX, activityEvents, orderStatuses, turnEnds, type SubagentActivity, type TurnEndEvent } from "../../src/runtime/activity.ts";
import { turnLineage } from "../../src/runtime/subagents.ts";
import type { ActivityEvent } from "../../src/plugins/types.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
export type ActivityGateway = {
  reportActivity(tenantId: string, agentId: string, events: readonly ActivityEvent[], ends?: readonly TurnEndEvent[]):
    Promise<Array<{ alias: string; sent: number } | { alias: string; skipped: string }>>;
};

const CURSOR = "CREATE TABLE IF NOT EXISTS activity_sent (id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL)";

export function activityCursor(sql: Sql): number {
  sql.exec(CURSOR);
  const known = sql.exec("SELECT through_seq FROM activity_sent WHERE id = 1").toArray()[0];
  return known ? Number(known.through_seq) : 0;
}

function setCursor(sql: Sql, through: number) {
  sql.exec("INSERT INTO activity_sent(id, through_seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET through_seq = excluded.through_seq", through);
}

// The last status instant sent, so the next batch's statuses come strictly after it (orderStatuses).
// Moved with the cursor, so a batch sent again is dated the same.
const STATUS_CLOCK = "CREATE TABLE IF NOT EXISTS activity_status_clock (id INTEGER PRIMARY KEY CHECK (id = 1), last_at INTEGER NOT NULL)";

function statusClock(sql: Sql): number {
  sql.exec(STATUS_CLOCK);
  const known = sql.exec("SELECT last_at FROM activity_status_clock WHERE id = 1").toArray()[0];
  return known ? Number(known.last_at) : 0;
}

function setStatusClock(sql: Sql, lastAt: number) {
  sql.exec("INSERT INTO activity_status_clock(id, last_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_at = excluded.last_at", lastAt);
}

/**
 * Subagent events as Raft's `SubagentLineage` (src/runtime/activity.ts `subagentEvents`), on only where the deployment
 * sets SUBAGENT_ACTIVITY=1: off — the default — a child's rows make no event. Its lineage is the parent's
 * `send_to_agent` call id of the child turn the row belongs to (`turnLineage`), read from the object's own table.
 */
export function subagentActivityFor(sql: Sql, env: { SUBAGENT_ACTIVITY?: unknown }): SubagentActivity | undefined {
  if (env.SUBAGENT_ACTIVITY !== "1") return undefined;
  return {
    lineage(session: string, at: number) {
      try { return turnLineage(sql as never, session, at); } catch { return null; }
    },
  };
}

export async function flushActivity(
  gateway: ActivityGateway, sql: Sql, tenantId: string, agentId: string, limit = ACTIVITY_BATCH_MAX, subagents?: SubagentActivity,
): Promise<{ events: number; sent: number; through: number; skipped: string[] }> {
  const sent0 = activityCursor(sql);
  const { rows, through } = pendingTrace(sql, sent0, limit);
  const events = activityEvents(agentId, rows, subagents);
  // How each turn that ends in this batch ended, beside the events rather than on them (`turnEnds` says why).
  const ends = turnEnds(agentId, rows);
  const clock0 = statusClock(sql);
  const clock = orderStatuses(events, clock0);
  let sent = 0;
  const skipped: string[] = [];
  if (events.length) {
    for (const r of await gateway.reportActivity(tenantId, agentId, events, ends)) {
      if ("sent" in r) sent += r.sent;
      else skipped.push(`${r.alias}: ${r.skipped}`);
    }
  }
  if (through > sent0) setCursor(sql, through);
  if (clock > clock0) setStatusClock(sql, clock);
  return { events: events.length, sent, through: Math.max(sent0, through), skipped };
}

/**
 * The two readers of the trace outbox, in the order the alarm pass runs them:
 * activity first, then the export with a hold at whatever activity has NOT
 * consumed. A failing activity send holds at its unmoved cursor — passing
 * "nothing held" would let the export prune the very rows the next pass needs
 * Each failure is reported, not thrown: the
 * pass goes on and asks for another pass.
 *
 * `alsoHold`: a third reader's cursor (cf/src/github-refresh-forward.ts, staged before this runs), so the export
 * prunes through the lowest of the three. Null: no third reader.
 */
export async function flushActivityThenTrace(
  gateway: ActivityGateway, sink: TraceSink, sql: Sql, tenantId: string, agentId: string, subagents?: SubagentActivity,
  alsoHold: number | null = null,
): Promise<{ activityError: string | null; traceError: string | null }> {
  let holdThrough: number;
  let activityError: string | null = null;
  try {
    holdThrough = (await flushActivity(gateway, sql, tenantId, agentId, ACTIVITY_BATCH_MAX, subagents)).through;
  } catch (e) {
    activityError = String((e as { message?: unknown })?.message ?? e).slice(0, 200);
    holdThrough = activityCursor(sql);
  }
  let traceError: string | null = null;
  let days: string[] = [];
  try {
    const hold = alsoHold === null ? holdThrough : Math.min(holdThrough, alsoHold);
    days = (await flushTrace(sink, sql, tenantId, agentId, 500, Date.now, hold)).days;
  } catch (e) {
    traceError = String((e as { message?: unknown })?.message ?? e).slice(0, 200);
  }
  // The day index (cf/src/trace-r2.ts `noteTraceDays`). Its failure is not a trace error: the rows are exported, and
  // a missing marker costs the friction scan a listing, so it is warned about and written again on the next pass.
  try {
    await noteTraceDays(sink, sql, tenantId, agentId, days);
  } catch (e) {
    console.warn(`trace day index for ${tenantId}/${agentId}: ${String((e as { message?: unknown })?.message ?? e).slice(0, 200)}`);
  }
  return { activityError, traceError };
}
