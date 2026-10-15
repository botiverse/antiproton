/**
 * The agent's status changes, derived by the runtime from its own trace rows
 * (src/trace/outbox.ts) — the same rows the activity events come from
 * (src/runtime/activity.ts), read on the same pass. The runtime knows its state;
 * the service does not infer it from another runtime's event names.
 *
 *   inbound, delivered            → thinking   (a message entered; the model is next)
 *   model.call, at its start      → thinking   (dated at - ms, when the call was made)
 *   model.call toolUse, at its end → working   (tools run next)
 *   tool.call, at its start       → working    (not one the provider ran: `operatorCall`)
 *   model.call stop|length|aborted → online    (the turn is over)
 *   model.call error              → error      (with why, for a daily spend limit's refusal or a busy first turn)
 *   session.needs_reset set       → error      (with why: pushes are refused until a reset)
 *   model.retry refused|cancelled → error|online (a busy first turn given up, or its re-dispatch cancelled)
 *   agent.ready                   → online     (a provisioned agent ready before its first turn, src/runtime/ready.ts)
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

/**
 * The task the raft plugin's push tools run under when the provider, not the model, calls them
 * (cf/src/provision/steps.ts `provisionTool`: enable_push on a create or a new credential, disable_push on a
 * delete). Their operations go through the gateway like the model's, so they leave `tool.call` rows; those rows
 * are not the agent working. Read as a working status they showed every new hosted agent "working" until its
 * first turn ended, and one never woken "working" for ever.
 */
export const PROVISION_TASK = "provision";

/** Whether a row is a tool call the provider made rather than the agent: no activity and no status of the agent's. */
export function operatorCall(row: TraceOutboxRow): boolean {
  return row.kind === "tool.call" && row.attrs.task === PROVISION_TASK;
}

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
        if (operatorCall(row)) break;
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
        // A call refused for a daily spend limit says why, as `detail`, which Raft's dot shows beside `error`.
        else if (row.status === "error") {
          // A first turn neither model answered says so the same way (src/model/model-fallback.ts).
          const why = typeof row.attrs.limit === "string" && row.attrs.limit ? row.attrs.limit
            : typeof row.attrs.busy === "string" && row.attrs.busy ? row.attrs.busy : null;
          const limit = why ? why.slice(0, 200) : null;
          raw.push({ at: row.at, key: id, status: "error", ...(limit ? { detail: limit } : {}) });
        }
        break;
      case "model.retry":
        if (row.status === "refused") raw.push({ at: row.at, key: id, status: "error", ...(typeof row.attrs.busy === "string" && row.attrs.busy ? { detail: row.attrs.busy.slice(0, 200) } : {}) });
        else if (row.status === "cancelled") raw.push({ at: row.at, key: id, status: "online" });
        break;
      case "session.needs_reset":
        if (row.status === "set") raw.push({ at: row.at, key: id, status: "error", detail: "Conversation too long for the model; waiting for an operator reset" });
        break;
      case "agent.ready":
        raw.push({ at: row.at, key: id, status: "online" });
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
