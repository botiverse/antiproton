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
 *   tool.call               → PreToolUse + PostToolUse / PostToolUseFailure  (not one the provider ran: `operatorCall`)
 *                             both with `toolUseId`; the end with `ok`, `durationMs`, and `exitCode` when there is one
 *   turn.stop stopped       → BridgeFatal         (the turn was ended from outside: `stopped: by owner`, `stopped: agent deleted`, …)
 *   model.call stop|length  → Stop                (the turn is answered)
 *   model.call aborted      → Stop                (cancelled: no longer working)
 *   model.call error        → BridgeFatal         (the turn died; a daily spend limit's refusal says so and why)
 *   model.call toolUse      → nothing             (still working)
 *   session.needs_reset set → BridgeFatal         (the overflow backstop gave up: pushes are refused until a reset)
 *   agent.ready             → nothing             (its `online` is a status-only event, src/runtime/status.ts)
 *   a subagent's row        → nothing             (a child session's work: trace only, `subagentRow`)
 *
 * The event id is the row's seq under the agent: unique for the agent's
 * lifetime because seq is AUTOINCREMENT and never reused, so a batch sent
 * twice is the same events twice, which the service dedupes. `errorClass` is a
 * free string the service shows (cut at 120 there); `status` is not read by
 * the service and is not sent.
 */
import type { TraceOutboxRow } from "../trace/outbox.ts";
import type { ActivityEvent } from "../plugins/types.ts";
import { operationToolName } from "./pi-tools.ts";
import { operatorCall, statusEvents, subagentRow, turnEndClass } from "./status.ts";

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
/**
 * What maps a subagent's rows to events (`activityEvents`), present only where the deployment turns it on
 * (SUBAGENT_ACTIVITY=1, cf/src/index.ts): `lineage` answers the parent's `send_to_agent` call id for a child session.
 * Absent — the default — a child's rows make no event at all, as before: Raft's ingest strips fields it does not know,
 * so a child's tool call sent with its marker stripped would read as the agent's own.
 */
export interface SubagentActivity { lineage(session: string, at: number): string | null }

export function activityEvents(agentId: string, rows: readonly TraceOutboxRow[], subagents?: SubagentActivity): ActivityEvent[] {
  const events = hookEvents(agentId, rows, subagents);
  // The status after an instant is the last change at that instant; earlier ones at the same instant
  // were superseded before anyone could see them.
  const after = new Map<string, ReturnType<typeof statusEvents>[number]>();
  for (const s of statusEvents(agentId, rows)) after.set(s.occurredAt, s);
  const hosts = new Map<string, ActivityEvent>();
  // The last of the agent's own events at an instant carries it; never a subagent's, which is not the agent's state.
  for (const e of events) if (!e.subagent) hosts.set(e.occurredAt, e);
  for (const [instant, s] of after) {
    const host = hosts.get(instant);
    if (host) {
      host.status = s.status;
      if (s.detail) host.detail = s.detail;
    } else events.push(s);
  }
  return events;
}

/**
 * Moves the status-carrying events so none shares an instant with the one before or with `after`, the
 * last status instant already sent; returns the new last. Raft keeps the status with the latest
 * occurredAt, so two at one millisecond leave it to arrival order. They happen: a tool that takes 0 ms
 * starts and ends on the model call's own end. A later event moves by the millisecond it needs,
 * together with the activity event it rides on.
 */
export function orderStatuses(events: readonly ActivityEvent[], after: number): number {
  let last = after;
  const carrying = events.filter((e) => e.status !== undefined)
    .map((e) => ({ e, at: Date.parse(e.occurredAt) }))
    .sort((a, b) => a.at - b.at);
  for (const { e, at } of carrying) {
    // Strictly earlier than what was already sent is left alone: Raft keeps the later one, which is right.
    // Moving it forward would make an older status win. (Starts are dated back, so a span can overlap one
    // sent in an earlier pass.)
    if (at < after) continue;
    last = Math.max(at, last + 1);
    if (last !== at) e.occurredAt = new Date(last).toISOString();
  }
  return last;
}

