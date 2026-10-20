/**
 * A turn ended from outside rather than by the agent: the provider's stop route, the operator's /admin/cancel-turn, or
 * the agent's delete (cf/src/runtime.ts `stopTurn`). On preview (2026-10-15) two deleted agents kept calling their model
 * every 2–3 s for five minutes: the delete took the agent's credential and push away and did nothing to the turn
 * already running in its object, and nothing else could end it short of a $0 spend limit.
 */
import type { SqlHost } from "../store/pi-storage.ts";
import type { TraceRow } from "../trace/outbox.ts";
import { logEvent } from "../core/log.ts";

type Sql = SqlHost["sql"];

export type StopTrigger = "provider_stop" | "admin_cancel" | "delete";

/** What ending a turn did: the run aborted, nothing was running, or it could not be ended, with why. */
export type StopTurnOutcome =
  | { result: "interrupted"; cancelledTurn: string }
  | { result: "not_running" }
  | { result: "failed"; error: string };

/** What Raft is shown for each (src/runtime/activity.ts, `turn.stop`). */
export const STOP_ERROR_CLASS: Record<StopTrigger, string> = {
  provider_stop: "stopped: by owner",
  admin_cancel: "stopped: by operator",
  delete: "stopped: agent deleted",
};

const TABLE = "CREATE TABLE IF NOT EXISTS agent_deleted (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)";

/** The agent was deleted by its provider: from now on no pass takes a step for it. Kept on a repeated delete. */
export function markAgentDeleted(sql: Sql, at: number): void {
  sql.exec(TABLE);
  sql.exec("INSERT OR IGNORE INTO agent_deleted(id, at) VALUES (1, ?)", at);
}

/** When the agent was deleted, or null. An object that never had the table was never deleted. */
export function agentDeletedAt(sql: Sql): number | null {
  const has = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'agent_deleted'").toArray().length > 0;
  if (!has) return null;
  const row = sql.exec("SELECT at FROM agent_deleted WHERE id = 1").toArray()[0] as { at?: unknown } | undefined;
  return row ? Number(row.at) : null;
}

/** The `turn.stop` row for a run that was ended: `cancelled`, with who ended it in its errorClass. */
export function turnStopRow(o: { tenantId: string; agentId: string; operationId: string; trigger: StopTrigger; at: number; turn?: string | null }): TraceRow {
  return {
    at: o.at, tenantId: o.tenantId, agentId: o.agentId, kind: "turn.stop", spanId: o.operationId,
    status: "stopped", verdict: "cancelled",
    // `turn`: the turn that was stopped (`turnIdOf`, read before the stop closed it), as a model call's row carries it.
    attrs: { errorClass: STOP_ERROR_CLASS[o.trigger], trigger: o.trigger, ...(o.turn ? { turn: o.turn } : {}) },
  };
}

/**
 * The `turn.stop` log line for one stop attempt: `side` is where it was written, the agent's object (`do`) or the
 * Worker that answered the stop request (`worker`). Both write one, so a stop that reached the object has two lines.
 */
export function logTurnStop(o: { tenantId: string; agentId: string; trigger: StopTrigger; side: "do" | "worker" }, out: StopTurnOutcome): void {
  logEvent("turn.stop", { tenantId: o.tenantId, agentId: o.agentId, trigger: o.trigger,
    result: out.result === "interrupted" ? "aborted" : out.result === "failed" ? "failed" : "nothing_running",
    ...(out.result === "interrupted" ? { turn: out.cancelledTurn } : {}), ...(out.result === "failed" ? { error: out.error } : {}),
    side: o.side });
}
