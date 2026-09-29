/**
 * The agent's activity, as the service it belongs to wants to hear it
 * (raft-agent-activity-ingest.v1, agreed with Tenny, Raft, 2026-09-28).
 *
 * The source is the trace outbox (src/trace/outbox.ts): one row per ENDED
 * span, appended where the work commits. Nothing new is recorded for this; the
 * rows are read a second time on the alarm pass (cf/src/activity-raft.ts) and
 * mapped here. A span has one row, at its end, so a tool call yields two events
 * at once: PreToolUse dated the span's start, PostToolUse(Failure) dated its
 * end — the service orders by occurredAt. The display goes "working" on the
 * message that started the turn, stays there through tool results, and comes
 * back on the model's final answer:
 *
 *   inbound, delivered      → UserPromptSubmit   (a message entered the model)
 *   tool.call               → PreToolUse + PostToolUse / PostToolUseFailure
 *   model.call stop|length  → Stop                (the turn is answered)
 *   model.call aborted      → Stop                (cancelled: no longer working)
 *   model.call error        → BridgeFatal         (the turn died)
 *   model.call toolUse      → nothing             (still working)
 *
 * The event id is the row's seq under the agent: unique for the agent's
 * lifetime because seq is AUTOINCREMENT and never reused, so a batch sent
 * twice is the same events twice, which the service dedupes. `errorClass` is a
 * free string the service shows (cut at 120 there); `status` is not read by
 * the service and is not sent.
 */
import type { TraceOutboxRow } from "../trace/outbox.ts";
import type { ActivityEvent } from "../plugins/types.ts";
import { statusEvents } from "./status.ts";

export const ACTIVITY_SCHEMA = "raft-agent-activity-ingest.v1";
/**
 * Rows per pass. Raft takes at most 200 events a request (EXTERNAL_ACTIVITY_EVENT_LIMIT). A row makes
 * at most two: a tool row its call and result (statuses fold onto them), a model-call row at most a
 * status-only start and an end.
 */
export const ACTIVITY_BATCH_MAX = 100;

export function activityEventId(agentId: string, seq: number): string {
  return `${agentId}:${seq}`;
}

/**
 * The events a run of trace rows means, with the agent's status changes on them: each change goes on
 * the activity event of the same instant when there is one, otherwise it is a status-only event.
 */
export function activityEvents(agentId: string, rows: readonly TraceOutboxRow[]): ActivityEvent[] {
  const events = hookEvents(agentId, rows);
  // The status after an instant is the last change at that instant; earlier ones at the same instant
  // were superseded before anyone could see them.
  const after = new Map<string, ReturnType<typeof statusEvents>[number]>();
  for (const s of statusEvents(agentId, rows)) after.set(s.occurredAt, s);
  const hosts = new Map<string, ActivityEvent>();
  for (const e of events) hosts.set(e.occurredAt, e);   // the last activity event at an instant carries it
  for (const [instant, s] of after) {
    const host = hosts.get(instant);
    if (host) host.status = s.status;
    else events.push(s);
  }
  return events;
}

/** The activity events a run of trace rows means, in row order; rows that mean nothing to the service yield none. */
function hookEvents(agentId: string, rows: readonly TraceOutboxRow[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const row of rows) {
    const base = { eventId: activityEventId(agentId, row.seq), occurredAt: new Date(row.at).toISOString() };
    switch (row.kind) {
      case "inbound":
        if (row.status === "delivered") out.push({ ...base, hookEventName: "UserPromptSubmit" });
        break;
      case "tool.call": {
        const tool = typeof row.attrs.tool === "string" ? row.attrs.tool : "tool";
        const mount = typeof row.attrs.mount === "string" ? row.attrs.mount : null;
        // Named as the model names it, so the service's trajectory reads like the transcript.
        const toolName = mount ? `${mount}__${tool}` : tool;
        const ok = row.verdict === "ok";
        const ms = typeof row.ms === "number" ? row.ms : 0;
        out.push({ eventId: `${base.eventId}:pre`, occurredAt: new Date(row.at - ms).toISOString(), hookEventName: "PreToolUse", toolName });
        out.push({
          ...base,
          hookEventName: ok ? "PostToolUse" : "PostToolUseFailure",
          toolName,
          ...(typeof row.ms === "number" ? { durationMs: row.ms } : {}),
          ...(ok ? {} : { errorClass: row.status }),
        });
        break;
      }
      case "model.call":
        if (row.status === "stop" || row.status === "length" || row.status === "aborted") out.push({ ...base, hookEventName: "Stop" });
        else if (row.status === "error") out.push({ ...base, hookEventName: "BridgeFatal", errorClass: "model_call_failed" });
        break;
      default:
        break;
    }
  }
  return out;
}
