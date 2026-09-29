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
import { flushTrace, type TraceSink } from "./trace-r2.ts";
import { ACTIVITY_BATCH_MAX, activityEvents } from "../../src/runtime/activity.ts";
import { statusEvents } from "../../src/runtime/status.ts";
import type { ActivityEvent, StatusEvent } from "../../src/plugins/types.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
export type ActivityGateway = {
  reportActivity(tenantId: string, agentId: string, events: readonly ActivityEvent[]):
    Promise<Array<{ alias: string; sent: number } | { alias: string; skipped: string }>>;
  reportStatus?(tenantId: string, agentId: string, events: readonly StatusEvent[]):
    Promise<Array<{ alias: string; sent: number } | { alias: string; skipped: string }>>;
};

const CURSOR = "CREATE TABLE IF NOT EXISTS activity_sent (id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL)";

export function activityCursor(sql: Sql): number {
  sql.exec(CURSOR);
  const known = sql.exec("SELECT through_seq FROM activity_sent WHERE id = 1").toArray()[0];
  return known ? Number(known.through_seq) : 0;
}

/**
 * The status last derived for this agent, and whether a send of it was confirmed. Kept because status
 * changes come only from new rows: if the last change of a turn (`online`) fails to send and the agent
 * then stays idle, no later row will say it again, and the service would show `working` for ever. So an
 * unconfirmed last status is sent again on each pass, rows or not, until a send returns.
 */
const STATUS_TABLE = "CREATE TABLE IF NOT EXISTS status_sent (id INTEGER PRIMARY KEY CHECK (id = 1), event TEXT NOT NULL, confirmed INTEGER NOT NULL)";

function lastStatus(sql: Sql): { event: StatusEvent; confirmed: boolean } | null {
  sql.exec(STATUS_TABLE);
  const r = sql.exec("SELECT event, confirmed FROM status_sent WHERE id = 1").toArray()[0];
  if (!r) return null;
  try { return { event: JSON.parse(String(r.event)) as StatusEvent, confirmed: Number(r.confirmed) === 1 }; }
  catch { return null; }
}

function setLastStatus(sql: Sql, event: StatusEvent, confirmed: boolean) {
  sql.exec(STATUS_TABLE);
  sql.exec("INSERT INTO status_sent(id, event, confirmed) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET event = excluded.event, confirmed = excluded.confirmed",
    JSON.stringify(event), confirmed ? 1 : 0);
}

function setCursor(sql: Sql, through: number) {
  sql.exec("INSERT INTO activity_sent(id, through_seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET through_seq = excluded.through_seq", through);
}

export async function flushActivity(
  gateway: ActivityGateway, sql: Sql, tenantId: string, agentId: string, limit = ACTIVITY_BATCH_MAX,
): Promise<{ events: number; sent: number; through: number; skipped: string[]; statuses: number; statusError: string | null }> {
  const sent0 = activityCursor(sql);
  const { rows, through } = pendingTrace(sql, sent0, limit);
  const events = activityEvents(agentId, rows);
  let sent = 0;
  const skipped: string[] = [];
  if (events.length) {
    for (const r of await gateway.reportActivity(tenantId, agentId, events)) {
      if ("sent" in r) sent += r.sent;
      else skipped.push(`${r.alias}: ${r.skipped}`);
    }
  }
  // The same rows' status changes, after the activity they belong to was taken. Status is only ever
  // "now", so a failed send never holds rows (a status outage must not stall the activity feed); what
  // is kept instead is the last status and whether it was confirmed, and an unconfirmed one is sent
  // again below even when no row is new — the last change of a turn has no later change to replace it.
  const last = lastStatus(sql);
  const changes = statusEvents(agentId, rows, last?.event.status ?? null);
  const statuses = changes.length ? changes : last && !last.confirmed ? [last.event] : [];
  let statusError: string | null = null;
  if (statuses.length && gateway.reportStatus) {
    let confirmed = false;
    try {
      for (const r of await gateway.reportStatus(tenantId, agentId, statuses)) {
        if ("skipped" in r) skipped.push(`${r.alias} (status): ${r.skipped}`);
      }
      // A service that is not listening (push off) has nothing owed to it: done, like a send.
      confirmed = true;
    } catch (e) {
      statusError = String((e as { message?: unknown })?.message ?? e).slice(0, 200);
    }
    setLastStatus(sql, statuses[statuses.length - 1]!, confirmed);
  }
  if (through > sent0) setCursor(sql, through);
  return { events: events.length, sent, through: Math.max(sent0, through), skipped, statuses: statuses.length, statusError };
}

/**
 * The two readers of the trace outbox, in the order the alarm pass runs them:
 * activity first, then the export with a hold at whatever activity has NOT
 * consumed. A failing activity send holds at its unmoved cursor — passing
 * "nothing held" would let the export prune the very rows the next pass needs
 * Each failure is reported, not thrown: the
 * pass goes on and asks for another pass.
 */
export async function flushActivityThenTrace(
  gateway: ActivityGateway, sink: TraceSink, sql: Sql, tenantId: string, agentId: string,
): Promise<{ activityError: string | null; traceError: string | null }> {
  let holdThrough: number;
  let activityError: string | null = null;
  try {
    holdThrough = (await flushActivity(gateway, sql, tenantId, agentId)).through;
  } catch (e) {
    activityError = String((e as { message?: unknown })?.message ?? e).slice(0, 200);
    holdThrough = activityCursor(sql);
  }
  let traceError: string | null = null;
  try {
    await flushTrace(sink, sql, tenantId, agentId, 500, Date.now, holdThrough);
  } catch (e) {
    traceError = String((e as { message?: unknown })?.message ?? e).slice(0, 200);
  }
  return { activityError, traceError };
}
