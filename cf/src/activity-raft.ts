/**
 * The activity drain: the trace outbox's rows past what the agent's service has
 * been told, mapped (src/runtime/activity.ts) and sent through the gateway to
 * the mounts that report activity (the raft plugin), on the alarm pass beside
 * the usage and trace flushes.
 *
 * A second reader of one outbox. Its cursor (`activity_sent`) lives in the same
 * SQLite as the rows, like `trace_sent`; the trace flush prunes only through
 * the lower of the two cursors (flushTrace's `holdThrough`), so a service that
 * is down keeps its rows. Not for ever: past ACTIVITY_BACKLOG_MAX rows the
 * cursor jumps to the newest row and the pass warns — the trace export must
 * not be held hostage by a display, and a display that is a day behind is
 * not worth catching up. An agent with no reporting mount costs one query and
 * advances its cursor, so the outbox is never held on its account.
 *
 * Send, then cursor: a send that throws moves nothing and the pass comes back
 * (usagePending); the event ids are the rows' seqs, so the resend is the same
 * events and the service dedupes.
 */
import { pendingTrace } from "../../src/trace/outbox.ts";
import { ACTIVITY_BATCH_MAX, activityEvents } from "../../src/runtime/activity.ts";
import type { ActivityEvent } from "../../src/plugins/types.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
export type ActivityGateway = {
  reportActivity(tenantId: string, agentId: string, events: readonly ActivityEvent[]):
    Promise<Array<{ alias: string; sent: number } | { alias: string; skipped: string }>>;
};

const CURSOR = "CREATE TABLE IF NOT EXISTS activity_sent (id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL)";
/** Rows a silent service may hold back before the display gives up on them. */
export const ACTIVITY_BACKLOG_MAX = 5_000;

export function activityCursor(sql: Sql): number {
  sql.exec(CURSOR);
  const known = sql.exec("SELECT through_seq FROM activity_sent WHERE id = 1").toArray()[0];
  return known ? Number(known.through_seq) : 0;
}

function setCursor(sql: Sql, through: number) {
  sql.exec("INSERT INTO activity_sent(id, through_seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET through_seq = excluded.through_seq", through);
}

export async function flushActivity(
  gateway: ActivityGateway, sql: Sql, tenantId: string, agentId: string, limit = ACTIVITY_BATCH_MAX,
): Promise<{ events: number; sent: number; through: number; skipped: string[]; dropped: number }> {
  const sent0 = activityCursor(sql);
  const backlog = Number(sql.exec("SELECT COUNT(*) AS n FROM trace_outbox WHERE seq > ?", sent0).toArray()[0]?.n ?? 0);
  let dropped = 0;
  let from = sent0;
  if (backlog > ACTIVITY_BACKLOG_MAX) {
    // Skip to the newest `limit` rows; what is skipped is on record here and in the pass's log.
    const newest = Number(sql.exec("SELECT MAX(seq) AS m FROM trace_outbox").toArray()[0]?.m ?? sent0);
    const keepFrom = Number(sql.exec("SELECT seq FROM trace_outbox WHERE seq > ? ORDER BY seq DESC LIMIT 1 OFFSET ?", sent0, limit - 1).toArray()[0]?.seq ?? newest);
    dropped = Number(sql.exec("SELECT COUNT(*) AS n FROM trace_outbox WHERE seq > ? AND seq < ?", sent0, keepFrom).toArray()[0]?.n ?? 0);
    console.warn(`activity for ${tenantId}/${agentId}: ${dropped} row(s) behind a silent service were skipped`);
    from = keepFrom - 1;
  }
  const { rows, through } = pendingTrace(sql, from, limit);
  const events = activityEvents(agentId, rows);
  let sent = 0;
  const skipped: string[] = [];
  if (events.length) {
    for (const r of await gateway.reportActivity(tenantId, agentId, events)) {
      if ("sent" in r) sent += r.sent;
      else skipped.push(`${r.alias}: ${r.skipped}`);
    }
  }
  if (through > sent0) setCursor(sql, through);
  return { events: events.length, sent, through: Math.max(sent0, through), skipped, dropped };
}
