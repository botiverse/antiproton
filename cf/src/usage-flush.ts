/**
 * When an agent's object comes back for its outboxes, and when it may stop.
 *
 * The outboxes — usage (src/usage/outbox.ts) and trace (src/trace/outbox.ts, read by two drains: the
 * export and the activity report) — are sent only by an alarm pass (cf/src/index.ts `alarm`). Two ways
 * a row used to be left there indefinitely:
 *
 * - it was written by a handler outside any pass (a provisioning tool call through the gateway records
 *   a usage row and a trace row) and nothing armed an alarm afterwards: the object slept on it until
 *   something else woke it, which for an idle agent can be days (2026-09-28: two agents' usage stuck
 *   since a push tool call);
 * - the pass that found nothing more to do stood down with rows it could not send: more than one batch,
 *   or a send that lost the cursor race, and — always — the pass's own active time, which `do_activity`
 *   holds only once the pass has ended (src/usage/active.ts).
 *
 * The first is closed at the end of every handler (`#usageWake` in index.ts): rows unsent and no alarm
 * armed arms one shortly. Only with NO alarm armed: an armed alarm is a pass that will send them (every
 * pass flushes), and moving it earlier would add a pass to a model turn. A pass's own appends are not
 * covered by this — its handler is the pass, and the pass decides for itself below.
 *
 * The second is closed by the pass: before it stands down it counts its own time so far, sends once
 * more, and if rows are still unsent it comes back — at once while each pass moves a cursor (a backlog
 * drains; it is finite), and with a growing gap while none does, at most `USAGE_RETRY_LIMIT` times in a
 * row. Then it stands down and leaves the rows for the next wake: a sink that refuses for minutes is
 * not worth a wake every few seconds for ever.
 */

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

/** How soon a handler that left rows unsent, with no alarm armed, has them sent. */
export const USAGE_WAKE_DELAY_MS = 5_000;
/** How soon a pass that sent a full batch comes back for the rest. */
export const USAGE_DRAIN_DELAY_MS = 1_000;
/** The first gap after a pass that sent nothing; each further one doubles it. */
export const USAGE_RETRY_BASE_MS = 5_000;
/** Passes in a row that may move no cursor before the object stops coming back for the rows. */
export const USAGE_RETRY_LIMIT = 5;

/** A read that answers undefined for a table this object has never made: a look must not make it. */
function first(sql: Sql, q: string, ...b: unknown[]): any {
  try { return sql.exec(q, ...b).toArray()[0]; }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return undefined; throw e; }
}

const cursor = (sql: Sql, table: string): number => Number(first(sql, `SELECT through_seq FROM ${table} WHERE id = 1`)?.through_seq ?? 0);

/** Where the three drains stand: usage to D1, trace to the export, trace to the activity report. */
export function drainCursors(sql: Sql): [usage: number, trace: number, activity: number] {
  return [cursor(sql, "usage_sent"), cursor(sql, "trace_sent"), cursor(sql, "activity_sent")];
}

/** Whether any outbox holds a row one of its drains has not taken. Reads only. */
export function hasUnsent(sql: Sql): boolean {
  const [usage, trace, activity] = drainCursors(sql);
  if (first(sql, "SELECT 1 AS x FROM usage_outbox WHERE seq > ? LIMIT 1", usage)) return true;
  return !!first(sql, "SELECT 1 AS x FROM trace_outbox WHERE seq > ? LIMIT 1", Math.min(trace, activity));
}

const RETRIES = "CREATE TABLE IF NOT EXISTS usage_flush_retries (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)";

/**
 * The end of a pass that has nothing else to come back for. `unsent`: rows are still in an outbox after
 * the final send; `moved`: this pass advanced a drain's cursor. Returns how long until the pass comes
 * back, or null to stand down. The count of passes that moved nothing is kept in the object's storage,
 * because the object may be evicted between them.
 */
export function standDownDelay(sql: Sql, unsent: boolean, moved: boolean): number | null {
  sql.exec(RETRIES);
  const had = Number(first(sql, "SELECT n FROM usage_flush_retries WHERE id = 1")?.n ?? 0);
  let n = 0;
  let delay: number | null = null;
  if (unsent && moved) delay = USAGE_DRAIN_DELAY_MS;
  else if (unsent && had < USAGE_RETRY_LIMIT) { n = had + 1; delay = USAGE_RETRY_BASE_MS * 2 ** had; }
  if (n !== had) sql.exec("INSERT INTO usage_flush_retries(id, n) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n", n);
  return delay;
}
