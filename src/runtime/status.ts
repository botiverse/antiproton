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
 * whose credential goes quiet. These are status-only events; `activityEvents`
 * (src/runtime/activity.ts) folds each onto the activity event of the same
 * instant when there is one.
 */
import type { TraceOutboxRow } from "../trace/outbox.ts";
import type { ActivityEvent, AgentStatus } from "../plugins/types.ts";

/** The status changes a run of trace rows means, oldest first, with no two consecutive alike. */
export function statusEvents(agentId: string, rows: readonly TraceOutboxRow[], before: AgentStatus | null = null): Array<ActivityEvent & { status: AgentStatus }> {
  const raw: Array<{ at: number; key: string; status: AgentStatus; detail?: string }> = [];
  for (const row of rows) {
    const id = `${agentId}:${row.seq}:status`;
    const ms = typeof row.ms === "number" ? row.ms : 0;
    switch (row.kind) {
      case "inbound":
        if (row.status === "delivered") raw.push({ at: row.at, key: id, status: "thinking" });
        break;
      case "tool.call": {
        // What "working" is working on, named as the model names the tool; shown with the status in Raft.
        const tool = typeof row.attrs.tool === "string" ? row.attrs.tool : null;
        const mount = typeof row.attrs.mount === "string" ? row.attrs.mount : null;
        const name = tool ? (mount ? `${mount}__${tool}` : tool) : null;
        raw.push({ at: row.at - ms, key: `${id}:start`, status: "working", ...(name ? { detail: `Using ${name}`.slice(0, 200) } : {}) });
        break;
      }
      case "model.call":
        // A start is only known when the span measured itself; without `ms` it would sit on the end's
        // own instant and say nothing the end does not.
        if (ms > 0) raw.push({ at: row.at - ms, key: `${id}:start`, status: "thinking" });
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
  const out: Array<ActivityEvent & { status: AgentStatus }> = [];
  // A change is a new status or, for the same status, a new detail: the model asking for tools says
  // "working", and each tool that then starts says what it is working on.
  let current: string | null = before === null ? null : `${before}|`;
  for (const r of raw) {
    const key = `${r.status}|${r.detail ?? ""}`;
    if (key === current) continue;
    current = key;
    out.push({ eventId: r.key, status: r.status, ...(r.detail ? { detail: r.detail } : {}), occurredAt: new Date(r.at).toISOString() });
  }
  return out;
}
