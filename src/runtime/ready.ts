/**
 * The `online` a provisioned agent says when it is ready, before its first turn.
 *
 * Raft shows the status it last heard, and before this an agent made by the provider had heard nothing of its own:
 * the provider's enable_push is not the agent's work (src/runtime/status.ts `operatorCall`), and the first status
 * came from the first turn. So a new agent's dot waited on a turn, and one never woken waited for ever. Ready is
 * push enabled and, for an agent made with `awaitImport`, the import landed (src/store/workspace-import.ts): the
 * runtime asks at both instants (cf/src/runtime.ts `provisionedReady`), and the first that finds both true writes
 * the row.
 *
 * One `agent.ready` trace row, once per agent, dated the instant it was found ready. It travels as every status
 * does, on the activity drain (cf/src/activity-raft.ts), so it is retried, ordered and deduped like the others,
 * and sent only while push is on. Never once a turn has started: the turn's own statuses say what the agent is,
 * and an `online` written after them would, by its later occurredAt, override the one in force.
 */
import { appendTrace } from "../trace/outbox.ts";
import { agentStarted, readHold } from "../store/workspace-import.ts";
import type { SqlHost } from "../store/pi-storage.ts";

type Sql = SqlHost["sql"];

const READY_SCHEMA = "CREATE TABLE IF NOT EXISTS agent_ready (tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, at INTEGER NOT NULL, " +
  "PRIMARY KEY (tenant_id, agent_id))";

/**
 * Write the agent's `agent.ready` row now, if it is ready and has not said so; whether it was written. The caller
 * has found push enabled and runs this inside its transaction, so the once and the row commit together.
 */
export function markReady(sql: Sql, tenantId: string, agentId: string, reason: string, now: number): boolean {
  // Held for its import: ready when the import lifts the hold, which asks again.
  if (readHold(sql, tenantId, agentId)?.liftedAt === null) return false;
  if (agentStarted(sql, tenantId, agentId)) return false;
  sql.exec(READY_SCHEMA);
  if (sql.exec("SELECT 1 FROM agent_ready WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray().length) return false;
  sql.exec("INSERT INTO agent_ready(tenant_id, agent_id, at) VALUES (?,?,?)", tenantId, agentId, now);
  appendTrace(sql, [{
    at: now, tenantId, agentId, kind: "agent.ready", spanId: `ready_${agentId}`, status: "ready", verdict: "ok", attrs: { reason },
  }]);
  return true;
}