/** The activity events a run of trace rows means, in row order; rows that mean nothing to the service yield none. */
function hookEvents(agentId: string, rows: readonly TraceOutboxRow[], subagents?: SubagentActivity): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const row of rows) {
    // A subagent's model calls and tools are its own, not the agent's (`subagentRow`, src/runtime/status.ts): no event,
    // unless the deployment maps them (`subagentEvents`), and even then never a Stop or a prompt.
    if (subagentRow(row) || row.kind === "subagent.start" || row.kind === "subagent.turn") {
      if (subagents) out.push(...subagentEvents(agentId, row, subagents));
      continue;
    }
    const base = { eventId: activityEventId(agentId, row.seq), occurredAt: new Date(row.at).toISOString() };
    switch (row.kind) {
      case "inbound":
        if (row.status === "delivered") out.push({ ...base, hookEventName: "UserPromptSubmit" });
        break;
      case "tool.call":
        if (!operatorCall(row)) out.push(...toolCallEvents(base, row));
        break;
      // A turn that was ended from outside: who ended it is the row's errorClass (cf/src/runtime.ts `stopTurn`,
      // `turnEndClass` in src/runtime/status.ts), so the activity log says why the agent stopped instead of going quiet.
      case "turn.stop":
        if (row.status === "stopped") out.push({ ...base, hookEventName: "BridgeFatal", errorClass: turnEndClass(row) });
        break;
      case "model.call":
        if (row.status === "stop" || row.status === "length" || row.status === "aborted") out.push({ ...base, hookEventName: "Stop" });
        else if (row.status === "error") out.push({ ...base, hookEventName: "BridgeFatal", errorClass: modelCallErrorClass(row) });
        break;
      case "session.needs_reset":
        if (row.status === "set") out.push({ ...base, hookEventName: "BridgeFatal", errorClass: NEEDS_RESET_ERROR });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * A tool call's two events from its row: PreToolUse dated the span's start, PostToolUse(Failure) at its end. The agent's
 * own calls (`hookEvents`) and a subagent's (`subagentEvents`, with its marker on both) are mapped the same way.
 */
function toolCallEvents(base: { eventId: string; occurredAt: string }, row: TraceOutboxRow, subagent?: ActivityEvent["subagent"]): ActivityEvent[] {
  const tool = typeof row.attrs.tool === "string" ? row.attrs.tool : "tool";
  const mount = typeof row.attrs.mount === "string" ? row.attrs.mount : null;
  // Named as the model names it, so the service's trajectory reads like the transcript. The row's `tool` is the
  // dispatch address (`raft.messages_send`), not the tool's own name (`operationToolName`).
  const toolName = mount ? operationToolName(mount, tool) : tool;
  const ok = row.verdict === "ok";
  const ms = typeof row.ms === "number" ? row.ms : 0;
  // The operation id, on both events, is what pairs them: one per call and one row per operation
  // (src/trace/seams.ts `operationEnds`). Not the model's call id, which a run_js program's host calls
  // share and a resumed question reuses.
  const toolUseId = row.spanId;
  // How long the tool ran: from the attempt's start when the row says it (`attrs.runMs`), so a call held
  // for a person's approval does not count the wait; otherwise the whole span. The call itself stays dated
  // at the request, when the model asked for it.
  const runMs = typeof row.attrs.runMs === "number" ? row.attrs.runMs : null;
  const durationMs = runMs ?? (typeof row.ms === "number" ? row.ms : null);
  const exitCode = typeof row.attrs.exitCode === "number" ? row.attrs.exitCode : null;
  const marker = subagent ? { subagent } : {};
  return [
    { eventId: `${base.eventId}:pre`, occurredAt: new Date(row.at - ms).toISOString(), hookEventName: "PreToolUse", toolName, toolUseId, ...marker },
    {
      ...base,
      hookEventName: ok ? "PostToolUse" : "PostToolUseFailure",
      toolName,
      toolUseId,
      ...marker,
      ok: toolOutcome(row.status, row.attrs.denied === true),
      ...(durationMs === null ? {} : { durationMs }),
      ...(exitCode === null ? {} : { exitCode }),
      ...(ok ? {} : { errorClass: row.status }),
    },
  ];
}

/**
 * `ok` on a tool's end, from the operation's status (`row.status`, written verbatim): whether the call did what it
 * was asked. `succeeded` is true even for a command that exited non-zero (`exitCode` says that); `failed` and
 * `rejected` are false; `unknown` (the outcome was lost) and `cancelled` are null, which the service reads as "not
 * known" — sent as an explicit null, not left out. A held call a person refused ends `cancelled` too, but is false
 * (`attrs.denied`, src/trace/seams.ts): the call was refused, as a policy refusal is, which is not an unknown outcome.
 */
export function toolOutcome(status: string, denied = false): boolean | null {
  if (denied) return false;
  switch (status) {
    case "succeeded": return true;
    case "failed": case "rejected": return false;
    default: return null;
  }
}

/**
 * A subagent's rows as Raft's subagent events (`SubagentLineage`): its start, its tool calls, its end. Ids and enums only.
 *
 *   subagent.start (spawn, follow_up) → the parent's own PreToolUse + PostToolUse for send_to_agent (no marker), then
 *                                       SubagentStart { phase: "started" }
 *   subagent.start (wake)             → SubagentStart { phase: "started" }
 *   a child's tool.call               → PreToolUse + PostToolUse / PostToolUseFailure { phase: "active" }
 *   subagent.turn done|failed|stopped|cancelled → SubagentStop { phase: "ended", outcome, reportChars }: a cancel is
 *                                       `ceiling` only when its row's `cause` says the harness took it at its time or
 *                                       lifetime; any other cancel is `stopped`
 *   a child's model.call, js.run, a report's retry or drop, a wake that was never posted → nothing (never a Stop,
 *                                       never a prompt)
 */
function subagentEvents(agentId: string, row: TraceOutboxRow, subagents: SubagentActivity): ActivityEvent[] {
  const base = { eventId: activityEventId(agentId, row.seq), occurredAt: new Date(row.at).toISOString() };
  const lineage = (taskId: string, parent: string | null | undefined, phase: "started" | "active" | "ended") =>
    ({ ...(parent ? { parentToolUseId: parent } : {}), taskId, phase });
  if (row.kind === "subagent.start") {
    const taskId = row.spanId;
    const parent = row.parentId ?? subagents.lineage(taskId, row.at);
    // send_to_agent has no tool.call row (it is a model tool, not a gateway operation), so its pair's `toolUseId` is the
    // model's call id: the same id the child's marker names as `parentToolUseId`, so the service can join the step to
    // its child. It is unique per send: the start row is written once per turn (cf/src/runtime.ts `#sendToAgent`, a
    // replay finds the turn already posted), and the tool is the model's own, not one of run_js's host calls (`offered`).
    const toolUseId = row.parentId;
    const own = row.status !== "wake" && toolUseId
      ? [{ eventId: `${base.eventId}:pre`, occurredAt: base.occurredAt, hookEventName: "PreToolUse" as const, toolName: SEND_TOOL, toolUseId },
         { ...base, eventId: `${base.eventId}:post`, hookEventName: "PostToolUse" as const, toolName: SEND_TOOL, toolUseId, ok: true }]
      : [];
    return [...own, { ...base, hookEventName: "SubagentStart", subagent: lineage(taskId, parent, "started") }];
  }
  if (row.kind === "subagent.turn") {
    const outcome = row.status === "done" || row.status === "failed" || row.status === "stopped" ? row.status
      : row.status === "cancelled" ? (row.attrs.cause === "ceiling" ? "ceiling" : "stopped") : null;
    if (!outcome) return [];
    const chars = typeof row.attrs.reportChars === "number" ? row.attrs.reportChars : 0;
    // Inside the marker, where Raft reads them: its ingest keeps the marker and drops unknown top-level fields.
    return [{ ...base, hookEventName: "SubagentStop",
      subagent: { ...lineage(row.spanId, row.parentId ?? subagents.lineage(row.spanId, row.at), "ended"), outcome, reportChars: chars } }];
  }
  if (row.kind === "tool.call" && typeof row.attrs.task === "string") {
    const taskId = row.attrs.task;
    const ms = typeof row.ms === "number" ? row.ms : 0;
    // The turn the step was part of: the one that had started when the step began, whatever turn runs by the time this
    // is read (a flush behind a follow-up must not give a turn-1 step turn 2's parent).
    return toolCallEvents(base, row, lineage(taskId, subagents.lineage(taskId, row.at - ms), "active"));
  }
  return [];
}

/** The parent's tool, as the model names it. */
const SEND_TOOL = "send_to_agent";

/**
 * What the service shows for a conversation the overflow backstop gave up on (src/runtime/overflow-backstop.ts): the
 * pushes it refuses were already answered "delivered" at the hook, so this, once per episode, is how the sender learns
 * that nothing will answer them until an operator resets the session.
 */
export const NEEDS_RESET_ERROR = "context_overflow: conversation too long for the model; pushes are refused until an operator resets it";

/**
 * The `errorClass` a failed model call is sent with. Raft shows it as the text of the activity log's "Bridge fatal"
 * entry, at most 120 characters (slock agentOrchestrator.ts, the BridgeFatal mapping), so a call refused for a daily
 * spend limit (`attrs.limit`, src/trace/seams.ts `modelCallRow`) names itself and carries its sentence, as
 * `NEEDS_RESET_ERROR` does; anything else is `model_call_failed`.
 */
export const USAGE_LIMIT_ERROR_CLASS = "usage_limit_reached";
function modelCallErrorClass(row: TraceOutboxRow): string {
  const limit = typeof row.attrs.limit === "string" && row.attrs.limit ? row.attrs.limit : null;
  return limit ? `${USAGE_LIMIT_ERROR_CLASS}: ${limit}`.slice(0, 120) : "model_call_failed";
}
