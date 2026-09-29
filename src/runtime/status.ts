/**
 * The agent's status changes, derived by the runtime from its own trace rows
 * (src/trace/outbox.ts) — the same rows the activity events come from
 * (src/runtime/activity.ts), read on the same pass. The runtime knows its state;
 * the service does not infer it from another runtime's event names.
 *
 *   inbound, delivered            → thinking   (a message entered; the model is next)
 *   model.call, at its start      → thinking   (dated at - ms, when the call was made)
 *   model.call toolUse, at its end → working   (tools run next)
 *   tool.call, at its start       → working
 *   model.call stop|length|aborted → online    (the turn is over)
 *   model.call error              → error
 *
 * A row is one ENDED span, so a start is dated back by its measured `ms`. Events
 * are sorted by time and a change to the status already in force is dropped:
 * what is sent is transitions, and the service keeps the latest by occurredAt.
 * Offline is not derived here: it is said when push is switched off (the raft
 * plugin's disable_push), and the service shows it on its own for an agent
 * whose credential goes quiet.
 */
import type { TraceOutboxRow } from "../trace/outbox.ts";
import type { AgentStatus, StatusEvent } from "../plugins/types.ts";

export const STATUS_SCHEMA = "raft-agent-status.v1";

/** The status changes a run of trace rows means, oldest first, with no two consecutive alike. */
export function statusEvents(agentId: string, rows: readonly TraceOutboxRow[], before: AgentStatus | null = null): StatusEvent[] {
  const raw: Array<{ at: number; key: string; status: AgentStatus }> = [];
  for (const row of rows) {
    const id = `${agentId}:${row.seq}:status`;
    const ms = typeof row.ms === "number" ? row.ms : 0;
    switch (row.kind) {
      case "inbound":
        if (row.status === "delivered") raw.push({ at: row.at, key: id, status: "thinking" });
        break;
      case "tool.call":
        raw.push({ at: row.at - ms, key: `${id}:start`, status: "working" });
        break;
      case "model.call":
        raw.push({ at: row.at - ms, key: `${id}:start`, status: "thinking" });
        if (row.status === "toolUse") raw.push({ at: row.at, key: id, status: "working" });
        else if (row.status === "stop" || row.status === "length" || row.status === "aborted") raw.push({ at: row.at, key: id, status: "online" });
        else if (row.status === "error") raw.push({ at: row.at, key: id, status: "error" });
        break;
      default:
        break;
    }
  }
  // Stable by time: a start dated back can precede an earlier row's end.
  raw.sort((a, b) => a.at - b.at);
  const out: StatusEvent[] = [];
  let current = before;
  for (const r of raw) {
    if (r.status === current) continue;
    current = r.status;
    out.push({ eventId: r.key, status: r.status, occurredAt: new Date(r.at).toISOString() });
  }
  return out;
}
